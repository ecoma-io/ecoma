/**
 * Regression mid-flow — thay đổi trạng thái NGAY GIỮA CHỪNG một luồng authorization
 * (Workstream B: token issuance, session, revocation).
 *
 * Ba tình huống "giữa chừng" mà spec handler (internal-handlers.spec) không phủ:
 *
 *   1. Suspend commit giữa bài push `session/verified` và consent `decide` —
 *      decide vẫn chạy đúng hợp đồng §5.1.5b (consent là quyết định của user),
 *      nhưng suspend không được mở lại đường phát hành: revocation 3 mức của
 *      gate chặn mọi phát hành kế tiếp.
 *   2. Grant bị thu hồi giữa consent-decide được ghi và thời điểm cấp code —
 *      THƯỜNG XUYÊN không có hàng `token_revocations` nào: hàng `oauth_grants`
 *      `status = 'revoked'` là bằng chứng duy nhất. Gateway phát hành
 *      (issuance-gate) phải chặn cả hai trường hợp này — hàng 9/14 của state
 *      machine (docs/domains/auth §5.1.2) cho nhánh không có kiện revocation.
 *   3. ASR (account_session_ref) rotate giữa `consent/context` và `decide` —
 *      decide với ASR cũ bị từ chối, Y KHÔNG bị tiêu thụ, decide với ASR đúng
 *      phía sau vẫn chạy được (không bị "kẹt vĩnh viễn").
 *
 * ⚠️ PostgreSQL THẬT (testcontainers) vì cả ba kịch bản đều là thứ tự ghi trong
 *.db-auth: test stub sẽ xanh-green ngay cả một CAS sai. Thiếu Docker ⇒ ĐỎ —
 * harness probe fail-loud, không có đường skip.
 */

import postgres from 'postgres';

import type { Provider } from 'oidc-provider';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { base64UrlToBytes, deriveHandle, hashHandle, HANDLE_DOMAINS } from '@ecoma-io/auth-domain';
import {
  checkRevocationAtIssuance,
  createAuthorizationStore,
  type PostgresClientLike,
} from '@ecoma-io/auth-infrastructure';
import { runConsentContext, runConsentDecide } from '../../src/consent-handler';
import { runSessionVerified } from '../../src/session-verified-handler';
import { createIssuanceGateFromDeps } from '../../src/oidc/issuance-gate';
import type { IssuanceGate } from '../../src/oidc/adapter';
import { startAuthDatabase, type AuthDatabase } from './harness';

/** Probe Docker một lần ở tầng module — kết quả do globalSetup đăng ký qua env. */
/** Container riêng của file này, dựng một lần trong `beforeAll`. */
let db: AuthDatabase;

const HANDLE_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CLIENT_ID = 'client-midflow-pg-test';
/** Marker cleanup — mọi sub của suite này bám marker này. */
const SUB_PREFIX = 'sub-midflow-';
const TX_SUFFIX = '-for-midflow-spec-000';

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

function newTxId(prefix: string): string {
  return `${prefix}-fixed-transaction-identifier${TX_SUFFIX}`;
}

async function seedClient(migrator: postgres.Sql): Promise<void> {
  await migrator`
    INSERT INTO auth.oauth_clients (client_id, client_name, client_type)
    VALUES (${CLIENT_ID}, 'midflow pg test client', 'public')
    ON CONFLICT (client_id) DO NOTHING
  `;
}

async function seedTransaction(
  runtime: postgres.Sql,
  params: {
    transactionId: string;
    /** NULL = identity chưa bind (trước session/verified) — đúng mô hình 0002. */
    sub: string | null;
    state: 'browser_confirmed' | 'awaiting_consent';
    handleHashX: string;
    handleHashY?: string;
    accountSessionRef: string | null;
  },
): Promise<void> {
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
      base64UrlToBytes(params.handleHashX),
      CLIENT_ID,
      'https://app.example.com/cb',
      ['openid'],
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      'S256',
      base64UrlToBytes('AAIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw4'),
      new Date(Date.now() + 600_000),
      params.sub,
      'urn:ecoma:acr:email-otp',
      new Date(Date.now() - 30_000),
      params.accountSessionRef,
      params.state,
      params.handleHashY === undefined ? null : base64UrlToBytes(params.handleHashY),
    ],
  );
}

async function cleanup(migrator: postgres.Sql): Promise<void> {
  await migrator.unsafe(
    `DELETE FROM auth.token_revocations WHERE subject_ref LIKE '${SUB_PREFIX}%'`,
  );
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
    `DELETE FROM auth.authorization_codes
      WHERE authorization_transaction_id LIKE '%${TX_SUFFIX}%'`,
  );
  await migrator.unsafe(`DELETE FROM auth.oidc_state WHERE id LIKE 'it-%${TX_SUFFIX}%'`);
  await migrator.unsafe(
    `DELETE FROM auth.authorization_transactions
      WHERE transaction_id LIKE '%${TX_SUFFIX}%'`,
  );
}

/**
 * Stub provider — hình dạng đúng đủ cho `attachInteractionResult` + Grant của
 * decide. Interaction.find trả undefined ⇒ `attachInteractionResult` trả
 * undefined ⇒ các handler trả fail-closed 422 sau khi CAS đã commit — hành vi
 * này được internal-handlers.spec phủ chi tiết; đây chỉ dùng làm đường "không
 * có Interaction" để test tập trung vào thứ tự DB, không phải protocol glue.
 */
function stubProvider(): Provider {
  class FakeInteraction {
    returnTo = 'https://rp.example.com/cb';
    result: unknown;
    constructor(public readonly id: string) {}
    // Không persist gì: Interaction.find dưới trả undefined ⇒ mọi handler sees
    // "không có Interaction" và trả fail-closed — persist không được đọc lại.
    async persist(): Promise<void> {
      return undefined;
    }
    static async find(): Promise<undefined> {
      return undefined;
    }
  }
  class FakeGrant {
    jti: string;
    accountId = '';
    clientId = '';
    constructor(init?: { jti?: string }) {
      this.jti = init?.jti ?? 'fake-grant-jti';
    }
    // Stub của provider Grant: scope/claims không được đọc trong các kịch bản
    // này — method chỉ giữ đúng shape gọi của provider. Không thể là no-op
    // thuần (no-empty-function), nên để lại phép tính vô hại.
    addOIDCScope(): void {
      void this.jti;
    }
    addOIDCClaims(): void {
      void this.jti;
    }
    async save(): Promise<string> {
      return this.jti;
    }
  }
  return {
    Interaction: FakeInteraction,
    Grant: FakeGrant,
  } as unknown as Provider;
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

describe('mid-flow state changes — issuance controls stay closed', () => {
  it('suspend committed between push and decide: decide still commits the user decision, the gate blocks the next issuance on account status', async () => {
    const { runtime, migrator } = await setup();
    try {
      // KHÔNG seed grant: push không có grant hiện hành ⇒ needsConsent ⇒
      // `consent_required` (grant do determine sau decide tự tạo).
      const sub = `${SUB_PREFIX}susp-0000000000000000000000000000`;
      const txId = newTxId('msp');
      const handleX = await deriveHandle({
        key: HANDLE_KEY,
        transactionId: txId,
        domain: HANDLE_DOMAINS.loginHandoff,
      });
      await seedClient(migrator);
      await seedTransaction(runtime, {
        transactionId: txId,
        sub: null,
        state: 'browser_confirmed',
        handleHashX: await hashHandle(handleX),
        accountSessionRef: null,
      });

      // (1) Push thắng — account CÒN active lúc checkStatus (trước suspend).
      //     CAS consume X + bind identity, rồi advance sang `awaiting_consent`
      //     với handle Y (consent_required path của session-verified-handler).
      const rawBody = new TextEncoder().encode(
        JSON.stringify({
          handle: handleX,
          sub,
          acr: 'urn:ecoma:acr:email-otp',
          authn_at: Math.floor(Date.now() / 1000) - 10,
          account_session_ref: 'asr-midflow-susp',
          event_id: 'evt-midflow-push-1',
        }),
      );
      const verified = await runSessionVerified({
        provider: stubProvider(),
        postgresClient: runtime as unknown as PostgresClientLike,
        store: createAuthorizationStore({ client: runtime as unknown as PostgresClientLike }),
        handleKey: HANDLE_KEY,
        accountBaseUrl: 'https://account.ecoma.io',
        now: new Date(),
        checkStatus: async () => 'active',
        rawBody,
      });
      expect(verified.status).toBe(200);
      const verifiedBody = verified.body as { outcome: string; continue_url?: string };
      expect(verifiedBody.outcome).toBe('consent_required');
      const handleY = new URL(verifiedBody.continue_url ?? '').searchParams.get('handle');
      expect(typeof handleY).toBe('string');

      // (2) Suspend commit — ở mô hình thật account/status = 'suspended'; auth
      //     không có hàng nào tự ghi (projection của §7 là việc của account).
      //     Bằng chứng suspend tồn tại ở đây là checkStatus stub bên dưới.

      // (3) Decide sau suspend: quyết định consent là quyết định của USER —
      //     CAS advance/consume-Y + grant approve vẫn commit (§5.1.5b, một sự
      //     kiện; branch decide KHÔNG vấn AccountClient). Interaction stub
      //     fail-closed ⇒ 422 sau commit, không continue_url mới.
      const decide = await runConsentDecide({
        provider: stubProvider(),
        postgresClient: runtime as unknown as PostgresClientLike,
        payload: {
          handle: handleY as string,
          decision: 'approve',
          account_session_ref: 'asr-midflow-susp',
        },
        handleKey: HANDLE_KEY,
        now: new Date(),
      });
      expect(decide.status).toBe(422);
      const decisions = await runtime<{ decision: string }[]>`
        SELECT decision FROM auth.oauth_consent_decisions
         WHERE authorization_transaction_id = ${txId}
      `;
      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.decision).toBe('approve');
      // Decide đã mở grant active — nhưng chấp nhận đứng trên BỘ MÁY CẤP CODE
      // KHÔNG có nghĩa là token sẽ được cấp: phát hành là chốt chặn thứ hai.
      const grantsActive = await runtime<{ count: string }[]>`
        SELECT count(*)::text AS count FROM auth.oauth_grants
         WHERE sub = ${sub} AND status = 'active'
      `;
      expect(grantsActive[0]?.count).toBe('1');

      // (4) PHÁT HÀNH MỚI sau suspend — gate NÉM vì account status (§5.1.0
      //     điều kiện 3): status 'suspended' nằm ngoài allowlist
      //     `allowsIssuance`, fail-closed đúng hợp đồng của gate.
      const gate = createIssuanceGateFromDeps({
        postgresClient: runtime as unknown as PostgresClientLike,
        checkStatus: async () => 'suspended',
      });
      await expect(
        gate.assertIssuable({ accountId: sub, clientId: CLIENT_ID, grantId: null }),
      ).rejects.toThrow('account status');

      // (5) Audit hàng chặn: `token_issue_denied` với reason 'account_status'.
      const denyRows = await runtime<{ details: unknown; outcome: string | null }[]>`
        SELECT details AS details, outcome
          FROM auth.authorization_audit_events
         WHERE subject_ref = ${sub}
           AND event_type = 'token_issue_denied'
         ORDER BY occurred_at DESC
         LIMIT 1
      `;
      // ⚠️ `details` jsonb đi qua driver với một chuỗi JSON.stringify ⇒ jsonb
      //     typeof 'string' (double-encoded) — đọc phải qua một lần unwrap
      //     jsonb string. Chi tiết này là hành vi thật của `insertAuditEvent`.
      const denialPayload = JSON.parse(denyRows[0]?.details as unknown as string) as {
        reason: string;
      };
      expect(denialPayload.reason).toBe('account_status');
      expect(denyRows[0]?.outcome).toBe('denied');

      // (6) Negative control: KHÔNG có hàng revocation nào được ghi — việc chặn
      //     ở bước (4) đến duy nhất từ account status, không phải từ
      //     `token_revocations` (đường revoke riêng là kịch bản thứ hai).
      const revocation = await checkRevocationAtIssuance(runtime as unknown as PostgresClientLike, {
        sub,
        clientId: CLIENT_ID,
      });
      expect(revocation).toBe('not_revoked');
      // Account trở lại active ⇒ grant vừa decide tạo ra lại cấp được — chấp
      // nhận đứng trên path phát hành đúng nghĩa, gate chỉ chặn khi status sai.
      const gateRecover = createIssuanceGateFromDeps({
        postgresClient: runtime as unknown as PostgresClientLike,
        checkStatus: async () => 'active',
      });
      await expect(
        gateRecover.assertIssuable({ accountId: sub, clientId: CLIENT_ID, grantId: null }),
      ).resolves.toBeUndefined();
      const issuedRows = await runtime<{ count: string }[]>`
        SELECT count(*)::text AS count FROM auth.authorization_audit_events
         WHERE subject_ref = ${sub}
           AND event_type = 'token_issued'
      `;
      expect(issuedRows[0]?.count).toBe('1');
    } finally {
      await cleanup(migrator);
      await runtime.end({ timeout: 1 });
      await migrator.end({ timeout: 1 });
    }
  });

  it('grant revoked between consent-decide and code issuance: gate throws even with no token_revocations row', async () => {
    const { runtime, migrator } = await setup();
    try {
      const sub = `${SUB_PREFIX}grv-0000000000000000000000000000`;
      const txId = newTxId('mgr');
      const handleY = await deriveHandle({
        key: HANDLE_KEY,
        transactionId: txId,
        domain: HANDLE_DOMAINS.consentContinuation,
      });
      // KHÔNG seed grant: decide approve tự sinh grant — đây là thời điểm "đã
      // consent được ghi" của kịch bản.
      await seedClient(migrator);
      await seedTransaction(runtime, {
        transactionId: txId,
        sub,
        state: 'awaiting_consent',
        handleHashX: 'ZZkVq2oFfTAgy1WcdbeNkanIsw6CwJh0jAcs8CtGYWw',
        handleHashY: await hashHandle(handleY),
        accountSessionRef: 'asr-midflow-grv',
      });

      // (1) Decide approve — grant + scopes + decision là MỘT sự kiện tx
      //     (§5.1.5b; CAS chi tiết đã được internal-handlers.spec phủ).
      await runConsentDecide({
        provider: stubProvider(),
        postgresClient: runtime as unknown as PostgresClientLike,
        payload: {
          handle: handleY,
          decision: 'approve',
          account_session_ref: 'asr-midflow-grv',
        },
        handleKey: HANDLE_KEY,
        now: new Date(),
      });
      const grants = await runtime<{ id: string }[]>`
        SELECT id FROM auth.oauth_grants WHERE sub = ${sub} AND status = 'active'
      `;
      expect(grants).toHaveLength(1);
      const grantId = grants[0]?.id;
      if (grantId === undefined) {
        throw new Error('decide khong de lai grant active');
      }

      // (2) Grant bị revoke giữa decide và thời điểm cấp code — KHÔNG có kiện
      //     `token_revocations` nào: hàng `oauth_grants.status` là bằng chứng
      //     duy nhất (hàng 9/14 của state machine, docs/domains/auth §5.1.2).
      await runtime.unsafe(
        `UPDATE auth.oauth_grants SET status = 'revoked', revoked_at = now(),
           revoked_reason = 'midflow-revoke-grant'
         WHERE id = $1`,
        [grantId],
      );

      // (3) IssuanceGate NÉM cho artifact mang grantId này — code cấp trong
      //     resume gọi adapter.upsert(AuthorizationCode), payload mang accountId
      //     + clientId + grantId ⇒ gate phải chặn tại đây. Trước khi yêu cầu
      //     fix của WS-B, phép kiểm này không nằm trong gate và test này đỏ.
      const gate = createIssuanceGateFromDeps({
        postgresClient: runtime as unknown as PostgresClientLike,
        // Account vẫn active — điều kiện 3 không phải cái chặn ở đây.
        checkStatus: async () => 'active',
      });
      await expect(
        gate.assertIssuable({ accountId: sub, clientId: CLIENT_ID, grantId }),
      ).rejects.toThrow('grant mat hieu luc');

      // (4) Anti-drift: phép kiểm revocation (token_revocations) trả
      //     'not_revoked' cho kịch bản này — chứng minh việc chặn thật sự
      //     đến từ `oauth_grants.status`, không phải từ một hàng revocation.
      const revocation = await checkRevocationAtIssuance(runtime as unknown as PostgresClientLike, {
        sub,
        clientId: CLIENT_ID,
        grantId,
      });
      expect(revocation).toBe('not_revoked');

      // (5) Audit vẫn append-only: hàng audit `token_issue_denied` phải được
      //     ghi với reason 'grant_revoked' — đúng quy tắc tracing của gate
      //     (SR-015/FR-020). ⚠️ Khác với việc chặn ở kịch bản 1, audit đây
      //     KHÔNG fire-and-forget — assert ngay sau reject.
      const auditRows = await runtime<{ details: unknown; outcome: string | null }[]>`
        SELECT details AS details, outcome
          FROM auth.authorization_audit_events
         WHERE subject_ref = ${sub}
           AND event_type = 'token_issue_denied'
         ORDER BY occurred_at DESC
         LIMIT 1
      `;
      // ⚠️ Cùng lệch jsonb của kịch bản 1: một lần unwrap trước khi đọc reason.
      const denialPayload2 = JSON.parse(auditRows[0]?.details as unknown as string) as {
        reason: string;
      };
      expect(denialPayload2.reason).toBe('grant_revoked');
      expect(auditRows[0]?.outcome).toBe('denied');
    } finally {
      await cleanup(migrator);
      await runtime.end({ timeout: 1 });
      await migrator.end({ timeout: 1 });
    }
  });

  it('ASR rotated between context and decide: decide with the stale ASR is refused and Y stays unconsumed', async () => {
    const { runtime, migrator } = await setup();
    try {
      const sub = `${SUB_PREFIX}asr-0000000000000000000000000000`;
      const txId = newTxId('mas');
      const handleY = await deriveHandle({
        key: HANDLE_KEY,
        transactionId: txId,
        domain: HANDLE_DOMAINS.consentContinuation,
      });
      await seedClient(migrator);
      await seedTransaction(runtime, {
        transactionId: txId,
        sub,
        state: 'awaiting_consent',
        handleHashX: 'ZZkVq2oFfTAgy1WcdbeNkanIsw6CwJh0jAcs8CtGYWw',
        handleHashY: await hashHandle(handleY),
        accountSessionRef: 'asr-midflow-before',
      });

      // (1) Context bằng session ASR đang hiện hành — chấp nhận. KHÔNG seed
      //     grant nào ⇒ isNewClient/isNewScope là TRUE và authn_at "vừa hết
      //     hạn" của seed cùng authn_at mới ⇒ risk 'elevated' (2 điểm), không
      //     phải 'low' — đây là hành vi thật của `assessRiskLevel`.
      const contextOk = await runConsentContext({
        postgresClient: runtime as unknown as PostgresClientLike,
        payload: { handle: handleY, account_session_ref: 'asr-midflow-before' },
        now: new Date(),
      });
      expect(contextOk.status).toBe(200);
      const contextOkBody = contextOk.body as { client_name?: string; risk_level?: string };
      expect(contextOkBody.client_name).toBe(CLIENT_ID);
      // isNewClient/isNewScope TRUE (không grant nào) + authn "vừa hết hạn" của
      // seed ⇒ đúng 2 điểm: 'high' từ `assessRiskLevel`, không phải trị số cứng
      // nào khác — risk là TRÌNH BÀY (không phải control bảo mật), chỉ cần nó
      // phản ánh đúng cấu hình fixture.
      expect(contextOkBody.risk_level).toBe('high');

      // (2) Session của account rotate — phía account sẽ ghi ASR MỚI vào
      //     transaction (projection §7). decide/context về sau này phải dùng
      //     ASR MỚI — ASR cũ là phiên bản của một session khác.
      //     Ở đây ghi trực tiếp vào hàng — cùng hiệu quả một projection.
      await runtime.unsafe(
        `UPDATE auth.authorization_transactions SET account_session_ref = $2
         WHERE transaction_id = $1`,
        [txId, 'asr-midflow-after'],
      );

      // (3) Decide bằng ASR STALE bị từ chối, KHÔNG ghi state nào: một ASR
      //     khác là một session khác đang hỏi consent của transaction người
      //     khác (§5.1.5) — ASR mismatch bị từ chối TRƯỚC khi chạm CAS.
      const decideStale = await runConsentDecide({
        provider: stubProvider(),
        postgresClient: runtime as unknown as PostgresClientLike,
        payload: {
          handle: handleY,
          decision: 'approve',
          account_session_ref: 'asr-midflow-before',
        },
        handleKey: HANDLE_KEY,
        now: new Date(),
      });
      expect(decideStale.status).toBe(422);
      // KHÔNG có thông tin gì lộ: error body không chứa giá trị nào từ payload
      // (handle, sub, ref) — cùng bị invariant 9.
      const decideStaleBody = decideStale.body as { error: string };
      expect(decideStaleBody.error).toBe('invalid_request');
      expect(JSON.stringify(decideStaleBody)).not.toContain('asr-midflow-before');

      // (4) Y chưa consume, state giữ nguyên — decide stale KHÔNG CAS được.
      //     Hành vi này cho phép decide với ASR ĐÚNG phía sau vẫn tiếp tục.
      const state = await migrator<{ state: string; consumed: boolean }[]>`
        SELECT state, handle_y_consumed_at IS NOT NULL AS consumed
          FROM auth.authorization_transactions WHERE transaction_id = ${txId}
      `;
      expect(state[0]?.state).toBe('awaiting_consent');
      expect(state[0]?.consumed).toBe(false);

      // (5) Decide bằng ASR đúng hiện hành — CAS thắng: state advance sang
      //     `ready_to_complete` kèm Y consumed + Z ghi (Interaction stub chỉ
      //     làm `attachInteractionResult` fail-closed ⇒ 422 sau commit).
      const decideFresh = await runConsentDecide({
        provider: stubProvider(),
        postgresClient: runtime as unknown as PostgresClientLike,
        payload: {
          handle: handleY,
          decision: 'approve',
          account_session_ref: 'asr-midflow-after',
        },
        handleKey: HANDLE_KEY,
        now: new Date(),
      });
      expect(decideFresh.status).toBe(422); // fail-closed interaction stub
      const state2 = await migrator<{ state: string; consumed: boolean }[]>`
        SELECT state, handle_y_consumed_at IS NOT NULL AS consumed
          FROM auth.authorization_transactions WHERE transaction_id = ${txId}
      `;
      expect(state2[0]?.state).toBe('ready_to_complete');
      expect(state2[0]?.consumed).toBe(true);
    } finally {
      await cleanup(migrator);
      await runtime.end({ timeout: 1 });
      await migrator.end({ timeout: 1 });
    }
  });

  // Alias narrowing cho TS — không cần runtime ở đây (adapter shape đã có test
  // riêng trong oidc/adapter.spec).
  void (undefined as unknown as IssuanceGate | undefined);
});
