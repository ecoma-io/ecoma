import postgres from 'postgres';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  checkRevocationAtIssuance,
  findActiveGrant,
  findCommittedConsentDecision,
  findRegisteredClient,
  insertAuditEvent,
  insertConsentDecision,
  insertGrant,
  insertGrantScopes,
  type PostgresClientLike,
} from '@ecoma-io/auth-infrastructure';
import { startAuthDatabase, type AuthDatabase } from './harness';

/**
 * Hợp đồng đọc/ghi của các store `db-auth` trong `@ecoma-io/auth-infrastructure`
 * (`oauth-client-store`, `oauth-grant-store`, `token-revocation-store`,
 * `authorization-audit-store`) trên PostgreSQL THẬT.
 *
 * ⚠️ Vì sao suite này tồn tại: các hàm của các store đó chỉ có
 * coverage GIÁN TIẾP qua handler/gate (internal-handlers, mid-flow,
 * gate-wiring) — mỗi nhánh chưa đi qua được ở đường đó thì chưa được test.
 * Đúng nguyên tắc §7 của 06-testing.md: gần trạng thái authoritative
 * (`oauth_grants`, `token_revocations`) thì race/UNIQUE/idempotency phải được
 * kiểm trực tiếp, không suy diễn từ một đường handler đi ngang.
 *
 * ⚠️ PostgreSQL thật, không stub: index unique partial
 * (`oauth_grants_active_sub_client_idx`) và hành vi khoá của `INSERT` đồng
 * thời là thứ chỉ tồn tại trong PostgreSQL. Một Map giả cho "đúng một winner"
 * nhưng không nói gì về hàng loser nhận lỗi gì — mà người gọi (`consent/decide`)
 * phụ thuộc đúng hình dạng lỗi đó để phân biệt với lỗi hạ tầng.
 *
 * ⚠️ Thiếu Docker: fail-loud qua `docker-probe.global-setup.ts` của config
 * integration — không skip im lặng với exit 0.
 */

let db: AuthDatabase;

function base() {
  if (db === undefined) {
    throw new Error('database container is not running');
  }
  return {
    host: db.host,
    port: db.port,
    database: db.database,
    prepare: false,
  } as const;
}

/** Pool runtime `max: 10` — điều kiện để hai INSERT thật sự chạy song song. */
function connectRuntime(max = 10): postgres.Sql {
  return postgres({
    ...base(),
    user: db.runtimeUser,
    password: db.runtimePassword,
    max,
  });
}

/** Role DDL — seed và cleanup, đúng hai vai của mọi suite PG trong app này. */
function connectMigrator(): postgres.Sql {
  return postgres({
    ...base(),
    user: db.migratorUser,
    password: db.migratorPassword,
    max: 1,
  });
}

async function setup(): Promise<{ runtime: postgres.Sql; migrator: postgres.Sql }> {
  return { runtime: connectRuntime(), migrator: connectMigrator() };
}

/**
 * Cast pool thật sang `PostgresClientLike` — brand `[NONCE_CLAIM_TARGET]` là
 * brand danh nghĩa không có giá trị runtime (postgres.js không trang bị nó),
 * cùng hình dạng cast `as unknown as PostgresClientLike` mà mọi suite PG khác
 * của app dùng. Một helper duy nhất để các điểm gọi trong test còn đọc được
 * hàm nào đang nhận pool nào.
 */
function clientOf(sql: postgres.Sql): PostgresClientLike {
  return sql as unknown as PostgresClientLike;
}

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

const CLIENT_ID = 'client-authz-store-test';
const CLIENT_ID_ALT = 'client-authz-store-other';
/** Marker cleanup — mọi sub của suite bám marker này. */
const SUB_PREFIX = 'sub-authz-store-';
/** Suffix tx id — cleanup xoá theo marker này (con trước cha). */
const TX_SUFFIX = '-for-authz-store-spec-0';

function newSub(tag: string): string {
  return `${SUB_PREFIX}${tag}-0000000000000000000000000000`;
}

function newTxId(prefix: string): string {
  return `${prefix}-fixed-transaction-identifier${TX_SUFFIX}`;
}

async function seedClient(migrator: postgres.Sql, clientId: string): Promise<void> {
  await migrator`
    INSERT INTO auth.oauth_clients (client_id, client_name, client_type)
    VALUES (${clientId}, 'authz store test client', 'public')
    ON CONFLICT (client_id) DO NOTHING
  `;
}

/**
 * Seed client rồi đặt `status` theo yêu cầu — tách khỏi `seedClient` vì
 * `status` chỉ cần `disabled` ở đúng một test, và `UPDATE` sau INSERT giữ
 * fixture còn một đường.
 */
async function setClientStatus(
  migrator: postgres.Sql,
  clientId: string,
  status: 'active' | 'disabled',
): Promise<void> {
  await migrator`
    UPDATE auth.oauth_clients SET status = ${status} WHERE client_id = ${clientId}
  `;
}

async function seedRedirectUri(
  migrator: postgres.Sql,
  clientId: string,
  redirectUri: string,
): Promise<void> {
  await migrator`
    INSERT INTO auth.client_redirect_uris (client_id, redirect_uri)
    VALUES (${clientId}, ${redirectUri})
    ON CONFLICT (client_id, redirect_uri) DO NOTHING
  `;
}

async function setAllowedScopes(
  migrator: postgres.Sql,
  clientId: string,
  scopes: string[],
): Promise<void> {
  await migrator`
    UPDATE auth.oauth_clients SET allowed_scopes = ${scopes}::text[]
     WHERE client_id = ${clientId}
  `;
}

/**
 * INSERT grant thô qua migrator — KHÔNG qua `insertGrant` ở test race, để
 * mô phỏng đúng hai caller độc lập cùng gọi hàm store (không chia pool).
 */
async function seedGrantRow(
  migrator: postgres.Sql,
  params: { sub: string; clientId: string },
): Promise<string> {
  const rows = await migrator<{ id: string }[]>`
    INSERT INTO auth.oauth_grants (sub, client_id, status, granted_at)
    VALUES (${params.sub}, ${params.clientId}, 'active', now())
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error('seedGrantRow khong tra ve id');
  }
  return id;
}

/** Thu hồi grant bằng đúng UPDATE hai cột mà mọi đường revoke thật dùng. */
async function revokeGrant(runtime: postgres.Sql, grantId: string, reason: string): Promise<void> {
  await runtime.unsafe(
    `UPDATE auth.oauth_grants
        SET status = 'revoked', revoked_at = now(), revoked_reason = $2
      WHERE id = $1`,
    [grantId, reason],
  );
}

/**
 * Consent decision thật để `insertGrant` trỏ FK `consent_decision_id` vào —
 * đúng hình dạng caller production (`consent/decide` luôn gọi với id của
 * decision vừa ghi trong cùng tx). ⚠️ `consentDecisionId: undefined` KHÔNG
 * chạy được với driver: postgres.js từ chối bind `undefined`
 * (UNDEFINED_VALUE) thay vì dịch thành NULL — tức là nhánh nullable của type
 * `NewGrantInput` chưa từng có đường đi qua nó. Test giữ đúng đường production;
 * khoảng trống type-vs-driver này được ghi trong PR body, không được "fix âm
 * thầm" trong một PR test-only.
 */
async function seedDecisionForGrant(
  runtime: postgres.Sql,
  migrator: postgres.Sql,
  sub: string,
  tag: string,
): Promise<string> {
  const txId = newTxId(`gr-${tag}`);
  await seedTransaction(runtime, { transactionId: txId, clientId: CLIENT_ID, sub });
  const decisionId = await insertConsentDecision(clientOf(runtime), {
    sub,
    clientId: CLIENT_ID,
    redirectUri: 'https://app.example.com/cb',
    grantedScopes: [],
    decision: 'approve',
    authorizationTransactionId: txId,
    now: new Date(),
  });
  void migrator;
  return decisionId;
}

/**
 * Transaction sẵn sàng làm FK cha của `oauth_consent_decisions` — cột
 * `authorization_transaction_id` trỏ RESTRICT vào đây.
 */
async function seedTransaction(
  runtime: postgres.Sql,
  params: { transactionId: string; clientId: string; sub?: string },
): Promise<void> {
  // ⚠️ CHECK `identity_is_complete_check`: biết sub là bắt buộc biết acr +
  //     authn_at (không có "biết ai" mà không biết với assurance nào) — seed
  //     có sub phải đi kèm hai cột đó.
  const hasSub = params.sub !== undefined;
  await runtime.unsafe(
    `INSERT INTO auth.authorization_transactions (
        transaction_id, handle_hash_x, client_id, redirect_uri,
        requested_scopes, code_challenge, code_challenge_method,
        browser_binding_hash, key_version, expires_at, sub, acr, authn_at, state
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $11, $12, 'browser_confirmed')`,
    [
      params.transactionId,
      // `handle_hash_x` UNIQUE bytea — mỗi tx một giá trị riêng, đủ 43 ký tự
      // base64url để decode ra 32 byte đúng schema CHECK độ dài.
      Buffer.from(`x-${params.transactionId}`).subarray(0, 32).toString('base64url'),
      params.clientId,
      'https://app.example.com/cb',
      ['openid'],
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      'S256',
      Buffer.from(`b-${params.transactionId}`).subarray(0, 32).toString('base64url'),
      new Date(Date.now() + 600_000),
      params.sub ?? null,
      hasSub ? 'urn:ecoma:acr:email-otp' : null,
      hasSub ? new Date(Date.now() - 30_000) : null,
    ],
  );
}

/**
 * Dọn TOÀN BỘ hàng của suite theo marker. Thứ tự con trước cha:
 * audit events và token revocations KHÔNG dọn (append-only — giữ bằng chứng
 * như các suite PG khác của app đã chọn), các bảng còn lại xoá theo marker
 * riêng của suite để không va các suite khác trong cùng container.
 */
async function cleanup(migrator: postgres.Sql): Promise<void> {
  await migrator.unsafe(
    `DELETE FROM auth.client_grant_scopes
      WHERE grant_id IN (SELECT id FROM auth.oauth_grants WHERE sub LIKE '${SUB_PREFIX}%')`,
  );
  await migrator.unsafe(`DELETE FROM auth.oauth_grants WHERE sub LIKE '${SUB_PREFIX}%'`);
  await migrator.unsafe(
    `DELETE FROM auth.oauth_consent_decisions
      WHERE authorization_transaction_id LIKE '%${TX_SUFFIX}%'`,
  );
  await migrator.unsafe(
    `DELETE FROM auth.authorization_transactions WHERE transaction_id LIKE '%${TX_SUFFIX}%'`,
  );
  await migrator.unsafe(
    `DELETE FROM auth.client_redirect_uris
      WHERE client_id IN ('${CLIENT_ID}', '${CLIENT_ID_ALT}')`,
  );
  await migrator.unsafe(
    `DELETE FROM auth.oauth_clients WHERE client_id LIKE 'client-authz-store-%'`,
  );
}

/* ------------------------------------------------------------------ */
/* Suite                                                               */
/* ------------------------------------------------------------------ */

beforeAll(async () => {
  db = await startAuthDatabase();
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

describe('authorization-store — against a real PostgreSQL', () => {
  describe('findRegisteredClient', () => {
    it('an active client with several redirect URIs — aggregates sorted URIs and allowed scopes', async () => {
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        // Chèn NGƯỢC thứ tự bảng chữ cái để chứng minh `ORDER BY` của câu query
        // là hành vi thật, không phải trùng khớp ngẫu nhiên với thứ tự chèn.
        await seedRedirectUri(migrator, CLIENT_ID, 'https://app.example.com/cb-zeta');
        await seedRedirectUri(migrator, CLIENT_ID, 'https://app.example.com/cb-alpha');
        await seedRedirectUri(migrator, CLIENT_ID, 'https://app.example.com/cb-mid');
        await setAllowedScopes(migrator, CLIENT_ID, ['openid', 'profile']);

        const client = await findRegisteredClient(clientOf(runtime), CLIENT_ID);

        expect(client).toBeDefined();
        expect(client?.client_id).toBe(CLIENT_ID);
        expect(client?.client_type).toBe('public');
        expect(client?.isActive).toBe(true);
        expect([...(client?.redirect_uris ?? [])]).toEqual([
          'https://app.example.com/cb-alpha',
          'https://app.example.com/cb-mid',
          'https://app.example.com/cb-zeta',
        ]);
        expect([...(client?.allowed_scopes ?? [])]).toEqual(['openid', 'profile']);
      } finally {
        await cleanup(migrator);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('a client with no registered redirect URI — empty list, not NULL', async () => {
      // ⚠️ `coalesce(..., '{}')` của câu query: LEFT JOIN không có hàng nào
      //     `array_agg` thành NULL, và một `undefined` hay null ở đây biến
      //     bước "duyệt redirect_uri đăng ký" ở tầng trên thành nổ TypeError
      //     thay vì một phép so sánh false vô hại.
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);

        const client = await findRegisteredClient(clientOf(runtime), CLIENT_ID);

        expect(client).toBeDefined();
        expect([...(client?.redirect_uris ?? ['sentinel'])]).toEqual([]);
      } finally {
        await cleanup(migrator);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('a disabled client — undefined, the read itself refuses (policy in one layer)', async () => {
      // ⚠️ Comment của hàm: lọc `status` NGAY TRONG read là đặt chính sách vào
      //     đúng một tầng. Test này chốt hợp đồng đó — caller không phải tự
      //     kiểm `isActive` vì một client disabled VẪN không bao giờ về tay họ.
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        await setClientStatus(migrator, CLIENT_ID, 'disabled');
        await seedRedirectUri(migrator, CLIENT_ID, 'https://app.example.com/cb');

        const client = await findRegisteredClient(clientOf(runtime), CLIENT_ID);

        expect(client).toBeUndefined();
      } finally {
        await cleanup(migrator);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('an unknown client id — undefined', async () => {
      const { runtime, migrator } = await setup();
      try {
        const client = await findRegisteredClient(clientOf(runtime), 'client-never-registered');
        expect(client).toBeUndefined();
      } finally {
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });
  });

  describe('findActiveGrant', () => {
    it('the active grant of a pair — aggregates scopes and returns the grant id', async () => {
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        await seedClient(migrator, CLIENT_ID_ALT);
        const sub = newSub('g1');
        const grantId = await seedGrantRow(migrator, { sub, clientId: CLIENT_ID });
        await migrator`
          INSERT INTO auth.client_grant_scopes (grant_id, scope)
          SELECT ${grantId}, scope
            FROM unnest(ARRAY['profile', 'openid']::text[]) AS scope
        `;

        const grant = await findActiveGrant(clientOf(runtime), { sub, clientId: CLIENT_ID });

        expect(grant).toBeDefined();
        expect(grant?.id).toBe(grantId);
        expect(grant?.account_id).toBe(sub);
        expect(grant?.client_id).toBe(CLIENT_ID);
        expect(grant?.isActive).toBe(true);
        // Scopes được sort bởi `ORDER BY` của query — thứ tự chèn là ngược.
        expect([...(grant?.scopes ?? [])]).toEqual(['openid', 'profile']);
        // Một grant KHÔNG lọt qua cho client khác — phạm vi cặp là hợp đồng.
        const otherClient = await findActiveGrant(clientOf(runtime), {
          sub,
          clientId: CLIENT_ID_ALT,
        });
        expect(otherClient).toBeUndefined();
      } finally {
        await cleanup(migrator);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('a revoked grant is invisible; a fresh grant for the same pair becomes the active one', async () => {
      // ⚠️ Hợp đồng đọc của bảng: `status = 'active'` nằm trong WHERE — grant
      //     đã thu hồi không bao giờ là đáp án, và cặp có quyền REPLACE lại
      //     cấp được grant mới (điều kiện để luồng "revoke rồi consent lại"
      //     của FR-022 chạy được).
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        const sub = newSub('g2');
        const firstId = await seedGrantRow(migrator, { sub, clientId: CLIENT_ID });
        await revokeGrant(runtime, firstId, 'test-revoke-then-regrant');

        expect(
          await findActiveGrant(clientOf(runtime), { sub, clientId: CLIENT_ID }),
        ).toBeUndefined();

        const secondId = await seedGrantRow(migrator, { sub, clientId: CLIENT_ID });
        const grant = await findActiveGrant(clientOf(runtime), { sub, clientId: CLIENT_ID });
        expect(grant?.id).toBe(secondId);
        expect(grant?.isActive).toBe(true);
      } finally {
        await cleanup(migrator);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });
  });

  describe('oauth_grants_active_sub_client_idx — single active grant per pair', () => {
    it('two concurrent INSERTs of an active grant for the same pair — exactly one row survives', async () => {
      // ⚠️ Test duy nhất của PR này đi thẳng vào index unique partial của 0003:
      //     tại một thời điểm mỗi cặp (sub, client) chỉ được MỘT grant active.
      //     Không assert thứ tự thắng — người thắng là kết quả của race PostgreSQL.
      //     Điều phải đúng là bất biến: đúng MỘT hàng active, và hàng thua là
      //     một unique violation (kẻ gọi xử lý như một business outcome, không
      //     phải lỗi hạ tầng).
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        const sub = newSub('race');
        await seedGrantRow(migrator, { sub, clientId: CLIENT_ID });
        // Chuẩn hoá về trạng thái "chưa có grant nào" bằng cách thu hồi grant
        // seed — index partial chỉ nhìn hàng `active`, nên cặp giờ tự do.
        const seeded = await runtime<{ id: string }[]>`
          SELECT id FROM auth.oauth_grants WHERE sub = ${sub} AND status = 'active'
        `;
        await revokeGrant(runtime, seeded[0]?.id ?? '', 'test-clear-slate');

        const attempts = await Promise.allSettled([
          seedGrantRow(migrator, { sub, clientId: CLIENT_ID }),
          seedGrantRow(migrator, { sub, clientId: CLIENT_ID }),
        ]);

        const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
        const rejected = attempts.filter((a) => a.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        const reason = (rejected[0] as PromiseRejectedResult).reason;
        expect(String(reason)).toMatch(/oauth_grants_active_sub_client_idx|duplicate key/u);

        const rows = await migrator<{ status: string }[]>`
          SELECT status FROM auth.oauth_grants WHERE sub = ${sub} ORDER BY granted_at
        `;
        expect(rows).toHaveLength(2);
        expect(rows.filter((r) => r.status === 'active')).toHaveLength(1);
        expect(rows.filter((r) => r.status === 'revoked')).toHaveLength(1);
      } finally {
        await cleanup(migrator);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });
  });

  describe('checkRevocationAtIssuance', () => {
    it('a subject-level row blocks both clients of the subject', async () => {
      // ⚠️ Mức lồng nhau §6.4: `subject` chặn MỌI client — test hai client cùng
      //     một sub là cách bắt một câu WHERE thiếu nhánh subject.
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        await seedClient(migrator, CLIENT_ID_ALT);
        const sub = newSub('rv1');
        await runtime.unsafe(
          `INSERT INTO auth.token_revocations (level, subject_ref, reason)
           VALUES ('subject', $1, 'test-subject-level')`,
          [sub],
        );

        expect(
          await checkRevocationAtIssuance(clientOf(runtime), { sub, clientId: CLIENT_ID }),
        ).toBe('revoked');
        expect(
          await checkRevocationAtIssuance(clientOf(runtime), { sub, clientId: CLIENT_ID_ALT }),
        ).toBe('revoked');
      } finally {
        await cleanup(migrator);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('a client-level row blocks exactly its own pair — another client and another sub stay clear', async () => {
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        await seedClient(migrator, CLIENT_ID_ALT);
        const sub = newSub('rv2');
        const otherSub = newSub('rv2-other');
        await runtime.unsafe(
          `INSERT INTO auth.token_revocations (level, subject_ref, client_id, reason)
           VALUES ('client', $1, $2, 'test-client-level')`,
          [sub, CLIENT_ID],
        );

        expect(
          await checkRevocationAtIssuance(clientOf(runtime), { sub, clientId: CLIENT_ID }),
        ).toBe('revoked');
        // Cặp lân cận KHÔNG bị ô nhiễm — giới hạn phạm vi là điều kiện sống còn
        // của mức lồng nhau (cùng bất biến mà internal-handlers đã ghim qua
        // handler; ở đây là hợp đồng của chính hàm đọc).
        expect(
          await checkRevocationAtIssuance(clientOf(runtime), { sub, clientId: CLIENT_ID_ALT }),
        ).toBe('not_revoked');
        expect(
          await checkRevocationAtIssuance(clientOf(runtime), {
            sub: otherSub,
            clientId: CLIENT_ID,
          }),
        ).toBe('not_revoked');
      } finally {
        await cleanup(migrator);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('a token-level row blocks only its grant — other grants of the same pair keep issuing', async () => {
      // ⚠️ Đúng comment của hàm: mức `token` theo `grant_id` chỉ chặn cấp mới
      //     cho GRANT đó; grant khác của cùng cặp không bị kéo theo.
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        const sub = newSub('rv3');
        const grantA = await seedGrantRow(migrator, { sub, clientId: CLIENT_ID });
        await revokeGrant(runtime, grantA, 'test-make-room-for-grant-b');
        const grantB = await seedGrantRow(migrator, { sub, clientId: CLIENT_ID });
        await runtime.unsafe(
          `INSERT INTO auth.token_revocations (level, subject_ref, client_id, grant_id, reason)
           VALUES ('token', $1, $2, $3, 'test-token-level')`,
          [sub, CLIENT_ID, grantB],
        );

        expect(
          await checkRevocationAtIssuance(clientOf(runtime), {
            sub,
            clientId: CLIENT_ID,
            grantId: grantB,
          }),
        ).toBe('revoked');
        expect(
          await checkRevocationAtIssuance(clientOf(runtime), {
            sub,
            clientId: CLIENT_ID,
            grantId: grantA,
          }),
        ).toBe('not_revoked');
        // Không truyền grantId — nhánh `$3::uuid IS NOT NULL` khoá mức token
        // lại hoàn toàn: kiểm subject/client vẫn chạy nhưng không dính hàng nào.
        expect(
          await checkRevocationAtIssuance(clientOf(runtime), { sub, clientId: CLIENT_ID }),
        ).toBe('not_revoked');
      } finally {
        await cleanup(migrator);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('a token row carrying only token_hash (no grant_id) never blocks issuance — the shape 0011 allows', async () => {
      // ⚠️ Hình dạng hợp lệ của 0011: hàng chỉ có `token_hash` là dữ liệu cho
      //     introspection/verify, KHÔNG vô hiệu việc cấp mới. Comment của hàm
      //     chốt điều này — để nó thành một assert chứ không phải lời hứa.
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        const sub = newSub('rv4');
        await runtime.unsafe(
          `INSERT INTO auth.token_revocations (level, subject_ref, client_id, token_hash, reason)
           VALUES ('token', $1, $2, 'hash-only-no-grant-id', 'test-token-hash-only')`,
          [sub, CLIENT_ID],
        );

        expect(
          await checkRevocationAtIssuance(clientOf(runtime), { sub, clientId: CLIENT_ID }),
        ).toBe('not_revoked');
      } finally {
        await cleanup(migrator);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });
  });

  describe('insertGrant + insertGrantScopes', () => {
    it('re-submitting the same scopes — no error, no duplicates', async () => {
      // ⚠️ `ON CONFLICT (grant_id, scope) DO NOTHING` là hợp đồng idempotency
      //     của hàm: caller decide-replay gọi lại mà không nổ, và bảng không
      //     phình theo số lần gọi.
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        const sub = newSub('gs');
        const decisionId = await seedDecisionForGrant(runtime, migrator, sub, 'gs');

        const grantId = await insertGrant(clientOf(runtime), {
          sub,
          clientId: CLIENT_ID,
          scopes: ['openid', 'profile'],
          consentDecisionId: decisionId,
          now: new Date(),
        });
        await insertGrantScopes(clientOf(runtime), { grantId, scopes: ['openid', 'profile'] });
        await insertGrantScopes(clientOf(runtime), { grantId, scopes: ['openid', 'profile'] });
        await insertGrantScopes(clientOf(runtime), { grantId, scopes: ['openid'] });

        const rows = await migrator<{ scope: string }[]>`
          SELECT scope FROM auth.client_grant_scopes
           WHERE grant_id = ${grantId} ORDER BY scope
        `;
        expect(rows.map((r) => r.scope)).toEqual(['openid', 'profile']);
      } finally {
        await cleanup(migrator);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('an empty scope list inserts nothing and still succeeds', async () => {
      // ⚠️ `unnest(ARRAY[]::text[])` tạo 0 hàng — hợp đồng "vẫn thành công"
      //     của decide deny path (scope rỗng là giá trị hợp lệ).
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        const sub = newSub('gs-empty');
        const decisionId = await seedDecisionForGrant(runtime, migrator, sub, 'gs-empty');
        const grantId = await insertGrant(clientOf(runtime), {
          sub,
          clientId: CLIENT_ID,
          scopes: [],
          consentDecisionId: decisionId,
          now: new Date(),
        });

        await expect(
          insertGrantScopes(clientOf(runtime), { grantId, scopes: [] }),
        ).resolves.toBeUndefined();

        const rows = await migrator<{ count: string }[]>`
          SELECT count(*)::text AS count FROM auth.client_grant_scopes WHERE grant_id = ${grantId}
        `;
        expect(rows[0]?.count).toBe('0');
      } finally {
        await cleanup(migrator);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });
  });

  describe('insertConsentDecision + findCommittedConsentDecision', () => {
    it('the committed decision is read back by its transaction id — earliest wins', async () => {
      // ⚠️ `ORDER BY decided_at ASC LIMIT 1` là hợp đồng đọc "quyết định nào đã
      //     thắng". Trong production CAS chặn một transaction có 2 decision —
      //     test này ghim PHÍA ĐỌC: khi có nhiều hàng, hàng sớm nhất là đáp án.
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        const txId = newTxId('dec');
        await seedTransaction(runtime, { transactionId: txId, clientId: CLIENT_ID });

        const earlier = new Date(Date.now() - 5_000);
        const later = new Date(Date.now());
        const denyId = await insertConsentDecision(clientOf(runtime), {
          sub: newSub('dec'),
          clientId: CLIENT_ID,
          redirectUri: 'https://app.example.com/cb',
          grantedScopes: [],
          decision: 'deny',
          authorizationTransactionId: txId,
          now: earlier,
        });
        await insertConsentDecision(clientOf(runtime), {
          sub: newSub('dec'),
          clientId: CLIENT_ID,
          redirectUri: 'https://app.example.com/cb',
          grantedScopes: ['openid'],
          decision: 'approve',
          authorizationTransactionId: txId,
          now: later,
        });

        expect(
          await findCommittedConsentDecision(clientOf(runtime), {
            authorizationTransactionId: txId,
          }),
        ).toBe('deny');
        expect(denyId).toBeDefined();
      } finally {
        await cleanup(migrator);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('a transaction with no decision — undefined', async () => {
      const { runtime, migrator } = await setup();
      try {
        const decision = await findCommittedConsentDecision(clientOf(runtime), {
          authorizationTransactionId: newTxId('none'),
        });
        expect(decision).toBeUndefined();
      } finally {
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });
  });

  describe('insertAuditEvent', () => {
    it('an unknown event_type is rejected by the CHECK — the allowlist is the database, not a convention', async () => {
      // ⚠️ Allowlist của 0008 là ràng buộc DB (`event_type` CHECK). Đây là lớp
      //     enforce thật: thêm một event type mới ĐÒI một migration — thêm
      //     trong code thôi là INSERT nổ ngay.
      const { runtime, migrator } = await setup();
      try {
        await expect(
          insertAuditEvent(clientOf(runtime), {
            eventType: 'event_type_that_does_not_exist',
            clientId: CLIENT_ID,
          }),
        ).rejects.toThrow(/authorization_audit_events_event_type_check/u);
      } finally {
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('optional fields round-trip as NULL and details arrives as a jsonb object', async () => {
      // ⚠️ Hợp đồng của hàm: mọi field optional → NULL khi vắng mặt, và
      //     `details` đi qua driver là jsonb LỒN ĐÔI (một chuỗi JSON chứa
      //     JSON) — hành vi đã được mid-flow-state-change.spec.ts đo và ghim
      //     ("một lần unwrap trước khi đọc reason"). Test này ghim cùng hợp
      //     đồng ở mức hàm: sau MỘT lần unwrap, payload đúng những gì caller
      //     truyền vào.
      const { runtime, migrator } = await setup();
      try {
        await insertAuditEvent(clientOf(runtime), {
          eventType: 'client_authenticated',
          clientId: CLIENT_ID,
          details: { method: 'private_key_jwt' },
        });

        const rows = await migrator<
          {
            subject_ref: string | null;
            outcome: string | null;
            details: unknown;
          }[]
        >`
          SELECT subject_ref, outcome, details
            FROM auth.authorization_audit_events
           WHERE client_id = ${CLIENT_ID} AND event_type = 'client_authenticated'
           ORDER BY occurred_at DESC LIMIT 1
        `;
        expect(rows[0]?.subject_ref).toBeNull();
        expect(rows[0]?.outcome).toBeNull();
        const unwrapped = JSON.parse(rows[0]?.details as unknown as string) as {
          method: string;
        };
        expect(unwrapped.method).toBe('private_key_jwt');
      } finally {
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });
  });
});
