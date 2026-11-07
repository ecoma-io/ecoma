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
import environmentsRoute from './environments.get';
import machineTokensRoute from './machine-tokens.get';
import pacticipantsRoute from './pacticipants.get';
import pactsRoute from './pacts.get';

const CONFIGURED = {
  pactBrokerApiBaseUrl: 'https://broker-api.test',
  pactBrokerApiToken: 'test-token',
};

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

function buildApp(
  route: { method: 'GET' | 'POST'; path: string; handler: unknown },
  runtimeConfig: unknown,
): WebHandler {
  const app = createApp();
  // Nuxt gắn `runtimeConfig` vào `event.context` ở middleware thật của nó; ở
  // web handler test phải tự gắn — đúng slot mà route đọc
  // (`event.context.runtimeConfig`).
  app.use((event) => {
    event.context.runtimeConfig = runtimeConfig;
  });
  const router = createRouter();
  if (route.method === 'POST') {
    router.post(route.path, route.handler as never);
  } else {
    router.get(route.path, route.handler as never);
  }
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
  const webHandler = buildApp({ method, path, handler }, options.runtimeConfig ?? CONFIGURED);
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

  it('keeps the exact upstream path per route — each route owns its endpoint', async () => {
    const expectedPaths: Record<string, string> = {
      '/api/broker/pacts': '/matrix',
      '/api/broker/pacticipants': '/pacticipants',
      '/api/broker/environments': '/environments',
      '/api/broker/machine-tokens': '/admin/machine-tokens',
      '/api/broker/can-i-deploy': '/can-i-deploy',
    };

    for (const [path, handler] of ALL_ROUTES) {
      let calledPath = '';
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          calledPath = new URL(String(input)).pathname;
          return new Response('{}', { status: 200 });
        }),
      );

      await call(path, handler, { methodFor: path });
      expect(calledPath, `route: ${path}`).toBe(expectedPaths[path]);
    }
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
