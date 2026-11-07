/**
 * Spec cho shim `ecoma-account-bridge`.
 *
 * Môi trường test là Node thuần: handler được gọi trực tiếp với Request/env
 * giả; `fetch` toàn cục được stub nên không có network thật. Các claim về hành
 * vi forwarding end-to-end qua workerd thật thuộc về kiểm thử tích hợp của
 * local platform (WIC), không phải unit test này.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type BridgeEnv } from './main';

/** Ghi log của handler vào một mảng để test assert mà không làm bẩn output. */
function captureWorkerLogs(): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    if (typeof line === 'string') {
      try {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Log không phải JSON (không đến từ worker) — bỏ qua.
      }
    }
  });
  return lines;
}

/**
 * Tạo fetch stub trả một upstream response giả lập từ container account.
 *
 * Signature của `fetch` (input + init) — mockImplementation nhận `(input,
 * init)` và cast `respond` một lần ở đây thay vì khai `Function` loses-type ở
 * caller: `mock.calls` giữ nguyên shape `(input, init)` để test đọc init mà
 * không cần cast thêm.
 */
function stubUpstream(
  respond: (input: unknown, init?: RequestInit) => Response,
): ReturnType<typeof vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>> {
  const fetchStub = vi
    .fn<(input: unknown, init?: RequestInit) => Promise<Response>>()
    .mockImplementation(async (input, init) => respond(input, init));
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

const UPSTREAM_ORIGIN = 'http://ecoma-test-account:3000';

function bridgeRequest(path: string, init?: RequestInit): Request {
  return new Request(`http://ecoma-account-bridge.internal${path}`, init);
}

describe('account-bridge worker', () => {
  beforeEach(() => {
    captureWorkerLogs();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('serves GET /health itself without touching the upstream', async () => {
    const fetchStub = stubUpstream(() => new Response('should not be called'));

    const response = await worker.fetch(bridgeRequest('/health', { method: 'GET' }), {});

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ service: 'account-bridge', status: 'ok' });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('rejects requests with 503 upstream_unconfigured when BRIDGE_TARGET_ORIGIN is missing', async () => {
    const fetchStub = stubUpstream(() => new Response('should not be called'));

    const response = await worker.fetch(
      bridgeRequest('/internal/account/status', { method: 'POST' }),
      {},
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'upstream_unconfigured' });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('rejects requests with 503 when BRIDGE_TARGET_ORIGIN is not a parsable URL', async () => {
    const response = await worker.fetch(
      bridgeRequest('/internal/account/status', { method: 'POST' }),
      { BRIDGE_TARGET_ORIGIN: 'not-a-url' } satisfies BridgeEnv,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'upstream_unconfigured' });
  });

  it('rejects methods outside the forwarded set with 405', async () => {
    const fetchStub = stubUpstream(() => new Response('should not be called'));

    const response = await worker.fetch(
      bridgeRequest('/internal/account/status', { method: 'DELETE' }),
      { BRIDGE_TARGET_ORIGIN: UPSTREAM_ORIGIN } satisfies BridgeEnv,
    );

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toEqual({ error: 'method_not_allowed' });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('forwards to the upstream origin keeping path, query and application headers', async () => {
    const fetchStub = stubUpstream(
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const response = await worker.fetch(
      bridgeRequest('/internal/account/status?depth=full', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ecoma-internal-signature': 'signature-value',
          connection: 'keep-alive',
          'transfer-encoding': 'chunked',
        },
        body: JSON.stringify({ sub: 'user-1' }),
      }),
      { BRIDGE_TARGET_ORIGIN: UPSTREAM_ORIGIN } satisfies BridgeEnv,
    );

    expect(response.status).toBe(200);
    expect(fetchStub).toHaveBeenCalledTimes(1);

    const [upstreamUrl, init] = fetchStub.mock.calls[0];
    // Chỉ protocol/host bị đổi; path + query giữ nguyên — chữ ký HMAC của
    // envelope ký trên path thật, shim đổi path là phá contract.
    if (!(upstreamUrl instanceof URL)) throw new TypeError('upstream URL expected');
    if (!init) throw new TypeError('forwarded request init expected');
    expect(upstreamUrl.protocol).toBe('http:');
    expect(upstreamUrl.host).toBe('ecoma-test-account:3000');
    expect(upstreamUrl.pathname).toBe('/internal/account/status');
    expect(upstreamUrl.search).toBe('?depth=full');

    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-ecoma-internal-signature')).toBe('signature-value');
    // Header hop-by-hop không được sao chép.
    expect(headers.get('connection')).toBeNull();
    expect(headers.get('transfer-encoding')).toBeNull();
    // Host là host của upstream, không phải host của shim.
    expect(headers.get('host')).toBe('ecoma-test-account:3000');
  });

  it('passes the upstream status and body through untouched', async () => {
    stubUpstream(
      () =>
        new Response(JSON.stringify({ error: 'invalid_signature' }), {
          status: 401,
          statusText: 'Unauthorized',
          headers: { 'content-type': 'application/json' },
        }),
    );

    const response = await worker.fetch(
      bridgeRequest('/internal/auth/token', { method: 'POST', body: 'envelope' }),
      { BRIDGE_TARGET_ORIGIN: UPSTREAM_ORIGIN } satisfies BridgeEnv,
    );

    expect(response.status).toBe(401);
    expect(response.statusText).toBe('Unauthorized');
    await expect(response.json()).resolves.toEqual({ error: 'invalid_signature' });
  });

  it('translates an upstream connection failure into 503 upstream_unreachable', async () => {
    stubUpstream(() => {
      throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:3000');
    });

    const response = await worker.fetch(
      bridgeRequest('/internal/account/status', { method: 'POST' }),
      { BRIDGE_TARGET_ORIGIN: UPSTREAM_ORIGIN } satisfies BridgeEnv,
    );

    expect(response.status).toBe(503);
    // Body đọc MỘT lần — assert cả shape lẫn "không rò message của driver"
    // trên cùng nội dung đó (body đã-consumed không đọc lại được).
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: 'upstream_unreachable' });
    expect(body).not.toContain('ECONNREFUSED');
  });

  it('does not follow redirects — the redirect status reaches the caller as-is', async () => {
    const fetchStub = stubUpstream(
      () => new Response(null, { status: 302, headers: { location: 'http://elsewhere.invalid/' } }),
    );

    const response = await worker.fetch(
      bridgeRequest('/internal/account/status', { method: 'GET' }),
      { BRIDGE_TARGET_ORIGIN: UPSTREAM_ORIGIN } satisfies BridgeEnv,
    );

    expect(response.status).toBe(302);
    const [, init] = fetchStub.mock.calls[0];
    expect(init?.redirect).toBe('manual');
  });
});
