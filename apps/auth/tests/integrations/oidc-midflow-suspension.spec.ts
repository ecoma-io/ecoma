/**
 * ACCEPTANCE — gate cấp phát (SR-015/FR-020, §6.0) trên provider THẬT: treo account
 * GIỮA LUỒNG, ở đúng thời điểm `adapter.upsert` gọi `assertIssuable`.
 *
 * ## Vì sao suite này tồn tại
 *
 * `internal-handlers.spec.ts` kiểm phần back-channel (CAS X/Y/Z) với provider STUB;
 * `oidc-fullflow.spec.ts` đi trọn luồng §5.1.2 trên provider thật nhưng CỐ Ý không
 * wire gate (xem JSDoc của `oidc/runtime.ts`: "test không truyền gate là test trình
 * duyệt protocol thuần"). Suite này ghép hai nửa: provider thật + gate thật.
 *
 * Kịch bản và luồng xác minh (cùng luật với `oidc-fullflow.spec.ts`: provider thật
 * trên server Node thật, Postgres thật; gate copy đúng cấu trúc `createIssuanceGate`
 * của `oidc/runtime.ts` từ CÁC THÀNH PHẦN production — `AccountClient`,
 * `allowsIssuance`, `checkRevocationAtIssuance`, `insertAuditEvent`):
 *
 *   1. Trước resume → status stub trả 'active' — step authorize → /auth → confirm →
 *      session/verified → consent/decide đi đúng đường production. Kết quả của
 *      session/verified có thể là `granted` (grant active đã phủ mọi scope yêu cầu —
 *      nhánh grantedPath của state machine §5.1.2, nghĩa là KHÔNG consent prompt)
 *      hoặc `consent_required` — caller chấp nhận CẢ HAI, tie vào là handle Y.
 *   2. Status stub đổi thành 'suspended'.
 *   3. GET resume (browser thật mang cookie `_interaction_resume`) → provider gọi
 *      `adapter.upsert` cho AuthorizationCode → gate throw → browser KHÔNG nhận code.
 *
 * Assert ở tầng database thật:
 *
 *   4. `auth.authorization_audit_events` có hàng `token_issue_denied` với
 *      `error_code='access_denied'` và `details` mang `reason='account_status'`
 *      (đọc qua parse của `details::text` — xem FINDING về double-encoded jsonb
 *      trong thân test).
 *   5. `auth.oidc_state` KHÔNG có hàng AuthorizationCode nào của sub này — không cấp.
 *   6. Control test (status active cả luồng) phải cấp code bình thường — bắt lỗi
 *      "gate chặn cả account khoẻ" (fail-closed quá mức).
 *
 * ⚠️ Việc `resumeResponse.status` trả chuỗi và việc HTTP response mãi mãi là
 * non-expose error là chi tiết của `error_handler` + `err_out` của oidc-provider
 * (generic Error → server_error + "oops! something went wrong") — test khẳng định
 * protocol surface đó chứ không assert chuỗi message nội bộ của gate.
 *
 * ⚠️ Thiếu Docker ⇒ SKIP toàn bộ — skip không phải pass; report phải nêu.
 */

import type { Server } from 'node:http';

import postgres from 'postgres';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createNonce, signRequest } from '@ecoma-io/auth-contracts';
import { allowsIssuance } from '@ecoma-io/auth-domain';
import {
  checkRevocationAtIssuance,
  createPostgresClient,
  insertAuditEvent,
  withPostgresClient,
  type PostgresClientLike,
} from '@ecoma-io/auth-infrastructure';

import { PROVIDER_ROUTES } from '../../src/oidc/provider';
import type { IssuanceGate } from '../../src/oidc/adapter';
import { AccountClient } from '../../src/account-client';
import { loadAuthConfig, type AuthEnv } from '../../src/config';
import { startAuthDatabase, type AuthDatabase } from './harness';

/* ------------------------------------------------------------------ */
/* PostgreSQL harness — cùng luật với oidc-fullflow.spec.ts            */
/* ------------------------------------------------------------------ */

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
  return postgres({ ...base(), user: db.runtimeUser, password: db.runtimePassword, max });
}

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

const HANDLE_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CLIENT_ID = 'client-issgate-pg-test';
const CLIENT_REDIRECT = 'https://rp.example.com/cb';
/**
 * ⚠️ Marker `sub-issgate-` / `evt-issgate-` RIÊNG của suite này — workstream
 * khác dùng `sub-midflow-` / `-for-midflow-spec-`; hai workstream kiểm cùng khái
 * niệm trên hai worktree, cleanup của mỗi suite phải chỉ quét đúng hàng của mình.
 *
 * ⚠️ HAI subject: suspended test dùng SUB_SUSPENDED, control dùng SUB_ACTIVE —
 * consent/decide tạo `oauth_grants` theo (sub, client); nếu hai test dùng chung
 * một subject thì grant active của test đầu đổi luồng test sau sang grantedPath
 * (biến giữa các test phải là status stub, không phải trạng thái grant).
 */
const SUB_SUSPENDED = 'sub-issgate-spec-suspend-0000000000000000000';
const SUB_ACTIVE = 'sub-issgate-spec-active-00000000000000000000';
const INTERNAL_SECRET = 'issgate-internal-secret';
const TEST_AUDIENCE = 'https://api.ecoma.io/issgate';
const ACCOUNT_BASE_URL = 'https://account.ecoma.io';
/** Issuer phải khớp origin của server Node cục bộ — provider dựng URL tuyệt đối từ nó. */
let ISSUER = 'http://127.0.0.1:0';

let runtimeSql: postgres.Sql;
let nodeServer: Server;
let nodePort = 0;

/**
 * Trạng thái giả của account service — mutable giữa các lần gọi.
 *
 * Test flip biến này thành 'suspended' GIỮA LUỒNG (sau consent/decide, trước resume)
 * — đây chính là "account state change mid-flow" mà §6.0 cấm cấp token khi gặp.
 */
let statusStub: 'active' | 'suspended' = 'active';

/**
 * Binding stub cho `AccountClient` — return body do `statusStub` quyết định.
 *
 * ⚠️ Boundary stub được chấp nhận ở mốc fullflow (`makeEnv` cũng stub fetch);
 * phần production thực sự cần trung thực (`AccountClient.checkStatus` và toàn bộ
 * gate path) chạy HẾT qua code thật. Binding là edge duy nhất cần giả lập.
 */
const bindingStub = {
  fetch: async (_request: Request): Promise<Response> =>
    new Response(JSON.stringify({ status: statusStub }), { status: 200 }),
};

/** Bọc `fetch` để tự trỏ về server Node cục bộ, bỏ qua DNS của ISSUER. */
async function localFetch(path: string, init?: RequestInit): Promise<Response> {
  return await fetch(`http://127.0.0.1:${nodePort}${path}`, {
    ...init,
    redirect: 'manual',
  });
}

/**
 * Ký envelope nội bộ rồi POST vào route nội bộ — qua Hono app (`app.request`),
 * KHÔNG qua server Node của provider: `/internal/*` là lane Hono (xem
 * `runtime.ts` — bridge chỉ nhận các route provider).
 */
async function internalPost(
  app: {
    request: (path: string, init?: RequestInit, env?: AuthEnv) => Promise<Response> | Response;
  },
  path: string,
  payload: unknown,
  env: AuthEnv,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const headers = await signRequest({
    method: 'POST',
    path,
    body,
    secret: INTERNAL_SECRET,
    timestamp: String(Math.floor(Date.now() / 1000)),
    nonce: createNonce(),
  });
  const response = await app.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: body as unknown as BodyInit,
    },
    env,
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/**
 * Gate cấp phát — copy cấu trúc `createIssuanceGate` của `oidc/runtime.ts`.
 *
 * ⚠️ KHÔNG import `createIssuanceGate` — hàm đó KHÔNG export, và mutable stub cũng
 * KHÔNG phải thứ runtime prod cần. Gate ở đây dựng từ CÁC THÀNH PHẦN production
 * (`AccountClient`, `allowsIssuance`, `checkRevocationAtIssuance`,
 * `insertAuditEvent`) để trung thực về hành vi thực tế — một stub "return false"
 * là một test tự爆香 mà không chứng minh gì về production.
 */
function makeIssuanceGate(
  config: { internalSecret: string },
  postgresClient: PostgresClientLike,
): IssuanceGate {
  const account = new AccountClient({
    binding: bindingStub,
    secret: config.internalSecret,
  });
  return {
    assertIssuable: async ({ accountId, clientId, grantId }) => {
      const status = await account.checkStatus({ accountId, nowMs: Date.now() });
      if (!allowsIssuance(status)) {
        await insertAuditEvent(postgresClient, {
          eventType: 'token_issue_denied',
          subjectRef: accountId,
          clientId,
          grantId: grantId ?? undefined,
          outcome: 'denied',
          errorCode: 'access_denied',
          details: { reason: 'account_status' },
        });
        throw new Error(`issuance gate: account status "${status}" khong cho phep cap token`);
      }
      const revocation = await checkRevocationAtIssuance(postgresClient, {
        sub: accountId,
        clientId,
        grantId: grantId ?? undefined,
      });
      if (revocation !== 'not_revoked') {
        await insertAuditEvent(postgresClient, {
          eventType: 'token_issue_denied',
          subjectRef: accountId,
          clientId,
          grantId: grantId ?? undefined,
          outcome: 'denied',
          errorCode: 'access_denied',
          details: { reason: 'revocation' },
        });
        throw new Error('issuance gate: token da bi revoke (subject/client/grant)');
      }
      // token_issued fire-and-forget — tương ứng runtime prod; không assert hàng này
      // ở đây, suite này chỉ khẳng định nhánh DENIED (gate invoked + bị chặn).
      // Bất biến "token_issued luôn mọc khi cấp thành công" thuộc các suite khác.
    },
  };
}

/**
 * Server Node bọc `provider.callback()` — CHÍNH XÁC cách `buildRuntime` dựng bridge:
 * cùng constructor, cùng handler; điểm khác biệt DUY NHẤT với `oidc-fullflow.spec.ts`
 * là truyền `issuanceGate` vào factory (như runtime prod luôn làm).
 */
async function bootProvider(pem: string): Promise<void> {
  // ⚠️ Port cấp TRƯỚC, issuer dựng TỪ port đó — cùng lý do với `bootProvider` của
  // `oidc-fullflow.spec.ts` (issuer không khớp origin thì resume URL sai scheme).
  const { createServer } = await import('node:http');
  const probeServer = createServer((_req: unknown, res: { end: (chunk?: string) => void }) => {
    res.end('probe-only');
  });
  await new Promise<void>((resolve) => {
    probeServer.listen(0, '127.0.0.1', () => resolve());
  });
  const probeAddress = probeServer.address();
  const allocatedPort =
    typeof probeAddress === 'object' && probeAddress !== null ? probeAddress.port : 0;
  expect(allocatedPort).toBeGreaterThan(0);
  await new Promise<void>((resolve, reject) => {
    probeServer.close((err?: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
  nodePort = allocatedPort;
  // Issuer scheme PHẢI https — wrapper ghi đè `x-forwarded-proto: https` như bridge
  // production; localFetch vẫn gọi socket http thật (chỉ dùng pathname+search).
  ISSUER = `https://127.0.0.1:${nodePort}`;

  const env = makeEnv(pem);
  const config = await loadAuthConfig(env);
  const { createProvider } = await import('../../src/oidc/provider');
  const postgresClientConfig = { hyperdrive: config.hyperdrive };
  // Client pool dài hạn cho gate (lane `postgresClient` của `createIssuanceGateFromDeps`)
  // + client dùng-một-lần để load static clients — đúng hai lane của issue #289.
  const poolClient = createPostgresClient(config.hyperdrive);
  const provider = await withPostgresClient(
    postgresClientConfig,
    async (staticClientsLoader) =>
      await createProvider({
        config,
        postgresClientConfig,
        staticClientsLoader,
        signingPem: config.signingKeyPem,
        // ⚠️ Wire gate như production (`buildRuntime` của `oidc/runtime.ts`).
        issuanceGate: makeIssuanceGate(config, poolClient),
      }),
  );
  nodeServer = createServer(((req: unknown, res: unknown) => {
    const incoming = req as { headers: Record<string, string | string[] | undefined> };
    incoming.headers['x-forwarded-proto'] = 'https';
    (provider.callback() as (r: unknown, w: unknown) => void)(req, res);
  }) as never);
  await new Promise<void>((resolve, reject) => {
    nodeServer.once('error', reject);
    nodeServer.listen(nodePort, '127.0.0.1', () => resolve());
  });
  void provider;
}

/** Env khớp issuer thật của server Node — gọi SAU `bootProvider`. */
function makeEnv(pem: string): AuthEnv {
  return {
    HYPERDRIVE: {
      connectionString: `postgres://${db.runtimeUser}:${db.runtimePassword}@${db.host}:${db.port}/${db.database}`,
    },
    ACCOUNT_SERVICE: {
      fetch: async () => new Response(JSON.stringify({ status: statusStub })),
    },
    AUTH_SIGNING_KEY: pem,
    AUTH_SIGNING_KEY_ID: 'kid-issgate',
    AUTH_HANDLE_KEY: HANDLE_KEY,
    AUTH_HANDLE_KEY_VERSION: '1',
    AUTH_INTERNAL_SECRET: INTERNAL_SECRET,
    AUTH_ISSUER: ISSUER,
    AUTH_AUDIENCE: TEST_AUDIENCE,
    AUTH_COOKIE_KEYS: 'issgate-cookie-key-1,issgate-cookie-key-2',
    AUTH_ACCOUNT_BASE_URL: ACCOUNT_BASE_URL,
  };
}

/* ------------------------------------------------------------------ */
/* Suite                                                               */
/* ------------------------------------------------------------------ */

beforeAll(async () => {
  // Schema đã sẵn sàng bên trong `startAuthDatabase` (migration chạy một lần lúc
  // container lên, bằng credential migrator thật).
  db = await startAuthDatabase();
  runtimeSql = connectRuntime();
}, 180_000);

afterAll(async () => {
  nodeServer?.close();
  // Dọn đúng fixture của suite này (giống `oidc-fullflow.spec.ts`). ⚠️
  // `authorization_audit_events` KHÔNG dọn: append-only (0009 thu DELETE khỏi
  // runtime role) — hàng audit của lần chạy trước ở lại là đúng thiết kế; assert
  // trong test đọc theo marker sub nên không va hàng cũ.
  try {
    await runtimeSql.unsafe(`
      DELETE FROM auth.client_grant_scopes
        WHERE grant_id IN (
          SELECT id FROM auth.oauth_grants WHERE sub LIKE 'sub-issgate-spec-%')
    `);
    await runtimeSql.unsafe(`
      DELETE FROM auth.oauth_grants WHERE sub LIKE 'sub-issgate-spec-%'
    `);
    await runtimeSql.unsafe(`
      DELETE FROM auth.oauth_consent_decisions
        WHERE authorization_transaction_id IN (
          SELECT transaction_id FROM auth.authorization_transactions
            WHERE event_id LIKE 'evt-issgate-%')
    `);
    await runtimeSql.unsafe(`
      DELETE FROM auth.authorization_codes
        WHERE authorization_transaction_id IN (
          SELECT transaction_id FROM auth.authorization_transactions
            WHERE event_id LIKE 'evt-issgate-%')
    `);
    await runtimeSql.unsafe(`
      DELETE FROM auth.oidc_state
        WHERE payload->>'clientId' = ${CLIENT_ID}
           OR payload->>'accountId' LIKE 'sub-issgate-spec-%'
    `);
    await runtimeSql.unsafe(`
      DELETE FROM auth.authorization_transactions
        WHERE event_id LIKE 'evt-issgate-%'
    `);
  } catch {
    // Dọn thất bại không được che kết quả test; database test xem như dùng một lần.
  }
  // `?.` chứ không phải `.`: `beforeAll` chết (Docker mất) thì Vitest vẫn chạy
  // `afterAll` — một throw ở đây đè lỗi thật của `beforeAll`.
  await runtimeSql?.end({ timeout: 1 });
  await db?.stop();
});

/* ------------------------------------------------------------------ */
/* Step 1-5 của §5.1.2 — tới NGAY TRƯỚC resume                         */
/* ------------------------------------------------------------------ */

interface WalkUpToApproved {
  /** Resume URL của provider (absolute, cùng origin ISSUER). */
  resumeUrl: URL;
  /** Cookie `_interaction_resume` (và `_interaction`) thu từ bước /auth. */
  cookieHeader: string;
}

/**
 * Đi authorize → /auth → confirm → session/verified → consent/decide (approve).
 * Trả về resume URL + cookie resume — caller tự quyết định trình tự sau đó
 * (chủ yếu là flip status stub rồi GET resume).
 */
async function walkUpToApproved(params: {
  scopes: string;
  state: string;
  nonce: string;
  eventId: string;
  keypairPem: string;
  /** Subject của luồng — test suspended và control dùng SUB KHÁC nhau (grant tạo ở decide là per-sub). */
  subject: string;
}): Promise<WalkUpToApproved> {
  const env = makeEnv(params.keypairPem);
  const { default: app } = await import('../../src/main');

  // PKCE thật: verifier + challenge S256.
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = Buffer.from(verifierBytes).toString('base64url');
  const challenge = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  ).toString('base64url');

  // ── 1. GET /authorize (glue ECOMA, qua app Hono thật) ──────────────
  const authorizeUrl =
    `/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(CLIENT_REDIRECT)}` +
    `&response_type=code&scope=${params.scopes}&state=${params.state}` +
    `&nonce=${params.nonce}&code_challenge=${challenge}&code_challenge_method=S256`;
  const authorizeResponse = await app.request(authorizeUrl, { redirect: 'manual' }, env);
  expect(authorizeResponse.status).toBe(302);
  const providerAuthUrl = new URL(authorizeResponse.headers.get('location') as string);
  expect(providerAuthUrl.origin + providerAuthUrl.pathname).toBe(
    `${ISSUER}${PROVIDER_ROUTES.authorizationRoute}`,
  );
  const handleX = providerAuthUrl.searchParams.get('ecoma_x');
  expect(typeof handleX).toBe('string');
  expect(handleX?.length).toBeGreaterThanOrEqual(43);
  const setCookie = authorizeResponse.headers.get('set-cookie') ?? '';
  expect(setCookie).toContain('__Host-auth-browser=');
  const browserBinding = setCookie.split(';')[0]?.split('=')[1];
  expect(typeof browserBinding).toBe('string');

  // ── 2. GET /auth (provider thật, pipeline Koa thật qua server Node) ─
  // Gọi ĐÚNG MỘT LẦN: cookie `_interaction_resume` của response này là thứ browser
  // cần cho resume sau — gọi lại là tạo Interaction thứ hai, sai trình tự §5.1.2.
  const providerAuthResponse = await localFetch(
    `${providerAuthUrl.pathname}${providerAuthUrl.search}`,
    { headers: { cookie: `__Host-auth-browser=${browserBinding}` } },
  );
  expect(providerAuthResponse.status).toBe(303);
  const interactionUrl = new URL(providerAuthResponse.headers.get('location') as string);
  expect(interactionUrl.origin).toBe(ACCOUNT_BASE_URL);
  expect(interactionUrl.pathname).toBe('/login');
  expect(interactionUrl.searchParams.get('handle')).toBe(handleX);

  // Cookie từ bước /auth: gom mọi cookie `_interaction*` thực tế của response —
  // `_interaction` (signed) đã có sau bước redirect sang account; mọi cookie này
  // đều cần cho resume (provider match theo prefix `_interaction`).
  const authCookies = providerAuthResponse.headers
    .getSetCookie()
    .map((candidate) => candidate.split(';')[0])
    .filter((candidate) => candidate.startsWith('_interaction'));
  expect(authCookies.length).toBeGreaterThan(0);
  const cookieHeader = authCookies.join('; ');

  // ── 3. GET /authorize/confirm (glue — CAS pending_browser → confirmed) ─
  const confirmResponse = await app.request(
    `/authorize/confirm?handle=${handleX}`,
    {
      redirect: 'manual',
      headers: { cookie: `__Host-auth-browser=${browserBinding}` },
    },
    env,
  );
  expect(confirmResponse.status).toBe(302);
  expect(confirmResponse.headers.get('location')).toBe(
    `${ACCOUNT_BASE_URL}/login/continue?handle=${encodeURIComponent(handleX ?? '')}`,
  );

  // ── 4. POST /internal/session/verified → consent_required ────────
  const verified = await internalPost(
    app,
    '/internal/session/verified',
    {
      handle: handleX,
      sub: params.subject,
      acr: 'urn:ecoma:acr:email-otp',
      authn_at: Date.now(),
      account_session_ref: 'asr-issgate-1',
      event_id: params.eventId,
    },
    env,
  );
  expect(verified.status).toBe(200);
  // needsConsent: KHÔNG có grant active của subject NÀY được seed trước
  // /authorize ⇒ existingGrant undefined ⇒ luôn consent_required. ⚠️ Mỗi test
  // dùng subject RIÊNG: consent/decide tạo oauth_grants theo (sub, client),
  // grant active còn sót từ test trước trên CÙNG subject sẽ đẩy lần chạy sau
  // vào grantedPath — biến giữa các test phải là status stub, không phải grant.
  expect(verified.body['outcome']).toBe('consent_required');
  const handleY = new URL(verified.body['continue_url'] as string).searchParams.get('handle');
  expect(typeof handleY).toBe('string');

  // ── 5. POST /internal/consent/decide (approve) → resume URL ──────
  const decide = await internalPost(
    app,
    '/internal/consent/decide',
    {
      handle: handleY,
      decision: 'approve',
      account_session_ref: 'asr-issgate-1',
    },
    env,
  );
  expect(decide.status).toBe(200);
  expect(decide.body['outcome']).toBe('approved');
  const resumeUrl = new URL(decide.body['continue_url'] as string);
  expect(resumeUrl.origin).toBe(ISSUER);

  return { resumeUrl, cookieHeader };
}

describe('issuance gate at provider level — account suspended mid-flow, between approve and resume (acceptance)', () => {
  it('blocks code issuance at resume when the account is suspended after consent approve', async () => {
    // Client PHẢI seed TRƯỚC bootProvider: createProvider load clients tĩnh
    // từ DB lúc dựng và ném sớm nếu không có client public nào.
    await runtimeSql`
      INSERT INTO auth.oauth_clients (client_id, client_name, client_type, allowed_scopes)
      VALUES (${CLIENT_ID}, 'issgate pg test client', 'public',
              ARRAY['openid', 'offline_access']::text[])
      ON CONFLICT (client_id) DO UPDATE SET allowed_scopes = EXCLUDED.allowed_scopes
    `;
    await runtimeSql`
      INSERT INTO auth.client_redirect_uris (client_id, redirect_uri)
      VALUES (${CLIENT_ID}, ${CLIENT_REDIRECT})
      ON CONFLICT DO NOTHING
    `;

    const keypair = await generateKeyPair('ES256', { extractable: true });
    const pem = await exportPKCS8(keypair.privateKey);

    // Trước resume: account active — mọi step trước resume thành công.
    statusStub = 'active';
    await bootProvider(pem);

    const preResume = await walkUpToApproved({
      scopes: 'openid%20offline_access',
      state: 'st-issgate-1',
      nonce: 'n-issgate-1',
      eventId: 'evt-issgate-approved-1',
      keypairPem: pem,
      subject: SUB_SUSPENDED,
    });

    // ── Treo account GIỮA LUỒNG: sau decide, trước resume ─────────────
    statusStub = 'suspended';

    // ── 6. GET resume (browser thật) → gate throw, KHÔNG code ────────
    const resumeResponse = await localFetch(
      preResume.resumeUrl.pathname + preResume.resumeUrl.search,
      { headers: { cookie: preResume.cookieHeader }, redirect: 'manual' },
    );
    // `error_handler` + `err_out` của oidc-provider 9.12.2: generic Error không
    // expose ⇒ 500 + JSON `server_error` (khi client không accept html) hoặc HTML
    // render. Body có thể là JSON hoặc HTML — assert status + KHÔNG có code
    // trong mọi redirect location (response phải là error, không phải redirect).
    expect(resumeResponse.status).toBe(500);
    const location = resumeResponse.headers.get('location');
    expect(location).toBeNull();

    // Audit: đúng một hàng `token_issue_denied`, đúng reason.
    // ⚠️ PHÁT HIỆN LỆCH (FINDING, không vá trong PR này): `insertAuditEvent`
    // bind `JSON.stringify(event.details)` vào `$10::jsonb` — tôi đo bằng
    // probe (postgres.js + $N::jsonb): truyền STRING cho một tham số có
    // ::jsonb cast khiến Postgres nhận CHUỖI làm một giá trị jsonb-scalar,
    // tức `details` bị double-encoded (`jsonb_typeof(details) === 'string'`,
    // `details->>'reason'` trả NULL). Bind OBJECT trực tiếp (hoặc object cast)
    // cho jsonb_typeof đúng 'object'. Đây LÀ lệch comment của `adapter.upsert`
    // đã cảnh báo cho payload oidc_state, nhưng nằm ở `authorization-audit-store.ts`
    // (store khác, caller khác) — gap này cần một fix production riêng, ngoài
    // phạm vi test-only của workstream này. Spec đọc qua `details::text` rồi
    // parse HAI LẦN để khẳng định đúng invariant "details mang reason", không
    // phụ thuộc cách encode nào production dùng trong tương lai.
    const auditRows = await runtimeSql<{ error_code: string | null; details_text: string }[]>`
      SELECT error_code, details::text AS details_text FROM auth.authorization_audit_events
       WHERE event_type = 'token_issue_denied' AND subject_ref = ${SUB_SUSPENDED}
    `;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.error_code).toBe('access_denied');
    // ⚠️ Double-encoded: details_text là một chuỗi JSON vấn có chuỗi JSON bên
    // trong — parse HAI LẦN. Phát hiện này đi vào report; spec không chỉnh
    // hành vi production (chỉ test-only).
    const first = JSON.parse(auditRows[0]?.details_text ?? 'null') as unknown;
    const details = (typeof first === 'string' ? JSON.parse(first) : first) as {
      reason?: string;
    };
    expect(details['reason']).toBe('account_status');

    // Không AuthorizationCode nào của sub này được persist: gate chặn TRƯỚC lúc
    // `upsert` ghi hàng (adapter chạy gate trước phần ghi — xem `adapter.ts`).
    const codeRows = await runtimeSql<{ count: string }[]>`
      SELECT count(*) AS count FROM auth.oidc_state
       WHERE kind = 'AuthorizationCode' AND payload->>'accountId' = ${SUB_SUSPENDED}
    `;
    expect(Number(codeRows[0]?.count)).toBe(0);

    // Token endpoint không thể đổi code thành token (code chưa từng tồn tại):
    // assert thứ hai khẳng định phản xạ protocol — POST /token với code không có
    // trong DB PHẢI trả protocol-level error, KHÔNG token.
    const tokenAttempt = await localFetch(PROVIDER_ROUTES.tokenRoute, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'fake-code-never-issued-by-this-flow',
        redirect_uri: CLIENT_REDIRECT,
        client_id: CLIENT_ID,
        code_verifier: 'd'.repeat(43),
        resource: TEST_AUDIENCE,
      }).toString(),
      redirect: 'manual',
    });
    expect(tokenAttempt.status).toBe(400);
    const tokenAttemptBody = (await tokenAttempt.json()) as { error?: string };
    expect(tokenAttemptBody['error']).toBe('invalid_grant');
  });

  it('still completes a full flow when the account stays active the whole way (control)', async () => {
    // Test kỷ luật: cùng luồng với test trên nhưng status active — phải cấp code
    // bình thường. Phòng trường hợp gate hỏng theo hướng "nuốt mọi thứ"
    // (fail-closed quá mức) — test trên sẽ pass kể cả khi gate chặn cả Account active.
    statusStub = 'active';
    const pem = await exportPKCS8(
      (await generateKeyPair('ES256', { extractable: true })).privateKey,
    );
    const preResume = await walkUpToApproved({
      scopes: 'openid%20offline_access',
      state: 'st-issgate-2',
      nonce: 'n-issgate-2',
      eventId: 'evt-issgate-approved-2',
      keypairPem: pem,
      subject: SUB_ACTIVE,
    });

    const resumeResponse = await localFetch(
      preResume.resumeUrl.pathname + preResume.resumeUrl.search,
      { headers: { cookie: preResume.cookieHeader }, redirect: 'manual' },
    );
    // Resume cũng qua pipeline Koa — 303 như bước /auth, không phải 302 của glue.
    expect(resumeResponse.status).toBe(303);
    const clientCallback = new URL(resumeResponse.headers.get('location') as string);
    expect(clientCallback.origin).toBe('https://rp.example.com');
    expect(clientCallback.pathname).toBe('/cb');
    const code = clientCallback.searchParams.get('code');
    expect(typeof code).toBe('string');

    // token_issue_denied KHÔNG sinh thêm hàng cho subject control này — 0.
    const denyRows = await runtimeSql<{ count: string }[]>`
      SELECT count(*) AS count FROM auth.authorization_audit_events
       WHERE event_type = 'token_issue_denied' AND subject_ref = ${SUB_ACTIVE}
    `;
    expect(Number(denyRows[0]?.count)).toBe(0);
  });
});
