import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SESSION_COOKIE_NAME,
  createSessionIdentifier,
  hashSessionIdentifier,
  insertSession,
  sessionDeadlines,
} from '@ecoma-io/backoffice-infrastructure';
import { BACKOFFICE_DATABASE, type BackofficeDatabase, startBackofficeDatabase } from './harness';

/**
 * Hợp đồng HTTP của `backoffice` ở chế độ **non-SSR SPA** (issue #67) trên
 * **runtime Worker thật**.
 *
 * Vì sao suite này tồn tại: lỗi nó ghim từng sống sót qua mọi test cũ, vì các
 * test đó chỉ đọc `wrangler.jsonc` và source. Khi `ssr: false`, Nitro cài route
 * catch-all `/**` trả shell HTML — mọi path không khớp route/API đều nhận
 * **HTML 200**, kể cả một path `/api` sai, đúng hình dạng "thành công" với mọi
 * client chỉ kiểm `response.ok`. Không assertion cấu hình nào nhìn thấy điều
 * đó, nên nó phải được đo bằng request thật.
 *
 * `createTestHarness` của wrangler khởi động **workerd** với chính
 * `wrangler.jsonc` của app rồi gửi HTTP qua `server.fetch()`: assets layer,
 * router Nitro, middleware authn và handler đều chạy như production. Không
 * Docker, không mock router — workerd chạy in-process từ devDependency
 * `wrangler` (cùng mô hình `apps/llm-console`, `apps/llm-seller`).
 *
 * ## Service binding giả — chỉ để boot, không phải mock hành vi
 *
 * `wrangler.jsonc` khai hai `services` (`ACCOUNT_SERVICE`,
 * `STAFF_ACCESS_SERVICE`); workerd từ chối boot khi service được trỏ tới không
 * nằm trong harness. Stub ở đây **chỉ tồn tại để runtime lên được** — trả 503
 * cho mọi fetch. Ở harness đầu (không cấu hình OIDC) middleware authn
 * fail-closed **trước** khi route nào chạm binding; harness thứ hai (cuối file,
 * cấu hình OIDC đầy đủ) có nhánh gọi binding thật nhưng chỉ `/api/me` chạm nó,
 * theo hợp đồng "controlled degrade" của route đó (displayName về `null`).
 * Cấu hình OIDC + DB thật ở mức middleware là việc của
 * `authn-middleware.spec.ts` (PostgreSQL thật) — suite này ghim hình dạng
 * routing ở tầng Worker cho cả hai trạng thái cấu hình.
 *
 * ⚠️ Harness được tạo trong `beforeAll`, không ở top level: Vitest import mọi
 * spec file trước khi chạy, nên dựng workerd lúc import sẽ boot runtime kể cả
 * khi cả file bị skip. `close()` trong `afterAll` là bắt buộc — workerd còn
 * sống giữ port và tiến trình vitest không thoát.
 *
 * ⚠️ Suite đọc `.output/` thật, nên target `test-integration` phải
 * `dependsOn: build`. Thiếu output thì `listen()` ném ngay — đỏ, không pass rỗng.
 */

const APP_DIR = resolve(import.meta.dirname, '..', '..');

/** `require('wrangler')` thay vì `await import`: CLI bundle lớn, giữ ngoài pipeline transform của vitest (tiền lệ `apps/transactional-mail`). */
const wranglerCli = createRequire(import.meta.url)('wrangler') as typeof import('wrangler');

type TestHarness = Awaited<ReturnType<typeof wranglerCli.createTestHarness>>;

let harness: TestHarness;

/** Thư mục stub script của `beforeAll` — outer scope để `afterAll` dọn sạch. */
let stubDir = '';

// ⚠️ Hai hook dưới đây là hook **tầng file** (đăng ký ngoài mọi `describe`, có
// hiệu lực cho cả file): `beforeAll` chạy một lần trước test đầu tiên của file,
// còn `afterAll` chạy một lần SAU test cuối cùng của file — tức sau cả describe
// thứ hai ở cuối file. Vì vậy `stubDir` còn nguyên khi describe thứ hai dựng
// harness của mình qua `join(stubDir, ...)`, và chỉ bị xóa khi cả hai describe
// đã chạy xong. Tách hook ra khỏi describe cũng cố ý: hai harness dùng chung
// một thư mục stub, không describe nào "sở hữu" nó.
beforeAll(async () => {
  // Stub script ghi vào tmpdir lúc chạy — không nằm trong repo, vì nội dung của
  // nó không từng được đọc bởi nhánh test nào (xem JSDoc đầu file). Outer scope
  // để `afterAll` xóa được thư mục sau khi `close()`.
  stubDir = await mkdtemp(join(tmpdir(), 'ecoma-backoffice-worker-stub-'));
  const stubScript = join(stubDir, 'index.mjs');
  await writeFile(
    stubScript,
    'export default { fetch: () => new Response(null, { status: 503 }) };',
  );

  harness = wranglerCli.createTestHarness({
    root: APP_DIR,
    workers: [
      { configPath: resolve(APP_DIR, 'wrangler.jsonc') },
      // Tên stub phải khớp **đúng** tên service trong `wrangler.jsonc` —
      // workerd resolve `services` theo tên worker trong cùng harness.
      {
        config: {
          name: 'ecoma-account-bridge',
          main: stubScript,
          compatibility_date: '2026-10-05',
        },
      },
      {
        config: {
          name: 'ecoma-staff-access',
          main: stubScript,
          compatibility_date: '2026-10-05',
        },
      },
    ],
  });
  await harness.listen();
}, 120_000);

afterAll(async () => {
  await harness.close();
  // `rm` sau `close()`: workerd không còn giữ file trong thư mục stub. `force`
  // để lần chạy sau không đỏ vì rác của lần này — dọn dẹp không được biến thành
  // một kết quả test mới.
  if (stubDir !== '') {
    await rm(stubDir, { recursive: true, force: true });
  }
});

interface RouteResponse {
  readonly status: number;
  readonly contentType: string;
  readonly cacheControl: string;
  readonly body: string;
}

/**
 * Parse JSON body với assertion tường minh — body sai định dạng là **failure
 * của expect** (`not.toThrow`), không phải `SyntaxError` nổ ngoài vòng assertion
 * và biến test thành crash thay vì báo đỏ đúng chỗ.
 */
function expectJson(body: string): unknown {
  let parsed: unknown;
  expect(() => {
    parsed = JSON.parse(body) as unknown;
  }).not.toThrow();
  return parsed as unknown;
}

/**
 * Gọi một path qua worker runtime.
 *
 * URL phải **tuyệt đối**: `harness.fetch` không resolve path tương đối —
 * undici từ chối với `ERR_INVALID_URL` ở mọi path, lỗi dễ bị đọc nhầm thành
 * "runtime không phục vụ được". Hostname `.invalid` là cố ý: request đi thẳng
 * vào Worker, không phụ thuộc DNS hay hostname của môi trường.
 */
async function fetchRoute(
  path: string,
  headers: Record<string, string> = {},
  method: 'GET' | 'POST' = 'GET',
): Promise<RouteResponse> {
  const response = await harness.fetch(`http://worker.invalid${path}`, { headers, method });

  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    cacheControl: response.headers.get('cache-control') ?? '',
    body: await response.text(),
  };
}

describe('backoffice worker runtime (SPA, issue #67)', () => {
  // Sáu route thật của app — deep link phải mở đúng shell, rồi client router
  // mới render nội dung. Đủ cả hai route ngoài bộ prototype của e2e (`/audit`,
  // `/onboarding`) ở tầng HTTP, nơi không cần binding hay phiên.
  it.each(['/', '/staff', '/roles', '/permissions', '/audit', '/onboarding'])(
    'serves the SPA shell for %s',
    async (path) => {
      const response = await fetchRoute(path);

      expect(response.status).toBe(200);
      expect(response.contentType).toContain('text/html');
      expect(response.body).toContain('<!DOCTYPE html>');
    },
  );

  it('serves the static asset that the shell references', async () => {
    const shell = await fetchRoute('/');
    // Không dùng message thứ hai của `expect` (bị rule `vitest/valid-expect`
    // cấm): một asset path `undefined` làm test đỏ ngay ở dòng dưới.
    const assetPath = /\/_nuxt\/[\w.-]+\.js/u.exec(shell.body)?.[0] ?? '';

    expect(assetPath).not.toBe('');

    const asset = await fetchRoute(assetPath);

    expect(asset.status).toBe(200);
    expect(asset.contentType).toContain('javascript');
  });

  it('answers /health with JSON liveness', async () => {
    const response = await fetchRoute('/health');

    expect(response.status).toBe(200);
    expect(response.contentType).toContain('application/json');
    expect(expectJson(response.body)).toEqual({ status: 'ok' });
  });

  // Middleware authn chạy trước mọi route và fail-closed khi thiếu cấu hình
  // OIDC (503). Đây chính là hành vi "mặc định đóng" cần giữ nguyên sau khi
  // tắt SSR: path lạ dưới `/api/` **không bao giờ** rơi vào shell HTML — nó
  // bị chặn ở middleware trước, với JSON lỗi, kể cả khi không có route nào
  // khớp. Phân loại 401 chi tiết nằm ở harness có cấu hình OIDC (describe cuối
  // file); phân loại 401/503 theo trạng thái phiên là việc của
  // `authn-middleware.spec.ts`.
  it.each(['/api/non-existent', '/api/nested/deep', '/api/'])(
    'never answers %s with the SPA shell — authn fails closed first',
    async (path) => {
      const response = await fetchRoute(path);

      expect(response.status).toBe(503);
      expect(response.contentType).toContain('application/json');
      expect(response.body).not.toContain('<!DOCTYPE html>');
      expect(expectJson(response.body)).toMatchObject({ statusCode: 503 });
    },
  );

  // `/api` (không có dấu `/` phía sau) nằm ngoài tiền tố `/api/` của
  // middleware, nên nó tới được catch-all JSON 404 trong `server/api/`. Đây là
  // path từng trả **HTML 200** (shell) trước khi thêm catch-all — đo được trên
  // workerd, đúng lỗi mà issue #67 ghim.
  it('answers /api with a JSON 404, never the SPA shell', async () => {
    const response = await fetchRoute('/api');

    expect(response.status).toBe(404);
    expect(response.contentType).toContain('application/json');
    expect(response.body).not.toContain('<!DOCTYPE html>');
    expect(expectJson(response.body)).toEqual({
      statusCode: 404,
      statusMessage: 'Not Found',
    });
  });

  // ⚠️ Header của một lần điều hướng bằng trình duyệt, không phải của `fetch`.
  // Middleware lỗi của Nitro chỉ bỏ qua error renderer khi `Accept` **không**
  // chứa `text/html`, nên một handler dùng `createError` sẽ trả trang HTML thay
  // vì JSON khi request trông giống navigation. Đây là lý do phải gửi header
  // thật: request mặc định của harness không có `Accept`, nên một mình nó không
  // phân biệt được hai cách cài.
  it('answers /api with JSON even for a browser navigation', async () => {
    const response = await fetchRoute('/api', {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'sec-fetch-mode': 'navigate',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    });

    expect(response.status).toBe(404);
    expect(response.contentType).toContain('application/json');
    expect(response.body).not.toContain('<!DOCTYPE html>');
    expect(JSON.parse(response.body)).toEqual({
      statusCode: 404,
      statusMessage: 'Not Found',
    });
  });

  // Ba path auth nằm ngoài ranh giới chặn của middleware (chính là luồng xác
  // thực). Login với env không cấu hình phải fail-closed 503 JSON — không bao
  // giờ là shell HTML 200.
  it('keeps the auth flow reachable: /api/auth/login fails closed with JSON', async () => {
    const response = await fetchRoute('/api/auth/login');

    expect(response.status).toBe(503);
    expect(response.contentType).toContain('application/json');
    expect(expectJson(response.body)).toMatchObject({ statusCode: 503 });
    expect(response.body).not.toContain('<!DOCTYPE html>');
  });

  // Logout là POST idempotent (ADR-0011): nhận 204 không body. Ghim ở tầng
  // Worker để một refactor đổi method không chỉ nổ ở unit test mà nổ cả ở
  // hình dạng request thật.
  it('answers POST /api/auth/logout with the idempotent 204', async () => {
    const response = await fetchRoute('/api/auth/logout', {}, 'POST');

    expect(response.status).toBe(204);
    expect(response.body).toBe('');
  });

  // Service worker vẫn được sinh ra và chiến lược cache không đổi sau khi tắt
  // SSR (issue #67 — chỉ verify, không redesign): `/api/**` là NetworkOnly
  // (response có phiên không bao giờ vào cache), `/_nuxt/*.{js,css}` là
  // CacheFirst, và manifest precache vẫn được sinh từ build thật.
  it('ships a service worker that keeps /api NetworkOnly and precaches build assets', async () => {
    const sw = await fetchRoute('/sw.js');

    expect(sw.status).toBe(200);
    expect(sw.contentType).toContain('javascript');
    expect(sw.body).toContain('precacheAndRoute');
    // NetworkOnly cho `/api/` — một runtimeCaching đổi handler là response có
    // phiên bắt đầu vào cache, vi phạm invariant "API không cache".
    //
    // ⚠️ Regex cho phép **một mức** ngoặc lồng nhau (`(?:[^()]|\([^()]*\))*`),
    // không dùng `[^)]*`: Workbox sinh matcher có ngoặc bên trong (ví dụ
    // `({request}) => ...`), và `[^)]*` dừng ở dấu `)` đầu tiên nên sẽ không
    // với tới `NetworkOnly` — test đỏ dù SW đúng. Chỉ một mức lồng: đủ cho mọi
    // hình dạng matcher Workbox sinh, và không cho phép regex chạy xuyên qua
    // lệnh `registerRoute` kế tiếp (khớp phải nằm trong một lần gọi).
    expect(sw.body).toMatch(/registerRoute\s*\((?:[^()]|\([^()]*\))*NetworkOnly/su);
    expect(sw.body).toContain('CacheFirst');
  });
});

/**
 * Cùng runtime Worker thật, nhưng **có cấu hình OIDC + PostgreSQL thật** —
 * nửa còn lại của hợp đồng routing (finding #1 của review PR #70): một path lạ
 * dưới `/api/` khi **đã xác thực** phải gặp catch-all JSON 404 của `server/api/`
 * (không phải shell), còn khi **chưa xác thực** phải dừng ở middleware authn
 * với 401 — và Accept `text/html` không biến path nào ở `/api/**` thành shell
 * HTTP 200.
 *
 * Vì sao không dùng harness đầu: `configPath` không khai `vars`/Hyperdrive nào
 * ở top-level (chỉ `env.staging` có), nên worker trong harness đầu luôn chạy ở
 * trạng thái "chưa cấu hình" — đúng cái nửa đầu suite ghim. Worker cấu hình ở
 * đây dùng config **inline** nhân bản các trường của `wrangler.jsonc` (không
 * khai lại được `configPath` hai lần trong một harness) và thêm đúng ba thứ
 * test cần: `vars` OIDC test, binding `DB_BACKOFFICE` mô phỏng local (cùng cơ
 * chế `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_*` mà lane local dùng) và
 * cùng hai stub service để boot được.
 */
describe('backoffice worker runtime with authn configured (PR #70 finding 1)', () => {
  const AUDIENCE = 'https://api.test.ecoma.io/backoffice';
  const CLIENT_ID = 'worker-runtime-authn';
  const ACCOUNT_ID = `sub_${'b'.repeat(32)}`;
  const KEY_ID = 'worker-runtime-authn-key';
  const AUTH_WORKER_NAME = 'ecoma-backoffice-auth';

  let authHarness: TestHarness;
  let db: BackofficeDatabase;
  let jwksServer: Server;
  let issuerUrl = '';
  let signingKey: CryptoKeyPair;
  let sessionValue = '';
  let previousHyperdriveConnectionString: string | undefined;

  beforeAll(async () => {
    db = await startBackofficeDatabase();

    signingKey = (await generateKeyPair('ES256', { extractable: true })) as CryptoKeyPair;
    const jwk = {
      kid: KEY_ID,
      alg: 'ES256',
      use: 'sig',
      ...(await exportJWK(signingKey.publicKey)),
    };

    jwksServer = createServer((req, res) => {
      if (req.url === '/jwks.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((done) => {
      jwksServer.listen(0, '127.0.0.1', done);
    });
    const address = jwksServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('fake auth server did not bind a port');
    }
    issuerUrl = `http://127.0.0.1:${address.port}`;

    // Phiên thật trong PostgreSQL thật: cookie giá trị ngẫu nhiên, DB giữ
    // SHA-256 của nó cùng access token ES256 do chính key ở trên ký — middleware
    // xác thực đường thật (lookup by hash + JWKS fetch), không có bypass test.
    const token = await signAccessToken();
    sessionValue = createSessionIdentifier();
    const client = await db.connect();
    try {
      const deadlines = sessionDeadlines(Date.now());
      await insertSession(client as never, {
        idHash: await hashSessionIdentifier(sessionValue),
        accountSub: ACCOUNT_ID,
        accessToken: token,
        refreshToken: null,
        authTime: null,
        acr: null,
        expiresAt: new Date(deadlines.idleExpiresAtMs),
      });
    } finally {
      await client.end();
    }

    const stubScript = join(stubDir, 'index.mjs');
    // Hyperdrive local của miniflare KHÔNG nhận connection string từ config —
    // nó đọc biến môi trường `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>`
    // trước khi dựng binding (cùng cơ chế lane local dùng cho WIC auth). Phải set
    // TRƯỚC `createTestHarness`. Giữ giá trị cũ để `afterAll` khôi phục — biến
    // môi trường của tiến trình test không được rò rỉ ra ngoài suite này
    // (connection string trỏ tới PostgreSQL test sẽ bị đóng ở `afterAll`).
    previousHyperdriveConnectionString =
      process.env['CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_BACKOFFICE'];
    process.env['CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_BACKOFFICE'] =
      `postgres://ecoma_backoffice_runtime:${db.rolePassword}@${db.host}:${db.port}/${BACKOFFICE_DATABASE}`;
    authHarness = wranglerCli.createTestHarness({
      root: APP_DIR,
      workers: [
        {
          config: {
            name: AUTH_WORKER_NAME,
            main: resolve(APP_DIR, '.output/server/index.mjs'),
            compatibility_date: '2026-10-05',
            compatibility_flags: ['nodejs_compat'],
            services: [
              { binding: 'ACCOUNT_SERVICE', service: 'ecoma-account-bridge' },
              { binding: 'STAFF_ACCESS_SERVICE', service: 'ecoma-staff-access' },
            ],
            vars: {
              BACKOFFICE_AUTH_ISSUER: issuerUrl,
              BACKOFFICE_AUTH_AUDIENCE: AUDIENCE,
              BACKOFFICE_AUTH_CLIENT_ID: CLIENT_ID,
            },
            hyperdrive: [
              {
                binding: 'DB_BACKOFFICE',
                id: '00000000000000000000000000000000',
              },
            ],
          },
        },
        {
          config: {
            name: 'ecoma-account-bridge',
            main: stubScript,
            compatibility_date: '2026-10-05',
          },
        },
        {
          config: {
            name: 'ecoma-staff-access',
            main: stubScript,
            compatibility_date: '2026-10-05',
          },
        },
      ],
    });
    await authHarness.listen();
  }, 240_000);

  afterAll(async () => {
    await authHarness.close();
    await new Promise<void>((done) => {
      jwksServer.close(() => done());
    });
    await db.stop();
    // Khôi phục đúng trạng thái biến môi trường trước khi suite chạy (xóa nếu
    // trước đó chưa tồn tại) — xem chú thích ở `beforeAll`.
    if (previousHyperdriveConnectionString === undefined) {
      delete process.env['CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_BACKOFFICE'];
    } else {
      process.env['CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_BACKOFFICE'] =
        previousHyperdriveConnectionString;
    }
  });

  /** Ký access token đúng cấu trúc `at+jwt` của `auth` (tiền lệ `authn-middleware.spec.ts`). */
  async function signAccessToken(expSeconds?: number): Promise<string> {
    return new SignJWT({
      scope: 'openid offline_access',
      client_id: CLIENT_ID,
      jti: 'worker-runtime-authn-jti',
    })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: KEY_ID })
      .setIssuer(issuerUrl)
      .setAudience(AUDIENCE)
      .setSubject(ACCOUNT_ID)
      .setIssuedAt()
      .setExpirationTime(expSeconds ?? Math.floor(Date.now() / 1000) + 300)
      .sign(signingKey.privateKey as CryptoKey);
  }

  /** Request thẳng vào worker có cấu hình OIDC — `getWorker(name).fetch` của harness. */
  async function fetchRouteOnAuthWorker(
    path: string,
    headers: Record<string, string> = {},
  ): Promise<RouteResponse> {
    const worker = authHarness.getWorker(AUTH_WORKER_NAME);
    const response = await worker.fetch(`http://worker.invalid${path}`, { headers });

    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      cacheControl: response.headers.get('cache-control') ?? '',
      body: await response.text(),
    };
  }

  /** Header cookie của phiên đã insert trong `beforeAll`. */
  function sessionCookie(): string {
    return `${SESSION_COOKIE_NAME}=${sessionValue}`;
  }

  // ---- Scenario A — đã cấu hình, CHƯA xác thực: middleware chặn bằng 401 ----

  it.each(['/api/non-existent', '/api/me'])(
    'answers %s with the authentication 401 in JSON when unauthenticated',
    async (path) => {
      const response = await fetchRouteOnAuthWorker(path);

      expect(response.status).toBe(401);
      expect(response.contentType).toContain('application/json');
      expect(response.body).not.toContain('<!DOCTYPE html>');
      expect(expectJson(response.body)).toMatchObject({ statusCode: 401 });
    },
  );

  // ---- Scenario B — đã xác thực: catch-all JSON 404, route thật vẫn tới ----

  it('answers an unknown /api route with the catch-all JSON 404 when authenticated', async () => {
    const response = await fetchRouteOnAuthWorker('/api/non-existent', {
      cookie: sessionCookie(),
    });

    // Hình dạng đúng của `server/api/[...path].ts` — bằng chứng request đi
    // qua middleware (401 nếu không) rồi tới catch-all, không phải shell.
    expect(response.status).toBe(404);
    expect(response.contentType).toContain('application/json');
    expect(response.body).not.toContain('<!DOCTYPE html>');
    expect(expectJson(response.body)).toEqual({
      statusCode: 404,
      statusMessage: 'Not Found',
    });
  });

  it('serves /api/me from its real handler when authenticated', async () => {
    const response = await fetchRouteOnAuthWorker('/api/me', { cookie: sessionCookie() });

    // Route thật nhận request sau middleware — catch-all không che nó. Stub
    // ACCOUNT_SERVICE trả 503 nên `displayName` suy theo hợp đồng "controlled
    // degrade" của route: vẫn 200, `displayName: null`.
    expect(response.status).toBe(200);
    expect(response.contentType).toContain('application/json');
    expect(response.cacheControl).toBe('no-store');
    expect(expectJson(response.body)).toEqual({ sub: ACCOUNT_ID, displayName: null });
  });

  // ---- Scenario C — Accept text/html: không bao giờ shell 200 cho `/api/**` ----

  it('never answers an unknown /api route with the SPA shell for a browser navigation', async () => {
    const browserNavigation = {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'sec-fetch-mode': 'navigate',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    };

    // Chưa xác thực: 401 — đúng response xác thực, không phải shell 200. Nitro
    // render 401 dưới dạng trang lỗi HTML cho browser navigation, và trang lỗi
    // đó cũng chứa root `__nuxt`; dấu vân tay phân biệt ở đây là payload lỗi
    // nhúng trong trang (`statusMessage` "unauthorized" của middleware).
    const unauthenticated = await fetchRouteOnAuthWorker('/api/non-existent', browserNavigation);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.status).not.toBe(200);
    expect(unauthenticated.body).toContain('unauthorized');

    // Đã xác thực: catch-all JSON 404 — Accept không đổi hình dạng response.
    const authenticated = await fetchRouteOnAuthWorker('/api/non-existent', {
      ...browserNavigation,
      cookie: sessionCookie(),
    });
    expect(authenticated.status).toBe(404);
    expect(authenticated.contentType).toContain('application/json');
    expect(authenticated.body).not.toContain('<!DOCTYPE html>');
    expect(expectJson(authenticated.body)).toEqual({
      statusCode: 404,
      statusMessage: 'Not Found',
    });
  });
});
