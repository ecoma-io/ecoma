/**
 * ACCEPTANCE — RP-initiated logout (`end_session`, §6.7 docs/applications/auth/01-architecture.md)
 * trên Node THẬT: oidc-provider thật, adapter Postgres thật (bảng
 * `auth.oidc_state`), PostgreSQL thật, khoá ES256 thật, session thật.
 *
 * ⚠️ Cầu `cloudflare:node` (`handleAsNodeRequest`) CHỈ tồn tại trên workerd —
 * cùng luật với `oidc-fullflow.spec.ts`: server Node cục bộ bọc
 * `provider.callback()` là nửa cùng hàm vận hành (`oidc/runtime.ts` dựng server
 * đúng cách này); biến môi trường workerd chưa được verify (ghi ở cuối file).
 *
 * Bằng chứng protocol, KHÔNG phải so metadata với hằng:
 *
 *   1. Endpoint thực sự được mount: `GET /session/end` KHÔNG 404/405 — với
 *      browser chưa có session, provider tự hoàn tất logout (form_post trang
 *      confirm mang `logout: 'yes'`); với session thật, trang confirm HTML
 *      render (end_session.js renderLogout). Mount là bằng chứng ở chính
 *      pipeline chạy qua, không ở một route stub.
 *   2. `post_logout_redirect_uri` KHÔNG đăng ký với client ⇒ 4xx
 *      `invalid_request` (end_session.js:70-76) — logout SẼ ĐI QUA bao nhiêu
 *      cũng được nhưng KHÔNG bị đưa tới URI tuỳ ý. Open-redirect chặn
 *      fail-closed là hành vi thật đo được, không phải đọc source.
 *   3. Confirm POST (form thật từ trang confirm: `xsrf` từ HTML + cookie
 *      `_session` thật) → 303 về `end_session_success` và hàng Session biến
 *      mất khỏi `auth.oidc_state` — destroy() chạy thật qua adapter.
 *   4. Discovery provider thật khai `end_session_endpoint` đúng route mounted
 *      — cặp advertised ↔ mounted đo trên document thật và trên response
 *      không-404; shadow Hono ghim cùng bất biến ở `main.spec.ts`.
 *
 * ⚠️ Thiếu Docker (nên không có PostgreSQL) ⇒ SKIP toàn bộ — skip không phải
 * pass; report phải nêu.
 */

import type { Server } from 'node:http';

import postgres from 'postgres';
import { exportPKCS8, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROVIDER_ROUTES } from '../../src/oidc/provider';
import { loadAuthConfig, type AuthEnv } from '../../src/config';
import { withPostgresClient } from '@ecoma-io/auth-infrastructure';
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

const CLIENT_ID = 'client-endsession-pg-test';
const CLIENT_REDIRECT = 'https://rp-endsession.example.com/cb';
const SUB = 'sub-endsession-00000000000000000000000000000';
const INTERNAL_SECRET = 'endsession-internal-secret';
const TEST_AUDIENCE = 'https://api.ecoma.io/endsession';
const ACCOUNT_BASE_URL = 'https://account.ecoma.io';
const HANDLE_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** Issuer dựng từ port thật của server Node (cùng luật với fullflow). */
let ISSUER = 'https://127.0.0.1:0';
let nodeServer: Server;
let nodePort = 0;
let runtimeSql: postgres.Sql;

/** Bọc `fetch` trỏ về server Node cục bộ, bỏ qua DNS của ISSUER (fullflow). */
async function localFetch(path: string, init?: RequestInit): Promise<Response> {
  return await fetch(`http://127.0.0.1:${nodePort}${path}`, {
    ...init,
    redirect: 'manual',
  });
}

/**
 * Gom cookie set-cookie thành một header `cookie` — bỏ attributes. Chỉ cookie
 * của provider (`_session*`/`_interaction*`) đi qua; cookie glue
 * `__Host-auth-browser` là của lane Hono, không ăn nhập ở đây.
 */
function collectCookies(response: Response): string {
  const raw = response.headers.getSetCookie?.() ?? [];
  return raw
    .map((c) => c.split(';')[0])
    .filter((c) => c.startsWith('_session') || c.startsWith('_interaction'))
    .join('; ');
}

/** Assert id là string — phục vụ `unsafe([...])` tham số hoá */
function stringOf(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError(`expected string id, got ${typeof value}`);
  return value;
}

/**
 * Server Node bọc `provider.callback()` — chính hình dạng `bootProvider` của
 * oidc-fullflow.spec.ts: port cấp trước, issuer dựng từ port, wrapper ghi đè
 * `x-forwarded-proto` đúng ngữ nghĩa edge (provider `proxy = true`).
 */
async function bootProvider(pem: string): Promise<void> {
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

/** Env khớp issuer thật — gọi SAU `bootProvider` (cùng luật với fullflow). */
function makeEnv(pem: string): AuthEnv {
  return {
    HYPERDRIVE: {
      connectionString: `postgres://${db.runtimeUser}:${db.runtimePassword}@${db.host}:${db.port}/${db.database}`,
    },
    ACCOUNT_SERVICE: {
      fetch: async () => new Response(JSON.stringify({ status: 'active' })),
    },
    AUTH_SIGNING_KEY: pem,
    AUTH_SIGNING_KEY_ID: 'kid-endsession',
    AUTH_HANDLE_KEY: HANDLE_KEY,
    AUTH_HANDLE_KEY_VERSION: '1',
    AUTH_INTERNAL_SECRET: INTERNAL_SECRET,
    AUTH_ISSUER: ISSUER,
    AUTH_AUDIENCE: TEST_AUDIENCE,
    AUTH_COOKIE_KEYS: 'endsession-cookie-key-1,endsession-cookie-key-2',
    AUTH_ACCOUNT_BASE_URL: ACCOUNT_BASE_URL,
  };
}

beforeAll(async () => {
  // Schema đã sẵn sàng bên trong `startAuthDatabase` (migration chạy một lần
  // lúc container lên, bằng credential migrator thật).
  db = await startAuthDatabase();
  runtimeSql = connectRuntime();
}, 180_000);

afterAll(async () => {
  nodeServer?.close();
  // ⚠️ Dọn đúng fixture của SUITE NÀY theo marker (`endsession`); bảng audit
  // KHÔNG dọn (append-only — hàng test ở lại là đúng thiết kế).
  try {
    await runtimeSql?.unsafe(
      `DELETE FROM auth.client_grant_scopes
        WHERE grant_id IN (
          SELECT id FROM auth.oauth_grants WHERE sub LIKE 'sub-endsession-%')`,
    );
    await runtimeSql?.unsafe(`DELETE FROM auth.oauth_grants WHERE sub LIKE 'sub-endsession-%'`);
    await runtimeSql?.unsafe(
      `DELETE FROM auth.oidc_state
        WHERE payload->>'clientId' = ${CLIENT_ID}
           OR payload->>'accountId' = ${SUB}`,
    );
    await runtimeSql?.unsafe(
      `DELETE FROM auth.client_redirect_uris WHERE client_id = ${CLIENT_ID}`,
    );
    await runtimeSql?.unsafe(`DELETE FROM auth.oauth_clients WHERE client_id = ${CLIENT_ID}`);
  } catch {
    // Dọn thất bại không được che kết quả test; database test xem như dùng một lần.
  }
  await runtimeSql?.end({ timeout: 1 });
  await db?.stop();
});

describe('RP-initiated logout (/session/end) — against a real PostgreSQL (acceptance)', () => {
  it('mounts GET /session/end, rejects an unregistered post_logout_redirect_uri, and destroys the session on the real confirm POST', async () => {
    // ── Dựng: khoá ES256 thật + env thật + provider thật trên server Node ─
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const pem = await exportPKCS8(privateKey);
    // Client fixture PHẢI seed trước bootProvider: createProvider load clients
    // tĩnh lúc dựng và ném sớm khi không có client public nào (fullflow).
    await runtimeSql`
        INSERT INTO auth.oauth_clients (client_id, client_name, client_type, allowed_scopes)
        VALUES (${CLIENT_ID}, 'endsession pg test client', 'public',
                ARRAY['openid', 'offline_access', 'profile']::text[])
        ON CONFLICT (client_id) DO UPDATE SET allowed_scopes = EXCLUDED.allowed_scopes
      `;
    await runtimeSql`
        INSERT INTO auth.client_redirect_uris (client_id, redirect_uri)
        VALUES (${CLIENT_ID}, ${CLIENT_REDIRECT})
        ON CONFLICT DO NOTHING
      `;
    await bootProvider(pem);

    // ── 1. Discovery của provider thật khai end_session = route sống ─────
    // Cặp với shadow Hono ở main.spec.ts: advertised trên document thật
    // phải khớp mounted (các bước dưới đo mounted bằng response không-404
    // và đường HTML thật).
    const discoveryResponse = await localFetch('/.well-known/openid-configuration');
    expect(discoveryResponse.status).toBe(200);
    const discovery = (await discoveryResponse.json()) as Record<string, unknown>;
    expect(discovery['end_session_endpoint']).toBe(`${ISSUER}${PROVIDER_ROUTES.end_session}`);

    // ── 2. GET /session/end KHÔNG mount-là-404: pipeline chạy tới HTML ──
    // Browser chưa có session → provider tự hoàn tất (form_post confirm
    // mang logout: 'yes'); có session ⇒ trang confirm (bước 6).
    const anonymous = await localFetch(PROVIDER_ROUTES.end_session, { redirect: 'manual' });
    expect(anonymous.status).not.toBe(404);
    expect(anonymous.status).not.toBe(405);
    const anonymousBody = await anonymous.text();
    expect(anonymousBody).toContain('<form method="post"');
    expect(anonymousBody).toContain('name="xsrf"');
    const anonymousAction = new URL(anonymousBody.match(/action="([^"]+)"/u)?.[1] ?? '').pathname;
    expect(anonymousAction).toBe(`${PROVIDER_ROUTES.end_session}/confirm`);

    // ── 3. Session THẬT: dựng bằng pipeline authorization của provider ──
    // PKCE thật + một request /auth thật (Interaction thật —/quả adapter) +
    // result gắn trực tiếp vào Interaction (cùng cách attachInteractionResult
    // của back-channel làm) + resume của browser.
    const verifierBytes = new Uint8Array(32);
    crypto.getRandomValues(verifierBytes);
    const verifier = Buffer.from(verifierBytes).toString('base64url');
    const challenge = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    ).toString('base64url');
    const handleXFixture = 'x-endsession-fixture-000000000000000000000000000000000';
    const authQuery = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: CLIENT_REDIRECT,
      response_type: 'code',
      scope: 'openid',
      state: 'st-endsession-1',
      nonce: 'n-endsession',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: TEST_AUDIENCE,
      // Policy của auth ÉP prompt login+consent trên MỌI authorization, và
      // `interactions.url` ĐÒI handle X trong params — thiếu là provider
      // ném 500. Logout test KHÔNG đi glue ECOMA: session dựng qua result
      // + resume, tương đương browser quay lại sau back-channel.
      ecoma_x: handleXFixture,
      prompt: 'login consent',
    });
    const authResponse = await localFetch(`/auth?${authQuery}`, { redirect: 'manual' });
    expect(authResponse.status).toBe(303);
    const interactionUrl = new URL(authResponse.headers.get('location') as string);
    expect(interactionUrl.origin).toBe(ACCOUNT_BASE_URL);
    expect(interactionUrl.searchParams.get('handle')).toBe(handleXFixture);

    // Interaction thật trong auth.oidc_state (partial index 0013: correlator).
    const interactions = await runtimeSql<{ id: string; payload: Record<string, unknown> }[]>`
        SELECT id, payload FROM auth.oidc_state
         WHERE kind = 'Interaction'
           AND payload->'params'->>'ecoma_x' = ${handleXFixture}
      `;
    expect(interactions).toHaveLength(1);

    // Provider Grant (kind 'Grant' của oidc_state): payload đúng IN_PAYLOAD
    // của Grant model 9.12.2 (`models/grant.js`) — `openid.scope` là chuỗi
    // (không phải mảng), `openid.claims` là mảng; resume của provider đọc
    // các trường đó qua `getOIDCScopeFiltered`.
    const providerGrantId = crypto.randomUUID();
    const nowSec = Math.floor(Date.now() / 1000);
    const grantPayload = {
      jti: providerGrantId,
      kind: 'Grant',
      iat: nowSec,
      exp: nowSec + 30 * 24 * 60 * 60,
      accountId: SUB,
      clientId: CLIENT_ID,
      openid: { scope: 'openid', claims: ['sub', 'acr', 'auth_time'] },
      resource: {},
      resources: [],
      resource_accounts: {},
    };
    // ⚠️ Bind qua `unsafe` tham số hoá — ĐÚNG pattern `adapter.upsert`
    // (adapter.ts:150-170): payload bind TRỰC TIẾT object, KHÔNG
    // `JSON.stringify` (postgres.js nhận string làm jsonb-scalar ⇒
    // double-encoded). Tagged template của driver chỉ nhận
    // `SerializableParameter` (string/number/Date...), không nhận object —
    // nên object PHẢI đi qua `unsafe` (định `ParameterOrJSON`).
    await runtimeSql.unsafe(
      `INSERT INTO auth.oidc_state (kind, id, payload, expires_at)
         VALUES ('Grant', $1, $2, now() + interval '30 days')`,
      [providerGrantId, grantPayload],
    );

    // Result gắn bằng UPDATE payload — chính cách attachInteractionResult
    // sửa Interaction trong DB.
    const interactionPayload = interactions[0]?.['payload'] as Record<string, unknown>;
    interactionPayload['result'] = {
      login: {
        remember: true,
        accountId: SUB,
        ts: nowSec,
        acr: 'urn:ecoma:acr:email-otp',
      },
      consent: { grantId: providerGrantId },
    };
    // Interaction ID đọc từ SELECT trước — một row, không có giá trị nào từ
    // request chạm chuỗi SQL; payload bind object trực tiếp (xem lý do ở
    // INSERT Grant phía trên). Cast sang `JSONValue` của driver: `unsafe`
    // định `ParameterOrJSON`, và payload jsonb parse từ SELECT mang kiểu
    // `Record<string, unknown>` — `unknown` không thuộc `JSONValue`.
    await runtimeSql.unsafe(
      `UPDATE auth.oidc_state SET payload = $2
         WHERE kind = 'Interaction' AND id = $1`,
      [stringOf(interactions[0]?.['id']), interactionPayload as postgres.JSONValue],
    );

    // ── 4. Resume: cấp code và SESSION COOKIE (precondition của logout) ─
    // Browser quay lại RESUME URL của provider (`/auth/:uid`), KHÔNG theo
    // redirect tới account. Cookie gửi là bộ set-cookie của bước 3 — resume
    // cần `_interaction_resume` (path = pathname resume) và `_interaction`
    // (path = pathname login của account, nên KHÔNG khớp /auth/:uid) để
    // tìm Interaction. `returnTo` của Interaction là nguồn đọc: lấy từ
    // payload, không tự dựng URL.
    const resumeCookies = collectCookies(authResponse);
    expect(resumeCookies).toContain('_interaction_resume=');
    const returnTo = (interactions[0]?.['payload'] as Record<string, unknown>)?.[
      'returnTo'
    ] as string;
    // returnTo là ABSOLUTE URL dựng từ issuer của provider — lấy pathname.
    const resumePathname = new URL(returnTo).pathname;
    expect(resumePathname).toMatch(/^\/auth\//u);
    const resumeResponse = await localFetch(resumePathname, {
      headers: { cookie: resumeCookies },
      redirect: 'manual',
    });
    // Resume thành công = result áp + code cấp — 303 tới redirect_uri.
    expect(resumeResponse.status).toBe(303);
    const clientCallback = new URL(resumeResponse.headers.get('location') as string);
    expect(clientCallback.origin).toBe('https://rp-endsession.example.com');
    expect(typeof clientCallback.searchParams.get('code')).toBe('string');

    // Session thật tồn tại trong auth.oidc_state (kind 'Session' là một
    // trong 7 kind hợp lệ của CHECK 0013).
    const sessionBefore = await runtimeSql<{ id: string }[]>`
        SELECT id FROM auth.oidc_state
         WHERE kind = 'Session' AND payload->>'accountId' = ${SUB}
      `;
    expect(sessionBefore.length).toBeGreaterThanOrEqual(1);

    // ── 5. GET /session/end VỚI session: trang confirm HTML + xsrf —─────
    // client_id chọn đúng path else-if (end_session.js:62-66), không cần
    // id_token_hint: chính luồng logout "client đổi callback" là ca thật.
    const withSession = await localFetch(
      `${PROVIDER_ROUTES.end_session}?client_id=${CLIENT_ID}&state=st-out-1`,
      {
        redirect: 'manual',
        headers: { cookie: collectCookies(resumeResponse) },
      },
    );
    expect(withSession.status).toBe(200);
    const confirmHtml = await withSession.text();
    expect(confirmHtml).toContain('op.logoutForm');
    // xsrf bị useState bảo vệ (generateXsrf sinh secret mới vào session.state).
    expect(confirmHtml).toMatch(/name="xsrf" value="[0-9a-f]+"/u);
    expect(confirmHtml).toContain('form="op.logoutForm"');

    // ⚠️ post_logout_redirect_uri KHÔNG đăng ký: chặn tại REQUEST (bước
    // endSessionChecks của end_session.js:70-76) — 400 invalid_request,
    // KHÔNG touch session và KHÔNG có redirect tuỳ ý.
    const rogueRedirect = await localFetch(
      `${PROVIDER_ROUTES.end_session}?client_id=${CLIENT_ID}` +
        `&post_logout_redirect_uri=${encodeURIComponent('https://evil.example.com/after-logout')}`,
      { redirect: 'manual', headers: { cookie: collectCookies(resumeResponse) } },
    );
    // Provider trả 400 kèm trang renderError của mặc định — bằng chứng
    // từ chối giữ ở HTTP semantics, không phải chỉ trong body.
    expect(rogueRedirect.status).toBeGreaterThanOrEqual(400);
    expect(rogueRedirect.status).toBeLessThan(500);
    expect(rogueRedirect.headers.get('location')).toBeNull();
    const rogueText = await rogueRedirect.text();
    expect(rogueText).not.toContain('https://evil.example.com');
    // Session KHÔNG bị destroy bởi attempt chặn — đếm số hàng Session
    // không giảm từ trước khi tại đây.
    const sessionAfterRogue = await runtimeSql<{ id: string }[]>`
        SELECT id FROM auth.oidc_state
         WHERE kind = 'Session' AND payload->>'accountId' = ${SUB}
      `;
    expect(sessionAfterRogue.length).toBe(sessionBefore.length);

    // ── 6. Confirm POST với form thật (xsrf từ HTML + cookie session) ───
    const xsrfMatch = confirmHtml.match(/name="xsrf" value="([0-9a-f]+)"/u);
    expect(xsrfMatch).not.toBeNull();
    const xsrf = xsrfMatch?.[1] as string;
    const confirmUrl = new URL(confirmHtml.match(/action="([^"]+)"/u)?.[1] ?? '', ISSUER);
    expect(confirmUrl.pathname).toBe(`${PROVIDER_ROUTES.end_session}/confirm`);

    const confirmResponse = await localFetch(confirmUrl.pathname + confirmUrl.search, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: collectCookies(withSession),
      },
      body: new URLSearchParams({ xsrf, logout: 'yes' }).toString(),
    });
    // Confirm destroy + revoke rồi 303 về end_session_success (không dùng
    // post_logout_redirect_uri ở bước này).
    expect(confirmResponse.status).toBe(303);
    const confirmLocation = confirmResponse.headers.get('location') as string;
    expect(confirmLocation).toBe(`${ISSUER}${PROVIDER_ROUTES.end_session}/success`);

    // Session cookie bị clear (expired) trong response của confirm.
    const confirmSetCookies = confirmResponse.headers.getSetCookie?.() ?? [];
    expect(
      confirmSetCookies.some(
        (c) => c.startsWith('_session=') && /expires=Thu, 01 Jan 1970/u.test(c),
      ),
    ).toBe(true);

    // Hàng Session của SUB biến mất khỏi auth.oidc_state — destroy() thật
    // qua adapter, đo ở bảng, không ở lời hứa nào trong source.
    const sessionAfter = await runtimeSql<{ id: string }[]>`
        SELECT id FROM auth.oidc_state
         WHERE kind = 'Session' AND payload->>'accountId' = ${SUB}
      `;
    expect(sessionAfter.length).toBe(sessionBefore.length - 1);
    for (const before of sessionBefore) {
      expect(sessionAfter.map((s) => s.id)).not.toContain(before.id);
    }

    // ── 7. Success page: `end_session_success` cũng được mount thật ─────
    // Location là URL tuyệt đối theo issuer (scheme https thật của edge);
    // localFetch chỉ cần pathname.
    const successPathname = new URL(confirmLocation).pathname;
    expect(successPathname).toBe(`${PROVIDER_ROUTES.end_session}/success`);
    const successResponse = await localFetch(successPathname, { redirect: 'manual' });
    expect(successResponse.status).toBe(200);
    expect(await successResponse.text()).toContain('Sign-out Success');
  });
});
