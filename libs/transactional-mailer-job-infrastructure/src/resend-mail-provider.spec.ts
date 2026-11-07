import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  MailProviderPort,
  MailProviderSendRequest,
  MailProviderSendResult,
} from '@ecoma-io/transactional-mailer-job-application';

import {
  createResendMailProvider,
  type ProviderFetch,
  type ProviderRequestInit,
  type ProviderResponse,
  type ResendProviderConfig,
} from './resend-mail-provider';

/* -------------------------------------------------------------------------------------------- */
/* Fixture                                                                                        */
/* -------------------------------------------------------------------------------------------- */

const NOW_MS = 1_800_000_000_000;
const ENDPOINT = 'https://relay.invalid/emails';
const TOKEN = 're_sentinel_9f3c1a_token';
const SENDER = 'sentinel-9f3c1a@example.invalid';
const RECIPIENT = 'sentinel-9f3c1a-recipient@example.invalid';
const SUBJECT = 'sentinel-9f3c1a-subject';
const BODY = '<p>sentinel-9f3c1a-body</p>';
const DELIVERY_ID = 'sentinel-9f3c1a-delivery';

function config(overrides: Partial<ResendProviderConfig> = {}): ResendProviderConfig {
  return {
    endpoint: ENDPOINT,
    token: TOKEN,
    from: SENDER,
    timeoutMs: 10_000,
    ...overrides,
  };
}

function request(overrides: Partial<MailProviderSendRequest> = {}): MailProviderSendRequest {
  return {
    deliveryId: DELIVERY_ID,
    recipient: RECIPIENT,
    subject: SUBJECT,
    body: BODY,
    contentType: 'text/html',
    deadlineMs: NOW_MS + 60_000,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Fake fetch                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/** Lần gọi `fetch` đã ghi lại, để assert trên request thật sự đã ra wire. */
type RecordedCall = {
  readonly url: string;
  readonly init: ProviderRequestInit;
};

type FetchStub = {
  readonly fetchImpl: ProviderFetch;
  readonly calls: RecordedCall[];
};

type FetchBehaviour =
  | {
      readonly kind: 'respond';
      readonly status: number;
      readonly body: string;
      readonly retryAfter?: string;
    }
  /** Ném exception — mô phỏng network error của HTTP client. */
  | { readonly kind: 'throw' }
  /** Chờ `signal` rồi ném `AbortError` — mô phỏng request bị huỷ. */
  | { readonly kind: 'await-abort' };

function stubFetch(behaviour: FetchBehaviour): FetchStub {
  const calls: RecordedCall[] = [];

  const fetchImpl: ProviderFetch = async (url, init) => {
    calls.push({ url, init });

    if (behaviour.kind === 'throw') {
      // Nội dung exception giống hệt những gì một HTTP client thật ném (URL đầy đủ kèm
      // secret trong message) — để ca assert bắt được cả đường rò rỉ qua `errorCode`.
      throw new TypeError(`fetch failed for ${url} with token ${TOKEN}`);
    }

    if (behaviour.kind === 'await-abort') {
      // Chờ abort rồi reject. Signal của adapter là kiểu **cấu trúc tối thiểu** (chỉ
      // `aborted`), nên stub tự đăng ký listener trên một `AbortSignal` thật thay vì
      // dùng `addEventListener` của kiểu đó — adapter không bao giờ gọi listener, chỉ
      // `abort()`, và test này cần bắt đúng hành vi đó.
      const signal = init.signal as AbortSignal;
      return new Promise<ProviderResponse>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException('The operation was aborted.', 'AbortError'));

          return;
        }
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    }

    const headers = new Headers();
    if (behaviour.retryAfter !== undefined) {
      headers.set('Retry-After', behaviour.retryAfter);
    }

    return new Response(behaviour.body, { status: behaviour.status, headers }) as ProviderResponse;
  };

  return { fetchImpl, calls };
}

function providerWith(
  behaviour: FetchBehaviour,
  overrides: Partial<ResendProviderConfig> = {},
  nowMs: () => number = () => NOW_MS,
): { readonly port: MailProviderPort; readonly stub: FetchStub } {
  const stub = stubFetch(behaviour);

  return {
    port: createResendMailProvider(config(overrides), { fetchImpl: stub.fetchImpl, nowMs }),
    stub,
  };
}

/**
 * `fetchImpl` trả một response **thông tin** (`1xx`).
 *
 * Phải dựng bằng object thay vì `new Response(body, {status})`: `undici` (runtime của
 * `environment: 'node'`) **ném** `RangeError` khi status nằm ngoài 200–599, nên một
 * `Response` thật không tạo được cho `101` — còn adapter trên workerd thì nhận được.
 * Dùng object cấu trúc là đúng: adapter chỉ đọc `status`, `headers` và `json()`.
 */
const informationalFetch: ProviderFetch = async () => ({
  status: 101,
  headers: new Headers(),
  json: async () => ({ id: 'm-1' }),
});

function ok(id: unknown): FetchBehaviour {
  return { kind: 'respond', status: 200, body: JSON.stringify({ id }) };
}

/* -------------------------------------------------------------------------------------------- */
/* Deadline                                                                                       */
/* -------------------------------------------------------------------------------------------- */

describe('deadline', () => {
  it('rejects an expired deadline without calling the provider', async () => {
    const { port, stub } = providerWith(ok('provider-message-1'));

    const result = await port.send(request({ deadlineMs: NOW_MS }));

    expect(result).toStrictEqual({
      kind: 'rejected',
      errorClass: 'retryable',
      errorCode: 'timeout',
      retryAfterMs: null,
    });
    expect(stub.calls).toEqual([]);
  });

  it('rejects a deadline one ms in the past', async () => {
    const { port } = providerWith(ok('provider-message-1'));

    expect(await port.send(request({ deadlineMs: NOW_MS - 1 }))).toMatchObject({
      kind: 'rejected',
      errorClass: 'retryable',
      errorCode: 'timeout',
    });
  });

  it('fails closed when either side of the comparison is not finite', async () => {
    // Chỉ kiểm `deadlineMs` thì một đồng hồ `NaN` làm `deadlineMs <= nowMs` luôn `false`
    // và request đã quá hạn rơi xuống `accepted` — trần cứng bị vô hiệu hoá im lặng.
    const nonFinite = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

    for (const deadlineMs of nonFinite) {
      const { port } = providerWith(ok('provider-message-1'));

      expect(await port.send(request({ deadlineMs }))).toStrictEqual({
        kind: 'rejected',
        errorClass: 'retryable',
        errorCode: 'timeout',
        retryAfterMs: null,
      });
    }

    for (const nowMs of nonFinite) {
      const { port, stub } = providerWith(ok('provider-message-1'), {}, () => nowMs);

      expect(await port.send(request({ deadlineMs: NOW_MS - 1 }))).toStrictEqual({
        kind: 'rejected',
        errorClass: 'retryable',
        errorCode: 'timeout',
        retryAfterMs: null,
      });
      expect(stub.calls).toEqual([]);
    }
  });

  it('does not schedule a timer for an expired deadline', async () => {
    vi.useFakeTimers();

    try {
      // Với fake timer, một `await sleep()` bên trong `send` sẽ treo ca này (timeout) vì
      // không ai advance đồng hồ — phép thử này bắt đúng "không sleep", không chỉ "không log".
      const { port, stub } = providerWith(ok('provider-message-1'));
      const pending = port.send(request({ deadlineMs: NOW_MS - 10_000 }));

      expect(vi.getTimerCount()).toBe(0);

      await pending;

      expect(vi.getTimerCount()).toBe(0);
      expect(stub.calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 2xx                                                                                           */
/* -------------------------------------------------------------------------------------------- */

describe('accepted responses', () => {
  it('returns the provider message id on 200', async () => {
    const { port } = providerWith(ok('0193a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b'));

    expect(await port.send(request())).toStrictEqual({
      kind: 'accepted',
      providerMessageId: '0193a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b',
      warningCode: null,
    });
  });

  it.each([
    ['unparseable body', 'not json at all'],
    ['empty body', ''],
    ['non-object body', '"just-a-string"'],
    ['body without id', '{"name":"sent"}'],
    ['id is not a string', '{"id":42}'],
    ['id is empty', '{"id":""}'],
    ['id is blank', '{"id":"   "}'],
  ])('stays accepted with a null id and a warning for %s', async (_label, body) => {
    const { port } = providerWith({ kind: 'respond', status: 200, body });

    // `2xx` là bằng chứng provider **đã chấp nhận**; body không đọc được id không hạ
    // acceptance xuống thành lỗi — retry sau khi đã accept chỉ có thể gửi trùng (§9.2.2
    // hàng 9). `warningCode` là tín hiệu duy nhất để một endpoint sai vẫn trả 200 không
    // biến mất im lặng.
    expect(await port.send(request())).toStrictEqual({
      kind: 'accepted',
      providerMessageId: null,
      warningCode: 'provider-id-unparseable',
    });
  });

  it('reads the response body at most once', async () => {
    const jsonSpy = vi.fn<ProviderResponse['json']>(async () => ({ id: 'provider-message-1' }));
    const fetchImpl: ProviderFetch = async () => ({
      status: 200,
      headers: new Headers(),
      json: jsonSpy,
    });

    const port = createResendMailProvider(config(), { fetchImpl, nowMs: () => NOW_MS });

    expect(await port.send(request())).toStrictEqual({
      kind: 'accepted',
      providerMessageId: 'provider-message-1',
      warningCode: null,
    });
    expect(jsonSpy).toHaveBeenCalledTimes(1);
  });

  it('accepts a 202 as well as a 200', async () => {
    const { port } = providerWith({ kind: 'respond', status: 202, body: '{"id":"m-1"}' });

    expect(await port.send(request())).toMatchObject({
      kind: 'accepted',
      providerMessageId: 'm-1',
    });
  });

  it('never fabricates an id from the request', async () => {
    const { port } = providerWith(ok(null));
    const raw = JSON.stringify(await port.send(request()));

    expect(raw).not.toContain(DELIVERY_ID);
    expect(raw).not.toContain(RECIPIENT);
    expect(raw).not.toContain(SUBJECT);
    expect(raw).not.toContain(BODY);
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain(SENDER);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Status -> errorClass                                                                           */
/* -------------------------------------------------------------------------------------------- */

describe('status mapping', () => {
  it.each([
    ['401', 401, 'credential', 'provider-auth-rejected'],
    ['403', 403, 'credential', 'provider-auth-rejected'],
    ['400', 400, 'permanent', 'provider-request-rejected'],
    ['422', 422, 'permanent', 'provider-request-rejected'],
    ['404', 404, 'permanent', 'provider-request-rejected'],
    // `408` rơi vào nhóm "`4xx` khác" ⇒ `permanent`: canonical không có nhóm transient cho
    // HTTP status phía provider (§11.1). Nhánh này là điểm dễ đọc sai nhất của adapter.
    ['408', 408, 'permanent', 'provider-request-rejected'],
    // Idempotency conflict của provider là `409`/`422` — hazard đã được §9.3 ghi nhận
    // tường minh, và §11.1 cấm tự thêm ngoại lệ cho `4xx`.
    ['409', 409, 'permanent', 'provider-request-rejected'],
    ['500', 500, 'retryable', 'provider-server-error'],
    ['502', 502, 'retryable', 'provider-server-error'],
    ['503', 503, 'retryable', 'provider-server-error'],
  ])('maps %s to %s / %s', async (_label, status, errorClass, errorCode) => {
    const { port } = providerWith({ kind: 'respond', status, body: '{"message":"x"}' });

    expect(await port.send(request())).toStrictEqual({
      kind: 'rejected',
      errorClass,
      errorCode,
      retryAfterMs: null,
    });
  });

  it('maps a 1xx to retryable provider-server-error', async () => {
    /**
     * `1xx` là response protocol bất thường → `retryable` theo bảng chiếu error matrix.
     *
     * Phải dựng response bằng object thay vì `new Response(body, {status})`: `undici`
     * (runtime của `environment: 'node'`) **ném** `RangeError` khi status nằm ngoài
     * 200–599, nên một `Response` thật không tạo được cho `101` — và adapter trên
     * workerd thì nhận được. Dùng object cấu trúc là đúng: port chỉ đọc `status`.
     */
    const port = createResendMailProvider(config(), {
      fetchImpl: informationalFetch,
      nowMs: () => NOW_MS,
    });

    expect(await port.send(request())).toStrictEqual({
      kind: 'rejected',
      errorClass: 'retryable',
      errorCode: 'provider-server-error',
      retryAfterMs: null,
    });
  });

  it('maps 3xx to credential with the documented http-3xx token', async () => {
    // Adapter tắt redirect-following, nên nó thấy 3xx thật. Redirect là lỗi **cấu hình
    // endpoint** (credential → `blocked`), không phải thư bị provider từ chối (§11.1).
    for (const status of [301, 302, 307, 308]) {
      const { port } = providerWith({ kind: 'respond', status, body: '' });

      expect(await port.send(request())).toStrictEqual({
        kind: 'rejected',
        errorClass: 'credential',
        errorCode: 'http-3xx',
        retryAfterMs: null,
      });
    }
  });

  it('never returns 3xx as accepted', async () => {
    const { port } = providerWith({ kind: 'respond', status: 302, body: '{"id":"m-1"}' });

    expect((await port.send(request())).kind).toBe('rejected');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 429 / Retry-After                                                                              */
/* -------------------------------------------------------------------------------------------- */

describe('rate limiting', () => {
  it('reads Retry-After seconds as milliseconds', async () => {
    const { port } = providerWith({
      kind: 'respond',
      status: 429,
      body: '{"message":"rate limited"}',
      retryAfter: '7',
    });

    expect(await port.send(request())).toStrictEqual({
      kind: 'rejected',
      errorClass: 'retryable',
      errorCode: 'provider-rate-limited',
      retryAfterMs: 7_000,
    });
  });

  it('returns a null floor when the header is absent', async () => {
    const { port } = providerWith({ kind: 'respond', status: 429, body: '{}' });

    expect(await port.send(request())).toStrictEqual({
      kind: 'rejected',
      errorClass: 'retryable',
      errorCode: 'provider-rate-limited',
      retryAfterMs: null,
    });
  });

  it('reads an HTTP-date Retry-After as a relative delay', async () => {
    const { port } = providerWith(
      {
        kind: 'respond',
        status: 429,
        body: '{}',
        retryAfter: new Date(NOW_MS + 30_000).toUTCString(),
      },
      {},
      () => NOW_MS,
    );

    // HTTP-date là **độ trễ tương đối**: quy về giây nguyên, không phải epoch tuyệt đối.
    expect(await port.send(request())).toMatchObject({ retryAfterMs: 30_000 });
  });

  it('clamps a past HTTP-date to zero rather than to a negative delay', async () => {
    const { port } = providerWith(
      {
        kind: 'respond',
        status: 429,
        body: '{}',
        retryAfter: new Date(NOW_MS - 60_000).toUTCString(),
      },
      {},
      () => NOW_MS,
    );

    expect(await port.send(request())).toMatchObject({ retryAfterMs: 0 });
  });

  it('clamps a Retry-After above the 24h ceiling', async () => {
    const { port } = providerWith({
      kind: 'respond',
      status: 429,
      body: '{}',
      retryAfter: String(48 * 60 * 60),
    });

    expect(await port.send(request())).toMatchObject({ retryAfterMs: 86_400_000 });
  });

  it.each([
    ['blank', '   '],
    ['non-numeric', 'soon'],
    ['negative', '-5'],
    ['fractional', '1.5'],
  ])('returns a null floor for a %s Retry-After', async (_label, retryAfter) => {
    const { port } = providerWith({ kind: 'respond', status: 429, body: '{}', retryAfter });

    // `null` là giá trị trung thực; `0` sẽ biến một header hỏng thành retry liên tục.
    expect(await port.send(request())).toMatchObject({ retryAfterMs: null });
  });

  it('never reads Retry-After from a non-retryable response', async () => {
    // Header trên response `permanent`/`credential` không phải sàn hợp lệ: giữ nó ở đây sẽ
    // biến một thư bị provider từ chối vĩnh viễn thành một lần trì hoãn vô nghĩa.
    const { port } = providerWith({
      kind: 'respond',
      status: 422,
      body: '{}',
      retryAfter: '7',
    });

    expect(await port.send(request())).toMatchObject({
      retryAfterMs: null,
      errorClass: 'permanent',
    });
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Transport failure                                                                              */
/* -------------------------------------------------------------------------------------------- */

describe('transport failures', () => {
  it('maps a thrown network error to retryable provider-network-error', async () => {
    const { port, stub } = providerWith({ kind: 'throw' });

    expect(await port.send(request())).toStrictEqual({
      kind: 'rejected',
      errorClass: 'retryable',
      errorCode: 'provider-network-error',
      retryAfterMs: null,
    });
    expect(stub.calls).toHaveLength(1);
  });

  it('does not retry inside one call', async () => {
    // Một lần gọi port là **một** attempt của **một** execution đã claim; slot ngân sách B
    // đã bị tiêu đúng một lần ở claim, nên retry trong adapter nghĩa là gửi nhiều lần cho
    // một slot (§11.2).
    const { port, stub } = providerWith({ kind: 'throw' });

    await port.send(request());

    expect(stub.calls).toHaveLength(1);
  });

  it('maps an abort raised by the configured timeout to timeout', async () => {
    vi.useFakeTimers();

    try {
      const stub = stubFetch({ kind: 'await-abort' });
      const port = createResendMailProvider(config({ timeoutMs: 5_000 }), {
        fetchImpl: stub.fetchImpl,
        nowMs: () => NOW_MS,
      });

      const pending = port.send(request());
      await vi.advanceTimersByTimeAsync(5_000);

      expect(await pending).toStrictEqual({
        kind: 'rejected',
        errorClass: 'retryable',
        errorCode: 'timeout',
        retryAfterMs: null,
      });
      expect(stub.calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never lets the configured timeout outlive the deadline', async () => {
    vi.useFakeTimers();

    try {
      const stub = stubFetch({ kind: 'await-abort' });
      // `timeoutMs` lớn hơn nhiều lần phần deadline còn lại: adapter MUST NOT kéo dài trần
      // cứng của worker (§11.1), nên abort phải đến từ deadline chứ không từ config.
      const port = createResendMailProvider(config({ timeoutMs: 600_000 }), {
        fetchImpl: stub.fetchImpl,
        nowMs: () => NOW_MS,
      });

      const pending = port.send(request({ deadlineMs: NOW_MS + 3_000 }));

      await vi.advanceTimersByTimeAsync(2_999);
      expect(stub.calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);

      expect(await pending).toMatchObject({ errorCode: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the timer once the response settles', async () => {
    vi.useFakeTimers();

    try {
      const { port } = providerWith(ok('m-1'));
      await port.send(request());

      // Timer còn sống sau khi response đã về là một giữ Worker sống vô tình — và với một
      // cron sweep dài, chúng tích tụ.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the timer when the request fails too', async () => {
    vi.useFakeTimers();

    try {
      const { port } = providerWith({ kind: 'throw' });
      await port.send(request());

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Gửi một request thành công và trả về đúng một lần gọi `fetch` đã ghi lại.
 *
 * `expect` ở đây kiểm "đúng một lần gọi", nhưng phần kiểm payload thuộc về từng ca test
 * bên dưới — nên ca này chỉ cần lấy lời gọi về, không khẳng định gì về nội dung nó.
 */
async function sentCall(
  overrides: Partial<ResendProviderConfig> = {},
  requestOverrides: Partial<MailProviderSendRequest> = {},
): Promise<RecordedCall> {
  const { port, stub } = providerWith(ok('m-1'), overrides);

  await port.send(request(requestOverrides));

  expect(stub.calls).toHaveLength(1);
  const call = stub.calls[0];
  if (call === undefined) {
    throw new Error('expected exactly one fetch call');
  }

  return call;
}

/* -------------------------------------------------------------------------------------------- */
/* Request shape                                                                                  */
/* -------------------------------------------------------------------------------------------- */

describe('request shape', () => {
  it('posts to the endpoint from trusted config', async () => {
    const call = await sentCall({ endpoint: 'https://other.invalid/v1/send' });

    expect(call.url).toBe('https://other.invalid/v1/send');
  });

  it('sends the credential as a bearer header and never in the body', async () => {
    const call = await sentCall();

    expect(call.init.headers).toStrictEqual({
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `mailjob_${DELIVERY_ID}`,
    });
    expect(call.init.body).not.toContain(TOKEN);
  });

  it('never takes the endpoint from the request', async () => {
    const call = await sentCall({ endpoint: ENDPOINT }, { deliveryId: 'https://attacker.invalid' });

    expect(call.url).toBe(ENDPOINT);
  });

  it('sends the sender, one recipient, the subject and the html body', async () => {
    const call = await sentCall();

    expect(JSON.parse(call.init.body)).toStrictEqual({
      from: SENDER,
      to: [RECIPIENT],
      subject: SUBJECT,
      html: BODY,
    });
  });

  it('sends exactly the four Resend fields and nothing else', async () => {
    const call = await sentCall();

    // Wire protocol của Resend là chi tiết vendor và không được rò lên trên port; nhưng nó
    // cũng không được mang theo fencing state của control plane ra ngoài (§11.1).
    expect(new Set(Object.keys(JSON.parse(call.init.body) as object))).toEqual(
      new Set(['from', 'to', 'subject', 'html']),
    );
  });

  it('never puts a reply-to, cc or bcc on the wire', async () => {
    const call = await sentCall();
    const body = JSON.parse(call.init.body) as Record<string, unknown>;

    expect(body['reply_to']).toBeUndefined();
    expect(body['cc']).toBeUndefined();
    expect(body['bcc']).toBeUndefined();
    expect(body['text']).toBeUndefined();
  });

  it('uses an idempotency key that is stable and prefixed', async () => {
    const first = await sentCall({}, { deliveryId: 'delivery-abc' });
    const second = await sentCall({}, { deliveryId: 'delivery-abc' });
    const other = await sentCall({}, { deliveryId: 'delivery-xyz' });

    expect(first.init.headers['Idempotency-Key']).toBe('mailjob_delivery-abc');
    // Key ổn định xuyên retry: đó là toàn bộ ý nghĩa của việc gửi key (§9.3).
    expect(second.init.headers['Idempotency-Key']).toBe(first.init.headers['Idempotency-Key']);
    expect(other.init.headers['Idempotency-Key']).not.toBe(first.init.headers['Idempotency-Key']);
  });

  it('keeps the idempotency key within the 256-char provider limit', async () => {
    const call = await sentCall({}, { deliveryId: 'd'.repeat(200) });

    expect((call.init.headers['Idempotency-Key'] ?? '').length).toBeLessThanOrEqual(256);
  });

  it('turns redirect-following off explicitly', async () => {
    // Mặc định của `fetch` là follow; adapter MUST tắt nó **bằng cấu hình** chứ không dựa
    // vào mặc định — một redirect sẽ mang credential và nội dung thư ra khỏi trusted
    // config (§11.2).
    const call = await sentCall();

    expect(call.init.redirect).toBe('manual');
  });

  it('posts with the configured abort signal', async () => {
    const call = await sentCall();

    expect(call.init.method).toBe('POST');
    expect(call.init.signal).toBeDefined();
    expect(call.init.signal.aborted).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Sanitization và data leak                                                                      */
/* -------------------------------------------------------------------------------------------- */

describe('sanitization and data leak', () => {
  const ALL_BEHAVIOURS: readonly (readonly [string, FetchBehaviour])[] = [
    ['accepted', ok('m-1')],
    ['unparseable id', ok(null)],
    ['401', { kind: 'respond', status: 401, body: '{}' }],
    ['422', { kind: 'respond', status: 422, body: '{}' }],
    ['429', { kind: 'respond', status: 429, body: '{}', retryAfter: '7' }],
    ['503', { kind: 'respond', status: 503, body: '{}' }],
    ['302', { kind: 'respond', status: 302, body: '' }],
    ['network error', { kind: 'throw' }],
  ];

  it('never echoes the credential, recipient, subject or body into the result', async () => {
    for (const [, behaviour] of ALL_BEHAVIOURS) {
      const { port } = providerWith(behaviour);
      const raw = JSON.stringify(await port.send(request()));

      expect(raw).not.toContain(TOKEN);
      expect(raw).not.toContain(RECIPIENT);
      expect(raw).not.toContain(SUBJECT);
      expect(raw).not.toContain(BODY);
      expect(raw).not.toContain('@example.invalid');
    }
  });

  it('never echoes the endpoint into the result', async () => {
    for (const [, behaviour] of ALL_BEHAVIOURS) {
      const { port } = providerWith(behaviour);

      expect(JSON.stringify(await port.send(request()))).not.toContain('relay.invalid');
    }
  });

  it('does not leak the URL or the credential through a thrown exception', async () => {
    const { port } = providerWith({ kind: 'throw' });
    const result = await port.send(request());

    // Exception của HTTP client là bề mặt rò rỉ tiếp theo (URL đầy đủ kèm header); nó
    // không được log nguyên văn và cũng không được đi vào `errorCode` (§11.2).
    expect(result.kind === 'rejected' ? result.errorCode : '').not.toContain(TOKEN);
    expect(result.kind === 'rejected' ? result.errorCode : '').not.toContain(ENDPOINT);
  });

  it('emits only sanitized tokens', async () => {
    const errorCodes: string[] = [];
    const warningCodes: string[] = [];

    for (const [, behaviour] of ALL_BEHAVIOURS) {
      const { port } = providerWith(behaviour);
      const result = await port.send(request());

      if (result.kind === 'rejected') {
        errorCodes.push(result.errorCode);
      } else if (result.warningCode !== null) {
        warningCodes.push(result.warningCode);
      }
    }

    const allowedErrorCodes = new Set([
      'timeout',
      'provider-network-error',
      'provider-auth-rejected',
      'provider-request-rejected',
      'provider-rate-limited',
      'provider-server-error',
      'http-3xx',
    ]);
    const allowedWarningCodes = new Set(['provider-id-unparseable']);

    // Lọc rồi so rỗng sẽ xanh vô nghĩa nếu vòng lặp không thu được gì.
    expect(errorCodes.length).toBeGreaterThan(0);
    expect(warningCodes.length).toBeGreaterThan(0);
    expect(errorCodes.filter((code) => !allowedErrorCodes.has(code))).toEqual([]);
    expect(warningCodes.filter((code) => !allowedWarningCodes.has(code))).toEqual([]);
  });

  it('emits error tokens that pass the persisted-token pattern', async () => {
    // `last_error`/`last_error_class` được validate bằng
    // `SANITIZED_ERROR_TOKEN_PATTERN` (lowercase kebab-case) trước khi ghi xuống D1; một
    // token không khớp sẽ làm cả lần persist thất bại.
    const pattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

    const emitted: string[] = [];
    for (const [, behaviour] of ALL_BEHAVIOURS) {
      const { port } = providerWith(behaviour);
      const result = await port.send(request());

      // Gom token ra rồi assert **một lần** ngoài vòng lặp: `expect` có điều kiện bên
      // trong vòng lặp là một ca test có thể không assert gì mà vẫn xanh. Ở đây danh sách
      // phải khác rỗng, được kiểm ở case kế bên — nên "token sai" là đỏ chứ không phải
      // im lặng.
      emitted.push(result.kind === 'rejected' ? result.errorCode : (result.warningCode ?? ''));
    }

    // Không rỗng, để ca này không xanh vì không có gì để kiểm.
    const tokens = emitted.filter((token) => token !== '');
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.filter((token) => !pattern.test(token))).toEqual([]);
  });

  it('does not log anything', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );

    try {
      for (const [, behaviour] of ALL_BEHAVIOURS) {
        const { port } = providerWith(behaviour);
        await port.send(request());
      }

      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });

  it('exposes no own property that could hold the credential', async () => {
    const { port } = providerWith(ok('m-1'));

    await port.send(request());

    // Không field public nào giữ token, và không state nào serialize ra được. `send` là
    // chính method của port nên nó **có** mặt — thứ cần ghim là không có field *ngoài*
    // `send`, và `JSON.stringify` không rò ra credential nào.
    expect(Object.getOwnPropertyNames(port)).toEqual(['send']);
    // `JSON.stringify` bỏ qua function, nên `{}` là kết quả đúng: không có state nào
    // serialize ra được, không có credential nào rò qua nó.
    expect(JSON.stringify(port)).toBe('{}');
  });

  it('keeps the credential out of the errorCode of a permanent rejection', async () => {
    const { port } = providerWith({
      kind: 'respond',
      status: 400,
      body: '{"token":"' + TOKEN + '"}',
    });

    const result = await port.send(request());

    expect(result).toStrictEqual({
      kind: 'rejected',
      errorClass: 'permanent',
      errorCode: 'provider-request-rejected',
      retryAfterMs: null,
    });
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Dependency boundary                                                                           */
/* -------------------------------------------------------------------------------------------- */

/** Đường dẫn tới file config của composition root, đọc thẳng từ đĩa. */
const COMPOSITION_ROOT_CONFIG = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'apps',
  'transactional-mailer-job',
  'src',
  'config.ts',
);

/**
 * Mọi dạng comment trong một nguồn TS, kể cả chỉ dẫn dạng `// eslint-disable-next-line`.
 *
 * Các guard bên dưới quét chính file adapter, và regex của chúng nằm trong docblock giải
 * thích chính chúng — nên quét nguyên văn sẽ tự khớp chính comment đó và báo đỏ vô nghĩa.
 * Bỏ comment trước khi quét là cách chỉ so trên **code thật**.
 *
 * Dùng lại cho cả hai việc: bỏ comment trong **cả file** (dưới đây) và bỏ comment **bên
 * trong** một khối đã bắt ra — chỉ dẫn `eslint-disable` nằm trong `declare global` sẽ sót
 * lại nếu dùng regex chỉ khớp `//` ở đầu dòng.
 */
const COMMENTS = /\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gmu;

/** Source của adapter, đã bỏ comment. */
function adapterCode(): string {
  return readFileSync(join(import.meta.dirname, 'resend-mail-provider.ts'), 'utf8').replaceAll(
    COMMENTS,
    '',
  );
}

/**
 * Tên field khai trong một object type của một file, ở dạng `type` **hoặc** `interface`.
 *
 * Hai phía khai cùng một shape nhưng khác từ khoá (`type` ở composition root, `interface`
 * ở adapter), nên một regex chỉ nhận `type` sẽ ném trước khi kịp so — và ca test đỏ vì
 * lý do sai. Nhận cả hai, rồi so tập tên field mới là cách so được.
 */
function configFieldNames(source: string, typeName: string): readonly string[] {
  const body =
    source.match(new RegExp(`export type ${typeName} = \\{([^}]*)\\}`, 'u'))?.[1] ??
    source.match(new RegExp(`export interface ${typeName} \\{([^}]*)\\}`, 'u'))?.[1];
  if (body === undefined) {
    throw new Error(`${typeName} is not a single-brace object type`);
  }

  return [...body.matchAll(/^\s*readonly\s+([A-Za-z][A-Za-z0-9]*)\s*[?]?:/gmu)].map(
    (match) => match[1] ?? '',
  );
}

describe('dependency boundary', () => {
  it('reads the composition-root config from disk', () => {
    expect(readFileSync(COMPOSITION_ROOT_CONFIG, 'utf8')).toContain(
      'export type ResendProviderConfig',
    );
  });

  it('mirrors the composition-root config field for field', () => {
    // Adapter khai trùng `ResendProviderConfig` thay vì import: import chéo deploy unit bị
    // chặn ở `tsc` (rootDir) lẫn `@nx/enforce-module-boundaries`. Đổi tên field ở một phía
    // mà phía kia không đổi là hỏng **im lặng** — ca này biến nó thành đỏ ngay.
    const source = readFileSync(COMPOSITION_ROOT_CONFIG, 'utf8');

    // So field của **config.ts** với field của **adapter**: đối chiếu hai file khác nhau,
    // nên lệch tên ở một phía là đỏ. So một file với chính nó thì luôn xanh và bắt được
    // đúng một lỗi — thêm mắt thứ ba (`timeoutMs` ở dưới) chỉ chặt được việc quên ghim
    // danh sách, không chặn được việc đổi tên ở cả hai phía.
    expect(new Set(configFieldNames(source, 'ResendProviderConfig'))).toEqual(
      new Set(configFieldNames(adapterCode(), 'ResendProviderConfig')),
    );
    expect(new Set(configFieldNames(adapterCode(), 'ResendProviderConfig'))).toEqual(
      new Set(['endpoint', 'token', 'from', 'timeoutMs']),
    );
  });

  it('accepts the real global fetch and AbortController without an adapter shim', async () => {
    /**
     * Bề mặt global của consumer phải **không** bị đổi bởi khai báo module-scope trong
     * `resend-mail-provider.ts`. `tsconfig.spec.json` nạp `node` types, nên `fetch` và
     * `AbortController` ở đây là global thật; chúng gán được vào kiểu cấu trúc của adapter
     * là bằng chứng composition root truyền thẳng global `fetch` vào được.
     */
    const port = createResendMailProvider(config(), { fetchImpl: fetch });

    expect(typeof port.send).toBe('function');
    expect(typeof AbortController).toBe('function');
  });

  it('augments AbortSignal rather than replacing the real global', async () => {
    /**
     * Adapter **có** một `declare global` — nhưng nó khai `interface AbortSignal {}` rỗng,
     * tức **mở rộng** qua declaration merging. Điều đó là bắt buộc, không phải tai nạn:
     * `ProviderFetch` nhận `ProviderRequestInit` ở vị trí tham số (contravariant), nên một
     * `signal` là interface riêng của lib — dù là bản sao "đúng từng chữ ký" — làm global
     * `fetch` thật **không gán được**, và chỗ duy nhất đỏ là composition root. Ca ngay
     * trên ("accepts the real global fetch…") là bằng chứng cho điều đó.
     *
     * Nỗi thật sự là **thay** global: `declare global { function fetch… }` hay
     * `declare global { interface AbortSignal { … đủ thành viên … } }` sẽ ghi đè
     * `AbortSignal`/`fetch` thật của lib `dom` ở mọi consumer đọc declaration của lib —
     * gồm composition root — và làm hỏng chính những chỗ dùng chúng thật.
     *
     * Vì vậy guard ở đây kiểm **hình dạng** của khai báo, không kiểm sự tồn tại của nó:
     * được phép `declare global`, nhưng `AbortSignal` phải khai rỗng, và `fetch`/
     * `AbortController`/`setTimeout` phải ở **module scope** (`declare const`, không
     * phải trong `declare global`).
     */
    const globalBlocks = [...adapterCode().matchAll(/declare\s+global\s*\{([\s\S]*?)\n\}/gu)].map(
      (match) => match[1] ?? '',
    );

    // Đúng một khối, và bên trong nó không được có global nào khác: `fetch`/`AbortController`/
    // `setTimeout`/`clearTimeout` phải là `declare` ở module scope, vì đưa chúng vào
    // `declare global` là ghi đè global thật của consumer.
    //
    // Vì khối đã được chứng minh là đúng `interface AbortSignal {}` ở trên, phần "không có
    // gì khác" được phát biểu trên **chính nội dung khối đã bắt ra** — không phải bằng một
    // regex `declare global … [\s\S]* …` riêng, vì `[\s\S]*` vô hạn sẽ trèo qua dấu `}`
    // và khớp nhầm `declare const fetch` ở module scope phía dưới, báo đỏ sai lý do.
    expect(globalBlocks).toHaveLength(1);
    expect(globalBlocks[0]?.replaceAll(COMMENTS, '').replaceAll(/\s+/gu, '')).toBe(
      'interfaceAbortSignal{}',
    );
  });

  it('contains no logging statement', async () => {
    // Token, endpoint, recipient, subject, body và raw provider response không bao giờ
    // chạm log hay metric (§13, §11.2) — kể cả qua `console` lẫn qua bất kỳ helper nào.
    expect(adapterCode()).not.toMatch(/\bconsole\b/u);
    expect(adapterCode()).not.toMatch(/\blog(?:ger)?\s*\./u);
  });

  it('resolves instead of throwing for every documented outcome', async () => {
    const outcomes: MailProviderSendResult[] = [
      { kind: 'accepted', providerMessageId: 'm-1', warningCode: null },
      {
        kind: 'rejected',
        errorClass: 'retryable',
        errorCode: 'provider-network-error',
        retryAfterMs: null,
      },
    ];

    expect(new Set(outcomes.map((outcome) => outcome.kind))).toEqual(
      new Set(['accepted', 'rejected']),
    );
  });

  it('exposes exactly send on the adapter', async () => {
    const { port } = providerWith(ok('m-1'));

    expect(Object.keys(port)).toEqual(['send']);
  });
});
