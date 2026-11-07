/**
 * Integration — Discovery là NGUỒN SỰ THẬT của entrypoint authorization.
 *
 * ## Vấn đề mà suite này ghim
 *
 * `auth` có HAI tầng route: glue (Hono) giữ `/authorize` — cửa ngõ tạo
 * authorization transaction + browser binding rồi 302 sang route authorization
 * của provider (`/auth`); provider giữ `/auth`, `/token`, `/jwks.json`,
 * `/revocation`, `/session/end` (xem `apps/auth/src/main.ts`).
 *
 * Discovery phải quảng bá đúng tầng mà CLIENT được gọi. Trước #122 nó quảng bá
 * `/auth` — tức route NỘI BỘ của provider: client đọc metadata rồi gọi đúng
 * chỗ đó sẽ **không bao giờ** có transaction, không có browser binding, nên
 * luồng không thành. Test cũ ở `main.spec.ts` KHOÁ SAI giá trị đó, nên lỗi
 * sống lâu.
 *
 * ## Cấu trúc của suite
 *
 * Suite này **đọc `authorization_endpoint` TỪ CHÍNH document discovery** rồi
 * gọi đúng URL đó — không hardcode `/authorize` ở đây. Nhờ vậy test bắt được
 * cả hai chiều của lỗi:
 *
 *   1. Metadata quảng bá sai endpoint (lỗi của #122) ⇒ request đi vào route
 *      không tạo transaction ⇒ assertion về transaction FAIL.
 *   2. Metadata quảng bá đúng nhưng route không hoạt động ⇒ FAIL.
 *
 * ⚠️ Đây là integration test PROTOCOL/DB — KHÔNG phải E2E browser. Không có
 * trình duyệt, không có hệ thống con nào được dựng: chỉ Hono app thật, provider
 * thật qua server Node (cùng cách `oidc/runtime.ts` dựng bridge), PostgreSQL thật
 * (testcontainers), khoá ES256 thật.
 *
 * ⚠️ Cầu `cloudflare:node` (`handleAsNodeRequest`) chỉ tồn tại trên workerd — không
 * test được trong vitest. Nhánh Node của cùng cấu trúc đó là
 * `createServer(provider.callback())` của `node:http` — server này test được.
 * Bridge `dispatchToNode` ủy thác toàn bộ HTTP semantics cho Koa của provider qua
 * server Node, nên xác minh hành vi qua `provider.callback()` trên Node là bằng
 * chứng có ý nghĩa cho cùng một pipeline. Phần KHÔNG cùng hàm vận hành — biến môi
 * trường workerd, socket nội bộ — được ghi rõ ở cuối file là CHƯA verify, KHÔNG
 * được tính là đã pass.
 *
 * ⚠️ PostgreSQL THẬT (testcontainers): phần đáng tin cậy ở đây là trạng thái
 * `auth.authorization_transactions` sau khi gọi endpoint — transaction có thật,
 * browser binding đã băm đúng, không có gì cả. Stub SQL sẽ xanh ngay cả khi
 * glue ghi sai chỗ. Thiếu Docker ⇒ ĐỎ (cùng bộ luật với các suite hàng xóm;
 * harness probe fail-loud, không có đường skip).
 */

import type { Server } from 'node:http';

import postgres from 'postgres';
import { exportPKCS8, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bytesToBase64Url } from '@ecoma-io/auth-domain';

import { loadAuthConfig, type AuthEnv } from '../../src/config';
import { withPostgresClient } from '@ecoma-io/auth-infrastructure';
import { startAuthDatabase, type AuthDatabase } from './harness';

/* ------------------------------------------------------------------ */
/* PostgreSQL harness — cùng luật với các suite hàng xóm              */
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
  return postgres({
    ...base(),
    user: db.runtimeUser,
    password: db.runtimePassword,
    max,
  });
}

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

const HANDLE_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CLIENT_ID = 'client-discovery-pg-test';
const CLIENT_REDIRECT = 'https://rp.example.com/cb';
const INTERNAL_SECRET = 'discovery-internal-secret';
const TEST_AUDIENCE = 'https://api.ecoma.io/discovery';
const ACCOUNT_BASE_URL = 'https://account.ecoma.io';
/** Issuer phải khớp origin của server Node cục bộ — provider dựng URL tuyệt đối từ nó. */
let ISSUER = 'http://127.0.0.1:0';

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
    AUTH_SIGNING_KEY_ID: 'kid-discovery',
    AUTH_HANDLE_KEY: HANDLE_KEY,
    AUTH_HANDLE_KEY_VERSION: '1',
    AUTH_INTERNAL_SECRET: INTERNAL_SECRET,
    AUTH_ISSUER: ISSUER,
    AUTH_AUDIENCE: TEST_AUDIENCE,
    AUTH_COOKIE_KEYS: 'discovery-cookie-key-1,discovery-cookie-key-2',
    AUTH_ACCOUNT_BASE_URL: ACCOUNT_BASE_URL,
  };
}

/**
 * Dựng provider thật trên server Node cục bộ.
 *
 * ⚠️ Port cấp TRƯỚC, issuer dựng TỪ port đó: provider phải được khởi tạo với
 * ĐÚNG origin mà mọi URL edge sẽ mang. Ở đây port giữ vai trò "đã biết trước" —
 * cùng lý do với `oidc-fullflow.spec.ts`.
 *
 * ⚠️ Wrapper ghi đè `x-forwarded-proto: https` như bridge production
 * (`withForwardedProto` trong `oidc/runtime.ts`): server là http thuần, nên
 * không ghi đè thì provider chết `Cannot send secure cookie` y như workerd khi
 * production thiếu một trong hai nửa (`proxy` + header) — test sẽ xanh giả vì
 * lý do sai, hoặc đỏ vì lý do không phải logic của glue.
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
  // Issuer scheme PHẢI https (không phải scheme thật của socket test) — lý do
  // ở `oidc-fullflow.spec.ts`.
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
  nodeServer = createServer(((req: unknown, res: unknown) => {
    const incoming = req as { headers: Record<string, string | string[] | undefined> };
    incoming.headers['x-forwarded-proto'] = 'https';
    (provider.callback() as (r: unknown, w: unknown) => void)(req, res);
  }) as never);
  await new Promise<void>((resolve, reject) => {
    nodeServer.once('error', reject);
    nodeServer.listen(nodePort, '127.0.0.1', () => resolve());
  });
}

/* ------------------------------------------------------------------ */
/* Suite                                                               */
/* ------------------------------------------------------------------ */

beforeAll(async () => {
  db = await startAuthDatabase();
  runtimeSql = connectRuntime();
}, 180_000);

afterAll(async () => {
  nodeServer?.close();
  try {
    // Dọn đúng fixture của suite này. `authorization_audit_events` KHÔNG dọn:
    // append-only (0009 thu DELETE khỏi runtime role) — hàng audit của lần chạy
    // trước ở lại là đúng thiết kế, không phải rác.
    await runtimeSql?.unsafe(
      `DELETE FROM auth.authorization_transactions WHERE client_id = '${CLIENT_ID}'`,
    );
    await runtimeSql?.unsafe(
      `DELETE FROM auth.client_redirect_uris WHERE client_id = '${CLIENT_ID}'`,
    );
    await runtimeSql?.unsafe(`DELETE FROM auth.oauth_clients WHERE client_id = '${CLIENT_ID}'`);
  } catch {
    // Dọn thất bại không được che kết quả test; database test xem như dùng một lần.
  }
  await runtimeSql?.end({ timeout: 1 });
  await db?.stop();
});

describe('OIDC Discovery — the advertised authorization_endpoint is the entrypoint that works', () => {
  // Timeout 60s thay vì mặc định 5s: test này là một flow OIDC đầy đủ qua
  // provider thật + PostgreSQL thật — 5s là deadline sai cho hình thái test này.
  it('drives the authorization flow through the endpoint taken from the discovery document', async () => {
    // ── Dựng: khoá ES256 thật + client thật + provider thật ──────────────
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const pem = await exportPKCS8(privateKey);
    // Client PHẢI seed TRƯỚC bootProvider: `createProvider` load clients tĩnh
    // từ DB lúc dựng và ném sớm nếu không có client public nào.
    await runtimeSql`
        INSERT INTO auth.oauth_clients (client_id, client_name, client_type, allowed_scopes)
        VALUES (${CLIENT_ID}, 'discovery pg test client', 'public',
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
    const { default: app } = await import('../../src/main');

    // ── Bước 1: đọc Discovery ───────────────────────────────────────────
    // ⚠️ Đây là nguồn sự thật của endpoint — KHÔNG hardcode path ở đây.
    const discoveryResponse = await app.request('/.well-known/openid-configuration', {}, env);
    expect(discoveryResponse.status).toBe(200);
    const discovery = (await discoveryResponse.json()) as Record<string, unknown>;
    const authorizationEndpoint = discovery['authorization_endpoint'];
    expect(typeof authorizationEndpoint).toBe('string');

    // Endpoint được quảng bá phải là của GLUE — `/authorize`. Route `/auth` là
    // route NỘI BỘ của provider: gọi nó không tạo transaction.
    expect(new URL(authorizationEndpoint as string).pathname).toBe('/authorize');

    // ── Bước 2: gọi đúng endpoint được quảng bá ────────────────────────
    const verifier = 'discovery-pkce-verifier-0000000000000000000000';
    const challenge = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    ).toString('base64url');
    const authorizeUrl = new URL(authorizationEndpoint as string);
    authorizeUrl.searchParams.set('client_id', CLIENT_ID);
    authorizeUrl.searchParams.set('redirect_uri', CLIENT_REDIRECT);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('scope', 'openid offline_access');
    authorizeUrl.searchParams.set('state', 'st-discovery-1');
    authorizeUrl.searchParams.set('nonce', 'n-discovery-1');
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const authorizeResponse = await app.request(authorizeUrl.href, { redirect: 'manual' }, env);
    expect(authorizeResponse.status).toBe(302);

    // ── Bước 3: cookie browser binding được set ─────────────────────────
    const setCookie = authorizeResponse.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('__Host-auth-browser=');
    // Cookie binding phải là `Secure` + `Path=/` + `HttpOnly` + `SameSite=Lax`
    // (prefix `__Host-` chỉ được browser chấp nhận khi đủ ba điều kiện đầu).
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Domain=');
    const browserBinding = setCookie.split(';')[0]?.split('=')[1];
    expect(typeof browserBinding).toBe('string');
    expect(browserBinding?.length).toBeGreaterThanOrEqual(43);

    // ── Bước 4: redirect tới route authorization CỦA PROVIDER ──────────
    // Đây là bước mà `/auth` trở thành hợp đồng: glue 302 sang đó kèm
    // `ecoma_x` (handle X) và `resource`.
    const providerAuthUrl = new URL(authorizeResponse.headers.get('location') as string);
    expect(providerAuthUrl.origin + providerAuthUrl.pathname).toBe(`${ISSUER}/auth`);
    const handleX = providerAuthUrl.searchParams.get('ecoma_x');
    expect(typeof handleX).toBe('string');
    expect(handleX?.length).toBeGreaterThanOrEqual(43);
    expect(providerAuthUrl.searchParams.get('resource')).toBe(TEST_AUDIENCE);
    // Scope có `offline_access` ⇒ glue phải thêm `prompt=consent` (provider cắt
    // `offline_access` khỏi params trừ khi request mang `prompt=consent`).
    expect(providerAuthUrl.searchParams.get('prompt')).toBe('consent');

    // ── Bước 5: TRANSACTION thật được tạo trong `db-auth` ───────────────
    // Đây là phần đáng tin cậy nhất: hàng trong bảng thật, với CHECK thật.
    const transactions = await runtimeSql<
      {
        transaction_id: string;
        state: string;
        client_id: string;
        redirect_uri: string;
        requested_scopes: string[];
        code_challenge: string;
        code_challenge_method: string;
        client_state: string | null;
        nonce: string | null;
        browser_binding_hash: Uint8Array;
        handle_hash_x: Uint8Array;
      }[]
    >`
        SELECT transaction_id, state, client_id, redirect_uri, requested_scopes,
               code_challenge, code_challenge_method, client_state, nonce,
               browser_binding_hash, handle_hash_x
          FROM auth.authorization_transactions
         WHERE client_id = ${CLIENT_ID}
      `;
    expect(transactions).toHaveLength(1);
    const transaction = transactions[0];
    // Trạng thái sau `/authorize` là `pending_browser` — chờ cookie khớp ở
    // `/authorize/confirm`.
    expect(transaction?.state).toBe('pending_browser');
    // Mọi trường bind từ CHÍNH request `/authorize` (FR-005).
    expect(transaction?.redirect_uri).toBe(CLIENT_REDIRECT);
    expect(transaction?.requested_scopes).toEqual(['openid', 'offline_access']);
    expect(transaction?.code_challenge).toBe(challenge);
    expect(transaction?.code_challenge_method).toBe('S256');
    expect(transaction?.client_state).toBe('st-discovery-1');
    expect(transaction?.nonce).toBe('n-discovery-1');

    // Browser binding được LƯU DẠNG BĂM, không phải bản rõ: hash của giá trị
    // cookie phải bằng SHA-256 của chính giá trị đó (SR-006 / FR-009u).
    const bindingHash = bytesToBase64Url(transaction?.browser_binding_hash as Uint8Array);
    const expectedBindingHash = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(browserBinding as string)),
    ).toString('base64url');
    expect(bindingHash).toBe(expectedBindingHash);
    // Handle X cũng chỉ lưu dạng băm — bản rõ chỉ nằm trong URL.
    const handleHash = bytesToBase64Url(transaction?.handle_hash_x as Uint8Array);
    const expectedHandleHash = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(handleX as string)),
    ).toString('base64url');
    expect(handleHash).toBe(expectedHandleHash);

    // ── Bước 6: provider nhận request và tạo Interaction ────────────────
    // Chứng minh luồng đi được TỪ endpoint được quảng bá tới chỗ provider
    // nhận: Interaction của provider tồn tại trong `auth.oidc_state` (adapter
    // thật), và browser bị đẩy sang trang login của `account` mang handle X.
    const providerAuthResponse = await localFetch(
      `${providerAuthUrl.pathname}${providerAuthUrl.search}`,
      { headers: { cookie: `__Host-auth-browser=${browserBinding}` } },
    );
    expect(providerAuthResponse.status).toBe(303);
    const interactionUrl = new URL(providerAuthResponse.headers.get('location') as string);
    expect(interactionUrl.origin).toBe(ACCOUNT_BASE_URL);
    expect(interactionUrl.pathname).toBe('/login');
    expect(interactionUrl.searchParams.get('handle')).toBe(handleX);

    const interactionRows = await runtimeSql<{ id: string }[]>`
        SELECT id FROM auth.oidc_state
         WHERE kind = 'Interaction' AND payload->'params'->>'ecoma_x' = ${handleX}
      `;
    expect(interactionRows).toHaveLength(1);
  }, 60_000);

  it('the RFC 8414 document advertises the same entrypoint as the OIDC one', async () => {
    // ⚠️ Hai well-known dùng CHUNG một document (`discoveryDocument`), nên
    // chúng không được lệch nhau: client đọc bản RFC 8414 phải tới cùng một
    // entrypoint. Hàm `discoveryDocument` dựng từ MỘT nguồn, nhưng test ghim
    // điều đó lại — một bản copy-paste trong tương lai sẽ phá bộ luật.
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const env = makeEnv(pem);
    const { default: app } = await import('../../src/main');

    const oidc = (await (
      await app.request('/.well-known/openid-configuration', {}, env)
    ).json()) as Record<string, unknown>;
    const rfc8414 = (await (
      await app.request('/.well-known/oauth-authorization-server', {}, env)
    ).json()) as Record<string, unknown>;

    expect(rfc8414['authorization_endpoint']).toBe(oidc['authorization_endpoint']);
    expect(rfc8414['claims_supported']).toEqual(oidc['claims_supported']);
    expect(rfc8414['token_endpoint']).toBe(oidc['token_endpoint']);
  });
});
