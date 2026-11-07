/**
 * Test cho hợp đồng không-log của `server/utils/broker-client.ts` (SR-007).
 *
 * Hai bất biến được ghim ở đây:
 *
 * 1. `brokerCall` luôn set `authorization` từ config, **server-side** — browser
 *    không bao giờ tự mang token.
 * 2. Khi fetch ném (transport lỗi), log chỉ chứa **mã ổn định**
 *    (`broker_unreachable`) — message gốc của driver, URL đích, token không
 *    được xuất hiện ở bất kỳ đâu trong stdout/stderr.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { brokerCall } from '../server/utils/broker-client';

const CONFIG = { baseUrl: 'https://broker-api.test', token: 'secret-token-value' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('brokerCall', () => {
  it('sends the bearer token from config as the authorization header', async () => {
    let seenHeaders: Headers | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const result = await brokerCall(CONFIG, '/pacticipants');
    expect(seenHeaders?.get('authorization')).toBe(`Bearer ${CONFIG.token}`);
    expect(result).toEqual({ status: 200, body: { ok: true }, errorCode: null });
  });

  it('preserves upstream status and passes the parsed body through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"_embedded":{}}', { status: 403 })),
    );
    const result = await brokerCall(CONFIG, '/admin/machine-tokens');
    // 403 phải truyền nguyên văn — BFF không hiện hoá lỗi quyền của API thành 500.
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ _embedded: {} });
    expect(result.errorCode).toBeNull();
  });

  it('never logs the URL, token, or driver message when fetch throws', async () => {
    const noisyError = new Error(
      'fetch failed: https://broker-api.test/pacticipants?token=secret-token-value',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(noisyError)),
    );

    // Stub no-op bằng `undefined` — mock hàm rỗng bị oxlint no-empty-function chặn.
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logSpyInfo = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await brokerCall(CONFIG, '/pacticipants');

    // Kết quả: status 0 + mã ổn định — không ném, không rò token.
    expect(result).toEqual({ status: 0, body: null, errorCode: 'broker_unreachable' });

    // Toàn bộ log output (error/warn/log) chỉ được chứa mã ổn định; cả message
    // lỗi của driver lẫn token đều phải vắng mặt.
    const allOutput = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...logSpyInfo.mock.calls]
      .map((call) => call.map(String).join(' '))
      .join('\n');
    expect(allOutput).toContain('broker_unreachable');
    expect(allOutput).not.toContain(CONFIG.token);
    expect(allOutput).not.toContain('fetch failed');
    expect(allOutput).not.toContain('https://');
  });

  it('returns null body for an empty or non-JSON response instead of throwing', async () => {
    // ⚠️ 204 không chấp nhận body qua constructor Response (TypeError) — status
    // null-body phải dựng bằng `Response(null)`, đây là hình dạng thật mà một
    // API trả 204 sẽ có.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const empty = await brokerCall(CONFIG, '/pacticipants');
    expect(empty).toEqual({ status: 204, body: null, errorCode: null });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>oops</html>', { status: 500 })),
    );
    const html = await brokerCall(CONFIG, '/pacticipants');
    expect(html).toEqual({ status: 500, body: null, errorCode: null });
  });

  it('sets content-type only when a body is present', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('content-type') ?? '');
        return new Response(null, { status: 200 });
      }),
    );

    await brokerCall(CONFIG, '/can-i-deploy', { method: 'GET' });
    await brokerCall(CONFIG, '/pacts', { method: 'POST', body: JSON.stringify({ a: 1 }) });

    expect(seen[0]).toBe('');
    expect(seen[1]).toBe('application/json');
  });
});
