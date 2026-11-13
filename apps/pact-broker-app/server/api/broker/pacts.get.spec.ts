/**
 * Colocated spec của route `pacts.get.ts` — hợp đồng **composition** phía BFF
 * (issue #181): route gọi `/pacticipants` trước rồi `GET /matrix` ĐÚNG MỘT LẦN
 * với selector lặp `q[][pacticipant]`, thay vì gọi `/matrix` trống (API trả 400
 * khi thiếu pacticipant).
 *
 * Các nhánh ghim:
 *
 * - **Composition đúng**: hop 2 mang đúng một selector cho mỗi pacticipant
 *   (API tự union + dedup), body ma trận truyền nguyên văn về UI.
 * - **Broker rỗng ⇒ ma trận rỗng 200 tại BFF** — API không có contract
 *   zero-selector, và broker chưa có dữ liệu là trạng thái rỗng thật, không
 *   phải lỗi upstream; hop 2 không được gọi.
 * - **Status upstream truyền nguyên văn** ở cả hai hop — 403/500 của hop 1
 *   không bị hiện hoá thành 500 của BFF.
 * - **Transport hỏng ⇒ 502** + log ổn định, đúng luật chung `brokerCall`.
 * - **Shape lạ ⇒ rỗng** — HAL body bất thường của hop 1 là dữ liệu trống,
 *   không phải exception.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, createRouter, toWebHandler, type WebHandler } from 'h3';

import pactsRoute, { pacticipantNamesOf } from './pacts.get';

const CONFIGURED = {
  pactBrokerApiBaseUrl: 'https://broker-api.test',
  pactBrokerApiToken: 'test-token',
};

/** Web handler h3 thật; config được cấp qua stub toàn cục `useRuntimeConfig`. */
function buildHandler(runtimeConfig: unknown): WebHandler {
  // Route đọc config qua auto-import `useRuntimeConfig(event)` (sửa trong issue
  // #181: không phải slot `event.context.runtimeConfig` — slot đó không ai gắn
  // trên runtime thật), nên test stub toàn cục — đúng pattern `apps/account`.
  vi.stubGlobal('useRuntimeConfig', () => runtimeConfig);
  const app = createApp();
  const router = createRouter();
  router.get('/api/broker/pacts', pactsRoute as never);
  app.use(router.handler);
  return toWebHandler(app);
}

/** Một response JSON gọn cho stub fetch. */
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Body HAL của `GET /pacticipants` — đúng shape mà API công bố. */
function pacticipantsBody(names: string[]): unknown {
  return {
    _links: { self: { href: '/pacticipants' } },
    _embedded: {
      pacticipants: names.map((name) => ({
        name,
        createdAt: '2026-11-13T00:00:00Z',
        _links: { self: { href: `/pacticipants/${name}` } },
      })),
    },
  };
}

interface UpstreamCall {
  readonly path: string;
  readonly query: URLSearchParams;
}

/** Stub fetch toàn cục, ghi lại mọi lời gọi upstream theo thứ tự. */
function stubUpstream(respond: (call: UpstreamCall, index: number) => Response): UpstreamCall[] {
  const calls: UpstreamCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const call: UpstreamCall = { path: url.pathname, query: url.searchParams };
      return respond(call, calls.push(call) - 1);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pacts BFF route — composition over real endpoints', () => {
  it('queries the matrix once with one repeated selector per pacticipant', async () => {
    const calls = stubUpstream((call) => {
      if (call.path === '/pacticipants') {
        return jsonResponse(pacticipantsBody(['svc-a', 'svc-b']));
      }
      return jsonResponse({ summary: {}, notices: [], matrix: [{ consumer: { name: 'svc-a' } }] });
    });

    const handler = buildHandler(CONFIGURED);
    const response = await handler(new Request('https://dashboard.test/api/broker/pacts'));

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.path).toBe('/pacticipants');
    // Ghim hop ma trận tồn tại trước khi dereference — thay cho non-null
    // assertion (bị cấm).
    const matrixCall = calls[1];
    expect(matrixCall, 'the matrix hop happened').toBeDefined();
    expect(matrixCall?.path).toBe('/matrix');
    // Đúng một selector lặp cho mỗi pacticipant — API tự union + dedup.
    expect([...(matrixCall?.query.keys() ?? [])]).toEqual(['q[][pacticipant]', 'q[][pacticipant]']);
    expect(matrixCall?.query.getAll('q[][pacticipant]')).toEqual(['svc-a', 'svc-b']);
    await expect(response.json()).resolves.toEqual({
      summary: {},
      notices: [],
      matrix: [{ consumer: { name: 'svc-a' } }],
    });
  });

  it('answers an empty matrix directly when the broker has no pacticipant', async () => {
    const calls = stubUpstream(() => jsonResponse(pacticipantsBody([])));

    const handler = buildHandler(CONFIGURED);
    const response = await handler(new Request('https://dashboard.test/api/broker/pacts'));

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    await expect(response.json()).resolves.toEqual({ matrix: [] });
  });

  it('dedupes repeated pacticipant names before querying the matrix', async () => {
    const calls = stubUpstream((call) =>
      call.path === '/pacticipants'
        ? jsonResponse(pacticipantsBody(['svc-a', 'svc-a', 'svc-b']))
        : jsonResponse({ matrix: [] }),
    );

    const handler = buildHandler(CONFIGURED);
    await handler(new Request('https://dashboard.test/api/broker/pacts'));

    expect(calls[1]?.query.getAll('q[][pacticipant]')).toEqual(['svc-a', 'svc-b']);
  });

  it('passes a non-200 listing hop through verbatim and never queries the matrix', async () => {
    const calls = stubUpstream(() =>
      jsonResponse(
        { error: 'Forbidden', message: 'Token does not have required scope: read' },
        403,
      ),
    );

    const handler = buildHandler(CONFIGURED);
    const response = await handler(new Request('https://dashboard.test/api/broker/pacts'));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Forbidden',
      message: 'Token does not have required scope: read',
    });
    expect(calls).toHaveLength(1);
  });

  it('passes a non-200 matrix hop through verbatim', async () => {
    stubUpstream((call) =>
      call.path === '/pacticipants'
        ? jsonResponse(pacticipantsBody(['svc-a']))
        : jsonResponse(
            { error: 'Bad Request', message: 'pacticipant query parameter is required' },
            400,
          ),
    );

    const handler = buildHandler(CONFIGURED);
    const response = await handler(new Request('https://dashboard.test/api/broker/pacts'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Bad Request',
      message: 'pacticipant query parameter is required',
    });
  });

  it('maps a transport failure of the listing hop to 502 and never queries the matrix', async () => {
    const calls = stubUpstream(() => {
      throw new Error('fetch failed');
    });
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const handler = buildHandler(CONFIGURED);
    const response = await handler(new Request('https://dashboard.test/api/broker/pacts'));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: 'broker_unreachable' });
    expect(calls).toHaveLength(1);
    // Log duy nhất là mã ổn định — không bao giờ nối message của fetch (SR-007).
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ level: 'error', code: 'broker_unreachable', path: '/pacticipants' }),
    );
  });

  it('keeps the broker configured check ahead of any upstream call', async () => {
    const fetchSpy = vi.fn<(...args: unknown[]) => Promise<Response>>();
    vi.stubGlobal('fetch', fetchSpy);

    const handler = buildHandler({});
    const response = await handler(new Request('https://dashboard.test/api/broker/pacts'));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Service Unavailable',
      code: 'broker_not_configured',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('pacticipantNamesOf — defensive HAL parsing', () => {
  it('extracts only non-empty string names', () => {
    expect(pacticipantNamesOf(pacticipantsBody(['svc-a', 'svc-b']))).toEqual(['svc-a', 'svc-b']);
  });

  it('returns an empty list for a missing, non-object or malformed body', () => {
    expect(pacticipantNamesOf(null)).toEqual([]);
    expect(pacticipantNamesOf(undefined)).toEqual([]);
    expect(pacticipantNamesOf({})).toEqual([]);
    expect(pacticipantNamesOf({ _embedded: {} })).toEqual([]);
    expect(pacticipantNamesOf({ _embedded: { pacticipants: 'nope' } })).toEqual([]);
    expect(
      pacticipantNamesOf({ _embedded: { pacticipants: [null, 42, { name: 7 }, { name: '' }] } }),
    ).toEqual([]);
  });

  it('keeps first-seen order while deduplicating names', () => {
    expect(pacticipantNamesOf(pacticipantsBody(['b', 'a', 'b', 'a']))).toEqual(['b', 'a']);
  });
});
