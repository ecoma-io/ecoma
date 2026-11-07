import { exportPKCS8, generateKeyPair } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { signRequest } from '@ecoma-io/auth-contracts';
// Namespace import để `vi.spyOn` thay thế `createPostgresClient` theo từng ca
// (stub tầng driver của readiness probe — xem các ca `account_unreachable` và
// nhánh 200 trong `describe('GET /ready')`).
import * as infrastructure from '@ecoma-io/auth-infrastructure';

import app from './main';
import type { AuthEnv } from './config';

/**
 * Hợp đồng HTTP bề mặt công khai của `auth`.
 *
 * ⚠️ Phần quan trọng nhất không phải là endpoint nào trả gì, mà là endpoint
 * nào **chưa có** mà vẫn trả 404. Một endpoint stub trả 200 là một lời hứa
 * sai với resource server.
 */

let pem: string;
let env: AuthEnv;

/**
 * Issuer của test CỐ TÌNH khác mọi giá trị trong `src/`.
 *
 * ⚠️ Nếu test dùng `https://auth.ecoma.io` — cùng chuỗi với bản hardcode từng
 * tồn tại — thì test ĐI QUA với cả hai cách dựng. Đó chính là lý do một
 * endpoint hardcode issuer vẫn xanh toàn bộ suite. Giá trị ở đây phải là giá trị
 * mà chỉ config mới có thể cấp.
 */
const TEST_ISSUER = 'https://issuer-from-config-test.invalid';

/** Route nội bộ — hằng của hợp đồng, dùng lại ở cả đăng ký route lẫn dòng log. */
const INTERNAL_PATH = '/internal/session/verified';

/**
 * Nonce mạnh và **cố định** cho các ca chỉ muốn đi tới bước chữ ký.
 *
 * UUID v4 hợp lệ (version `4`, variant `9`) nên `isStrongNonce` đi đường nhanh và không
 * phụ thuộc heuristic đếm ký tự — một nonce ngẫu nhiên theo từng lần chạy sẽ làm test
 * này đỏ không tất định nếu heuristic đổi ngưỡng.
 */
const STRONG_NONCE = '3f2a9c1e-5b7d-4a86-9f01-2c4d6e8a0b13';

/**
 * Bắt mọi dòng `console.log` phát ra trong lúc chạy `run`, cùng giá trị nó trả về.
 *
 * ⚠️ Trả về **cả hai** để mỗi ca chỉ gọi `app.request` một lần: gọi lần thứ hai ở ngoài
 * thì assertion về dòng log không còn thuộc về chính response đang được kiểm.
 *
 * ⚠️ Spy phải được gỡ trong `finally`: để lại một `console.log` bị mock sẽ nuốt log của
 * các test chạy sau trong cùng file, và triệu chứng là một test khác "im lặng đỏ" ở chỗ
 * không liên quan.
 */
async function captureLogLines<T>(run: () => Promise<T>): Promise<{ lines: string[]; result: T }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  });
  try {
    return { lines, result: await run() };
  } finally {
    spy.mockRestore();
  }
}

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  pem = await exportPKCS8(privateKey);
});

beforeEach(() => {
  // ⚠️ `getConfig` cache theo isolate, nên `env` phải ỔN ĐỊNH qua các test —
  // đổi env giữa chừng sẽ không có tác dụng vì cache đã giữ config cũ.
  env = {
    HYPERDRIVE: { connectionString: 'hyperdrive-internal-placeholder' },
    ACCOUNT_SERVICE: { fetch: async () => new Response('{}') },
    AUTH_SIGNING_KEY: pem,
    AUTH_SIGNING_KEY_ID: 'kid-2026-01',
    AUTH_HANDLE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    // `0011`/C1: version cua khoá handle phải được khai báo tường minh — không
    // có giá trị mặc định, vì mặc định câm làm việc xoay khoá vô nghĩa.
    AUTH_HANDLE_KEY_VERSION: '1',
    AUTH_INTERNAL_SECRET: 'internal-secret-test',
    AUTH_ISSUER: TEST_ISSUER,
    AUTH_AUDIENCE: 'https://api.ecoma.io',
    // oidc-provider ký cookie phiên bằng keygrip — thiếu là fail-closed.
    AUTH_COOKIE_KEYS: 'test-cookie-key-1,test-cookie-key-2',
    AUTH_ACCOUNT_BASE_URL: 'https://account.ecoma.io',
  };
});

async function get(path: string): Promise<Response> {
  return await app.request(path, {}, env);
}

describe('GET /health', () => {
  it('reports the service as ok', async () => {
    const response = await get('/health');
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(body.service).toBe('auth');
    expect(body.status).toBe('ok');
    expect(Number.isNaN(Date.parse(body.time as string))).toBe(false);
  });
});

describe('GET /ready', () => {
  it('fails closed with 503 and binding_missing when the Hyperdrive binding is absent', async () => {
    // ⚠️ Thiếu binding là app không phục vụ được request nào, không phải "chạy
    // được một phần". Nhánh này cắt TRƯỚC probe DB, nên ca này không cần signing
    // key hợp lệ — chỉ để khẳng định thứ tự các kiểm: binding trước, DB sau.
    const readyEnv = { ...env };
    delete (readyEnv as Partial<AuthEnv>).HYPERDRIVE;

    const { lines, result: response } = await captureLogLines(
      async () => await app.request('/ready', {}, readyEnv),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'service_unavailable' });
    // `Retry-After` là một phần của hợp đồng 503 (docs/architecture/03-operations.md §3.2).
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      event: 'ready.failed',
      status: 503,
      reason: 'binding_missing',
    });
  });

  it('fails closed with 503 and binding_missing when the ACCOUNT_SERVICE binding is absent', async () => {
    // `HYPERDRIVE` có mà `ACCOUNT_SERVICE` không — vẫn không sẵn sàng: phát hành
    // không được khi không hỏi được status của account (control point fail-closed
    // lúc phát hành). Hai binding là hai điều kiện độc lập, không thể một ca thay
    // thế một ca kia.
    const readyEnv = { ...env };
    delete (readyEnv as Partial<AuthEnv>).ACCOUNT_SERVICE;

    const { lines, result: response } = await captureLogLines(
      async () => await app.request('/ready', {}, readyEnv),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'service_unavailable' });
    expect(response.headers.get('retry-after')).not.toBeNull();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      event: 'ready.failed',
      status: 503,
      reason: 'binding_missing',
    });
  });

  it('fails closed with 503 and db_unreachable when the database is unreachable — never logs the connection string', async () => {
    // Connection string cố tình trỏ tới một cổng không có ai nghe — connect
    // timeout của probe biến nó thành lỗi nhanh ⇒ `db_unreachable`. Ca này đi
    // ĐỦ đường thật (`createPostgresClient` + timeout riêng của readiness
    // probe), không stub tầng nào, nên thay đổi ở pool hay driver vẫn bắt được.
    //
    // ⚠️ NHÁNH NGƯỢC LẠI của hai test trước: `HYPERDRIVE` tồn tại nhưng DB chết.
    // Nhánh này cắt ở `probeDatabase`, sau khi cả hai kiểm binding đi qua.
    const readyEnv: AuthEnv = { ...env };
    // Cổng 1 trên `127.0.0.1` là một kết nối bị từ chối tức thì (không có daemon
    // nào nghe ở đó trong runner), nên ca này không chờ timeout dài.
    readyEnv.HYPERDRIVE = { connectionString: 'postgres://ecoma:nope@127.0.0.1:1/db-auth' };

    const { lines, result: response } = await captureLogLines(
      async () => await app.request('/ready', {}, readyEnv),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'service_unavailable' });
    // 503 của hạ tầng KHÔNG mang `WWW-Authenticate`.
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(parsed).toEqual({
      event: 'ready.failed',
      status: 503,
      reason: 'db_unreachable',
    });
    // Message của driver có thể chứa connection string — log chỉ được mã ổn định.
    expect(lines[0]).not.toContain('127.0.0.1');
    expect(lines[0]).not.toContain('db-auth');
  });

  it('fails closed with 503 and config_invalid when the signing config cannot load even with both bindings present', async () => {
    // `AUTH_SIGNING_KEY` sai shape (không phải PKCS#8 PEM) — `loadAuthConfig`
    // ném lúc `SigningKeyProvider.fromPem`. Binding + DB có xanh đến đâu, một
    // Worker không ký được token là Worker không phục vụ được request nào.
    //
    // ⚠️ Response và log KHÔNG nêu tên biến thiếu: tên cấu hình không thuộc
    // response công khai; readiness log chỉ mã ổn định.
    //
    // ⚠️ `vi.resetModules()` + dynamic import: `getConfig` cache config theo
    // isolate (cache PROMISE, KHÔNG cache lỗi) — một test trước đó với env hợp
    // lệ đã fill cache, và request qua instance `app` cũ sẽ đi qua cache mà
    // không hề gọi `loadAuthConfig` với PEM sai (đúng lỗi này, đo thật: ca
    // chạy một mình xanh, chạy sau ca DB chết nhận nhầm `db_unreachable`).
    // Instance module MỚI có cache rỗng, nên `loadAuthConfig` chạy thật với
    // env của ca này. Static import `app` của các ca khác không bị đụng.
    vi.resetModules();
    const freshApp = (await import('./main')).default;
    const readyEnv: AuthEnv = { ...env };
    readyEnv.AUTH_SIGNING_KEY = 'not-a-pem';
    // HYPERDRIVE trỏ cổng chết: nếu một refactor sau đảo thứ tự hai probe
    // (config sau DB), ca này chuyển sang fail `db_unreachable` — một đổi
    // hành vi mà ca này sẽ bắt, thay vì đi qua một probe treo vô hạn.
    readyEnv.HYPERDRIVE = { connectionString: 'postgres://ecoma:nope@127.0.0.1:1/db-auth' };

    const { lines, result: response } = await captureLogLines(
      async () => await freshApp.request('/ready', {}, readyEnv),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'service_unavailable' });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      event: 'ready.failed',
      status: 503,
      reason: 'config_invalid',
    });
    expect(lines[0]).not.toContain('AUTH_SIGNING_KEY');
  });

  it('fails closed with 503 and account_unreachable when the ACCOUNT_SERVICE binding throws — binding status never proves account reachability', async () => {
    // Binding "có mặt" (fetch là function) nhưng fetch THẤT BẠI — shim chết,
    // upstream treo, timeout... là các dạng thật của local lẫn production.
    // Probe readiness phải đi QUA binding (đường request thật) và coi "không
    // trả lời được" là fail-closed; việc binding được gắn không phải bằng chứng
    // account sống.
    //
    // ⚠️ Thứ tự probe trong route là config → DB → account: probe DB chạy
    // TRƯỚC probe account, nên ca này stub tầng DB
    // (`vi.spyOn` trên namespace import của `auth-infrastructure`)
    // để request đi TỚI probe account — fetch-stub của binding đếm được lần
    // gọi, còn DB thật thì không cần (không PostgreSQL trong unit runner).
    const readyEnv: AuthEnv = {
      ...env,
      ACCOUNT_SERVICE: {
        fetch: async () => {
          throw new Error('network unreachable (stub)');
        },
      },
    };

    const { lines, result: response } = await captureLogLines(async () => {
      const dbStub = vi.spyOn(infrastructure, 'createPostgresClient').mockImplementation(
        () =>
          ({
            unsafe: vi
              .fn<() => Promise<unknown[]>>()
              .mockResolvedValue([{ client_id: 'probe-client' }]),
            end: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
          }) as unknown as ReturnType<typeof infrastructure.createPostgresClient>,
      );
      try {
        return await app.request('/ready', {}, readyEnv);
      } finally {
        dbStub.mockRestore();
      }
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'service_unavailable' });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      event: 'ready.failed',
      status: 503,
      reason: 'account_unreachable',
    });
    // Message của stub chứa chữ "unreachable" — log chỉ được mã ổn định, không
    // byte nào từ exception của dependency.
    expect(lines[0]).not.toContain('stub');
  });

  it('returns 200 ready when the config loads and both probes pass — a non-2xx account response still counts as reachable', async () => {
    // Nhánh 200 với probe account TRẢ 503: account đỏ (db-account của nó chết)
    // vẫn là account SỐNG và trả lời đúng hợp đồng — readiness chi tiết của
    // account là việc của account. Chỉ "không trả lời được" (throw) là fail.
    //
    // ⚠️ Cùng kỹ thuật stub DB với ca trên: `ready.ok` là nhánh 200 duy nhất
    // của route, và ca này chứng minh nó đạt được với probe account non-2xx —
    // bản end-to-end trên stack thật (WIC + account container) thuộc Integration.
    const readyEnv: AuthEnv = {
      ...env,
      ACCOUNT_SERVICE: {
        fetch: async () => new Response('{}', { status: 503 }),
      },
    };

    const { lines, result: response } = await captureLogLines(async () => {
      const dbStub = vi.spyOn(infrastructure, 'createPostgresClient').mockImplementation(
        () =>
          ({
            unsafe: vi
              .fn<() => Promise<unknown[]>>()
              .mockResolvedValue([{ client_id: 'probe-client' }]),
            end: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
          }) as unknown as ReturnType<typeof infrastructure.createPostgresClient>,
      );
      try {
        return await app.request('/ready', {}, readyEnv);
      } finally {
        dbStub.mockRestore();
      }
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: 'auth', status: 'ready' });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({ event: 'ready.ok', status: 200 });
  });
  // ⚠️ Nhánh 200 ĐẦY ĐỦ trên hạ tầng thật (DB thật trả dòng
  // `auth.oauth_clients` + account thật qua shim) thuộc Integration — nó cần
  // một `auth.oauth_clients` thật (testcontainers, `tests/integrations/`).
  // Probe đi qua `createPostgresClient` — cùng pool shape của replay guard,
  // đã được phủ bởi lib suite — nên unit này phủ mọi nhánh fail của route và
  // nhánh 200 với stub ở tầng driver.
});

describe('GET /.well-known/openid-configuration', () => {
  it('declares the endpoints the provider actually mounts', async () => {
    // ⚠️ Provider (oidc-provider) là bộ máy thật; discovery của Hono chỉ shadow
    // với các giá trị đúng — `/authorize` là namespace ECOMA (glue), còn
    // `/auth` là route authorization của provider; `/jwks.json` của provider.
    const response = await get('/.well-known/openid-configuration');
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.issuer).toBe(TEST_ISSUER);
    expect(body.authorization_endpoint).toBe(`${TEST_ISSUER}/authorize`);
    expect(body.token_endpoint).toBe(`${TEST_ISSUER}/token`);
    expect(body.jwks_uri).toBe(`${TEST_ISSUER}/jwks.json`);
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    expect(body.response_types_supported).toEqual(['code']);
  });

  it('uses the issuer from config at EVERY endpoint, never hardcoded', async () => {
    // ⚠️ Regression: `issuer` trong discovery và `iss` trong access token là
    // MỘT điều kiện so khớp ở phía resource server. Nếu discovery hardcode
    // còn token ký theo config, hai bên lệch nhau — và sự lệch đó chỉ lộ ra
    // khi một token thật bị verify, không phải khi endpoint trả 200.
    const body = (await (await get('/.well-known/openid-configuration')).json()) as Record<
      string,
      unknown
    >;

    expect(body.authorization_endpoint).toBe(`${TEST_ISSUER}/authorize`);
    expect(body.token_endpoint).toBe(`${TEST_ISSUER}/token`);
    expect(body.jwks_uri).toBe(`${TEST_ISSUER}/jwks.json`);
    // Issuer của test không được xuất hiện ở bất kỳ chỗ nào trong `src/`.
    expect(body.issuer).not.toBe('https://auth.ecoma.io');
  });

  it('revocation is declared (RFC 7009 enabled), introspection/userinfo are not', async () => {
    // ⚠️ Khai một endpoint không tồn tại là hướng client vào một 404 — nhưng
    // NGƯỢC lại cũng sai: revocation đã implement (features.revocation) thì
    // phải được quảng bá, nếu không client không biết nó có.
    // `introspection_endpoint` không tồn tại theo D3: access token verify
    // offline. `userinfo` tắt (resource-bound audience).
    const body = (await (await get('/.well-known/openid-configuration')).json()) as Record<
      string,
      unknown
    >;

    expect(body.revocation_endpoint).toBe(`${TEST_ISSUER}/revocation`);
    expect(body).not.toHaveProperty('introspection_endpoint');
    expect(body).not.toHaveProperty('userinfo_endpoint');
  });

  it('end_session is declared like the provider does (rpInitiatedLogout enabled), and advertised matches the mounted route', async () => {
    // ⚠️ Regression: route `/session/end` luôn sống (app.all của
    // PROVIDER_ROUTES chuyển tiếp cho bridge), provider thật cũng quảng bá nó
    // khi rpInitiatedLogout bật (discovery.js) — nhưng bản shadow này BỎ khai
    // ⇒ một RP đọc discovery không biết logout chạy ở đâu. Test ghim cả hai
    // chiều: giá trị trong document đúng route được mount, VÀ đúng hằng
    // `PROVIDER_ROUTES` — đổi route trong provider.ts mà quên discovery là
    // test đỏ ngay.
    const body = (await (await get('/.well-known/openid-configuration')).json()) as Record<
      string,
      unknown
    >;
    expect(body.end_session_endpoint).toBe(`${TEST_ISSUER}/session/end`);
  });

  it('the RFC 8414 shadow serves the same document', async () => {
    const body = (await (await get('/.well-known/oauth-authorization-server')).json()) as Record<
      string,
      unknown
    >;
    expect(body.issuer).toBe(TEST_ISSUER);
    expect(body.token_endpoint).toBe(`${TEST_ISSUER}/token`);
  });
});

describe('GET /.well-known/jwks.json', () => {
  it('exposes only the public key — via the provider JWKS', async () => {
    // ⚠️ `/jwks.json` bây giờ là route của oidc-provider (bridge Node), không
    // còn là handler hand-rolled. Trong test Node môi trường, `cloudflare:node`
    // không import được — runtime dựng thất bại. Cách kiểm đúng cho môi trường
    // này: route phải KHÔNG trả 200 với material riêng tư. Một khi runtime dựng
    // thất bại, Hono trả 500 — nhưng KHÔNG BAO GIỜ là một JWKS có `d`.
    const response = await get('/.well-known/jwks.json');
    const text = await response.text();

    expect(text).not.toContain(pem);
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain('"d"');
  });

  it('the response NEVER contains private key material in any form', async () => {
    const text = await (await get('/.well-known/jwks.json')).text();

    expect(text).not.toContain(pem);
    expect(text).not.toContain('PRIVATE KEY');
    const body = pem.split('\n').filter((line) => line.length > 10)[1] ?? '';
    expect(body.length).toBeGreaterThan(10);
    expect(text).not.toContain(body);
  });
});

describe('provider routes — the Node bridge is 500 under Node tests and NEVER a faked 200', () => {
  it('the end-session route family — init, confirm subpath, success subpath — is registered (never 404)', async () => {
    // ⚠️ F1: `rpInitiatedLogout` bật là provider mount BA route
    // (`initialize_app.js`): `GET /session/end`, `POST /session/end/confirm`,
    // `GET /session/end/success`. Hono KHÔNG tự match subpath của một route
    // tĩnh — clone bug đã fix ở `/auth` năm xưa (`/auth` bare + `/auth/*`):
    // đăng ký chỉ `/session/end` bare là confirm POST + success GET 404, tức
    // logout render form nhưng KHÔNG BAO GIỜ hoàn tất. Chuỗi 3 request qua
    // `app.request` (lane Hono thật, KHÔNG bắn thẳng Node server như
    // oidc-end-session.spec.ts) khẳng định cả BA đều đến được bridge.
    //
    // Dưới Node test, runtime dựng thất bại ⇒ mỗi request trả 500 — nhưng 500
    // chỉ đúng khi request ĐI QUA lane bridge; 404 nghĩa là route chết trước
    // khi chạm bước chuyển tiếp.
    const init = await get('/session/end');
    expect(init.status).not.toBe(404);

    const confirm = await app.request(
      '/session/end/confirm',
      { method: 'POST', body: 'xsrf=x&logout=yes' },
      env,
    );
    expect(confirm.status).not.toBe(404);

    const success = await get('/session/end/success');
    expect(success.status).not.toBe(404);
  });

  it('/auth (the provider authorization endpoint) never returns 200 under any Node test environment', async () => {
    // ⚠️ `cloudflare:node` chỉ tồn tại trên workerd. Trong vitest (Node), việc
    // dựng runtime thất bại — response phải là 500 (lỗi hạ tầng của môi trường
    // test), không phải 200 rỗng, và không phải 404 (route phải đăng ký).
    const response = await get('/auth?client_id=x&response_type=code');
    expect(response.status).not.toBe(200);
  });

  it('/authorize/complete returns 404 — no such route', async () => {
    // §5.1.4 đặt `/authorize/complete` trong docs nhưng glue hiện tại trả
    // continue_url = resume URL của provider; route không được đăng ký ⇒ 404.
    expect((await get('/authorize/complete')).status).toBe(404);
  });

  it('root returns 404 — no UI here', async () => {
    expect((await get('/')).status).toBe(404);
  });
});

describe('POST /internal/session/verified — authenticate first, business logic after', () => {
  it('no signature — 401, NOT 501', async () => {
    // ⚠️ Thứ tự la mot phan cua hop dong: xac thuc truoc, nghiep vu sau. Neu
    // route tra 501 cho request khong chu ky thi no da xu ly du lieu cua
    // ke goi chua duoc xac thuc — va 501 cho request hop le la cau tra loi.
    const response = await app.request('/internal/session/verified', { method: 'POST' }, env);

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('HMAC');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('detail');
  });

  it('a body exactly AT the limit — not 413 (the boundary is `>`, not `>=`)', async () => {
    // ⚠️ Bien cua mot gioi han la thu de sai nhat: doi `total > limit` thanh
    // `total >= limit` khong lam test nao do — muon bat duoc phai co mot ca dung
    // BANG nguong. Body day dai dung 64 KiB, nen no phai di QUA buoc kiem kich
    // thuoc. Khong co header chu ky nen buoc tiep theo la `401` (thieu header,
    // truoc ca khi cham toi kho nonce): do la trang thai chung minh no da qua
    // cong kich thuoc, khac han `413`.
    const atLimit = new Uint8Array(64 * 1024);
    const response = await app.request(
      '/internal/session/verified',
      { method: 'POST', body: atLimit as unknown as BodyInit },
      env,
    );

    expect(response.status).not.toBe(413);
    expect(response.status).toBe(401);
  });

  it('Content-Length over the limit — 413 BEFORE reading any byte', async () => {
    const response = await app.request(
      '/internal/session/verified',
      {
        method: 'POST',
        headers: { 'content-length': String(65 * 1024) },
        body: '{}',
      },
      env,
    );

    expect(response.status).toBe(413);
  });

  it('chunked without Content-Length — 413 once the limit is passed while reading the stream', async () => {
    // ⚠️ Day chinh la lo OOM: `arrayBuffer()` nạp het payload truoc roi moi so,
    // nen chunked vuot han muc van cham bo nho. `readBodyLimited` phai tu choi
    // GIUA chung khi tong chunk vuot 64 KiB. Body day la ReadableStream truc
    // tiep — Hono khong dat Content-Length cho stream, giong chunked that.
    const limit = 64 * 1024;
    const oversized = new Uint8Array(limit + 1);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Nhom 1 KiB de chot chan phai phai doc NHIEU lan moi vuot tong.
        for (let offset = 0; offset < oversized.length; offset += 1024) {
          controller.enqueue(oversized.subarray(offset, Math.min(offset + 1024, oversized.length)));
        }
        controller.close();
      },
    });

    const response = await app.request(
      '/internal/session/verified',
      // `duplex: 'half'` la yeu cau cua undici khi body la stream.
      { method: 'POST', body: stream as unknown as BodyInit, duplex: 'half' } as RequestInit,
      env,
    );

    expect(response.status).toBe(413);
  });

  it('no specific reason in the response — it is not an oracle', async () => {
    const response = await app.request(
      '/internal/session/verified',
      {
        method: 'POST',
        headers: {
          'x-ecoma-internal-timestamp': '99999999999999',
          'x-ecoma-internal-nonce': 'x',
          'x-ecoma-internal-signature': 'v1=deadbeef',
        },
        body: '{}',
      },
      env,
    );

    expect(response.status).toBe(401);
    const text = await response.text();
    // Ten ly do cu the ("signature_mismatch", "timestamp_out_of_skew") se bi
    // bien response thanh oracle do chu ky.
    expect(text).not.toContain('signature_mismatch');
    expect(text).not.toContain('timestamp_out_of_skew');
  });

  it('an unreachable nonce store returns 503 service_unavailable, NOT 401', async () => {
    // ⚠️ Đây là thay đổi **ngữ nghĩa bảo mật** của endpoint, không phải chi tiết
    // hiển thị: trước đây mọi từ chối đều là 401. Request ở đây được **ký hợp lệ**
    // (đúng secret, nonce mạnh, timestamp trong cửa sổ skew) nên nó đi qua được
    // bước chữ ký và chết ở bước chiếm nonce — vì `HYPERDRIVE` trỏ vào một
    // connection string không resolve được.
    //
    // Phải khoá ở **tầng route**, không phải chỉ ở tầng dưới: `internal-auth.spec.ts`
    // chỉ chứng minh `isAuthenticatedInternalRequest` trả `db_unreachable`, còn
    // 401 hay 503 là quyết định của `main.ts`. Nếu nhánh `db_unreachable` bị bỏ
    // đi, request này quay về 401 và không test nào khác đỏ.
    const raw = '{}';
    const body = new TextEncoder().encode(raw);
    const path = '/internal/session/verified';
    const headers = await signRequest({
      method: 'POST',
      path,
      body,
      secret: env.AUTH_INTERNAL_SECRET as string,
      timestamp: String(Math.floor(Date.now() / 1000)),
    });

    // Một lần gọi duy nhất, bắt cả response lẫn dòng log: gọi hai lần thì assertion về
    // dòng log không còn thuộc về chính response đang được kiểm.
    const { lines, result: response } = await captureLogLines(
      async () => await app.request(path, { method: 'POST', headers, body: raw }, env),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'service_unavailable' });
    // ⚠️ `Retry-After` là phần của hợp đồng 503 của nền tảng
    // (`docs/architecture/03-operations.md` §3.2): thiếu nó thì phía gọi không phân biệt
    // được sự cố tạm thời với sự cố vĩnh viễn. Test này ghim cả **sự có mặt** lẫn
    // **định dạng** (số giây) — một header rỗng cũng thoả `not.toBeNull()`.
    const retryAfter = response.headers.get('retry-after');
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(Number(retryAfter))).toBe(true);
    // ⚠️ 503 là sự cố hạ tầng, không phải lỗi xác thực: không được mang
    // `WWW-Authenticate` (nó khiếu client thử lại bằng credential khác) và không
    // được rò chi tiết lỗi driver (SR-001 — message của driver có thể chứa
    // connection string).
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(JSON.stringify(response.headers)).not.toContain('hyperdrive');
    // ⚠️ Cùng bất biến đó áp cho dòng log: `db_unreachable` là **mã**, không phải
    // message của driver `pg` (message của nó có thể chứa connection string). Log là nơi
    // duy nhất nói rằng kho nonce không gọi được, nên nó phải ghi được mà không rò gì.
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      event: 'internal_auth.rejected',
      route: INTERNAL_PATH,
      method: 'POST',
      status: 503,
      reason: 'db_unreachable',
    });
    expect(lines[0]).not.toContain('hyperdrive');
  });

  it('rejects a body that differs only in bytes invalid as UTF-8 (F-01, end to end)', async () => {
    // ⚠️ Bất biến bảo mật trung tâm của PR này, kiểm **qua route thật** — không chỉ ở
    // tầng lib.
    //
    // `0xff` không phải UTF-8 hợp lệ, và `TextDecoder` non-fatal biến nó thành U+FFFD.
    // Bản trước của route này `new TextDecoder().decode(raw)` rồi mới ký, nên hai payload
    // **khác nhau trên dây** ra cùng một chữ ký: kẻ tấn công đổi byte trong payload mà
    // chữ ký vẫn đúng. Ca này ký `61 ff 62` rồi gửi `61 efbfbd 62` (chính là `a�b`)
    // và đòi `bad_signature`.
    //
    // Một bản cài đặt quay lại decode trước khi băm sẽ làm test này **xanh sai** ở nhánh
    // `ok` (nó chấp nhận), nên không thể lọt: đây là ca duy nhất trong file mà hai đầu
    // vào khác byte nhưng cùng "nội dung đã decode".
    const signedBytes = new Uint8Array([0x61, 0xff, 0x62]);
    const headers = await signRequest({
      method: 'POST',
      path: INTERNAL_PATH,
      body: signedBytes,
      secret: env.AUTH_INTERNAL_SECRET as string,
      timestamp: String(Math.floor(Date.now() / 1000)),
    });

    expect(new TextDecoder().decode(signedBytes)).toBe('a�b');

    const { lines, result: response } = await captureLogLines(
      async () =>
        await app.request(
          INTERNAL_PATH,
          { method: 'POST', headers, body: new Uint8Array([0x61, 0xef, 0xbf, 0xbd, 0x62]) },
          env,
        ),
    );

    expect(response.status).toBe(401);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ reason: 'bad_signature' });
  });

  it('rejects a body whose bytes differ from the signed ones, at the route', async () => {
    // Một byte bị thêm vào: cùng payload "có nghĩa", khác byte. Không được 501 (đi qua
    // được bước xác thực) mà phải 401.
    const raw = '{"sub":"sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}';
    const headers = await signRequest({
      method: 'POST',
      path: INTERNAL_PATH,
      body: new TextEncoder().encode(raw),
      secret: env.AUTH_INTERNAL_SECRET as string,
      timestamp: String(Math.floor(Date.now() / 1000)),
    });

    const response = await app.request(
      INTERNAL_PATH,
      { method: 'POST', headers, body: `${raw} ` },
      env,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });
});

describe('internal rejection log', () => {
  it('writes one line with event/route/method/status/reason and the fixed reason code', async () => {
    // ⚠️ Không có header nào ⇒ `missing_header`. Ca này ghim **hình dạng** của dòng log
    // (đúng năm trường, không thêm) và việc `reason` là mã của union chứ không phải chuỗi
    // tự do. Bỏ dòng log đi thì `401` trả về vẫn đúng như cũ và không test nào khác đỏ —
    // nghĩa là tín hiệu audit sẽ biến mất trong im lặng.
    const { lines, result: response } = await captureLogLines(
      async () => await app.request(INTERNAL_PATH, { method: 'POST', body: '{}' }, env),
    );

    expect(response.status).toBe(401);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      event: 'internal_auth.rejected',
      route: INTERNAL_PATH,
      method: 'POST',
      status: 401,
      reason: 'missing_header',
    });
  });

  it('never writes the signature header value into the log', async () => {
    // ⚠️ Chữ ký HMAC là giá trị **còn tái dùng được trong cửa sổ skew**, và một dòng log
    // sống lâu hơn request rất nhiều. Hợp đồng ở `docs/applications/auth/03-operations.md` §3
    // cấm ghi nó; `reason` mới là thứ đủ để phân loại sự cố.
    //
    // Bất biến này chỉ đo được bằng một chữ ký **nhận ra được** trong dòng log, nên ca
    // này dùng chuỗi `v1=…` đặc trưng; timestamp hợp lệ + nonce mạnh đưa request tới
    // bước so chữ ký (`bad_signature` là lý do xác định: `verifyRequest` kiểm chữ ký
    // TRƯỚC khi chạm kho nonce), nên không cần DB.
    const { lines, result: response } = await captureLogLines(
      async () =>
        await app.request(
          INTERNAL_PATH,
          {
            method: 'POST',
            headers: {
              'x-ecoma-internal-timestamp': String(Math.floor(Date.now() / 1000)),
              'x-ecoma-internal-nonce': STRONG_NONCE,
              'x-ecoma-internal-signature': 'v1=deadbeefdeadbeefdeadbeef',
            },
            body: '{}',
          },
          env,
        ),
    );

    expect(response.status).toBe(401);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(parsed.reason).toBe('bad_signature');
    expect(lines[0]).not.toContain('deadbeef');
  });
});

describe('routing', () => {
  it('no route at the root until one is defined', async () => {
    expect((await get('/')).status).toBe(404);
  });
});
