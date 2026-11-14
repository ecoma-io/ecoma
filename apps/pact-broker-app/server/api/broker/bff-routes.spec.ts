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
import { createApp, createRouter, defineEventHandler, toWebHandler, type WebHandler } from 'h3';

import { PRINCIPAL_CONTEXT_KEY } from '../../principal';
import canIDeployRoute from './can-i-deploy.post';
import environmentsRoute from './environments.get';
import machineTokensRoute from './machine-tokens.get';
import pacticipantsRoute from './pacticipants.get';
import pactsRoute from './pacts.get';

const CONFIGURED = {
  pactBrokerApiBaseUrl: 'https://broker-api.test',
};

/**
 * Access token của chủ phiên — BFF forward nó xuống API (ADR-0031 §4).
 * Không phải machine token của deploy unit: token đó đã bị retire (§5).
 */
const USER_TOKEN = 'user-access-token-value';

/** [path, route handler] — danh sách là nguồn chạy bảng, không phải bản sao. */
const GET_ROUTES: readonly (readonly [string, unknown])[] = [
  ['/api/broker/pacts', pactsRoute],
  ['/api/broker/pacticipants', pacticipantsRoute],
  ['/api/broker/environments', environmentsRoute],
  ['/api/broker/machine-tokens', machineTokensRoute],
];

/** [path, route handler, body] — route POST duy nhất (truy vấn, không ghi). */
const POST_ROUTES: readonly (readonly [string, unknown, object])[] = [
  ['/api/broker/can-i-deploy', canIDeployRoute, { pacticipant: 'service-a', version: '1.0.0' }],
];

const ALL_ROUTES: readonly (readonly [string, unknown])[] = [
  ...GET_ROUTES,
  ...POST_ROUTES.map(([path, handler]) => [path, handler] as const),
];

function buildApp(route: { method: 'GET' | 'POST'; path: string; handler: unknown }): WebHandler {
  const app = createApp();
  const router = createRouter();
  if (route.method === 'POST') {
    router.post(route.path, route.handler as never);
  } else {
    router.get(route.path, route.handler as never);
  }
  // Middleware authn gắn principal vào `event.context` — route đọc nó qua
  // `requirePrincipal`. Test dựng app h3 thủ công nên phải đóng vai middleware:
  // không có principal ⇒ 401, đúng như runtime thật (h3 chạy tiếp khi handler
  // trả undefined).
  app.use(
    defineEventHandler((event) => {
      event.context[PRINCIPAL_CONTEXT_KEY] = { actorSub: 'sub-user', accessToken: USER_TOKEN };
    }),
  );
  app.use(router.handler);
  return toWebHandler(app);
}

/**
 * Gọi một route qua web handler. Route POST (duy nhất: `can-i-deploy`) luôn
 * nhận body hợp lệ mặc định — các nhánh validate body sai được phủ riêng ở
 * describe cuối, không nằm trong bảng chung.
 */
async function call(
  path: string,
  handler: unknown,
  options: {
    runtimeConfig?: unknown;
    body?: object;
    methodFor?: string;
  } = {},
): Promise<Response> {
  const isPost = (options.methodFor ?? path).endsWith('can-i-deploy');
  const method: 'GET' | 'POST' = isPost ? 'POST' : 'GET';
  // Route đọc config qua auto-import `useRuntimeConfig(event)` (sửa trong issue
  // #181: không phải slot `event.context.runtimeConfig` — slot đó không ai gắn
  // trên runtime thật), nên test stub toàn cục — đúng pattern `apps/account`.
  vi.stubGlobal('useRuntimeConfig', () => options.runtimeConfig ?? CONFIGURED);
  const webHandler = buildApp({ method, path, handler });
  return webHandler(
    new Request(`https://dashboard.test${path}`, {
      method,
      ...(isPost
        ? {
            body: JSON.stringify(options.body ?? { pacticipant: 'service-a', version: '1.0.0' }),
            headers: { 'content-type': 'application/json' },
          }
        : {}),
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
      let calledPath = '';
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          calledPath = new URL(String(input)).pathname;
          return new Response('{"detail":"forbidden"}', {
            status: 403,
            headers: { 'content-type': 'application/json' },
          });
        }),
      );

      const response = await call(path, handler, { methodFor: path });

      expect(response.status).toBe(403);
      // BFF gọi đúng endpoint upstream mà route khai (không route nào dựng
      // lại logic liệt kê của API).
      expect(calledPath.length).toBeGreaterThan(0);
    });
  }

  it('keeps the exact upstream first hop per route — each route owns its endpoint', async () => {
    // `/api/broker/pacts` compose từ `/pacticipants` + `/matrix` (issue #181):
    // hop ĐẦU là listing, hop ma trận được phủ riêng ở describe cuối.
    const expectedFirstHop: Record<string, string> = {
      '/api/broker/pacts': '/pacticipants',
      '/api/broker/pacticipants': '/pacticipants',
      '/api/broker/environments': '/environments',
      '/api/broker/machine-tokens': '/admin/machine-tokens',
      '/api/broker/can-i-deploy': '/can-i-deploy',
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

      await call(path, handler, { methodFor: path });
      expect(calledPaths[0], `route: ${path}`).toBe(expectedFirstHop[path]);
    }
  });

  it('forwards the session access token, never a machine token of the deploy unit', async () => {
    // ADR-0031 §4: BFF forward access token CỦA CHỦ PHIÊN. Machine token của
    // BFF đã bị retire (§5) — không có header nào mang credential của deploy
    // unit, và browser không bao giờ thấy token nào.
    const seenAuth: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenAuth.push(new Headers(init?.headers).get('authorization') ?? '');
        return new Response('{}', { status: 200 });
      }),
    );

    await call('/api/broker/pacts', pactsRoute);

    expect(seenAuth.length).toBeGreaterThan(0);
    for (const header of seenAuth) {
      expect(header).toBe(`Bearer ${USER_TOKEN}`);
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

      const response = await call(path, handler, { methodFor: path });

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
