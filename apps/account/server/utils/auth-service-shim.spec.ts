/**
 * Unit test cho `server/utils/auth-service-shim.ts` — adapter HTTP của Service
 * Binding `AUTH_SERVICE` trên preset `node-server`.
 *
 * fetch được stub ở mức seam (`fetchImpl`) — shim ghi lại request gửi đi và
 * trả response do test chỉ định, không cần mạng. Điểm cần chứng minh là
 * **tính nguyên vẹn của transport**: envelope HMAC mà `auth-client` đã ký
 * trước khi vào binding phải tới nơi với đúng path, đúng header, đúng byte —
 * nên chữ ký được verify lại bằng `verifyRequest` **thật** của
 * `@ecoma-io/internal-auth-contracts` trên những gì shim gửi ra, cùng cách
 * `auth-client.spec.ts` verify chiều ngược lại.
 */

import { describe, expect, it } from 'vitest';

import { createNonce, signRequest, verifyRequest } from '@ecoma-io/internal-auth-contracts';

import { httpAuthServiceBinding } from './auth-service-shim';

const SECRET = 'test-internal-hmac-secret-0123456789abcdef';
const ORIGIN = 'http://ecoma-w0123456789ab-auth:4203';
const PATH = '/internal/session/verified';

/** Request đúng hình dạng mà `auth-client.postSignedJson` dựng ra. */
async function signedAuthRequest(): Promise<Request> {
  const body = new TextEncoder().encode(JSON.stringify({ handle: 'X'.repeat(43) }));
  const envelope = await signRequest({
    method: 'POST',
    path: PATH,
    body,
    secret: SECRET,
    timestamp: String(Math.floor(Date.now() / 1000)),
    nonce: createNonce(),
  });
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const [name, value] of Object.entries(envelope)) {
    headers.set(name, value);
  }
  return new Request(`https://auth.internal${PATH}`, {
    method: 'POST',
    headers,
    body: body.slice(),
  });
}

interface CapturedRequest {
  url: URL;
  method: string;
  headers: Headers;
  body: Uint8Array;
  init: RequestInit | undefined;
}

/** Stub fetch ghi lại request — một capture cho mỗi test. */
function stubFetch(response: Response): {
  captured: CapturedRequest[];
  fetch: typeof fetch;
} {
  const captured: CapturedRequest[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    captured.push({
      url: new URL(request.url),
      method: request.method,
      headers: request.headers,
      body: new Uint8Array(await request.arrayBuffer()),
      init,
    });
    return response;
  }) as unknown as typeof fetch;
  return { captured, fetch: impl };
}

describe('httpAuthServiceBinding', () => {
  it('rewrites the URL to the configured origin and keeps path and query', async () => {
    const { captured, fetch } = stubFetch(new Response('{}', { status: 200 }));
    const binding = httpAuthServiceBinding({ origin: ORIGIN, fetchImpl: fetch });

    await binding.fetch(new Request(`https://auth.internal${PATH}?tx=abc`));

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url.origin).toBe('http://ecoma-w0123456789ab-auth:4203');
    expect(captured[0]?.url.pathname).toBe(PATH);
    expect(captured[0]?.url.search).toBe('?tx=abc');
  });

  it('forwards the POST method and the signed envelope headers untouched', async () => {
    const { captured, fetch } = stubFetch(new Response('{}', { status: 200 }));
    const binding = httpAuthServiceBinding({ origin: ORIGIN, fetchImpl: fetch });
    const incoming = await signedAuthRequest();

    await binding.fetch(incoming);

    const forwardedHeaders = captured[0]?.headers;
    expect(captured[0]?.method).toBe('POST');
    expect(forwardedHeaders?.get('content-type')).toBe('application/json');
    // Header HMAC không được shim đụng: mọi header envelope gửi ra phải đúng
    // giá trị request đến đã ký.
    for (const [name, value] of incoming.headers.entries()) {
      expect(forwardedHeaders?.get(name)).toBe(value);
    }
  });

  it('forwards the request body byte-for-byte so the envelope signature survives', async () => {
    const { captured, fetch } = stubFetch(new Response('{}', { status: 200 }));
    const binding = httpAuthServiceBinding({ origin: ORIGIN, fetchImpl: fetch });
    const incoming = await signedAuthRequest();
    const originalBody = new Uint8Array(await incoming.clone().arrayBuffer());

    await binding.fetch(incoming);

    // Byte-for-byte: envelope ký trên body hash — một byte lệch là chữ ký hỏng.
    expect(new Uint8Array(captured[0]?.body ?? new Uint8Array())).toEqual(originalBody);

    // Chữ ký verify thật trên đường đi shim: method + path (của URL đã rewrite)
    // + header + body — cùng canonical contract mà worker auth sẽ verify.
    const forwarded = captured[0];
    const result = await verifyRequest({
      method: forwarded?.method ?? '',
      path: `${forwarded?.url.pathname}${forwarded?.url.search}`,
      body: forwarded?.body ?? new Uint8Array(),
      headers: Object.fromEntries(forwarded?.headers.entries() ?? []),
      secret: SECRET,
      now: String(Math.floor(Date.now() / 1000)),
      claimNonce: async () => false,
    });
    expect(result.ok, `verify failed: ${result.ok ? '' : result.reason}`).toBe(true);
  });

  it('passes the timeout signal from init through to the transport', async () => {
    const { captured, fetch } = stubFetch(new Response('{}', { status: 200 }));
    const binding = httpAuthServiceBinding({ origin: ORIGIN, fetchImpl: fetch });
    const controller = new AbortController();

    await binding.fetch(new Request(`https://auth.internal${PATH}`), {
      signal: controller.signal,
    });

    expect(captured[0]?.init?.signal).toBe(controller.signal);
  });

  it('returns the upstream response as-is', async () => {
    const upstream = new Response(JSON.stringify({ outcome: 'granted' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const { fetch } = stubFetch(upstream);
    const binding = httpAuthServiceBinding({ origin: ORIGIN, fetchImpl: fetch });

    const response = await binding.fetch(new Request(`https://auth.internal${PATH}`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outcome: 'granted' });
  });

  it('produces a binding that authServiceBinding accepts under the contract name', async () => {
    // Kiểm hình dạng cuối: object shim phải đi qua `authServiceBinding` —
    // cùng hàm mà mọi route dùng để đọc binding.
    const { authServiceBinding } = await import('../lib/auth-client');
    const binding = httpAuthServiceBinding({ origin: ORIGIN });
    expect(authServiceBinding({ cloudflare: { env: { AUTH_SERVICE: binding } } })).toBe(binding);
  });
});
