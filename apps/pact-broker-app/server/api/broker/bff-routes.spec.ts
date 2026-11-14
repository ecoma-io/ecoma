/**
 * Colocated spec đầu tiên của `server/api/broker/**` — hợp đồng chung của năm
 * route BFF trên **h3 app thật**, với `fetch` toàn cục giả lập đúng ranh giới
 * mà `brokerCall` nhìn thấy.
 *
 * Bốn nhánh ghim cho **từng** route (bảng chạy trên cả năm):
 *
 * 1. **Chưa cấu hình ⇒ `503` + mã ổn định `broker_not_configured`** — mọi
 *    route fail-closed như nhau; không route nào đoán origin hay trả rỗng.
 * 2. **Status của API truyền nguyên văn** (200/403/404…) — BFF không hiện hoá
 *    lỗi quyền hay lỗi lookup của API thành 500.
 * 3. **Transport hỏng ⇒ `502`** — lỗi của BFF (không gọi được API), khác với
 *    lỗi của API.
 * 4. **Body không phải JSON của API vẫn đi kèm status** — UI chỉ nhìn status
 *    cũng phân loại được; body `null` không được biến thành exception.
 *
 * ⚠️ `can-i-deploy` có thêm lớp validate body riêng, phủ trong describe cuối.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, createRouter, toWebHandler, type WebHandler } from 'h3';

import canIDeployRoute from './can-i-deploy.post';
import deploymentsRoute from './deployments.get';
import environmentsRoute from './environments.get';
import machineTokensDeleteRoute from './machine-tokens/[id]/index.delete';
import machineTokensCreateRoute from './machine-tokens.post';
import machineTokensRotateRoute from './machine-tokens/[id]/rotate.post';
import machineTokensRoute from './machine-tokens.get';
import matrixRoute from './matrix.get';
import pacticipantsRoute from './pacticipants.get';
import pactsRoute from './pacts.get';
import verificationsRoute from './verifications.get';
import { USER_TOKEN, principalForTests } from './test-principal';

const CONFIGURED = {
  pactBrokerApiBaseUrl: 'https://broker-api.test',
};

const UUID_PATH = '11111111-2222-3333-4444-555555555555';

/** [path, route handler] — danh sách là nguồn chạy bảng, không phải bản sao. */
const GET_ROUTES: readonly (readonly [string, unknown])[] = [
  ['/api/broker/pacts', pactsRoute],
  ['/api/broker/pacticipants', pacticipantsRoute],
  ['/api/broker/environments', environmentsRoute],
  ['/api/broker/machine-tokens', machineTokensRoute],
  ['/api/broker/matrix', matrixRoute],
  ['/api/broker/verifications', verificationsRoute],
  ['/api/broker/deployments', deploymentsRoute],
];

/**
 * [path, route handler, body] — các route POST. `can-i-deploy` là truy vấn
 * (không đổi trạng thái); create/rotate là mutation credential (#207, ADR-0032
 * §5 — write duy nhất được phép dưới /api/broker/*).
 */
const POST_ROUTES: readonly (readonly [string, unknown, object])[] = [
  ['/api/broker/can-i-deploy', canIDeployRoute, { pacticipant: 'service-a', version: '1.0.0' }],
  [
    '/api/broker/machine-tokens',
    machineTokensCreateRoute,
    { name: 'ci', purpose: 'developer', scopes: ['read'] },
  ],
  [`/api/broker/machine-tokens/:id/rotate`, machineTokensRotateRoute, {}],
];

/** [path, route handler] — route DELETE duy nhất (mutation credential). */
const DELETE_ROUTES: readonly (readonly [string, unknown])[] = [
  [`/api/broker/machine-tokens/:id`, machineTokensDeleteRoute],
];

const ALL_ROUTES: readonly (readonly [string, unknown])[] = [
  ...GET_ROUTES,
  ...POST_ROUTES.map(([path, handler]) => [path, handler] as const),
  ...DELETE_ROUTES,
];

/**
 * Query bắt buộc cho các route có validate đầu vào trước khi gọi API — bảng
 * chung kiểm hợp đồng forward, không phải nhánh validate (được phủ riêng ở
 * describe cuối từng route).
 */
const ROUTE_QUERY: Record<string, string> = {
  '/api/broker/matrix': 'pacticipant=svc-a&version=1.0.0',
  // Có provider, KHÔNG có version → hop 1 resolve latest pact (đúng first hop
  // khai ở expectedFirstHop); status 403/502 của hop 1 được truyền nguyên văn.
  '/api/broker/verifications': 'consumer=svc-a&provider=svc-b',
};

/** Method thật của route theo bảng khai — GET/POST/DELETE. */
function methodOf(path: string): 'GET' | 'POST' | 'DELETE' {
  if (DELETE_ROUTES.some(([p]) => p === path)) return 'DELETE';
  if (POST_ROUTES.some(([p]) => p === path)) return 'POST';
  return 'GET';
}

function buildApp(route: {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  handler: unknown;
}): WebHandler {
  // Đường dẫn đăng ký route không chứa query — `call` nhận URL đầy đủ (kèm
  // query cho các route validate đầu vào) nên tách search trước khi đăng ký.
  const routePath = route.path.split('?')[0] ?? route.path;
  const app = createApp();
  const router = createRouter();
  if (route.method === 'POST') {
    router.post(routePath, route.handler as never);
  } else if (route.method === 'DELETE') {
    router.delete(routePath, route.handler as never);
  } else {
    router.get(routePath, route.handler as never);
  }
  // Middleware authn gắn principal vào `event.context` — route đọc nó qua
  // `requirePrincipal`. Test dựng app h3 thủ công nên phải đóng vai middleware:
  // không có principal ⇒ 401, đúng như runtime thật (h3 chạy tiếp khi handler
  // trả undefined). Helper dùng chung ở `test-principal.ts` — một nguồn cho cả
  // hai spec file của thư mục này (review #254).
  app.use(principalForTests());
  app.use(router.handler);
  return toWebHandler(app);
}

/**
 * Gọi một route qua web handler. Route POST luôn nhận body hợp lệ mặc định
 * (`can-i-deploy`: tham số truy vấn; create/rotate: body credential) — các
 * nhánh validate body sai được phủ riêng ở describe cuối, không nằm trong
 * bảng chung. Rotate khớp path động qua hậu tố; DELETE khớp bảng riêng.
 */
async function call(
  path: string,
  handler: unknown,
  options: {
    runtimeConfig?: unknown;
    body?: object;
  } = {},
): Promise<Response> {
  const method = methodOf(path);
  // Route đọc config qua auto-import `useRuntimeConfig(event)` (sửa trong issue
  // #181: không phải slot `event.context.runtimeConfig` — slot đó không ai gắn
  // trên runtime thật), nên test stub toàn cục — đúng pattern `apps/account`.
  vi.stubGlobal('useRuntimeConfig', () => options.runtimeConfig ?? CONFIGURED);
  const webHandler = buildApp({ method, path, handler });
  const defaultBody = POST_ROUTES.find(([p]) => p === path)?.[2] ?? {};
  // Pattern `:id` dùng để đăng ký router; request dùng UUID thật như runtime.
  const requestPath = path.replaceAll(':id', UUID_PATH);
  return webHandler(
    new Request(`https://dashboard.test${requestPath}`, {
      method,
      ...(method === 'GET'
        ? {}
        : {
            body: JSON.stringify(options.body ?? defaultBody),
            headers: { 'content-type': 'application/json' },
          }),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('every /api/broker route fails closed when the BFF is unconfigured', () => {
  for (const [path, handler] of ALL_ROUTES) {
    it(`503 broker_not_configured: ${path}`, async () => {
      const response = await call(path, handler, { runtimeConfig: {} });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: 'Service Unavailable',
        code: 'broker_not_configured',
      });
    });
  }
});

describe('every /api/broker route forwards upstream status verbatim', () => {
  for (const [path, handler] of ALL_ROUTES) {
    it(`passes a 403 from the API through as 403: ${path}`, async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('{"detail":"forbidden"}', {
              status: 403,
              headers: { 'content-type': 'application/json' },
            }),
        ),
      );

      const response = await call(
        `${path}${ROUTE_QUERY[path] === undefined ? '' : `?${ROUTE_QUERY[path]}`}`,
        handler,
      );

      expect(response.status).toBe(403);
    });
  }

  it('keeps the exact upstream first hop per route — each route owns its endpoint', async () => {
    // `/verifications` resolve version từ latest pact trước khi hỏi matrix.
    // Query hợp lệ: bảng chung giờ truyền `ROUTE_QUERY` để route validate
    // đầu vào (matrix/verifications) tới được hop upstream thay vì 400 sớm —
    // nhánh 400 rỗng được phủ riêng ở describe cuối từng route.
    const firstHopQuery = {
      '/api/broker/pacts': '/pacticipants',
      '/api/broker/pacticipants': '/pacticipants',
      '/api/broker/environments': '/environments',
      // Cùng key cho GET list và POST create — cùng hop upstream đầu tiên.
      '/api/broker/machine-tokens': '/admin/machine-tokens',
      '/api/broker/machine-tokens/:id/rotate': `/admin/machine-tokens/${UUID_PATH}/rotate`,
      '/api/broker/machine-tokens/:id': `/admin/machine-tokens/${UUID_PATH}`,
      '/api/broker/can-i-deploy': '/can-i-deploy',
      '/api/broker/matrix': '/matrix',
      '/api/broker/verifications': '/pacts/provider/svc-b/consumer/svc-a/latest',
      '/api/broker/deployments': '/pacticipants',
    };

    for (const [path, handler] of ALL_ROUTES) {
      const calledPaths: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          calledPaths.push(new URL(String(input)).pathname);
          return new Response('{}', { status: 200 });
        }),
      );

      await call(`${path}${ROUTE_QUERY[path] === undefined ? '' : `?${ROUTE_QUERY[path]}`}`, handler);
      expect(calledPaths[0], `route: ${path}`).toBe(firstHopQuery[path]);
    }
  });

  it('forwards the session access token, never a machine token of the deploy unit', async () => {
    // ADR-0031 §4: BFF forward access token CỦA CHỦ PHIÊN. Machine token của
    // BFF đã bị retire (§5) — không có header nào mang credential của deploy
    // unit, và browser không bao giờ thấy token nào. Ghim trên MỌI route
    // (review #254) — forward là luật chung của `/api/broker/**`.
    const seenAuth: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenAuth.push(new Headers(init?.headers).get('authorization') ?? '');
        return new Response('{}', { status: 200 });
      }),
    );

    for (const [path, handler] of ALL_ROUTES) {
      seenAuth.length = 0;
      await call(`${path}${ROUTE_QUERY[path] === undefined ? '' : `?${ROUTE_QUERY[path]}`}`, handler);
      expect(seenAuth.length).toBeGreaterThan(0);
      for (const header of seenAuth) {
        expect(header, `route ${path}`).toBe(`Bearer ${USER_TOKEN}`);
      }
    }
  });
});

describe('machine-tokens — the BFF returns the API body byte-for-byte (ADR-0031 §5.3)', () => {
  const apiBody = {
    _embedded: {
      tokens: [
        {
          id: '11111111-2222-3333-4444-555555555555',
          name: 'ci-token',
          scopes: ['read', 'write'],
          createdAt: '2026-11-14T00:00:00.000Z',
          revokedAt: null,
        },
      ],
    },
  };

  it('returns exactly what the API returned and adds no field of its own', async () => {
    // §5.3 là điều kiện kiểm được: KHÔNG machine token (mọi scope) trong bất kỳ
    // response nào. Bằng chứng gồm hai vế — API chỉ trả 5 khoá metadata
    // (`apps/pact-broker-api/tests/integrations/api.spec.ts`, test lifecycle
    // machine token), và BFF là pass-through thuần: body ra bằng body vào, nên
    // BFF không thể tự thêm token material vào.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(apiBody), { status: 200 })),
    );

    const response = await call('/api/broker/machine-tokens', machineTokensRoute);

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual(apiBody);
    // Chốt thêm ở dạng phủ định: không khoá nào tên như vật liệu token, và
    // không giá trị nào trông như digest hex 64 ký tự hay ciphertext.
    const serialized = JSON.stringify(body);
    // Truy cập bracket để tránh no-underscore-dangle với HAL `_embedded`.
    const firstToken = (body as typeof apiBody)['_embedded'].tokens[0] ?? {};
    const keys = Object.keys(firstToken);
    expect(keys.some((key) => /token|secret|hash|cipher/iu.test(key))).toBe(false);
    expect(serialized).not.toMatch(/[0-9a-f]{64}/u);
    expect(serialized).not.toContain('ciphertext');
  });
});

describe('pacts — BFF-side composition of the matrix read (issue #181)', () => {
  it('queries the matrix once with one repeated selector per pacticipant', async () => {
    const calledUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        calledUrls.push(`${url.pathname}?${url.searchParams.toString()}`);
        if (url.pathname === '/pacticipants') {
          return new Response(
            JSON.stringify({
              _links: { self: { href: '/pacticipants' } },
              _embedded: {
                pacticipants: [
                  { name: 'svc-a', createdAt: '2026-11-13T00:00:00Z' },
                  { name: 'svc-b', createdAt: '2026-11-13T00:00:00Z' },
                ],
              },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ summary: {}, notices: [], matrix: [] }), {
          status: 200,
        });
      }),
    );

    const response = await call('/api/broker/pacts', pactsRoute);

    expect(response.status).toBe(200);
    expect(calledUrls).toHaveLength(2);
    // Tách pathname và search để assert không dính vào cách stub serialize URL
    // (chuỗi ghi lại luôn có `?` kể cả khi search rỗng).
    const firstHop = new URL(`https://broker.test${calledUrls[0]}`);
    expect(firstHop.pathname).toBe('/pacticipants');
    expect(firstHop.search).toBe('');
    // Selector lặp `q[][pacticipant]` — đúng format mà reference client gửi,
    // API tự union + dedup; không chế độ "không param" nào được phát minh.
    const matrixQuery = new URL(`https://broker.test${calledUrls[1]}`).searchParams;
    expect(matrixQuery.getAll('q[][pacticipant]')).toEqual(['svc-a', 'svc-b']);
    await expect(response.json()).resolves.toEqual({ summary: {}, notices: [], matrix: [] });
  });

  it('answers an empty matrix at the BFF when the broker has no pacticipant', async () => {
    const calledPaths: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calledPaths.push(new URL(String(input)).pathname);
        return new Response(JSON.stringify({ _links: {}, _embedded: { pacticipants: [] } }), {
          status: 200,
        });
      }),
    );

    const response = await call('/api/broker/pacts', pactsRoute);

    expect(response.status).toBe(200);
    expect(calledPaths).toEqual(['/pacticipants']);
    await expect(response.json()).resolves.toEqual({ matrix: [] });
  });
});

describe('every /api/broker route maps a transport failure to 502', () => {
  for (const [path, handler] of ALL_ROUTES) {
    it(`502 broker_unreachable when fetch throws: ${path}`, async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Promise.reject(new Error('fetch failed'))),
      );
      const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const response = await call(
        `${path}${ROUTE_QUERY[path] === undefined ? '' : `?${ROUTE_QUERY[path]}`}`,
        handler,
      );

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({ error: 'broker_unreachable' });
      expect(logSpy).toHaveBeenCalled();
    });
  }
});

describe('can-i-deploy — body validation before forward', () => {
  it('accepts the tri-state query and forwards exactly the three known parameters', async () => {
    let calledUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calledUrl = String(input);
        return new Response('{"deployable":true}', { status: 200 });
      }),
    );

    const response = await call('/api/broker/can-i-deploy', canIDeployRoute, {
      body: { pacticipant: 'service-a', version: '1.0.0', to: 'prod', junk: 'x' },
    });

    expect(response.status).toBe(200);
    const params = new URL(calledUrl).searchParams;
    // Chỉ ba tham số có nghĩa được truyền tiếp — dashboard không phải proxy mù.
    expect([...params.keys()].toSorted()).toEqual(['pacticipant', 'to', 'version']);
    expect(params.get('pacticipant')).toBe('service-a');
    expect(params.get('version')).toBe('1.0.0');
    expect(params.get('to')).toBe('prod');
    await expect(response.json()).resolves.toEqual({ deployable: true });
  });

  it('rejects an invalid body with 400 and never calls the API', async () => {
    const fetchSpy = vi.fn<(...args: unknown[]) => Promise<Response>>();
    vi.stubGlobal('fetch', fetchSpy);

    for (const body of [
      {},
      { pacticipant: '', version: '1' },
      { pacticipant: 'a', version: '' },
      { pacticipant: 'a', version: '1', to: '' },
      { pacticipant: 'x'.repeat(256), version: '1' },
      'not-an-object',
    ]) {
      const response = await call('/api/broker/can-i-deploy', canIDeployRoute, {
        body: body as object,
      });
      expect(response.status, `body: ${JSON.stringify(body)}`).toBe(400);
    }

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('omits the optional to-environment parameter when the body does not carry it', async () => {
    let calledUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calledUrl = String(input);
        return new Response('{"deployable":null}', { status: 200 });
      }),
    );

    await call('/api/broker/can-i-deploy', canIDeployRoute, {
      body: { pacticipant: 'a', version: '1' },
    });

    expect(new URL(calledUrl).searchParams.has('to')).toBe(false);
  });
});

describe('matrix — forward query with only the three meaningful parameters (issue #208)', () => {
  it('forwards pacticipant, version and to and drops everything else', async () => {
    let calledUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calledUrl = String(input);
        return new Response('{"summary":{},"matrix":[]}', { status: 200 });
      }),
    );

    const response = await call(
      '/api/broker/matrix?pacticipant=svc-a&version=1.0.0&to=test&junk=x',
      matrixRoute,
    );

    expect(response.status).toBe(200);
    const params = new URL(calledUrl).searchParams;
    expect([...params.keys()].toSorted()).toEqual(['pacticipant', 'to', 'version']);
    expect(params.get('pacticipant')).toBe('svc-a');
    expect(params.get('version')).toBe('1.0.0');
    expect(params.get('to')).toBe('test');
  });

  it('rejects a request without pacticipant with 400 and never calls the API', async () => {
    const fetchSpy = vi.fn<(...args: unknown[]) => Promise<Response>>();
    vi.stubGlobal('fetch', fetchSpy);

    const response = await call('/api/broker/matrix?version=1.0.0', matrixRoute);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Bad Request',
      code: 'pacticipant_required',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('verifications — composition from latest pact + matrix (issue #208)', () => {
  it('resolves the consumer version from the latest pact, then queries the matrix', async () => {
    const calledUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        calledUrls.push(`${url.pathname}?${url.searchParams.toString()}`);
        if (url.pathname === '/pacts/provider/svc-b/consumer/svc-a/latest') {
          return new Response(
            JSON.stringify({ consumer: { name: 'svc-a' }, consumerVersion: '2.0.0' }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ summary: {}, matrix: [] }), { status: 200 });
      }),
    );

    const response = await call(
      '/api/broker/verifications?consumer=svc-a&provider=svc-b',
      verificationsRoute,
    );

    expect(response.status).toBe(200);
    expect(calledUrls).toHaveLength(2);
    const matrixQuery = new URL(`https://broker.test${calledUrls[1]}`).searchParams;
    expect(matrixQuery.get('q[][pacticipant]')).toBe('svc-a');
    expect(matrixQuery.getAll('q[][version]')).toEqual(['2.0.0']);
    await expect(response.json()).resolves.toEqual({ summary: {}, matrix: [] });
  });

  it('skips the latest-pact hop when the query carries an explicit version', async () => {
    const calledPaths: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calledPaths.push(new URL(String(input)).pathname);
        return new Response(JSON.stringify({ matrix: [] }), { status: 200 });
      }),
    );

    const response = await call(
      '/api/broker/verifications?consumer=svc-a&version=3.1.0',
      verificationsRoute,
    );

    expect(response.status).toBe(200);
    expect(calledPaths).toEqual(['/matrix']);
  });

  it('rejects a request without consumer with 400 and never calls the API', async () => {
    const fetchSpy = vi.fn<(...args: unknown[]) => Promise<Response>>();
    vi.stubGlobal('fetch', fetchSpy);

    const response = await call('/api/broker/verifications', verificationsRoute);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Bad Request',
      code: 'consumer_required',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('deployments — composition from pacticipants + versions + deployed (issue #208)', () => {
  it('walks every pacticipant and merges the deployments of its latest version', async () => {
    const calledPaths: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        calledPaths.push(path);
        if (path === '/pacticipants') {
          return new Response(
            JSON.stringify({ _embedded: { pacticipants: [{ name: 'svc-a' }, { name: 'svc-b' }] } }),
            { status: 200 },
          );
        }
        if (path === '/pacticipants/svc-a/versions') {
          return new Response(
            JSON.stringify({ _embedded: { versions: [{ number: '2.0.0' }, { number: '1.0.0' }] } }),
            { status: 200 },
          );
        }
        if (path === '/pacticipants/svc-a/versions/2.0.0/deployed') {
          return new Response(
            JSON.stringify({
              _embedded: {
                deployments: [
                  { environment: 'test', deployedAt: '2026-11-13T00:00:00Z', undeployedAt: null },
                ],
              },
            }),
            { status: 200 },
          );
        }
        // svc-b: versions OK nhưng không deployment nào.
        return new Response(JSON.stringify({ _embedded: { deployments: [] } }), { status: 200 });
      }),
    );

    const response = await call('/api/broker/deployments', deploymentsRoute);

    expect(response.status).toBe(200);
    expect(calledPaths).toContain('/pacticipants/svc-a/versions');
    expect(calledPaths).toContain('/pacticipants/svc-a/versions/2.0.0/deployed');
    const body = (await response.json()) as {
      deployments: Array<{ pacticipant: string; version: string; environment: string }>;
    };
    expect(body.deployments).toEqual([
      {
        pacticipant: 'svc-a',
        version: '2.0.0',
        environment: 'test',
        deployedAt: '2026-11-13T00:00:00Z',
        undeployedAt: null,
      },
    ]);
  });

  it('filters to one pacticipant when the query asks for it', async () => {
    const calledPaths: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        calledPaths.push(path);
        if (path === '/pacticipants') {
          return new Response(
            JSON.stringify({ _embedded: { pacticipants: [{ name: 'svc-a' }, { name: 'svc-b' }] } }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ _embedded: { versions: [] } }), { status: 200 });
      }),
    );

    await call('/api/broker/deployments?pacticipant=svc-b', deploymentsRoute);

    expect(calledPaths).not.toContain('/pacticipants/svc-a/versions');
    expect(calledPaths).toContain('/pacticipants/svc-b/versions');
  });

  it('forwards the pacticipants listing status verbatim when the first hop fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"detail":"forbidden"}', { status: 403 })),
    );

    const response = await call('/api/broker/deployments', deploymentsRoute);

    expect(response.status).toBe(403);
  });
});
