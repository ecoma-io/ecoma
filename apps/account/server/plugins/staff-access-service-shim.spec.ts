/**
 * Unit test cho `server/plugins/staff-access-service-shim.ts` — adapter HTTP
 * của Service Binding `STAFF_ACCESS_SERVICE` trên preset `node-server` + glue
 * mount vào runtime config.
 *
 * fetch được stub ở mức seam (`fetchImpl`) — shim ghi lại request gửi đi và
 * trả response do test chỉ định, không cần mạng. Điểm cần chứng minh là
 * **tính nguyên vẹn của transport**: envelope HMAC mà `staff-access-client`
 * đã ký trước khi vào binding phải tới nơi với đúng path, đúng header, đúng
 * byte — nên chữ ký được verify lại bằng `verifyRequest` **thật** của
 * `@ecoma-io/internal-auth-contracts` trên những gì shim gửi ra, cùng cách
 * `auth-service-shim.spec.ts` verify chiều account → auth.
 *
 * `defineNitroPlugin` là auto-import của Nitro, không tồn tại ngoài runtime —
 * stub global như `staff-access-service-shim.spec.ts` của backoffice đã ghi,
 * để import được module mà không dựng runtime.
 */

import { describe, expect, it, vi } from 'vitest';

import { createNonce, signRequest, verifyRequest } from '@ecoma-io/internal-auth-contracts';

import { STAFF_ACCESS_SERVICE_BINDING_NAME } from '../lib/staff-access-client';

vi.stubGlobal('defineNitroPlugin', (plugin: unknown) => plugin);

const {
  httpStaffAccessServiceBinding,
  mountStaffAccessServiceBinding,
  default: plugin,
} = await import('./staff-access-service-shim');

const SECRET = 'test-staff-access-internal-secret-0123456789';
const ORIGIN = 'http://ecoma-staff-access:4206';
const PATH = '/authorization/verdict';

/** Request đúng hình dạng mà `requestPermissionVerdict` dựng ra. */
async function signedVerdictRequest(): Promise<Request> {
  const body = new TextEncoder().encode(
    JSON.stringify({ permission: 'invitation.create', correlation_id: 'corr-1' }),
  );
  const envelope = await signRequest({
    method: 'POST',
    path: PATH,
    body,
    secret: SECRET,
    timestamp: String(Math.floor(Date.now() / 1000)),
    nonce: createNonce(),
    actorSub: `sub_${'o'.repeat(32)}`,
  });
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const [name, value] of Object.entries(envelope)) {
    headers.set(name, value);
  }
  return new Request(`https://staff-access.internal${PATH}`, {
    method: 'POST',
    headers,
    body: body.slice(),
  });
}

describe('mountStaffAccessServiceBinding', () => {
  it('mounts the HTTP adapter into cloudflare.env from the configured URL', () => {
    const env: Record<string, unknown> = {};
    mountStaffAccessServiceBinding({ staffAccessServiceUrl: ORIGIN, cloudflare: { env } });

    expect(typeof (env[STAFF_ACCESS_SERVICE_BINDING_NAME] as { fetch?: unknown }).fetch).toBe(
      'function',
    );
  });

  it('keeps the config unchanged when the URL is empty (fail-closed not_configured path)', () => {
    const env: Record<string, unknown> = {};
    mountStaffAccessServiceBinding({ staffAccessServiceUrl: '', cloudflare: { env } });

    expect(env).toEqual({});
  });

  it('does nothing when cloudflare.env is absent', () => {
    expect(() =>
      mountStaffAccessServiceBinding({ staffAccessServiceUrl: 'http://x:1' }),
    ).not.toThrow();
  });

  it('does not replace an existing valid binding (Workers or prior mount)', () => {
    const existing = { fetch: async () => new Response(null) };
    const env: Record<string, unknown> = { [STAFF_ACCESS_SERVICE_BINDING_NAME]: existing };

    mountStaffAccessServiceBinding({ staffAccessServiceUrl: ORIGIN, cloudflare: { env } });

    expect(env[STAFF_ACCESS_SERVICE_BINDING_NAME]).toBe(existing);
  });

  it('replaces a malformed binding shape (no fetch is not a valid binding)', () => {
    const env: Record<string, unknown> = { [STAFF_ACCESS_SERVICE_BINDING_NAME]: { no: 'fetch' } };

    mountStaffAccessServiceBinding({ staffAccessServiceUrl: ORIGIN, cloudflare: { env } });

    expect(typeof (env[STAFF_ACCESS_SERVICE_BINDING_NAME] as { fetch?: unknown }).fetch).toBe(
      'function',
    );
  });

  it('tolerates an undefined config', () => {
    expect(() => mountStaffAccessServiceBinding(undefined)).not.toThrow();
  });

  it('produces a binding that staffAccessServiceBinding accepts under the contract name', async () => {
    // Kiểm hình dạng cuối: object shim phải đi qua `staffAccessServiceBinding`
    // — cùng hàm mà `authorizeInvitationIssuance` dùng để đọc binding.
    const { staffAccessServiceBinding } = await import('../lib/staff-access-client');
    const env: Record<string, unknown> = {};
    mountStaffAccessServiceBinding({ staffAccessServiceUrl: ORIGIN, cloudflare: { env } });
    expect(staffAccessServiceBinding({ cloudflare: { env } })).toBe(
      env[STAFF_ACCESS_SERVICE_BINDING_NAME],
    );
  });
});

describe('plugin registration', () => {
  it('registers a request hook on the Nitro app', () => {
    const hook = vi.fn<(name: string, fn: (event: unknown) => void) => void>();
    plugin({ hooks: { hook } });

    expect(hook).toHaveBeenCalledWith('request', expect.any(Function));
  });
});

describe('httpStaffAccessServiceBinding', () => {
  interface CapturedRequest {
    url: URL;
    method: string;
    headers: Headers;
    body: Uint8Array;
    init: RequestInit | undefined;
  }

  /** Stub fetch ghi lại request — một capture cho mỗi test. */
  function stubFetch(response: Response): { captured: CapturedRequest[]; fetch: typeof fetch } {
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

  it('rewrites the URL to the configured origin and keeps path and query', async () => {
    const { captured, fetch: stub } = stubFetch(new Response('{}', { status: 200 }));
    const binding = httpStaffAccessServiceBinding({ origin: ORIGIN, fetchImpl: stub });

    await binding.fetch(new Request(`https://staff-access.internal${PATH}?tx=abc`));

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url.origin).toBe(ORIGIN);
    expect(captured[0]?.url.pathname).toBe(PATH);
    expect(captured[0]?.url.search).toBe('?tx=abc');
  });

  it('forwards the POST method and the signed envelope headers untouched', async () => {
    const { captured, fetch: stub } = stubFetch(new Response('{}', { status: 200 }));
    const binding = httpStaffAccessServiceBinding({ origin: ORIGIN, fetchImpl: stub });
    const incoming = await signedVerdictRequest();

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
    const { captured, fetch: stub } = stubFetch(new Response('{}', { status: 200 }));
    const binding = httpStaffAccessServiceBinding({ origin: ORIGIN, fetchImpl: stub });
    const incoming = await signedVerdictRequest();
    const originalBody = new Uint8Array(await incoming.clone().arrayBuffer());

    await binding.fetch(incoming);

    // Byte-for-byte: envelope ký trên body hash — một byte lệch là chữ ký hỏng.
    expect(new Uint8Array(captured[0]?.body ?? new Uint8Array())).toEqual(originalBody);

    // Chữ ký verify thật trên đường đi shim: method + path (của URL đã rewrite)
    // + header + body — cùng canonical contract mà worker staff-access sẽ verify.
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
    const { captured, fetch: stub } = stubFetch(new Response('{}', { status: 200 }));
    const binding = httpStaffAccessServiceBinding({ origin: ORIGIN, fetchImpl: stub });
    const controller = new AbortController();

    await binding.fetch(new Request(`https://staff-access.internal${PATH}`), {
      signal: controller.signal,
    });

    expect(captured[0]?.init?.signal).toBe(controller.signal);
  });

  it('returns the upstream response as-is', async () => {
    const upstream = new Response(JSON.stringify({ verdict: 'allowed', actor_staff_id: 's1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const { fetch: stub } = stubFetch(upstream);
    const binding = httpStaffAccessServiceBinding({ origin: ORIGIN, fetchImpl: stub });

    const response = await binding.fetch(new Request(`https://staff-access.internal${PATH}`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ verdict: 'allowed', actor_staff_id: 's1' });
  });
});
