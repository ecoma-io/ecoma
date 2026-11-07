import postgres from 'postgres';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AccountStatusResponseValue } from '@ecoma-io/account-contracts';
import {
  allowsIssuance,
  base64UrlToBytes,
  deriveHandle,
  hashHandle,
  HANDLE_DOMAINS,
} from '@ecoma-io/auth-domain';
import type { PostgresClientLike } from '@ecoma-io/auth-infrastructure';
import type { Provider } from 'oidc-provider';

import { runSessionVerified } from '../../src/session-verified-handler';
import { runConsentContext, runConsentDecide } from '../../src/consent-handler';
import { startAuthDatabase, type AuthDatabase } from './harness';

// `consumeHandleY` gọi TRỰC TIẾP cho test ASR-khác của issue #57 — như một
// caller tương lai có thể làm (bỏ qua kiểm app-layer), để assert rằng bind SQL
// tự nó bảo vệ phiên sở hữu transaction.
import { consumeHandleY, createAuthorizationStore } from '@ecoma-io/auth-infrastructure';

/**
 * Hai back-channel handlers trên PostgreSQL THẬT: `session/verified` (CAS consume X
 * + bind) và `consent/decide` (advance → consume Y — MỘT transaction).
 *
 * ⚠️ Vì sao phải PostgreSQL thật: toàn bộ tính đúng đắn của hai handler này nằm ở
 * thứ tự CAS trong tx và ở các CHECK của schema (`handle_y_state_check` buộc
 * `awaiting_consent` phải có Y chưa consume). Một stub DB là schema thứ hai, và
 * thứ tự advance/consume SAI sẽ xanh trên stub nhưng vỡ ngay trên schema thật
 * (CHECK violation). Đúng bài học của `authorization-transaction-store.spec.ts`.
 *
 * ⚠️ Docker là phụ thuộc cứng (fail-loud qua docker-probe của config integration
 * — không skip với exit 0).
 *
 * Provider là STUB HÌNH DẠNG: các handler chỉ dùng `provider.Interaction` qua
 * `attachInteractionResult`, mà hàm đó trả `undefined` khi correlator không tra
 * được — với stub, `decidedResponse` đi đúng nhánh fail-closed
 * (`interaction khong tim thay`). Đường Interaction thật (payload correlate qua
 * `ecoma_x`) cần một provider thật — được ghi rõ trong report là chưa verify
 * end-to-end trong môi trường Node.
 */

/** Container riêng của file này, dựng một lần trong `beforeAll`. */
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

function connectRuntime(max = 10): postgres.Sql {
  return postgres({
    ...base(),
    user: db.runtimeUser,
    password: db.runtimePassword,
    max,
  });
}

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

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

/** Khoá HMAC cho handle — giá trị tùy ý 32 byte base64url. */
const HANDLE_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const CLIENT_ID = 'client-handlers-pg-test';

function newTxId(prefix: string): string {
  // transaction_id là TEXT — prefix làm cho mỗi test tự phân biệt trong log.
  // Giữ nguyên marker `-for-handlers-spec-` trong id: cleanup dọn theo marker này,
  // slice(0, 43) cũ cắt mất `-spec-` khiến hàng test sót lại va unique index.
  return `${prefix}-fixed-transaction-identifier-for-handlers-spec-0000000`;
}

async function seedClient(migrator: postgres.Sql, clientId: string): Promise<void> {
  await migrator`
    INSERT INTO auth.oauth_clients (client_id, client_name, client_type)
    VALUES (${clientId}, 'handlers pg test client', 'public')
    ON CONFLICT (client_id) DO NOTHING
  `;
}

async function seedGrant(
  migrator: postgres.Sql,
  params: { sub: string; clientId: string; scopes: string[] },
): Promise<string> {
  // Re-seed an toàn: (sub, client_id) trùng nhau giữa các test trong một run là
  // có chủ ý (một sub dùng chung) — partial unique index chỉ chặn HAI grant
  // active cùng lúc, nên upsert theo cặp đó thay vì INSERT thô.
  const rows = await migrator<{ id: string }[]>`
    INSERT INTO auth.oauth_grants (sub, client_id, status, granted_at)
    VALUES (${params.sub}, ${params.clientId}, 'active', now())
    ON CONFLICT (sub, client_id) WHERE status = 'active'
    DO UPDATE SET granted_at = now()
    RETURNING id
  `;
  const grantId = rows[0]?.id;
  if (grantId === undefined) {
    throw new Error('seedGrant khong tra ve id');
  }
  await migrator`
    INSERT INTO auth.client_grant_scopes (grant_id, scope)
    SELECT ${grantId}, scope FROM unnest(${params.scopes}::text[]) AS scope
    ON CONFLICT DO NOTHING
  `;
  return grantId;
}

async function seedTransaction(
  runtime: postgres.Sql,
  params: {
    transactionId: string;
    handleHashX: string;
    browserBindingHash: string;
    state?: 'pending_browser' | 'browser_confirmed' | 'awaiting_consent';
    handleHashY?: string;
    /** Bản rự handle X — khi có, seed kèm hàng Interaction của oidc_state
     *  (correlator `ecoma_x`) để `attachInteractionResult` tìm thấy. */
    rawHandleX?: string;
    /** Identity đã bind (sub/acr/authn_at/account_session_ref). Mặc định NULL —
     *  đúng mô hình "chờ xác minh"; các test consent/decide seed hàng ĐÃ bind
     *  (sau khi session/verified thắng và advance sang awaiting_consent). */
    bound?: boolean;
  },
): Promise<void> {
  const state = params.state ?? 'browser_confirmed';
  await runtime.unsafe(
    `INSERT INTO auth.authorization_transactions (
        transaction_id, handle_hash_x, client_id, redirect_uri,
        requested_scopes, code_challenge, code_challenge_method,
        browser_binding_hash, key_version, expires_at, sub, acr, authn_at,
        account_session_ref, state, handle_hash_y
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $11, $12, $13, $14, $15)`,
    [
      params.transactionId,
      // Cột `bytea`: seed bằng hashHandle base64url string sẽ lưu chuỗi text sai
      // và findTransactionByHandleX (so sánh qua base64UrlToBytea) không bao giờ
      // khớp — encode đúng như store làm.
      base64UrlToBytes(params.handleHashX),
      CLIENT_ID,
      'https://app.example.com/cb',
      ['openid'],
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      'S256',
      base64UrlToBytes(params.browserBindingHash),
      new Date(Date.now() + 600_000),
      // §5.1: sub/acr/authn_at/account_session_ref CHỈ được bind khi CAS
      // consumeHandleXAndBindIdentity thắng — seed NULL trừ khi test yêu cầu
      // hàng đã bind (consent/decide hoạt động trên transaction đã qua
      // session/verified). NULL còn làm assert "CAS thua ⇒ không bind" có ý nghĩa.
      params.bound === true ? 'sub-handlers-test-000000000000000000000000000' : null,
      params.bound === true ? 'urn:ecoma:acr:email-otp' : null,
      params.bound === true ? new Date(Date.now() - 30_000) : null,
      params.bound === true ? 'asr-handlers-test' : null,
      state,
      params.handleHashY === undefined ? null : base64UrlToBytes(params.handleHashY),
    ],
  );
  if (params.rawHandleX !== undefined) {
    await seedInteraction(runtime, {
      id: `it-${params.transactionId}`,
      ecomaX: params.rawHandleX,
    });
  }
}

/** Mọi hàng test bị xoá theo tx id — consent decisions/grants treo bằng FK được cascade. */
async function cleanup(migrator: postgres.Sql, _transactionIds: string[]): Promise<void> {
  // DB dùng chung giữa các test trong một run: TẤT CẢ các hàng test đều mang
  // dấu 'sub-handlers-test%' hoặc transaction_id '...-for-handlers-spec-...' —
  // xoá toàn bộ theo dấu đó (con trước cha) để test sau không va unique index
  // `handle_x_uniq` với hàng test trước. Việc gọi `cleanup(migrator, [])` vẫn
  // dọn sạch là chủ ý: mỗi test tự dọn phần của mình bất kể danh sách id.
  await migrator.unsafe(
    `DELETE FROM auth.token_revocations
      WHERE subject_ref LIKE 'sub-handlers-test%'
         OR subject_ref LIKE 'sub-handlers-revoc-%'`,
  );
  await migrator.unsafe(
    `DELETE FROM auth.client_grant_scopes
      WHERE grant_id IN (SELECT id FROM auth.oauth_grants
                          WHERE sub LIKE 'sub-handlers-test%'
                             OR sub LIKE 'sub-handlers-revoc-%')`,
  );
  await migrator.unsafe(
    `DELETE FROM auth.oauth_grants
       WHERE sub LIKE 'sub-handlers-test%' OR sub LIKE 'sub-handlers-revoc-%'`,
  );
  await migrator.unsafe(
    `DELETE FROM auth.oauth_consent_decisions
      WHERE authorization_transaction_id LIKE '%-for-handlers-spec-%'`,
  );
  await migrator.unsafe(
    `DELETE FROM auth.authorization_codes
      WHERE authorization_transaction_id LIKE '%-for-handlers-spec-%'`,
  );
  await migrator.unsafe(
    `DELETE FROM auth.oidc_state
      WHERE id LIKE 'it-%-for-handlers-spec-%'`,
  );
  await migrator.unsafe(
    `DELETE FROM auth.authorization_transactions
      WHERE transaction_id LIKE '%-for-handlers-spec-%'`,
  );
}

/**
 * Stub provider — `Interaction.find` đi đúng đường "không thấy", còn `Grant`
 * là fake đủ mặt cho `createProviderGrant`/`saveProviderGrant`: constructor
 * nhận `{jti}`, mutable accountId/clientId, addOIDCScope/addOIDCClaims no-op,
 * `save()` trả chính jti (không persist — các assertion của spec đọc DB ECOMA,
 * không đọc provider state).
 */
/** Tập id Interaction mà seedInteraction đã "chèn vào DB" — FakeInteraction.find đọc. */
const seededInteractionIds = new Set<string>();

function stubProvider(): Provider {
  const persisted = new Map<string, { result?: unknown }>();
  class FakeInteraction {
    returnTo = 'https://rp.example.com/cb';
    result: unknown;
    constructor(public readonly id: string) {}
    async persist(): Promise<void> {
      persisted.set(this.id, { result: this.result });
    }
    // find NẠP lại model từ "DB": sau persist thì có result, trước persist là
    // interaction sống mà chưa có result (đúng ngữ nghĩa attach cần).
    static async find(id: string) {
      const saved = persisted.get(id);
      if (saved === undefined && !seededInteractionIds.has(id)) {
        return undefined;
      }
      const inst = new FakeInteraction(id);
      if (saved !== undefined) {
        inst.result = saved.result;
      }
      return inst;
    }
  }

  class FakeGrant {
    jti: string;
    accountId = '';
    clientId = '';
    constructor(init?: { jti?: string }) {
      this.jti = init?.jti ?? 'fake-grant-jti';
    }
    addOIDCScope(_scope: string): void {
      // Stub: flow nội bộ không đi qua grant thật của provider.
    }
    addOIDCClaims(_claims: string[]): void {
      // Stub: như trên.
    }
    async save(_ttl: number): Promise<string> {
      return this.jti;
    }
  }
  return {
    Interaction: FakeInteraction,
    Grant: FakeGrant,
  } as unknown as Provider;
}

/**
 * Seed một hàng `auth.oidc_state` kind='Interaction' với correlator `ecoma_x` —
 * index biểu thức của 0013 tra đúng payload này; `provider.Interaction.find(id)`
 * của FakeInteraction trả object có `returnTo`/`persist`.
 */
async function seedInteraction(
  runtime: postgres.Sql,
  params: { id: string; ecomaX: string },
): Promise<void> {
  seededInteractionIds.add(params.id);
  await runtime`
    INSERT INTO auth.oidc_state (kind, id, payload, expires_at)
    VALUES ('Interaction', ${params.id},
            ${runtime.json({ params: { ecoma_x: params.ecomaX } })},
            now() + interval '10 minutes')
    ON CONFLICT (kind, id) DO UPDATE SET payload = EXCLUDED.payload
  `;
}

/** AccountClient stub: luôn trả `active`. */
function allowStatus(): (accountId: string) => Promise<AccountStatusResponseValue> {
  return async () => {
    // `allowsIssuance('active')` === true — giá trị này thuộc allowlist contract.
    return allowsIssuance('active') ? 'active' : 'suspended';
  };
}

function denyStatus(): (accountId: string) => Promise<AccountStatusResponseValue> {
  return async () => 'suspended';
}

/* ------------------------------------------------------------------ */
/* Suite                                                               */
/* ------------------------------------------------------------------ */

afterAll(async () => {
  // Vitest quản lifecycle connection trong từng test — không có shared handle nào.
});

describe('back-channel handlers — against a real PostgreSQL', () => {
  // Container riêng của file này: schema được dựng một lần lúc container lên
  // (bên trong `startAuthDatabase`, bằng credential migrator thật), các test
  // tự mở cặp client qua `setup()` và tự đóng trong `finally`.
  beforeAll(async () => {
    db = await startAuthDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  describe('POST /internal/session/verified', () => {
    it('CAS loses: pending_browser cannot be consumed — §5.1.0 condition 2 enforced by the DB', async () => {
      // ⚠️ `consumeHandleXAndBindIdentity` có `state = 'browser_confirmed'` trong
      // WHERE. Transaction đang `pending_browser` ⇒ CAS thua ⇒ handler phải trả
      // `invalid_request` (điều kiện 2), KHÔNG bind danh tính.
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        const txId = newTxId('pv');
        const handleX = await deriveHandle({
          key: HANDLE_KEY,
          transactionId: txId,
          domain: HANDLE_DOMAINS.loginHandoff,
        });
        const handleHashX = await hashHandle(handleX);
        await seedTransaction(runtime, {
          transactionId: txId,
          handleHashX,
          rawHandleX: handleX,
          browserBindingHash: 'AAIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw4',
          state: 'pending_browser',
        });

        const rawBody = new TextEncoder().encode(
          JSON.stringify({
            handle: handleX,
            sub: 'sub-handlers-test-000000000000000000000000000',
            acr: 'urn:ecoma:acr:email-otp',
            authn_at: Math.floor(Date.now() / 1000) - 10,
            account_session_ref: 'asr-handlers-test',
            event_id: 'evt-1',
          }),
        );

        const result = await runSessionVerified({
          provider: stubProvider(),
          postgresClient: runtime as unknown as PostgresClientLike,
          store: createAuthorizationStore({ client: runtime as unknown as PostgresClientLike }),
          handleKey: HANDLE_KEY,
          accountBaseUrl: 'https://account.ecoma.io',
          now: new Date(),
          checkStatus: allowStatus(),
          rawBody,
        });

        expect(result.status).toBe(422);
        expect(result.body).toMatchObject({ error: 'invalid_request' });
        // VÀ transaction chưa bị bind — mọi cột identity phải còn NULL.
        const rows = await migrator<{ sub: string | null; state: string }[]>`
          SELECT sub, state FROM auth.authorization_transactions
           WHERE transaction_id = ${txId}
        `;
        expect(rows[0]?.sub).toBeNull();
        expect(rows[0]?.state).toBe('pending_browser');
      } finally {
        await cleanup(migrator, []);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('CAS wins + browser_confirmed + granted scope + active account: granted — continue_url is the resume URL, Z is CAS-advanced', async () => {
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        await seedGrant(migrator, {
          sub: 'sub-handlers-test-000000000000000000000000000',
          clientId: CLIENT_ID,
          scopes: ['openid'],
        });
        const txId = newTxId('pg');
        const handleX = await deriveHandle({
          key: HANDLE_KEY,
          transactionId: txId,
          domain: HANDLE_DOMAINS.loginHandoff,
        });
        const handleHashX = await hashHandle(handleX);
        await seedTransaction(runtime, {
          transactionId: txId,
          handleHashX,
          rawHandleX: handleX,
          browserBindingHash: 'AAIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw4',
          state: 'browser_confirmed',
        });

        const rawBody = new TextEncoder().encode(
          JSON.stringify({
            handle: handleX,
            sub: 'sub-handlers-test-000000000000000000000000000',
            acr: 'urn:ecoma:acr:email-otp',
            authn_at: Math.floor(Date.now() / 1000) - 10,
            account_session_ref: 'asr-handlers-test',
            event_id: 'evt-granted-1',
          }),
        );

        const result = await runSessionVerified({
          provider: stubProvider(),
          postgresClient: runtime as unknown as PostgresClientLike,
          store: createAuthorizationStore({ client: runtime as unknown as PostgresClientLike }),
          handleKey: HANDLE_KEY,
          accountBaseUrl: 'https://account.ecoma.io',
          now: new Date(),
          checkStatus: allowStatus(),
          rawBody,
        });

        expect(result.status).toBe(200);
        const body = result.body as { outcome: string; continue_url?: string };
        expect(body.outcome).toBe('granted');
        // continue_url là resume URL của provider (interaction.returnTo của
        // FakeInteraction) — không rỗng, không fake khác.
        expect(body.continue_url).toBe('https://rp.example.com/cb');

        // Nhánh CAS: advance đã chạy trước attach — state là `ready_to_complete`
        // kèm event của lần advance:
        const rows = await migrator<{ state: string; event_id: string | null }[]>`
          SELECT state, event_id FROM auth.authorization_transactions
           WHERE transaction_id = ${txId}
        `;
        expect(rows[0]?.state).toBe('ready_to_complete');
        expect(rows[0]?.event_id).toBe('evt-granted-1');
      } finally {
        await cleanup(migrator, []);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('account suspended — 422 access_denied, the transaction WAS consumed (no rollback)', async () => {
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        const txId = newTxId('ps');
        const handleX = await deriveHandle({
          key: HANDLE_KEY,
          transactionId: txId,
          domain: HANDLE_DOMAINS.loginHandoff,
        });
        const handleHashX = await hashHandle(handleX);
        await seedTransaction(runtime, {
          transactionId: txId,
          handleHashX,
          rawHandleX: handleX,
          browserBindingHash: 'AAIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw4',
          state: 'browser_confirmed',
        });

        const rawBody = new TextEncoder().encode(
          JSON.stringify({
            handle: handleX,
            sub: 'sub-handlers-test-000000000000000000000000000',
            acr: 'urn:ecoma:acr:email-otp',
            authn_at: Math.floor(Date.now() / 1000) - 10,
            account_session_ref: 'asr-handlers-test',
            event_id: 'evt-susp-1',
          }),
        );

        const result = await runSessionVerified({
          provider: stubProvider(),
          postgresClient: runtime as unknown as PostgresClientLike,
          store: createAuthorizationStore({ client: runtime as unknown as PostgresClientLike }),
          handleKey: HANDLE_KEY,
          accountBaseUrl: 'https://account.ecoma.io',
          now: new Date(),
          checkStatus: denyStatus(),
          rawBody,
        });

        expect(result.status).toBe(422);
        expect(result.body).toMatchObject({ error: 'access_denied' });
        // X đã consume (CAS chạy trước checkStatus — đúng thứ tự §5.1.0: bind
        // là một sự kiện, fail-closed check sau đó không hoàn tác handle).
        const rows = await migrator<{ state: string; sub: string | null }[]>`
          SELECT state, sub FROM auth.authorization_transactions
           WHERE transaction_id = ${txId}
        `;
        expect(rows[0]?.state).toBe('browser_confirmed');
        expect(rows[0]?.sub).toBe('sub-handlers-test-000000000000000000000000000');
        const consumedRows = await migrator<{ consumed: string | null }[]>`
          SELECT handle_x_consumed_at::text AS consumed FROM auth.authorization_transactions
           WHERE transaction_id = ${txId}
        `;
        expect(consumedRows[0]?.consumed).not.toBeNull();
      } finally {
        await cleanup(migrator, []);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('subject-level revocation denies issuance even with active account (condition 4a)', async () => {
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        // Sub RIÊNG của test này: token_revocations append-only, một revocation
        // chèn ở đây sống sót qua cleanup và sẽ chặn mọi test sau dùng chung sub.
        await seedGrant(migrator, {
          sub: 'sub-handlers-revoc-subject-0000000000000000000000',
          clientId: CLIENT_ID,
          scopes: ['openid'],
        });
        const txId = newTxId('rv');
        const handleX = await deriveHandle({
          key: HANDLE_KEY,
          transactionId: txId,
          domain: HANDLE_DOMAINS.loginHandoff,
        });
        const handleHashX = await hashHandle(handleX);
        await seedTransaction(runtime, {
          transactionId: txId,
          handleHashX,
          rawHandleX: handleX,
          browserBindingHash: 'AAIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw4',
          state: 'browser_confirmed',
        });
        // Thu hồi mức subject cho chính sub push về — một hàng append-only.
        await runtime.unsafe(
          `INSERT INTO auth.token_revocations (level, subject_ref, reason)
           VALUES ('subject', $1, 'test-subject-revocation')`,
          ['sub-handlers-revoc-subject-0000000000000000000000'],
        );

        const rawBody = new TextEncoder().encode(
          JSON.stringify({
            handle: handleX,
            sub: 'sub-handlers-revoc-subject-0000000000000000000000',
            acr: 'urn:ecoma:acr:email-otp',
            authn_at: Math.floor(Date.now() / 1000) - 10,
            account_session_ref: 'asr-handlers-test',
            event_id: 'evt-revoc-subj-1',
          }),
        );

        const result = await runSessionVerified({
          provider: stubProvider(),
          postgresClient: runtime as unknown as PostgresClientLike,
          store: createAuthorizationStore({ client: runtime as unknown as PostgresClientLike }),
          handleKey: HANDLE_KEY,
          accountBaseUrl: 'https://account.ecoma.io',
          now: new Date(),
          checkStatus: allowStatus(),
          rawBody,
        });

        expect(result.status).toBe(422);
        expect(result.body).toMatchObject({ error: 'access_denied' });
        // Không có grant mới, không có transaction advance — từ chối trước khi
        // chạm state machine consent/grant.
        const rows = await migrator<{ state: string }[]>`
          SELECT state FROM auth.authorization_transactions WHERE transaction_id = ${txId}
        `;
        expect(rows[0]?.state).toBe('browser_confirmed');
      } finally {
        await cleanup(migrator, []);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('client-level revocation for another (sub, client) pair does not block issuance — scoping is bounded', async () => {
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        // Cùng lý do sub riêng: tránh ô nhiễm chéo qua token_revocations.
        await seedGrant(migrator, {
          sub: 'sub-handlers-revoc-client-00000000000000000000000',
          clientId: CLIENT_ID,
          scopes: ['openid'],
        });
        // Thu hồi mức client nhưng cho một sub KHÁC — push của sub này không
        // được bị chặn (giới hạn phạm vi là điều kiện sống còn của mức lồng nhau §6.4).
        await runtime.unsafe(
          `INSERT INTO auth.token_revocations (level, subject_ref, client_id, reason)
           VALUES ('client', 'sub-handlers-revoc-client-other-0000000000000000', $1, 'test')`,
          [CLIENT_ID],
        );
        const txId = newTxId('rc');
        const handleX = await deriveHandle({
          key: HANDLE_KEY,
          transactionId: txId,
          domain: HANDLE_DOMAINS.loginHandoff,
        });
        const handleHashX = await hashHandle(handleX);
        await seedTransaction(runtime, {
          transactionId: txId,
          handleHashX,
          rawHandleX: handleX,
          browserBindingHash: 'AAIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw4',
          state: 'browser_confirmed',
        });

        const rawBody = new TextEncoder().encode(
          JSON.stringify({
            handle: handleX,
            sub: 'sub-handlers-revoc-client-00000000000000000000000',
            acr: 'urn:ecoma:acr:email-otp',
            authn_at: Math.floor(Date.now() / 1000) - 10,
            account_session_ref: 'asr-handlers-test',
            event_id: 'evt-revoc-client-1',
          }),
        );

        const result = await runSessionVerified({
          provider: stubProvider(),
          postgresClient: runtime as unknown as PostgresClientLike,
          store: createAuthorizationStore({ client: runtime as unknown as PostgresClientLike }),
          handleKey: HANDLE_KEY,
          accountBaseUrl: 'https://account.ecoma.io',
          now: new Date(),
          checkStatus: allowStatus(),
          rawBody,
        });

        expect(result.status).toBe(200);
        const body = result.body as { outcome: string };
        expect(body.outcome).toBe('granted');
      } finally {
        await cleanup(migrator, []);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('idempotency (a): replay with the same event_id and same payload — consent_required is returned again, continues', async () => {
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        const txId = newTxId('pi');
        const handleX = await deriveHandle({
          key: HANDLE_KEY,
          transactionId: txId,
          domain: HANDLE_DOMAINS.loginHandoff,
        });
        const handleHashX = await hashHandle(handleX);
        await seedTransaction(runtime, {
          transactionId: txId,
          handleHashX,
          rawHandleX: handleX,
          browserBindingHash: 'AAIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw4',
          state: 'browser_confirmed',
        });

        const payload = {
          handle: handleX,
          sub: 'sub-handlers-test-000000000000000000000000000',
          acr: 'urn:ecoma:acr:email-otp',
          authn_at: Math.floor(Date.now() / 1000) - 10,
          account_session_ref: 'asr-handlers-test',
          event_id: 'evt-replay-1',
        };
        const rawBody = new TextEncoder().encode(JSON.stringify(payload));

        // Lần 1: grant KHÔNG tồn tại ⇒ needsConsent ⇒ CAS sang awaiting_consent.
        const first = await runSessionVerified({
          provider: stubProvider(),
          postgresClient: runtime as unknown as PostgresClientLike,
          store: createAuthorizationStore({ client: runtime as unknown as PostgresClientLike }),
          handleKey: HANDLE_KEY,
          accountBaseUrl: 'https://account.ecoma.io',
          now: new Date(),
          checkStatus: allowStatus(),
          rawBody,
        });
        expect(first.status).toBe(200);
        const firstBody = first.body as { outcome: string; continue_url: string };
        expect(firstBody.outcome).toBe('consent_required');

        // Lần 2: CÙNG bytes — CAS thua (X đã consumed), replay phải trả cùng Y.
        const second = await runSessionVerified({
          provider: stubProvider(),
          postgresClient: runtime as unknown as PostgresClientLike,
          store: createAuthorizationStore({ client: runtime as unknown as PostgresClientLike }),
          handleKey: HANDLE_KEY,
          accountBaseUrl: 'https://account.ecoma.io',
          now: new Date(),
          checkStatus: allowStatus(),
          rawBody,
        });
        expect(second.status).toBe(200);
        const secondBody = second.body as { outcome: string; continue_url: string };
        expect(secondBody.outcome).toBe('consent_required');
        expect(secondBody.continue_url).toBe(firstBody.continue_url);
        // continue_url mang handle Y trên consent UI của account — không phải
        // trên issuer của auth.
        expect(firstBody.continue_url.startsWith('https://account.ecoma.io/consent')).toBe(true);

        // State đã sang awaiting_consent kèm Y.
        const rows = await migrator<{ state: string }[]>`
          SELECT state FROM auth.authorization_transactions WHERE transaction_id = ${txId}
        `;
        expect(rows[0]?.state).toBe('awaiting_consent');
      } finally {
        await cleanup(migrator, []);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('idempotency (a) line 3: same event_id, different payload — invalid_request, NOT overwritten', async () => {
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        await seedGrant(migrator, {
          sub: 'sub-handlers-test-000000000000000000000000000',
          clientId: CLIENT_ID,
          scopes: ['openid'],
        });
        const txId = newTxId('pd');
        const handleX = await deriveHandle({
          key: HANDLE_KEY,
          transactionId: txId,
          domain: HANDLE_DOMAINS.loginHandoff,
        });
        const handleHashX = await hashHandle(handleX);
        await seedTransaction(runtime, {
          transactionId: txId,
          handleHashX,
          rawHandleX: handleX,
          browserBindingHash: 'AAIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw4',
          state: 'browser_confirmed',
        });

        const request = {
          handle: handleX,
          sub: 'sub-handlers-test-000000000000000000000000000',
          acr: 'urn:ecoma:acr:email-otp',
          authn_at: Math.floor(Date.now() / 1000) - 10,
          account_session_ref: 'asr-handlers-test',
          event_id: 'evt-dup-1',
        };

        const first = await runSessionVerified({
          provider: stubProvider(),
          postgresClient: runtime as unknown as PostgresClientLike,
          store: createAuthorizationStore({ client: runtime as unknown as PostgresClientLike }),
          handleKey: HANDLE_KEY,
          accountBaseUrl: 'https://account.ecoma.io',
          now: new Date(),
          checkStatus: allowStatus(),
          rawBody: new TextEncoder().encode(JSON.stringify(request)),
        });
        expect(first.status).toBe(200);

        // Cùng event_id, khác acr — payload khác (và bind khác).
        const second = await runSessionVerified({
          provider: stubProvider(),
          postgresClient: runtime as unknown as PostgresClientLike,
          store: createAuthorizationStore({ client: runtime as unknown as PostgresClientLike }),
          handleKey: HANDLE_KEY,
          accountBaseUrl: 'https://account.ecoma.io',
          now: new Date(),
          checkStatus: allowStatus(),
          rawBody: new TextEncoder().encode(
            JSON.stringify({ ...request, acr: 'urn:ecoma:acr:mfa' }),
          ),
        });
        expect(second.status).toBe(422);
        expect(second.body).toMatchObject({ error: 'invalid_request' });
      } finally {
        await cleanup(migrator, []);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('handle does not exist — 404 invalid_grant, no oracle', async () => {
      const { runtime, migrator } = await setup();
      try {
        const handleX = await deriveHandle({
          key: HANDLE_KEY,
          transactionId: newTxId('nope'),
          domain: HANDLE_DOMAINS.loginHandoff,
        });
        const result = await runSessionVerified({
          provider: stubProvider(),
          postgresClient: runtime as unknown as PostgresClientLike,
          store: createAuthorizationStore({ client: runtime as unknown as PostgresClientLike }),
          handleKey: HANDLE_KEY,
          accountBaseUrl: 'https://account.ecoma.io',
          now: new Date(),
          checkStatus: allowStatus(),
          rawBody: new TextEncoder().encode(
            JSON.stringify({
              handle: handleX,
              sub: 'sub-handlers-test-000000000000000000000000000',
              acr: 'urn:ecoma:acr:email-otp',
              authn_at: Math.floor(Date.now() / 1000) - 10,
              account_session_ref: 'asr-x',
              event_id: 'evt-none',
            }),
          ),
        });
        // CAS thua vì không có hàng — findTransactionByHandleX undefined ⇒ 404.
        expect(result.status).toBe(404);
        expect(result.body).toMatchObject({ error: 'invalid_grant' });
      } finally {
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });
  });

  describe('POST /internal/consent/*', () => {
    it('context: returns client_name/scope/risk_level, NO side effect', async () => {
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        const txId = newTxId('cx');
        const handleY = await deriveHandle({
          key: HANDLE_KEY,
          transactionId: txId,
          domain: HANDLE_DOMAINS.consentContinuation,
        });
        const handleHashY = await hashHandle(handleY);
        await seedTransaction(runtime, {
          transactionId: txId,
          handleHashX: 'ZZkVq2oFfTAgy1WcdbeNkanIsw6CwJh0jAcs8CtGYWw',
          browserBindingHash: 'AAIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw4',
          state: 'awaiting_consent',
          bound: true,
          handleHashY,
        });

        const result = await runConsentContext({
          postgresClient: runtime as unknown as PostgresClientLike,
          payload: { handle: handleY, account_session_ref: 'asr-handlers-test' },
          now: new Date(),
        });

        expect(result.status).toBe(200);
        const body = result.body as {
          client_name: string;
          scope: string[];
          risk_level: string;
        };
        expect(body.client_name).toBe(CLIENT_ID);
        expect([...body.scope]).toEqual(['openid']);
        expect(['low', 'elevated', 'high']).toContain(body.risk_level);

        // KHÔNG side effect: state phải còn nguyên.
        const rows = await migrator<{ state: string; event_id: string | null }[]>`
          SELECT state, event_id FROM auth.authorization_transactions
           WHERE transaction_id = ${txId}
        `;
        expect(rows[0]?.state).toBe('awaiting_consent');
        expect(rows[0]?.event_id).toBeNull();
      } finally {
        await cleanup(migrator, []);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('context: a different ASR — 422, leaks no transaction information', async () => {
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        const txId = newTxId('cy');
        const handleY = await deriveHandle({
          key: HANDLE_KEY,
          transactionId: txId,
          domain: HANDLE_DOMAINS.consentContinuation,
        });
        await seedTransaction(runtime, {
          transactionId: txId,
          handleHashX: 'ZZkVq2oFfTAgy1WcdbeNkanIsw6CwJh0jAcs8CtGYWw',
          browserBindingHash: 'AAIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw4',
          state: 'awaiting_consent',
          bound: true,
          handleHashY: await hashHandle(handleY),
        });

        const result = await runConsentContext({
          postgresClient: runtime as unknown as PostgresClientLike,
          payload: { handle: handleY, account_session_ref: 'asr-NGUOI-KHAC' },
          now: new Date(),
        });
        expect(result.status).toBe(422);
        expect(result.body).toMatchObject({ error: 'invalid_request' });
      } finally {
        await cleanup(migrator, []);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('decide deny: advance BEFORE consume in the same tx — CHECK not violated, Y + decision is ONE event', async () => {
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        const txId = newTxId('cd');
        const handleY = await deriveHandle({
          key: HANDLE_KEY,
          transactionId: txId,
          domain: HANDLE_DOMAINS.consentContinuation,
        });
        const handleHashY = await hashHandle(handleY);
        await seedTransaction(runtime, {
          transactionId: txId,
          handleHashX: 'ZZkVq2oFfTAgy1WcdbeNkanIsw6CwJh0jAcs8CtGYWw',
          browserBindingHash: 'AAIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw4',
          state: 'awaiting_consent',
          bound: true,
          handleHashY,
        });

        const result = await runConsentDecide({
          provider: stubProvider(),
          postgresClient: runtime as unknown as PostgresClientLike,
          payload: {
            handle: handleY,
            decision: 'deny',
            account_session_ref: 'asr-handlers-test',
          },
          handleKey: HANDLE_KEY,
          now: new Date(),
        });

        // Interaction stub không tìm thấy ⇒ nhánh fail-closed 422 sau khi tx đã
        // COMMIT — quyết định vẫn phải được ghi.
        expect(result.status).toBe(422);

        const rows = await migrator<
          {
            state: string;
            event_id: string | null;
            consumed: string | null;
            handle_z: string | null;
          }[]
        >`
          SELECT state, event_id, handle_y_consumed_at::text AS consumed,
                 handle_hash_z::text AS handle_z
            FROM auth.authorization_transactions WHERE transaction_id = ${txId}
        `;
        expect(rows[0]?.state).toBe('denied');
        // Khối event_* là idempotency của PUSH (§5.1.5a) — decide KHÔNG đụng;
        // quyết định nằm trong oauth_consent_decisions (được assert dưới).
        expect(rows[0]?.event_id).toBeNull();
        expect(rows[0]?.consumed).not.toBeNull();
        // Z được ghi cùng lúc (advance) — dù không dùng trong đường này.
        expect(rows[0]?.handle_z).not.toBeNull();

        const decisions = await migrator<{ decision: string }[]>`
          SELECT decision FROM auth.oauth_consent_decisions
           WHERE authorization_transaction_id = ${txId}
        `;
        expect(decisions).toHaveLength(1);
        expect(decisions[0]?.decision).toBe('deny');
      } finally {
        await cleanup(migrator, []);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('decide approve: grant + scopes + decision is ONE event in the tx', async () => {
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        const txId = newTxId('ca');
        const handleY = await deriveHandle({
          key: HANDLE_KEY,
          transactionId: txId,
          domain: HANDLE_DOMAINS.consentContinuation,
        });
        await seedTransaction(runtime, {
          transactionId: txId,
          handleHashX: 'ZZkVq2oFfTAgy1WcdbeNkanIsw6CwJh0jAcs8CtGYWw',
          browserBindingHash: 'AAIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw4',
          state: 'awaiting_consent',
          bound: true,
          handleHashY: await hashHandle(handleY),
        });

        const result = await runConsentDecide({
          provider: stubProvider(),
          postgresClient: runtime as unknown as PostgresClientLike,
          payload: {
            handle: handleY,
            decision: 'approve',
            account_session_ref: 'asr-handlers-test',
          },
          handleKey: HANDLE_KEY,
          now: new Date(),
        });
        // Interaction stub ⇒ fail-closed sau commit.
        expect(result.status).toBe(422);

        const rows = await migrator<{ state: string }[]>`
          SELECT state FROM auth.authorization_transactions WHERE transaction_id = ${txId}
        `;
        expect(rows[0]?.state).toBe('ready_to_complete');

        const grants = await migrator<{ status: string }[]>`
          SELECT status FROM auth.oauth_grants WHERE sub LIKE 'sub-handlers-test%'
        `;
        expect(grants).toHaveLength(1);
        expect(grants[0]?.status).toBe('active');

        const scopeRows = await migrator<{ scope: string }[]>`
          SELECT s.scope FROM auth.client_grant_scopes s
           JOIN auth.oauth_grants g ON g.id = s.grant_id
          WHERE g.sub LIKE 'sub-handlers-test%'
        `;
        expect(scopeRows.map((row) => row.scope)).toEqual(['openid']);
      } finally {
        await cleanup(migrator, []);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('decide replay with the same decision — SAME outcome, no second grant, no second decision', async () => {
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        const txId = newTxId('cr');
        const handleY = await deriveHandle({
          key: HANDLE_KEY,
          transactionId: txId,
          domain: HANDLE_DOMAINS.consentContinuation,
        });
        await seedTransaction(runtime, {
          transactionId: txId,
          handleHashX: 'ZZkVq2oFfTAgy1WcdbeNkanIsw6CwJh0jAcs8CtGYWw',
          browserBindingHash: 'AAIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw4',
          state: 'awaiting_consent',
          bound: true,
          handleHashY: await hashHandle(handleY),
        });

        const payload = {
          handle: handleY,
          decision: 'approve',
          account_session_ref: 'asr-handlers-test',
        };
        const first = await runConsentDecide({
          provider: stubProvider(),
          postgresClient: runtime as unknown as PostgresClientLike,
          payload,
          handleKey: HANDLE_KEY,
          now: new Date(),
        });
        expect(first.status).toBe(422); // fail-closed interaction stub

        const second = await runConsentDecide({
          provider: stubProvider(),
          postgresClient: runtime as unknown as PostgresClientLike,
          payload,
          handleKey: HANDLE_KEY,
          now: new Date(),
        });
        // Replay: cùng outcome (vẫn fail-closed vì Interaction stub), nhưng
        // quan trọng hơn là KHÔNG thêm hàng.
        expect(second.status).toBe(422);

        const grants = await migrator<{ count: string }[]>`
          SELECT count(*)::text AS count FROM auth.oauth_grants WHERE sub LIKE 'sub-handlers-test%'
        `;
        expect(grants[0]?.count).toBe('1');

        const decisions = await migrator<{ count: string }[]>`
          SELECT count(*)::text AS count FROM auth.oauth_consent_decisions
           WHERE authorization_transaction_id = ${txId}
        `;
        expect(decisions[0]?.count).toBe('1');
      } finally {
        await cleanup(migrator, []);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('decide a different decision after commit — invalid_request, decision NOT changed', async () => {
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        const txId = newTxId('cc');
        const handleY = await deriveHandle({
          key: HANDLE_KEY,
          transactionId: txId,
          domain: HANDLE_DOMAINS.consentContinuation,
        });
        await seedTransaction(runtime, {
          transactionId: txId,
          handleHashX: 'ZZkVq2oFfTAgy1WcdbeNkanIsw6CwJh0jAcs8CtGYWw',
          browserBindingHash: 'AAIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw4',
          state: 'awaiting_consent',
          bound: true,
          handleHashY: await hashHandle(handleY),
        });

        const first = await runConsentDecide({
          provider: stubProvider(),
          postgresClient: runtime as unknown as PostgresClientLike,
          payload: {
            handle: handleY,
            decision: 'approve',
            account_session_ref: 'asr-handlers-test',
          },
          handleKey: HANDLE_KEY,
          now: new Date(),
        });
        expect(first.status).toBe(422);

        const second = await runConsentDecide({
          provider: stubProvider(),
          postgresClient: runtime as unknown as PostgresClientLike,
          payload: {
            handle: handleY,
            decision: 'deny',
            account_session_ref: 'asr-handlers-test',
          },
          handleKey: HANDLE_KEY,
          now: new Date(),
        });
        // §5.1.5b: quyết định đã commit là vĩnh viễn.
        expect(second.status).toBe(422);
        expect(second.body).toMatchObject({ error: 'invalid_request' });

        // State vẫn là approve đã thắng.
        const rows = await migrator<{ state: string }[]>`
          SELECT state FROM auth.authorization_transactions WHERE transaction_id = ${txId}
        `;
        expect(rows[0]?.state).toBe('ready_to_complete');
      } finally {
        await cleanup(migrator, []);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('decide with the owning ASR — consume Y CAS wins and Y is consumed', async () => {
      // ⚠️ Test này ghim điều kiện `account_session_ref = $2 AND sub = $3` của
      // CAS 2 (canonical `0002` lines 305-331 — ví bug đã đo được: SQL của
      // `consumeHandleY` từng thiếu hai điều kiện này, nên một handle Y lọt sang
      // phiên khác vẫn consume được nếu caller bỏ qua kiểm app-layer). Nhánh
      // ĐÚNG phiên phải remain: 1 hàng consumed, state advance được.
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        const txId = newTxId('cy1');
        const handleY = await deriveHandle({
          key: HANDLE_KEY,
          transactionId: txId,
          domain: HANDLE_DOMAINS.consentContinuation,
        });
        await seedTransaction(runtime, {
          transactionId: txId,
          handleHashX: 'ZZkVq2oFfTAgy1WcdbeNkanIsw6CwJh0jAcs8CtGYWw',
          browserBindingHash: 'AAIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw4',
          state: 'awaiting_consent',
          bound: true,
          handleHashY: await hashHandle(handleY),
        });

        const result = await runConsentDecide({
          provider: stubProvider(),
          postgresClient: runtime as unknown as PostgresClientLike,
          payload: {
            handle: handleY,
            decision: 'approve',
            account_session_ref: 'asr-handlers-test',
          },
          handleKey: HANDLE_KEY,
          now: new Date(),
        });
        // Interaction stub ⇒ fail-closed sau commit: consume Y đã THẮNG nhưng
        // response 422 — bằng chứng của consume nằm ở trạng thái DB dưới, không
        // phải status.
        expect(result.status).toBe(422);

        const rows = await migrator<{ consumed: string | null; state: string }[]>`
          SELECT handle_y_consumed_at::text AS consumed, state
            FROM auth.authorization_transactions WHERE transaction_id = ${txId}
        `;
        expect(rows[0]?.consumed).not.toBeNull();
        expect(rows[0]?.state).toBe('ready_to_complete');
      } finally {
        await cleanup(migrator, []);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });

    it('decide with a DIFFERENT ASR — consume Y CAS loses 0 rows, Y stays unconsumed and consumable by the owner', async () => {
      // ⚠️ Regression cho chính lỗi của issue #57: ASR khác ⇒ CAS 0 rows.
      // Đường handler đã có kiểm app-layer (422 trước khi vào tx), nên để chạm
      // ĐƯỢC CAS với ASR sai — đúng scenario "direct caller bỏ qua kiểm
      // app-layer" mà issue mô tả — test này gọi `consumeHandleY` TRỰC TIẾP
      // trong một tx của runtime, như một caller tương lai sẽ làm. Hợp đồng:
      // bind SQL tự nó bào vệ, không phụ thuộc kiểm ở tầng app.
      const { runtime, migrator } = await setup();
      try {
        await seedClient(migrator, CLIENT_ID);
        const txId = newTxId('cy2');
        const handleY = await deriveHandle({
          key: HANDLE_KEY,
          transactionId: txId,
          domain: HANDLE_DOMAINS.consentContinuation,
        });
        await seedTransaction(runtime, {
          transactionId: txId,
          handleHashX: 'ZZkVq2oFfTAgy1WcdbeNkanIsw6CwJh0jAcs8CtGYWw',
          browserBindingHash: 'AAIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw4',
          state: 'awaiting_consent',
          bound: true,
          handleHashY: await hashHandle(handleY),
        });
        const handleYHash = await hashHandle(handleY);

        // Attacker consume Y trong tx của mình — session/sub khác.
        await runtime.begin(async (tx) => {
          const consumed = await consumeHandleY(tx as never, {
            handleYHash,
            accountSessionRef: 'asr-NGUOI-KHAC',
            sub: 'sub-handlers-test-000000000000000000000000000',
            decision: 'approve',
            eventId: 'consent:approve:' + txId,
            payloadHash: 'payload-hash-of-attacker-0000000000000000000',
            now: new Date(),
          });
          // ⚠️ Bind session/sub vào SQL ⇒ CAS 0 hàng: thua mà KHÔNG viết gì.
          expect(consumed).toBeUndefined();
        });

        // Trạng thái DB nguyên vẹn sau lần thử sai: Y chưa consumed, state chưa advance.
        const rows = await migrator<{ consumed: string | null; state: string }[]>`
          SELECT handle_y_consumed_at::text AS consumed, state
            FROM auth.authorization_transactions WHERE transaction_id = ${txId}
        `;
        expect(rows[0]?.consumed).toBeNull();
        expect(rows[0]?.state).toBe('awaiting_consent');

        // Y VẪN dùng được bởi phiên thật, sau khi attacker đã thử và thua
        // (idempotency replay hợp đồng §5.1.5b không bị bind làm hỏng).
        const result = await runConsentDecide({
          provider: stubProvider(),
          postgresClient: runtime as unknown as PostgresClientLike,
          payload: {
            handle: handleY,
            decision: 'approve',
            account_session_ref: 'asr-handlers-test',
          },
          handleKey: HANDLE_KEY,
          now: new Date(),
        });
        expect(result.status).toBe(422); // fail-closed interaction stub

        const after = await migrator<{ consumed: string | null; state: string }[]>`
          SELECT handle_y_consumed_at::text AS consumed, state
            FROM auth.authorization_transactions WHERE transaction_id = ${txId}
        `;
        expect(after[0]?.consumed).not.toBeNull();
        expect(after[0]?.state).toBe('ready_to_complete');
      } finally {
        await cleanup(migrator, []);
        await runtime.end({ timeout: 1 });
        await migrator.end({ timeout: 1 });
      }
    });
  });
});
