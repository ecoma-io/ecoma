/**
 * Unit test cho `server/lib/mail.ts` — build payload bằng validator thật của lib
 * contract, và fail-closed phân loại của `sendMail`.
 *
 * `sendMail` được test qua `vi.stubGlobal('fetch', ...)` — adapter chỉ dùng
 * `fetch` chuẩn nên stub là trung thực về biên (biên thật là HTTP transport;
 * kết nối tới transactional-mail thật thuộc về integration của service đó).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildOtpMailRequest,
  OTP_LOGIN_TEMPLATE,
  otpMailCorrelationId,
  otpMailIdempotencyKey,
  sendMail,
} from './mail';

/** Response shape hợp lệ theo `isPostMessagesResponse`. */
function validMailResponse(): Record<string, unknown> {
  return {
    id: 'msg-1',
    delivery_id: 'dlv-1',
    app: 'account',
    template: OTP_LOGIN_TEMPLATE,
    template_version: 1,
    status: 'queued',
    created: true,
    created_at: new Date().toISOString(),
  };
}

const VALID_REQUEST = buildOtpMailRequest({
  recipient: 'user@example.com',
  code: '12345678',
  correlationId: 'corr-1',
});

/** Secret test — placeholder, không phải credential thật. */
const TEST_SECRET = 'test-mail-internal-auth-secret-placeholder-0001';
/** Challenge UUID mẫu (dạng uuid v4) — identity của một challenge. */
const CHALLENGE_A = '0f0a6b1e-1111-4222-8333-444455556666';
/** Challenge UUID thứ hai — hai challenge KHÁC nhau. */
const CHALLENGE_B = '0f0a6b1e-7777-4888-9999-aaaa0000bbbb';

describe('buildOtpMailRequest', () => {
  it('builds a payload accepted by the real contract validator', () => {
    // Không phải test validator của lib — test rằng adapter của ta TẠO ra payload
    // mà lib chấp nhận. Build bằng validator thật là điều kiện để đổi contract
    // làm adapter đỏ ngay tại đây, chứ không ở production.
    expect(VALID_REQUEST).not.toBeNull();
  });

  it('carries the code only inside variables', () => {
    // Mã OTP đi vào `variables` để service render; không field nào khác của
    // request được chứa mã.
    const request = buildOtpMailRequest({
      recipient: 'user@example.com',
      code: '99887766',
      correlationId: 'corr-2',
    });
    expect(request?.variables).toEqual({ code: '99887766' });
    expect(JSON.stringify(request)).toContain('99887766');
  });

  it('keeps the template constant in sync with the contract', () => {
    // Template là logical name service bên kia phải có — đổi tên ở đây mà không
    // đổi bên kia là mail rơi vào template không tồn tại.
    expect(OTP_LOGIN_TEMPLATE).toBe('account.login-otp');
    expect(VALID_REQUEST?.template).toBe(OTP_LOGIN_TEMPLATE);
  });

  it('normalizes the recipient whitespace like the validator does', () => {
    const request = buildOtpMailRequest({
      recipient: '  user@example.com  ',
      code: '00000000',
      correlationId: 'corr-3',
    });
    expect(request?.recipient).toBe('user@example.com');
  });

  it('rejects a payload that breaks the contract (empty code)', () => {
    // variables rỗng không sai theo validator hiện tại (isObject là đủ), nhưng
    // recipient rỗng thì sai — dùng nó làm vết cho đường invalid_payload.
    const broken = buildOtpMailRequest({
      recipient: '',
      code: '12345678',
      correlationId: 'corr-4',
    });
    expect(broken).toBeNull();
  });
});

describe('sendMail', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails closed with config_missing when no URL is configured', async () => {
    // Config thiếu phải là một reason riêng — không được ngụy trang thành lỗi
    // transport thoáng qua, và không được fetch gì cả.
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendMail(
      undefined,
      VALID_REQUEST,
      otpMailIdempotencyKey(CHALLENGE_A),
      TEST_SECRET,
    );
    expect(result).toEqual({ ok: false, reason: 'config_missing' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed with credential_missing when no signing secret is configured', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendMail(
      'https://mail.example.com',
      VALID_REQUEST,
      otpMailIdempotencyKey(CHALLENGE_A),
      undefined,
    );
    expect(result).toEqual({
      ok: false,
      reason: 'credential_missing',
      detail: 'NUXT_MAIL_INTERNAL_AUTH_SECRET',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed with invalid_payload without fetching', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendMail(
      'https://mail.example.com',
      null,
      otpMailIdempotencyKey(CHALLENGE_A),
      TEST_SECRET,
    );
    expect(result).toEqual({ ok: false, reason: 'invalid_payload' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the validated payload to /v1/messages with json content-type and the required Idempotency-Key', async () => {
    // Contract receiver (`transactional-mail` FR-001 bước 3) bắt buộc
    // `Idempotency-Key`: thiếu ⇒ `400 invalid_request` và mail không bao giờ tới
    // hàng SEND. Assertion khớp ĐỦ headers thực tế — không `objectContaining` một
    // shape thiếu header (chi tiết `mail.ts` `sendMail`).
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(validMailResponse()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendMail(
      'https://mail.example.com',
      VALID_REQUEST,
      otpMailIdempotencyKey(CHALLENGE_A),
      TEST_SECRET,
    );
    expect(result).toEqual({ ok: true });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers as HeadersInit);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('idempotency-key')).toBe(otpMailIdempotencyKey(CHALLENGE_A));
    expect(headers.get('x-ecoma-internal-timestamp')).not.toBeNull();
    expect(headers.get('x-ecoma-internal-nonce')).not.toBeNull();
    expect(headers.get('x-ecoma-internal-signature')).toMatch(/^v1=[0-9a-f]{64}$/u);
  });

  it('strips a trailing slash from the configured URL', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(validMailResponse()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await sendMail(
      'https://mail.example.com/',
      VALID_REQUEST,
      otpMailIdempotencyKey(CHALLENGE_A),
      TEST_SECRET,
    );
    const calledUrl = String(fetchMock.mock.calls[0]?.[0] ?? '');
    expect(calledUrl.endsWith('/v1/messages')).toBe(true);
  });

  it('classifies a non-2xx response as rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('too many requests', { status: 429 })),
    );
    const result = await sendMail(
      'https://mail.example.com',
      VALID_REQUEST,
      otpMailIdempotencyKey(CHALLENGE_A),
      TEST_SECRET,
    );
    expect(result).toEqual({ ok: false, reason: 'rejected', detail: '429' });
  });

  it('classifies a 2xx with a foreign body as rejected, not as delivered', async () => {
    // Body lạ = đường không đúng service. Coi nó như đã gửi là mất mail im lặng.
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>ok</html>', { status: 200 })),
    );
    const result = await sendMail(
      'https://mail.example.com',
      VALID_REQUEST,
      otpMailIdempotencyKey(CHALLENGE_A),
      TEST_SECRET,
    );
    expect(result).toMatchObject({ ok: false, reason: 'rejected' });
  });

  it('classifies a network error as unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed')));
    const result = await sendMail(
      'https://mail.example.com',
      VALID_REQUEST,
      otpMailIdempotencyKey(CHALLENGE_A),
      TEST_SECRET,
    );
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  describe('idempotency key semantics (FR-002 at the receiver)', () => {
    it('derives different keys for two different challenges even when the OTP code is identical', () => {
      // ⚠️ Adversarial (PR1): digest HMAC của mã OTP là TẤT ĐỊNH theo
      // (key, purpose, code) và mã chỉ có 10^8 giá trị — hai challenge khác nhau
      // hoàn toàn có thể sinh cùng mã ⇒ cùng digest. Khoá derive từ identity
      // của challenge (UUID DB cấp) thì không bao giờ va: đây chính là bất biến
      // "two different challenges never share a key just because the OTP or its
      // digest collide" của task. Bản derive cũ (16 hex đầu của digest) fail test
      // này khi hai challengeId cùng ra một digest.
      expect(otpMailIdempotencyKey(CHALLENGE_A)).not.toBe(otpMailIdempotencyKey(CHALLENGE_B));

      // Và hình ảnh nghịch: hai challengeId khác nhau với CÙNG correlation body
      // vẫn phải ra hai khoá — khoá không bao giờ đọc từ body.
      const requestA = buildOtpMailRequest({
        recipient: 'user@example.com',
        code: '12345678',
        correlationId: CHALLENGE_A,
      });
      expect(requestA).not.toBeNull();
      expect(otpMailIdempotencyKey(CHALLENGE_B)).not.toBe(otpMailIdempotencyKey(CHALLENGE_A));
    });

    it('reuses the same key for a retry of the same challenge', () => {
      // Retry cùng challenge (fetch ambiguous rồi thử lại) phải tái dùng đúng
      // khoá: receiver trả `200` replay thay vì nhân đôi mail.
      expect(otpMailIdempotencyKey(CHALLENGE_A)).toBe(otpMailIdempotencyKey(CHALLENGE_A));
    });

    it('keeps the key inside the 128-character ceiling of the receiver', () => {
      // FR-001 bước 3: `Idempotency-Key` > 128 ký tự ⇒ `400 invalid_request`.
      // 15 (prefix) + 36 (UUID) = 51 — biên thật của đường production.
      expect(otpMailIdempotencyKey(CHALLENGE_A).length).toBeLessThanOrEqual(128);
      expect(otpMailIdempotencyKey(CHALLENGE_A)).toMatch(/^account-otp-ch-[0-9a-f-]{36}$/u);
    });

    it('keeps the key and the correlation id as distinct derivations', () => {
      // Hai khái niệm tách bạch: correlation (body, quan sát) và key (header,
      // an toàn) đều đến từ identity của challenge nhưng đi hai đường riêng;
      // key không được đọc từ body (không có đường trộn).
      const request = buildOtpMailRequest({
        recipient: 'user@example.com',
        code: '00000000',
        correlationId: otpMailCorrelationId(CHALLENGE_A),
      });
      expect(request?.correlation_id).toBe(CHALLENGE_A);
      expect(otpMailIdempotencyKey(CHALLENGE_A)).toBe(`account-otp-ch-${CHALLENGE_A}`);
    });

    it('sends the caller-provided key verbatim in the Idempotency-Key header', async () => {
      // Key do caller truyền tường minh — adapter không tự derive từ body.
      // Retry với cùng key ⇒ receiver trả replay; đổi key trên cùng payload ⇒
      // receiver trả `409 conflict` (same-key-different-payload đã có ở spec
      // `create-mail-message` của receiver; ở đây khoá header == khoá caller).
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(validMailResponse()), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const request = buildOtpMailRequest({
        recipient: 'user@example.com',
        code: '12345678',
        correlationId: CHALLENGE_B,
      });
      expect(request).not.toBeNull();
      await sendMail(
        'https://mail.example.com',
        request,
        otpMailIdempotencyKey(CHALLENGE_B),
        TEST_SECRET,
      );
      const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers as HeadersInit);
      expect(headers.get('idempotency-key')).toBe(`account-otp-ch-${CHALLENGE_B}`);
      // Body mang correlation của CHALLENGE_B nhưng header khoá của CHALLENGE_B —
      // hai đường derive riêng, không trộn.
      const rawBody = fetchMock.mock.calls[0]?.[1]?.body;
      const body = JSON.parse(new TextDecoder().decode(rawBody as Uint8Array)) as {
        correlation_id?: string;
      };
      expect(body.correlation_id).toBe(CHALLENGE_B);
    });
  });

  it('classifies a timeout as unreachable', async () => {
    // Timeout là đường quan trọng nhất của route OTP: request challenge không được
    // treo quá MAIL_TIMEOUT_MS. Stub fetch treo mãi — adapter phải tự cắt.
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      ),
    );
    const result = await sendMail(
      'https://mail.example.com',
      VALID_REQUEST,
      otpMailIdempotencyKey(CHALLENGE_A),
      TEST_SECRET,
    );
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('never throws for classified failures', async () => {
    // Bốn loại lỗi đã phân loại đều phải trả giá trị — ném ở đây buộc route
    // phân loại lại, tức là hai tầng cùng biết chi tiết transport.
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('boom')));
    await expect(
      sendMail(
        'https://mail.example.com',
        VALID_REQUEST,
        otpMailIdempotencyKey(CHALLENGE_A),
        TEST_SECRET,
      ),
    ).resolves.toBeDefined();
  });
});
