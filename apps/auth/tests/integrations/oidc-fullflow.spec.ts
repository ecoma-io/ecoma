/**
 * ACCEPTANCE — vòng giao thức §5.1.2 đầy đủ trên Node THẬT: oidc-provider thật,
 * adapter Postgres thật (bảng `auth.oidc_state`), PostgreSQL thật, khoá ES256 thật,
 * HMAC handle thật, CAS thật.
 *
 * ⚠️ Cầu `cloudflare:node` (`handleAsNodeRequest`) CHỈ tồn tại trên workerd — không
 * test được trong vitest. Nhánh Node của cùng cấu trúc đó là `createServer(
 * provider.callback())` của `node:http` — server này test được. Bridge `dispatchToNode`
 * ủy thác toàn bộ HTTP semantics cho Koa của provider qua server Node, nên xác minh
 * hành vi qua `provider.callback()` trên Node là bằng chứng có ý nghĩa cho cùng một
 * pipeline (chính `oidc/runtime.ts` dựng server đúng cách này). Phần KHÔNG cùng hàm
 * vận hành — biến môi trường workerd, socket nội bộ — được ghi rõ ở cuối file là
 * chưa verify, KHÔNG được tính là đã pass.
 *
 * Luồng xác minh (mỗi bước là một request HTTP thật hoặc một POST back-channel thật):
 *
 *   1. `GET /authorize` (glue ECOMA) → 302 tới `/auth` kèm `ecoma_x`, cookie
 *      `__Host-auth-browser` được set, hàng transaction `pending_browser` trong DB.
 *   2. `GET /auth` (provider thật) → 302 tới `interactions.url` — URL login của
 *      `account` mang handle X; hàng Interaction của `auth.oidc_state` tồn tại qua
 *      adapter thật.
 *   3. `GET /authorize/confirm?handle=X` (glue, mang cookie B) → CAS
 *      `pending_browser → browser_confirmed` trong DB.
 *   4. `POST /internal/session/verified` (envelope HMAC thật + nonce DB thật) →
 *      `consent_required` + `continue_url` consent UI; result `login` ĐÃ nằm trong
 *      Interaction (đọc lại qua `provider.Interaction.find` — adapter thật).
 *   5. `POST /internal/consent/decide` decision `approve` → `approved` +
 *      continue_url = resume URL của provider; provider Grant được lưu vào
 *      `auth.oidc_state` với jti = id của `oauth_grants`.
 *   6. `GET {resume}` bằng browser thật (fetch qua server Node với cookie
 *      `_interaction_resume` của bước 2) → provider cấp code, 302
 *      `redirect_uri?code=…&state=…` — code được persist qua adapter thật.
 *   7. `POST /token` → token response thật: access token JWT ES256 (`aud` đúng),
 *      ID token có `sub`/`acr`/`auth_time` từ result.login, refresh token tồn tại
 *      khi `offline_access`.
 *   8. `GET /.well-known/jwks.json` — JWKS công bố KHÔNG chứa `d`; ID token verify
 *      được bằng JWKS đó.
 *   9. Replay `session/verified` cùng event_id → idempotency §5.1.5a: cùng outcome.
 *
 * Docker là phụ thuộc cứng (fail-loud qua docker-probe của config integration —
 * không skip với exit 0).
 */

import type { Server } from 'node:http';

import postgres from 'postgres';
import { exportPKCS8, generateKeyPair, importJWK, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signRequest, createNonce } from '@ecoma-io/auth-contracts';
import { withPostgresClient } from '@ecoma-io/auth-infrastructure';

import { PROVIDER_ROUTES } from '../../src/oidc/provider';
import { loadAuthConfig, type AuthEnv } from '../../src/config';
import { startAuthDatabase, type AuthDatabase } from './harness';

/* ------------------------------------------------------------------ */
/* PostgreSQL harness — cùng luật với internal-handlers.spec.ts        */
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
const CLIENT_ID = 'client-fullflow-pg-test';
const CLIENT_REDIRECT = 'https://rp.example.com/cb';
const SUB = 'sub-fullflow-000000000000000000000000000';
const INTERNAL_SECRET = 'fullflow-internal-secret';
const TEST_AUDIENCE = 'https://api.ecoma.io/fullflow';
/** Audience phụ có allowlist client — dùng để pin client-allowlist của resource server. */
const RESTRICTED_AUDIENCE = 'https://office.ecoma.io/fullflow';
const ACCOUNT_BASE_URL = 'https://account.ecoma.io';
/** Issuer phải khớp origin của server Node cục bộ — provider dựng URL tuyệt đối từ nó. */
let ISSUER = 'http://127.0.0.1:0';

// Khai báo không-optional (như adapter.spec): test dùng thẳng không cần `!`.
// `afterAll` vẫn chạy khi `beforeAll` chết — cleanup nhận `undefined` ở runtime
// qua `?.` ở dưới, và các câu DELETE trong try/catch tự nuốt TypeError.
let runtimeSql: postgres.Sql;
let nodeServer: Server;
let nodePort = 0;

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
 * `runtime.ts` — bridge chỉ nhận các route provider), server Node của provider
 * không có route đó và trả 404 'Not Found' thuần.
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
 * Server Node bọc `provider.callback()` — CHÍNH XÁC cách `buildRuntime` dựng bridge:
 * cùng constructor, cùng hàm request handler; chỉ khác `listen(port)` thật thay vì
 * bridge socket nội bộ của workerd.
 */
async function bootProvider(pem: string): Promise<void> {
  // ⚠️ Port cấp TRƯỚC, issuer dựng TỪ port đó: provider phải được khởi tạo với
  // ĐÚNG origin mà mọi URL edge sẽ mang (ID token `iss` lấy nguyên văn từ
  // issuer của config — khởi tạo bằng `http://127.0.0.1:0` là `iss` lệch vĩnh
  // viễn so với resume URL dựng theo `x-forwarded-proto`). Đây cũng là bất biến
  // production: `AUTH_ISSUER` là origin đã biết trước tại deploy trên edge
  // Cloudflare, và mọi thứ (JWKS `iss`, resume URL, cookies scope) đều quy về
  // origin ấy. Ở đây port giữ vai trò "đã biết trước": mở server TRƯỚC, rồi
  // mới dựng provider trên cùng origin.
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
  // Issuer scheme PHẢI https (không phải scheme thật của socket test): wrapper ghi
  // đè `x-forwarded-proto: https` như bridge production, nên provider với
  // `proxy = true` dựng mọi URL tuyệt đối (returnTo → resume URL) theo https.
  // ISSUER lệch scheme là resumeUrl.origin không bao giờ khớp. localFetch vẫn
  // gọi socket http thật — chỉ dùng pathname+search, scheme của nó không vào ảnh.
  ISSUER = `https://127.0.0.1:${nodePort}`;

  const env = makeEnv(pem);
  const config = await loadAuthConfig(env);
  const { createProvider } = await import('../../src/oidc/provider');
  const postgresClientConfig = { hyperdrive: config.hyperdrive };
  const provider = await withPostgresClient(
    postgresClientConfig,
    async (staticClientsLoader) =>
      await createProvider({
        config,
        postgresClientConfig,
        staticClientsLoader,
        signingPem: config.signingKeyPem,
      }),
  );
  // Không gắn listener 'error' của provider: sự kiện này chỉ để chẩn đoán
  // (mọi lỗi giao thức đều đi qua response), và no-console cấm in từ test.
  // Giả lập nửa bridge của `dispatchToNode`: production luôn nhận https tại issuer
  // origin (Cloudflare edge), `withForwardedProto` ghi đè header từ URL scheme —
  // ở đây server là http thuần nên ghi đè thành 'https' để tái tạo đúng ngữ nghĩa
  // edge. Không bọc này là provider chết `Cannot send secure cookie` y như workerd
  // khi production thiếu một trong hai nửa (`proxy` + header) — test sẽ xanh giả
  // vì lý do sai, hoặc đỏ vì lý do không phải logic của glue.
  nodeServer = createServer(((req: unknown, res: unknown) => {
    const incoming = req as { headers: Record<string, string | string[] | undefined> };
    incoming.headers['x-forwarded-proto'] = 'https';
    (provider.callback() as (r: unknown, w: unknown) => void)(req, res);
  }) as never);
  // Port đã cấp ở trên — listen đúng port đó, issuer khớp origin của mọi URL.
  await new Promise<void>((resolve, reject) => {
    nodeServer.once('error', reject);
    nodeServer.listen(nodePort, '127.0.0.1', () => resolve());
  });
  void provider;
}

/**
 * Env khớp issuer thật của server Node — gọi SAU `bootProvider` (issuer mang
 * port thật do Node cấp).
 */
function makeEnv(pem: string): AuthEnv {
  return {
    HYPERDRIVE: {
      connectionString: `postgres://${db.runtimeUser}:${db.runtimePassword}@${db.host}:${db.port}/${db.database}`,
    },
    ACCOUNT_SERVICE: {
      fetch: async () => new Response(JSON.stringify({ status: 'active' })),
    },
    AUTH_SIGNING_KEY: pem,
    AUTH_SIGNING_KEY_ID: 'kid-fullflow',
    AUTH_HANDLE_KEY: HANDLE_KEY,
    AUTH_HANDLE_KEY_VERSION: '1',
    AUTH_INTERNAL_SECRET: INTERNAL_SECRET,
    AUTH_ISSUER: ISSUER,
    AUTH_AUDIENCE: TEST_AUDIENCE,
    AUTH_RESOURCES: JSON.stringify([
      { audience: RESTRICTED_AUDIENCE, clientIds: ['backoffice-only'] },
    ]),
    AUTH_COOKIE_KEYS: 'fullflow-cookie-key-1,fullflow-cookie-key-2',
    AUTH_ACCOUNT_BASE_URL: ACCOUNT_BASE_URL,
  };
}

/* ------------------------------------------------------------------ */
/* Suite                                                               */
/* ------------------------------------------------------------------ */

beforeAll(async () => {
  // Schema đã sẵn sàng bên trong `startAuthDatabase` (migration chạy một lần
  // lúc container lên, bằng credential migrator thật).
  db = await startAuthDatabase();
  runtimeSql = connectRuntime();
}, 180_000);

afterAll(async () => {
  nodeServer?.close();
  // ⚠️ Dọn đúng fixture của suite này trước khi đóng kết nối. Không dọn là
  // event_id cố định của lần chạy sau va chạm UNIQUE với hàng lần chạy trước
  // (`authorization_transactions_event_id_uniq`) — suite chỉ lặp lại được trên
  // database chưa từng chạy.internal-handlers.spec dọn theo cùng bộ luật.
  try {
    // Thứ tự tuân theo FK: scopes → grants → consent → codes → audit →
    // oidc_state → transactions (mọi subquery bám marker fixture của SUITE NÀY).
    await runtimeSql.unsafe(`
      DELETE FROM auth.client_grant_scopes
        WHERE grant_id IN (
          SELECT id FROM auth.oauth_grants WHERE sub LIKE 'sub-fullflow-%')
    `);
    await runtimeSql.unsafe(`
      DELETE FROM auth.oauth_grants WHERE sub LIKE 'sub-fullflow-%'
    `);
    await runtimeSql.unsafe(`
      DELETE FROM auth.oauth_consent_decisions
        WHERE authorization_transaction_id IN (
          SELECT transaction_id FROM auth.authorization_transactions
            WHERE event_id LIKE 'evt-fullflow-%')
    `);
    await runtimeSql.unsafe(`
      DELETE FROM auth.authorization_codes
        WHERE authorization_transaction_id IN (
          SELECT transaction_id FROM auth.authorization_transactions
            WHERE event_id LIKE 'evt-fullflow-%')
    `);
    // ⚠️ authorization_audit_events KHÔNG dọn: append-only (0009 thu DELETE
    // khỏi runtime role) — hàng audit của lần chạy trước ở lại là đúng thiết
    // kế, không phải rác; khối catch dưới không cứu được một câu bị từ chối
    // vì các DELETE sau nó trong cùng try đã không chạy.
    // Interaction/Session/Grant của provider nằm trong oidc_state — dọn theo
    // client và theo transaction correlator trước khi xoá transaction.
    await runtimeSql.unsafe(`
      DELETE FROM auth.oidc_state
        WHERE payload->>'clientId' = 'client-fullflow-pg-test'
           OR payload->>'accountId' = 'sub-fullflow-000000000000000000000000000'
    `);
    await runtimeSql.unsafe(`
      DELETE FROM auth.authorization_transactions
        WHERE event_id LIKE 'evt-fullflow-%'
    `);
  } catch {
    // Dọn thất bại không được che kết quả test; database test xem như dùng một lần.
  }
  // `?.` chứ không phải `.`: `beforeAll` chết (Docker mất, container không lên)
  // thì Vitest vẫn chạy `afterAll` — một throw ở đây đè lỗi thật của `beforeAll`.
  await runtimeSql?.end({ timeout: 1 });
  await db?.stop();
});

describe('oidc-provider full flow — against a real PostgreSQL (acceptance)', () => {
  it('walks the whole §5.1.2: authorize → provider → confirm → verified → decide → resume → token', async () => {
    // ── Dựng: khoá ES256 thật + env thật + provider thật trên server Node ─
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const pem = await exportPKCS8(privateKey);
    // Client thử nghiệm PHẢI seed TRƯỚC bootProvider: createProvider load clients
    // tĩnh từ DB lúc dựng và ném sớm nếu không có client public nào.
    await runtimeSql`
      INSERT INTO auth.oauth_clients (client_id, client_name, client_type, allowed_scopes)
      VALUES (${CLIENT_ID}, 'fullflow pg test client', 'public',
              ARRAY['openid', 'offline_access', 'profile']::text[])
      ON CONFLICT (client_id) DO UPDATE SET allowed_scopes = EXCLUDED.allowed_scopes
    `;
    await runtimeSql`
      INSERT INTO auth.client_redirect_uris (client_id, redirect_uri)
      VALUES (${CLIENT_ID}, ${CLIENT_REDIRECT})
      ON CONFLICT DO NOTHING
    `;
    await bootProvider(pem);
    const env = makeEnv(pem);

    // ── 1. GET /authorize (glue ECOMA, qua app Hono thật) ────────────────
    // Dùng `app.request` cho glue Hono (không cần server thứ hai) và fetch thật
    // cho pipeline provider. Glue + provider chia cùng PostgreSQL.
    const { default: app } = await import('../../src/main');

    // PKCE thật: verifier + challenge S256.
    const verifierBytes = new Uint8Array(32);
    crypto.getRandomValues(verifierBytes);
    const verifier = Buffer.from(verifierBytes).toString('base64url');
    const challenge = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    ).toString('base64url');

    const authorizeUrl =
      `/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(CLIENT_REDIRECT)}` +
      `&response_type=code&scope=openid%20offline_access&state=st-fullflow-1` +
      `&nonce=n-fullflow-1&code_challenge=${challenge}&code_challenge_method=S256`;
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

    // ── 2. GET /auth (provider thật, pipeline Koa thật qua server Node) ──
    // Cookie browser phải đi cùng để request giống browser thật (provider không
    // đọc nó — cookie B chỉ glue dùng — nhưng độ trung thực của luồng là mục tiêu).
    const providerAuthResponse = await localFetch(
      `${providerAuthUrl.pathname}${providerAuthUrl.search}`,
      { headers: { cookie: `__Host-auth-browser=${browserBinding}` } },
    );
    // Provider redirect bằng 303 (See Other — mặc định koa/provider cho GET);
    // glue Hono ở bước 1 mới là 302 — hai đường redirect khác nhau là chủ đích.
    expect(providerAuthResponse.status).toBe(303);
    const interactionUrl = new URL(providerAuthResponse.headers.get('location') as string);
    expect(interactionUrl.origin).toBe(ACCOUNT_BASE_URL);
    expect(interactionUrl.pathname).toBe('/login');
    expect(interactionUrl.searchParams.get('handle')).toBe(handleX);

    // Interaction nằm trong auth.oidc_state (adapter thật) với correlator ecoma_x.
    const interactionRows = await runtimeSql<{ id: string; return_to: string | null }[]>`
      SELECT id, payload->>'returnTo' AS return_to FROM auth.oidc_state
       WHERE kind = 'Interaction' AND payload->'params'->>'ecoma_x' = ${handleX}
    `;
    expect(interactionRows).toHaveLength(1);

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

    // ── 4. POST /internal/session/verified → consent_required ────────────
    const verifiedBody = {
      handle: handleX,
      sub: SUB,
      acr: 'urn:ecoma:acr:email-otp',
      authn_at: Date.now(),
      account_session_ref: 'asr-fullflow-1',
      event_id: 'evt-fullflow-verified-1',
    };
    const verified = await internalPost(app, '/internal/session/verified', verifiedBody, env);
    expect(verified.status).toBe(200);
    expect(verified.body['outcome']).toBe('consent_required');
    const consentUrl = new URL(verified.body['continue_url'] as string);
    expect(consentUrl.origin).toBe(ACCOUNT_BASE_URL);
    expect(consentUrl.pathname).toBe('/consent');
    const handleY = consentUrl.searchParams.get('handle');
    expect(typeof handleY).toBe('string');

    // result.login đã nằm trong Interaction (adapter thật, đọc qua DB).
    const withLogin = await runtimeSql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM auth.oidc_state WHERE kind = 'Interaction'
       AND payload->'params'->>'ecoma_x' = ${handleX}
    `;
    const loginResult = withLogin[0]?.payload['result'] as
      | { login?: { accountId?: string; acr?: string } }
      | undefined;
    expect(loginResult?.login?.accountId).toBe(SUB);
    expect(loginResult?.login?.acr).toBe('urn:ecoma:acr:email-otp');

    // ── 5. POST /internal/consent/decide (approve) → resume URL ──────────
    const decide = await internalPost(
      app,
      '/internal/consent/decide',
      {
        handle: handleY,
        decision: 'approve',
        account_session_ref: 'asr-fullflow-1',
      },
      env,
    );
    expect(decide.status).toBe(200);
    expect(decide.body['outcome']).toBe('approved');
    const resumeUrl = new URL(decide.body['continue_url'] as string);
    // Continue URL là resume URL của PROVIDER — tuyệt đối, cùng issuer.
    expect(resumeUrl.origin).toBe(ISSUER);

    // Provider Grant tồn tại với jti = id của oauth_grants.
    const grantRows = await runtimeSql<{ id: string; jti: string | null }[]>`
      SELECT g.id, p.id AS jti FROM auth.oauth_grants g
       JOIN auth.oidc_state p ON p.id = g.id::text
       WHERE g.sub = ${SUB} AND g.client_id = ${CLIENT_ID} AND g.status = 'active'
    `;
    expect(grantRows).toHaveLength(1);

    // ── 6. GET resume (browser thật — pipeline Koa thật cấp code) ────────
    // Browser giữ cookie `_interaction_resume` từ bước 2 (set bởi provider);
    // request này chứng minh đường resume + result áp + respond() cấp code.
    const resumeCookies: string[] = [];
    for (const [name, value] of providerAuthResponse.headers as unknown as Iterable<
      [string, string]
    >) {
      if (name === 'set-cookie') resumeCookies.push(value);
    }
    // `headers` của fetch là iterator lowercase tên — gom mọi set-cookie thực tế.
    const rawResumeCookieHeaders = providerAuthResponse.headers.getSetCookie?.() ?? [];
    const interactionResumeCookies = rawResumeCookieHeaders
      .map((c) => c.split(';')[0])
      .filter((c) => c.startsWith('_interaction'));
    const cookieHeader = [...interactionResumeCookies, ...resumeCookies.map((c) => c.split(';')[0])]
      .filter((c) => c.startsWith('_interaction'))
      .join('; ');
    expect(cookieHeader).not.toBe('');

    const resumeResponse = await localFetch(resumeUrl.pathname + resumeUrl.search, {
      headers: { cookie: cookieHeader },
      redirect: 'manual',
    });
    // Resume cũng qua pipeline Koa — 303 như bước 2, không phải 302 của glue.
    expect(resumeResponse.status).toBe(303);
    const clientCallback = new URL(resumeResponse.headers.get('location') as string);
    expect(clientCallback.origin).toBe('https://rp.example.com');
    expect(clientCallback.pathname).toBe('/cb');
    expect(clientCallback.searchParams.get('state')).toBe('st-fullflow-1');
    const code = clientCallback.searchParams.get('code');
    expect(typeof code).toBe('string');

    // ── 7. POST /token — token thật, verify bằng JWKS công bố ────────────
    const tokenRequest = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code as string,
      redirect_uri: CLIENT_REDIRECT,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      resource: TEST_AUDIENCE,
    });
    const tokenResponse = await localFetch(PROVIDER_ROUTES.tokenRoute, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenRequest.toString(),
      redirect: 'manual',
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      id_token: string;
      refresh_token?: string;
      token_type: string;
    };
    expect(tokens.token_type).toBe('Bearer');
    expect(typeof tokens.access_token).toBe('string');
    // `offline_access` được yêu cầu ⇒ refresh token phải được cấp.
    expect(typeof tokens.refresh_token).toBe('string');

    // ── 8. JWKS công bố không chứa khoá riêng; ID token verify được ──────
    const jwksResponse = await localFetch(PROVIDER_ROUTES.jwks);
    expect(jwksResponse.status).toBe(200);
    const jwks = (await jwksResponse.json()) as { keys: Record<string, unknown>[] };
    expect(jwks.keys.length).toBeGreaterThan(0);
    for (const key of jwks.keys) {
      expect(key['d']).toBeUndefined();
    }
    const idClaims = (
      await jwtVerify(
        tokens.id_token,
        (await importJWK({ ...jwks.keys[0], alg: 'ES256' }, 'ES256')) as never,
        {
          issuer: ISSUER,
          audience: CLIENT_ID,
        },
      )
    ).payload as Record<string, unknown>;
    expect(idClaims['sub']).toBe(SUB);
    expect(idClaims['acr']).toBe('urn:ecoma:acr:email-otp');
    expect(typeof idClaims['auth_time']).toBe('number');

    // Access token: ES256, aud = resource indicator.
    const accessClaims = (
      await jwtVerify(
        tokens.access_token,
        (await importJWK({ ...jwks.keys[0], alg: 'ES256' }, 'ES256')) as never,
        {
          issuer: ISSUER,
          audience: TEST_AUDIENCE,
        },
      )
    ).payload as Record<string, unknown>;
    expect(accessClaims['sub']).toBe(SUB);

    // ── 9. Replay session/verified cùng event — §5.1.5a ──────────────────
    const replay = await internalPost(app, '/internal/session/verified', verifiedBody, env);
    expect(replay.status).toBe(200);
    // Transaction đã qua resume (bước 6 destroy Interaction) ⇒ luồng ĐÃ hoàn
    // tất qua provider ⇒ `already_processed` — KHÔNG phải `granted` giả
    // (không còn continuation hợp lệ nào) và không phải `invalid_grant`
    // (ngược §5.1.6: retry không dẫn tới trạng thái không thể tiếp tục).
    expect(replay.body['outcome']).toBe('already_processed');

    // ── 10. FR-018a: reuse RT cũ ⇒ InvalidGrant + THU HỒI TOÀN FAMILY ────
    // Rotate một lần nữa để có RT mới (RT đầu đã bị consume lúc rotate đầu);
    // rồi dùng lại RT cũ — provider phải ném `refresh token already used`
    // (actions/grants/refresh_token.js:107-112) và revoke(ctx, grantId) xoá MỌI
    // artifact của grant qua adapter thật — khẳng định của 02-requirements.md:159:
    // "dùng lại token cũ → toàn family hết hiệu lực".
    const rt1 = tokens.refresh_token as string;
    const refreshRotate = await localFetch(PROVIDER_ROUTES.tokenRoute, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: rt1,
        client_id: CLIENT_ID,
        resource: TEST_AUDIENCE,
      }).toString(),
      redirect: 'manual',
    });
    expect(refreshRotate.status).toBe(200);
    const rotated = (await refreshRotate.json()) as { refresh_token?: string };
    expect(typeof rotated.refresh_token).toBe('string');
    const rt2 = rotated.refresh_token as string;

    const reuse = await localFetch(PROVIDER_ROUTES.tokenRoute, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: rt1,
        client_id: CLIENT_ID,
        resource: TEST_AUDIENCE,
      }).toString(),
      redirect: 'manual',
    });
    // Provider trả 400 invalid_grant — KHÔNG token nào được cấp từ RT đã consume.
    // ⚠️ `error_description` của InvalidGrant là hằng 'grant request is invalid'
    // (errors.js:97); message chi tiết nằm trong `error_detail` (errors.js:100-103),
    // chỉ lộ khi `features.cookies`/detail expose — do đó assert đúng nghĩa: code
    // invalid_grant và — quan trọng hơn — HẬU QUẢ thu hồi family ở dưới là bằng
    // chứng thật, không phải chuỗi lỗi.
    expect(reuse.status).toBe(400);
    const reuseBody = (await reuse.json()) as { error?: string };
    expect(reuseBody.error).toBe('invalid_grant');

    // ⚠️ Family hết hiệu lực là HÀNH VI ĐO ĐƯỢC, không phải lời hứa: RT vừa rotate
    // (rt2 — sinh SAU reuse, cùng grant) phải chết theo revokeByGrantId của adapter,
    // và MỌI hàng oidc_state của grant phải biến mất.
    const reuseRt2 = await localFetch(PROVIDER_ROUTES.tokenRoute, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: rt2,
        client_id: CLIENT_ID,
        resource: TEST_AUDIENCE,
      }).toString(),
      redirect: 'manual',
    });
    expect(reuseRt2.status).toBe(400);
    const grantRowsAfter = await runtimeSql<{ kind: string; id: string }[]>`
      SELECT kind, id FROM auth.oidc_state
       WHERE kind IN ('RefreshToken', 'AccessToken')
         AND payload->>'clientId' = ${CLIENT_ID}
         AND payload->>'accountId' = ${SUB}
    `;
    // Toàn bộ token của grant đã bị revoke(ctx, grantId) xoá — không còn hàng nào
    // sống sót (bảng audit vẫn giữ bằng chứng cấp, đúng thiết kế append-only).
    expect(grantRowsAfter).toHaveLength(0);
  });

  it('decide deny — result.error access_denied, NO grant created', async () => {
    // Provider đã chạy từ test trước (server Node cùng process) — env khớp issuer đó.
    // Key riêng cho test này chỉ phục vụ makeEnv; provider không dựng lại.
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const env = makeEnv(pem);
    const { default: app } = await import('../../src/main');

    const challenge = Buffer.from(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode('deny-verifier-0000000000000000000'),
      ),
    ).toString('base64url');
    const authorizeResponse = await app.request(
      `/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(CLIENT_REDIRECT)}` +
        // Scope 'profile' chưa có trong grant active từ test trước ⇒ needsConsent
        // trả true ⇒ mới có đường awaiting_consent + handle Y để decide deny.
        // (scope=openid thuần đã được grant phủ ⇒ grantedPath — không có consent.)
        `&response_type=code&scope=openid%20profile&state=st-deny&nonce=n-deny` +
        `&code_challenge=${challenge}&code_challenge_method=S256`,
      { redirect: 'manual' },
      env,
    );
    expect(authorizeResponse.status).toBe(302);
    const providerAuthUrl = new URL(authorizeResponse.headers.get('location') as string);
    const handleX = providerAuthUrl.searchParams.get('ecoma_x');
    const setCookie = authorizeResponse.headers.get('set-cookie') ?? '';
    const browserBinding = setCookie.split(';')[0]?.split('=')[1];

    await localFetch(providerAuthUrl.pathname + providerAuthUrl.search, {
      headers: { cookie: `__Host-auth-browser=${browserBinding}` },
    });
    await app.request(
      `/authorize/confirm?handle=${handleX}`,
      { redirect: 'manual', headers: { cookie: `__Host-auth-browser=${browserBinding}` } },
      env,
    );
    const verified = await internalPost(
      app,
      '/internal/session/verified',
      {
        handle: handleX,
        sub: SUB,
        acr: 'urn:ecoma:acr:email-otp',
        authn_at: Date.now(),
        account_session_ref: 'asr-fullflow-deny',
        event_id: 'evt-fullflow-verified-deny',
      },
      env,
    );
    expect(verified.status).toBe(200);
    const handleY = new URL(verified.body['continue_url'] as string).searchParams.get('handle');

    const decide = await internalPost(
      app,
      '/internal/consent/decide',
      {
        handle: handleY,
        decision: 'deny',
        account_session_ref: 'asr-fullflow-deny',
      },
      env,
    );
    expect(decide.status).toBe(200);
    expect(decide.body['outcome']).toBe('denied');
    // Continue URL là resume URL — browser quay lại provider để nhận
    // `error=access_denied` qua authError redirect của provider.
    const resumeUrl = new URL(decide.body['continue_url'] as string);
    expect(resumeUrl.origin).toBe(ISSUER);

    // Không grant nào được tạo cho transaction này.
    const grants = await runtimeSql<{ id: string }[]>`
      SELECT id FROM auth.oauth_grants WHERE sub = ${SUB} AND client_id = ${CLIENT_ID}
    `;
    // Test approve trước đã tạo một grant active; deny KHÔNG được tạo thêm.
    expect(grants.length).toBe(1);
  });

  it('a registered client requesting a restricted resource it is not allowlisted for is refused (client-allowlist gate)', async () => {
    // Provider đã boot với AUTH_RESOURCES khai RESTRICTED_AUDIENCE cho riêng
    // client 'backoffice-only'. Client fullflow (không nằm allowlist) xin thẳng
    // resource đó qua /auth: authorize path gọi getResourceServerInfo với client
    // của request (check_resource.js:75) — gate phải InvalidTarget TRƯỚC khi có
    // transaction nào, dù audience có trong registry.
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const env = makeEnv(pem);
    const { default: app } = await import('../../src/main');

    const challenge = Buffer.from(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode('allowlist-verifier-000000000000000'),
      ),
    ).toString('base64url');
    const providerResponse = await app.request(
      `/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(CLIENT_REDIRECT)}` +
        `&response_type=code&scope=openid&state=st-allowlist&nonce=n-allowlist` +
        `&code_challenge=${challenge}&code_challenge_method=S256` +
        `&resource=${encodeURIComponent(RESTRICTED_AUDIENCE)}`,
      { redirect: 'manual' },
      env,
    );
    // Glue /authorize chỉ forward params trong allowlist — `resource` KHÔNG nằm
    // trong AUTHORIZED_FORWARD_PARAMS (glue tự chọn resource theo client), nên
    // request qua glue KHÔNG bao giờ chạm gate với resource lạ. Đi thẳng provider
    // mới là đường bypass thật cần chặn:
    expect(providerResponse.status).toBe(302);
    const providerAuthUrl = new URL(providerResponse.headers.get('location') as string);
    const directUrl = new URL(`${ISSUER}/auth`);
    for (const key of [
      'client_id',
      'redirect_uri',
      'response_type',
      'scope',
      'state',
      'nonce',
      'code_challenge',
      'code_challenge_method',
    ]) {
      const value = providerAuthUrl.searchParams.get(key);
      if (value !== null) directUrl.searchParams.set(key, value);
    }
    directUrl.searchParams.set('resource', RESTRICTED_AUDIENCE);

    const refused = await localFetch(directUrl.pathname + directUrl.search, {
      redirect: 'manual',
    });
    // InvalidTarget GIỮA authorize flow (sau khi redirect_uri đã kiểm) là error
    // redirectable theo RFC 6749 §4.1.2.1: 303 về redirect_uri của client mang
    // error=invalid_target — KHÔNG phải trang 400.
    expect(refused.status).toBe(303);
    const errorUrl = new URL(refused.headers.get('location') as string);
    expect(errorUrl.origin).toBe('https://rp.example.com');
    expect(errorUrl.searchParams.get('error')).toBe('invalid_target');
  });
});
