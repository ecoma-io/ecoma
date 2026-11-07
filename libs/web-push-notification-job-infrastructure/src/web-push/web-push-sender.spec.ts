/**
 * Suite của adapter Web Push: pre-flight, header, JWT, ngân sách byte và error matrix.
 *
 * ⚠️ `fetchImpl` ở đây là **fake** — không có request nào ra mạng, và `fetch` thật của
 * Workers không bao giờ được chạm. Mỗi test tự kiểm "fetch **không** được gọi" khi cần,
 * vì phần lớn giá trị của pre-flight nằm ở việc **không** gửi.
 */

import type {
  WebPushSendRequest,
  WebPushSendResult,
} from '@ecoma-io/web-push-notification-job-application';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_PLAINTEXT_OCTETS,
  MAX_TTL_SECONDS,
  VAPID_EXPIRY_SECONDS,
  VAPID_SUB_IS_REQUIRED,
} from './constants';
import {
  b64u,
  FIXED_NOW_MS,
  generateSubscriptionKeyPair,
  generateVapidKeyPair,
  RFC8291_APPENDIX_A as V,
  TEST_ENDPOINT,
  TEST_PAYLOAD_JSON,
  TEST_TIMEOUT_MS,
  TEST_TTL_SECONDS,
  unb64u,
  utf8,
} from './test-fixtures';
import { createWebPushSender } from './web-push-sender';
import {
  VAPID_JOSE_ALGORITHM,
  VAPID_JOSE_SIGNATURE_OCTETS,
  VAPID_MAX_EXPIRY_SECONDS,
} from './vapid';

/** Một lần gọi `fetch` đã bắt. */
interface CapturedCall {
  readonly url: string;
  readonly init: RequestInit;
}

/**
 * `fetch` giả: ghi lại mọi lần gọi, trả `Response` với status cố định.
 *
 * `Response` thật của platform (không phải object `{status}` thuần) vì adapter đọc
 * `response.headers.get('retry-after')` — `headers` phải là `Headers` có `.get`.
 */
function fakeFetch(response: { status: number; headers?: Record<string, string> }): {
  fetchImpl: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: (init ?? {}) as RequestInit });
    return new Response(null, { status: response.status, headers: response.headers ?? {} });
  };
  return { fetchImpl, calls };
}

/** `fetch` giả luôn reject — mô phỏng DNS/connection refused trước khi gửi. */
function rejectingFetch(): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: (init ?? {}) as RequestInit });
    throw new TypeError('fetch failed');
  };
  return { fetchImpl, calls };
}

/** Request hợp lệ, override từngng field; `undefined` nghĩa là dùng giá trị mặc định. */
function buildRequest(
  overrides: Partial<WebPushSendRequest> & {
    readonly vapidPrivateKey?: string;
    readonly vapidPublicKey?: string;
  } = {},
): WebPushSendRequest {
  const request: WebPushSendRequest = {
    endpoint: TEST_ENDPOINT,
    p256dh: V.ua_public,
    auth: V.auth_secret,
    vapidPrivateKey: overrides.vapidPrivateKey ?? 'PLACEHOLDER_PRIVATE_KEY',
    vapidPublicKey: overrides.vapidPublicKey ?? 'PLACEHOLDER_PUBLIC_KEY',
    vapidSubject: 'mailto:push@example.com',
    payloadJson: TEST_PAYLOAD_JSON,
    ttlSeconds: TEST_TTL_SECONDS,
    timeoutMs: TEST_TIMEOUT_MS,
    ...overrides,
  };
  return request;
}

/** Header của `CapturedCall` dưới dạng object phẳng để assert. */
function headersOf(call: CapturedCall): Headers {
  return new Headers(call.init.headers);
}

/** Tách JWT ra khỏi header `Authorization` (`vapid t=<jwt>, k=<key>`). */
function parseAuthorization(header: string): {
  readonly scheme: string;
  readonly token: string;
  readonly key: string;
} {
  const match = /^vapid t=([^,]+), k=(.+)$/u.exec(header);
  if (match === null) {
    throw new Error(
      `Authorization header does not match the expected shape: ${header.slice(0, 40)}…`,
    );
  }
  return { scheme: 'vapid', token: match[1] ?? '', key: match[2] ?? '' };
}

/** Decode một phần JWT base64url thành JSON. */
function decodeJwtPart(part: string): unknown {
  return JSON.parse(new TextDecoder().decode(unb64u(part))) as unknown;
}

/** Cặp VAPID + request hợp lệ, dựng sẵn cho phần lớn test. */
let vapid: { privateKeyPkcs8Base64Url: string; publicKeyBase64Url: string };
let subscription: { p256dh: string; auth: string };
let validRequest: WebPushSendRequest;

beforeEach(async () => {
  vapid = await generateVapidKeyPair();
  subscription = await generateSubscriptionKeyPair();
  validRequest = buildRequest({
    p256dh: subscription.p256dh,
    auth: subscription.auth,
    vapidPrivateKey: vapid.privateKeyPkcs8Base64Url,
    vapidPublicKey: vapid.publicKeyBase64Url,
  });
});

describe('createWebPushSender request shape', () => {
  it('POSTs to the endpoint with redirect manual and the aes128gcm headers', async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 201 });
    const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });

    await sender.send(validRequest);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.init.method).toBe('POST');
    expect(call?.init.redirect).toBe('manual');
    const headers = headersOf(call ?? { url: '', init: {} });
    expect(headers.get('Content-Encoding')).toBe('aes128gcm');
    expect(headers.get('Content-Type')).toBe('application/octet-stream');
    // `new URL(...).href` — chuẩn hoá, không phải nguyên văn input.
    expect(call?.url).toBe(new URL(TEST_ENDPOINT).href);
  });

  it('sets Authorization to the RFC 8292 vapid scheme with t and k parameters', async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 201 });
    const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });

    await sender.send(validRequest);

    const authorization = headersOf(calls[0] ?? { url: '', init: {} }).get('Authorization');
    expect(authorization).not.toBeNull();
    const { scheme, token, key } = parseAuthorization(authorization ?? '');
    expect(scheme).toBe('vapid');
    expect(token.split('.')).toHaveLength(3);
    // `k` mang **public key uncompressed** nguyên văn từ runtime material (WP6), không
    // phải bản derive lại.
    expect(key).toBe(vapid.publicKeyBase64Url);
    expect(unb64u(key)).toHaveLength(65);
  });

  it('sets TTL to the integer number of seconds the caller computed', async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 201 });
    const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });

    await sender.send({ ...validRequest, ttlSeconds: 0 });
    expect(headersOf(calls[0] ?? { url: '', init: {} }).get('TTL')).toBe('0');

    await sender.send({ ...validRequest, ttlSeconds: 900 });
    const ttl = headersOf(calls[1] ?? { url: '', init: {} }).get('TTL');
    expect(ttl).toBe('900');
    expect(Number.isInteger(Number(ttl))).toBe(true);
  });

  it('sends a body of at most 4096 octets and never more than the plaintext budget allows', async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 201 });
    const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });

    await sender.send(validRequest);

    const body = calls[0]?.init.body;
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(0);
    expect(bytes.length).toBeGreaterThan(86 + utf8(TEST_PAYLOAD_JSON).length);
    expect(bytes.length).toBeLessThanOrEqual(4096);
  });

  it('rejects a TTL that cannot be represented on the wire without sending', async () => {
    for (const ttlSeconds of [-1, 1.5, Number.NaN, MAX_TTL_SECONDS + 1]) {
      const { fetchImpl, calls } = fakeFetch({ status: 201 });
      const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });

      const result = await sender.send({ ...validRequest, ttlSeconds });

      expect(result).toEqual({
        outcome: 'transient',
        phase: 'before_send',
        retryAfterMs: null,
        httpStatus: null,
      });
      expect(calls).toHaveLength(0);
    }
  });
});

describe('createWebPushSender VAPID token', () => {
  it('signs an ES256 JWT whose aud is the endpoint origin', async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 201 });
    const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });

    await sender.send(validRequest);

    const { token } = parseAuthorization(
      headersOf(calls[0] ?? { url: '', init: {} }).get('Authorization') ?? '',
    );
    const [headerPart, payloadPart] = token.split('.');
    expect(decodeJwtPart(headerPart ?? '')).toEqual({ typ: 'JWT', alg: 'ES256' });

    const claims = decodeJwtPart(payloadPart ?? '') as { aud: string; exp: number; sub?: string };
    // RFC 8292 §2: `aud` = origin của push resource URL — origin, **không** phải hostname.
    expect(claims.aud).toBe('https://push.example.net');
    expect(claims.aud).toBe(new URL(TEST_ENDPOINT).origin);
    expect(claims.sub).toBe('mailto:push@example.com');
  });

  it('sets exp to now plus the documented constant, and never past 24 hours', async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 201 });
    const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });

    await sender.send(validRequest);

    const [, payloadPart] = parseAuthorization(
      headersOf(calls[0] ?? { url: '', init: {} }).get('Authorization') ?? '',
    ).token.split('.');
    const claims = decodeJwtPart(payloadPart ?? '') as { exp: number };

    expect(claims.exp - Math.floor(FIXED_NOW_MS / 1000)).toBe(VAPID_EXPIRY_SECONDS);
    // RFC 8292 §2: `exp` MUST NOT be more than 24 hours from the time of the request.
    expect(claims.exp - Math.floor(FIXED_NOW_MS / 1000)).toBeLessThanOrEqual(
      VAPID_MAX_EXPIRY_SECONDS,
    );
    expect(VAPID_EXPIRY_SECONDS).toBe(12 * 60 * 60);
  });

  it('produces a 64-byte raw JOSE signature that verifies against the public key', async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 201 });
    const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });

    await sender.send(validRequest);

    const { token } = parseAuthorization(
      headersOf(calls[0] ?? { url: '', init: {} }).get('Authorization') ?? '',
    );
    const parts = token.split('.');
    const signingInput = `${parts[0]}.${parts[1]}`;
    const signature = unb64u(parts[2] ?? '');

    // RFC 7518 §3.4: `ES256` dùng chữ ký raw r||s 64 octet — **không** phải DER.
    expect(signature).toHaveLength(VAPID_JOSE_SIGNATURE_OCTETS);
    expect(VAPID_JOSE_SIGNATURE_OCTETS).toBe(64);

    const publicKey = await crypto.subtle.importKey(
      'raw',
      unb64u(vapid.publicKeyBase64Url),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    expect(
      await crypto.subtle.verify(VAPID_JOSE_ALGORITHM, publicKey, signature, utf8(signingInput)),
    ).toBe(true);
  });

  it('omits sub when vapidSubject is null, because RFC 8292 makes it optional', async () => {
    // RFC 8292 §2.1: "An application server MAY include a "sub" (Subject) claim".
    expect(VAPID_SUB_IS_REQUIRED).toBe(false);

    const { fetchImpl, calls } = fakeFetch({ status: 201 });
    const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });

    const result = await sender.send({ ...validRequest, vapidSubject: null });

    expect(result).toEqual({ outcome: 'delivered' });
    const { token } = parseAuthorization(
      headersOf(calls[0] ?? { url: '', init: {} }).get('Authorization') ?? '',
    );
    const [, payloadPart] = token.split('.');
    const claims = decodeJwtPart(payloadPart ?? '') as Record<string, unknown>;
    expect(Object.hasOwn(claims, 'sub')).toBe(false);
    expect(claims.aud).toBe('https://push.example.net');
  });
});

describe('createWebPushSender payload budget', () => {
  it('sends a 3993-octet plaintext exactly at the budget', async () => {
    const payloadJson = 'x'.repeat(MAX_PLAINTEXT_OCTETS);
    expect(utf8(payloadJson)).toHaveLength(MAX_PLAINTEXT_OCTETS);

    const { fetchImpl, calls } = fakeFetch({ status: 201 });
    const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });

    const result = await sender.send({ ...validRequest, payloadJson });

    expect(result).toEqual({ outcome: 'delivered' });
    expect(calls).toHaveLength(1);
    const body = calls[0]?.init.body;
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(0);
    // header 86 + plaintext 3993 + delimiter 1 + tag 16 = 4096 đúng trần WP5.
    expect(bytes.length).toBe(4096);
  });

  it('fails a 3994-octet plaintext as payload_too_large without ever calling fetch', async () => {
    const payloadJson = 'x'.repeat(MAX_PLAINTEXT_OCTETS + 1);
    expect(utf8(payloadJson)).toHaveLength(MAX_PLAINTEXT_OCTETS + 1);

    const { fetchImpl, calls } = fakeFetch({ status: 201 });
    const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });

    const result = await sender.send({ ...validRequest, payloadJson });

    expect(result).toEqual({
      outcome: 'failed',
      failureClass: 'payload_too_large',
      httpStatus: null,
    });
    // Worker §15: cấm cắt bớt để vừa — vậy nên **không** có fetch nào.
    expect(calls).toHaveLength(0);
  });
});

describe('createWebPushSender response classification', () => {
  it('maps 2xx to delivered', async () => {
    for (const status of [200, 201, 202, 204]) {
      const { fetchImpl } = fakeFetch({ status });
      const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });
      expect(await sender.send(validRequest)).toEqual({ outcome: 'delivered' });
    }
  });

  it('maps 404 to endpoint_invalid — the only class that may invalidate', async () => {
    const { fetchImpl } = fakeFetch({ status: 404 });
    const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });
    expect(await sender.send(validRequest)).toEqual({
      outcome: 'failed',
      failureClass: 'endpoint_invalid',
      httpStatus: 404,
    });
  });

  // DC-1: `410` trên **send path** của push service là endpoint đã chết, không phải trạng
  // thái tạm thời — Mozilla autopush map `NoUser`/`NoSubscription` → `410 GONE`
  // ("Expired URL endpoint"). Giữ transient sẽ chỉ đốt budget của Queue rồi rơi vào DLQ
  // trong khi subscription đã chết sống mãi.
  //
  // ⚠️ `httpStatus` giữ **410** (không gộp về 404) để metrics phân biệt một spike 410
  // với một spike 404 — chúng cùng class nhưng khác hệ quốc vận hành.
  it('maps 410 to endpoint_invalid, because a gone endpoint never becomes valid again', async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 410 });
    const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });

    expect(await sender.send(validRequest)).toEqual({
      outcome: 'failed',
      failureClass: 'endpoint_invalid',
      httpStatus: 410,
    });
    // Terminal: không retry, không gửi lần thứ hai.
    expect(calls).toHaveLength(1);
  });

  it('maps 401 and 403 to provider_auth without invalidating', async () => {
    for (const status of [401, 403]) {
      const { fetchImpl } = fakeFetch({ status });
      const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });
      expect(await sender.send(validRequest)).toEqual({
        outcome: 'failed',
        failureClass: 'provider_auth',
        httpStatus: status,
      });
    }
  });

  it('maps 413 to payload_too_large', async () => {
    const { fetchImpl } = fakeFetch({ status: 413 });
    const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });
    expect(await sender.send(validRequest)).toEqual({
      outcome: 'failed',
      failureClass: 'payload_too_large',
      httpStatus: 413,
    });
  });

  it('maps every 3xx to redirect_not_followed and never issues a second request', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const { fetchImpl, calls } = fakeFetch({
        status,
        headers: { Location: 'https://elsewhere.example.net/x' },
      });
      const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });

      expect(await sender.send(validRequest)).toEqual({
        outcome: 'failed',
        failureClass: 'redirect_not_followed',
        httpStatus: status,
      });
      // `redirect: 'manual'` — đi theo là gửi thông tin tới host khác.
      expect(calls).toHaveLength(1);
    }
  });

  it('maps 429 to transient with Retry-After seconds converted to milliseconds', async () => {
    const { fetchImpl } = fakeFetch({ status: 429, headers: { 'Retry-After': '7' } });
    const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });
    expect(await sender.send(validRequest)).toEqual({
      outcome: 'transient',
      phase: 'after_send',
      retryAfterMs: 7_000,
      httpStatus: 429,
    });
  });

  it('maps 429 without Retry-After, or with an HTTP-date, to a null retryAfterMs', async () => {
    const noHeaderVariants: readonly Record<string, string>[] = [
      {},
      { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' },
      { 'Retry-After': 'not-a-number' },
    ];
    for (const headers of noHeaderVariants) {
      const { fetchImpl } = fakeFetch({ status: 429, headers });
      const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });
      expect(await sender.send(validRequest)).toEqual({
        outcome: 'transient',
        phase: 'after_send',
        retryAfterMs: null,
        httpStatus: 429,
      });
    }
  });

  it('maps other 4xx and 5xx to transient after_send', async () => {
    // 409/418 là 4xx chưa có class riêng; 500/503 là 5xx. 429 bị chiếm ở test trên.
    for (const status of [409, 418, 500, 503]) {
      const { fetchImpl } = fakeFetch({ status });
      const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });
      const result: WebPushSendResult = await sender.send(validRequest);
      expect(result.outcome).toBe('transient');
      expect(result).toEqual({
        outcome: 'transient',
        phase: 'after_send',
        retryAfterMs: null,
        httpStatus: status,
      });
    }
  });

  it('maps a fetch rejection to transient before_send', async () => {
    const { fetchImpl } = rejectingFetch();
    const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });
    expect(await sender.send(validRequest)).toEqual({
      outcome: 'transient',
      phase: 'before_send',
      retryAfterMs: null,
      httpStatus: null,
    });
  });

  it('aborts at timeoutMs and returns transient after_send', async () => {
    // Fake chỉ settle khi thấy `signal.aborted` — tức là **chính** AbortController của
    // adapter đang làm việc, chứ không phải một rejection giả lập sẵn.
    let sawAbort = false;
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal ?? undefined;
        signal?.addEventListener('abort', () => {
          sawAbort = true;
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });

    const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });
    const result = await sender.send({ ...validRequest, timeoutMs: 1 });

    expect(sawAbort).toBe(true);
    expect(result).toEqual({
      outcome: 'transient',
      phase: 'after_send',
      retryAfterMs: null,
      httpStatus: null,
    });
  });

  it('cancels its timeout on the success path so no timer outlives the send', async () => {
    // Worker giữ Queue message trong `processing`: một timer còn sống sau khi `send` đã trả
    // là tài nguyên bị giữ vô ích, và cộng dồn theo số lần gửi. `clearTimeout` **luôn** phải
    // chạy — kể cả khi response về trước hạn (worker §16: không giữ message vô hạn).
    // ⚠️ Đếm **mọi** lần gọi, không lọc theo kiểu handle: trên Workers `setTimeout` trả
    // `number`, còn runtime test (Node) trả object `Timeout` — lọc theo `number` sẽ âm thầm
    // bỏ qua **mọi** lần gọi và test xanh giả (đã trải qua một lần).
    let cleared = 0;
    const realClearTimeout = globalThis.clearTimeout;
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((
      handle?: Parameters<typeof globalThis.clearTimeout>[0],
    ) => {
      cleared += 1;
      return realClearTimeout(handle);
    }) as typeof globalThis.clearTimeout);

    try {
      const { fetchImpl } = fakeFetch({ status: 201 });
      const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });

      await sender.send(validRequest);

      expect(cleared).toBe(1);
    } finally {
      clearSpy.mockRestore();
    }
  });

  it('cancels its timeout when fetch rejects', async () => {
    // ⚠️ Đếm **mọi** lần gọi, không lọc theo kiểu handle: trên Workers `setTimeout` trả
    // `number`, còn runtime test (Node) trả object `Timeout` — lọc theo `number` sẽ âm thầm
    // bỏ qua **mọi** lần gọi và test xanh giả (đã trải qua một lần).
    let cleared = 0;
    const realClearTimeout = globalThis.clearTimeout;
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((
      handle?: Parameters<typeof globalThis.clearTimeout>[0],
    ) => {
      cleared += 1;
      return realClearTimeout(handle);
    }) as typeof globalThis.clearTimeout);

    try {
      const { fetchImpl } = rejectingFetch();
      const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });

      await sender.send(validRequest);

      expect(cleared).toBe(1);
    } finally {
      clearSpy.mockRestore();
    }
  });
});

describe('createWebPushSender pre-flight failures', () => {
  it('rejects a non-https endpoint as endpoint_invalid without sending', async () => {
    for (const endpoint of [
      'http://push.example.net/push/abc',
      'ftp://push.example.net/push/abc',
      'not a url at all',
      '',
      'https://',
    ]) {
      const { fetchImpl, calls } = fakeFetch({ status: 201 });
      const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });

      expect(await sender.send({ ...validRequest, endpoint })).toEqual({
        outcome: 'failed',
        failureClass: 'endpoint_invalid',
        httpStatus: null,
      });
      expect(calls).toHaveLength(0);
    }
  });

  it('accepts an https endpoint regardless of letter case in the scheme', async () => {
    // `new URL` chuẩn hoá scheme; so tiền tố chuỗi thì không.
    const { fetchImpl, calls } = fakeFetch({ status: 201 });
    const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });

    const result = await sender.send({
      ...validRequest,
      endpoint: 'HTTPS://Push.Example.NET/push/abc',
    });

    expect(result).toEqual({ outcome: 'delivered' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://push.example.net/push/abc');
  });

  it('fails an empty or malformed VAPID key as vapid_key_missing without sending', async () => {
    const cases: readonly Pick<WebPushSendRequest, 'vapidPrivateKey' | 'vapidPublicKey'>[] = [
      { vapidPrivateKey: '', vapidPublicKey: vapid.publicKeyBase64Url },
      { vapidPrivateKey: vapid.privateKeyPkcs8Base64Url, vapidPublicKey: '' },
      { vapidPrivateKey: vapid.privateKeyPkcs8Base64Url, vapidPublicKey: 'AAAA' },
      { vapidPrivateKey: vapid.privateKeyPkcs8Base64Url, vapidPublicKey: b64u(new Uint8Array(64)) },
    ];

    for (const keys of cases) {
      const { fetchImpl, calls } = fakeFetch({ status: 201 });
      const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });

      expect(await sender.send({ ...validRequest, ...keys })).toEqual({
        outcome: 'failed',
        failureClass: 'vapid_key_missing',
        httpStatus: null,
      });
      expect(calls).toHaveLength(0);
    }
  });

  it('fails a private key that is not importable PKCS#8 as vapid_key_missing', async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 201 });
    const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });

    // Đúng 65 octet, đúng `0x04` — nhưng đây là *public* point, không phải DER PKCS#8.
    const result = await sender.send({
      ...validRequest,
      vapidPrivateKey: V.as_public,
    });

    expect(result).toEqual({
      outcome: 'failed',
      failureClass: 'vapid_key_missing',
      httpStatus: null,
    });
    expect(calls).toHaveLength(0);
  });

  it('maps malformed p256dh to transient before_send, never to endpoint_invalid', async () => {
    for (const p256dh of ['', 'not-base64!!', b64u(new Uint8Array(64)), V.ua_public.slice(0, -4)]) {
      const { fetchImpl, calls } = fakeFetch({ status: 201 });
      const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });

      const result = await sender.send({ ...validRequest, p256dh });

      // Subscription secret hỏng **không** nói gì về sức sống của endpoint — map sang
      // `endpoint_invalid` sẽ invalidate một subscription có thể còn tốt.
      expect(result).toEqual({
        outcome: 'transient',
        phase: 'before_send',
        retryAfterMs: null,
        httpStatus: null,
      });
      expect(calls).toHaveLength(0);
    }
  });

  it('maps malformed auth to transient before_send, never to endpoint_invalid', async () => {
    for (const auth of ['', 'not-base64!!', b64u(new Uint8Array(15)), b64u(new Uint8Array(17))]) {
      const { fetchImpl, calls } = fakeFetch({ status: 201 });
      const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });

      expect(await sender.send({ ...validRequest, auth })).toEqual({
        outcome: 'transient',
        phase: 'before_send',
        retryAfterMs: null,
        httpStatus: null,
      });
      expect(calls).toHaveLength(0);
    }
  });

  it('does not invalidate a valid subscription when only its key material is malformed', async () => {
    // Bổ sung cho trường hợp trên: **không** có kết quả nào trong suite này trả
    // `endpoint_invalid` mà không có bằng chứng provider từ chối endpoint.
    const { fetchImpl } = fakeFetch({ status: 201 });
    const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });

    const results: readonly WebPushSendResult[] = [
      await sender.send({ ...validRequest, p256dh: 'oops' }),
      await sender.send({ ...validRequest, auth: 'oops' }),
    ];

    for (const result of results) {
      expect(result.outcome === 'failed' && result.failureClass === 'endpoint_invalid').toBe(false);
    }
  });
});

describe('createWebPushSender secret hygiene', () => {
  it('carries no endpoint, key or payload material in any result shape', async () => {
    const { fetchImpl } = fakeFetch({ status: 429, headers: { 'Retry-After': '3' } });
    const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });

    const results: readonly WebPushSendResult[] = [
      { outcome: 'delivered' },
      await sender.send(validRequest),
      await sender.send({ ...validRequest, endpoint: 'http://insecure.example.net/x' }),
      await sender.send({ ...validRequest, payloadJson: 'y'.repeat(MAX_PLAINTEXT_OCTETS + 1) }),
      await sender.send({ ...validRequest, p256dh: 'oops' }),
      await sender.send({ ...validRequest, vapidPrivateKey: '' }),
    ];

    const secrets: readonly string[] = [
      TEST_ENDPOINT,
      'push.example.net',
      validRequest.p256dh,
      validRequest.auth,
      vapid.privateKeyPkcs8Base64Url,
      vapid.publicKeyBase64Url,
      TEST_PAYLOAD_JSON,
      'Tin moi',
      'Ban co mot viec moi',
    ];

    for (const result of results) {
      const serialized = JSON.stringify(result);
      for (const secret of secrets) {
        expect(serialized).not.toContain(secret);
      }
      // Chỉ được mang **đúng** các key đã khai báo trong port — không hơn, không thiếu.
      // ⚠️ So khớp theo tập `expect(...).toEqual(new Set)` chứ không `sort()`: `Array#sort`
      // cần `lib: es2023` (toSorted) mà tsconfig của lib để `es2022`, còn oxlint cấm
      // `sort` vì mutate. So sánh `toEqual` trên Set không cần thứ tự.
      const allowed: Record<WebPushSendResult['outcome'], readonly string[]> = {
        delivered: ['outcome'],
        failed: ['outcome', 'failureClass', 'httpStatus'],
        transient: ['outcome', 'phase', 'retryAfterMs', 'httpStatus'],
      };
      expect(new Set(Object.keys(result))).toStrictEqual(new Set(allowed[result.outcome]));
    }
  });

  it('never logs while sending', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { fetchImpl } = fakeFetch({ status: 500 });
      const sender = createWebPushSender({ fetchImpl, now: () => FIXED_NOW_MS });
      await sender.send(validRequest);

      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
