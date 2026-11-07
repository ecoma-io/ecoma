import { describe, expect, it, vi } from 'vitest';

import { MAX_SKEW_SECONDS, MIN_SKEW_SECONDS } from '@ecoma-io/internal-auth-contracts';

import { lazyConfigValidator, validateAccountConfig } from './config-validation';

/**
 * Test fail-closed của config.
 *
 * Mỗi test ở đây bảo vệ một câu hỏi: "Worker có khởi động được khi config sai không?".
 * Câu trả lời đúng cho tất cả là **không** — vì `03-operations.md` §8 quy định identity
 * không có degraded path, và Worker khởi động được rồi mới phát hiện thiếu secret thì
 * nó đã nhận traffic.
 */

/** Secret đủ dài, hợp lệ theo luật độ dài tối thiểu. */
const VALID_SECRET = 'k'.repeat(32);

/** OTP HMAC secret hợp lệ — cùng ngưỡng 32 ký tự với internal secret. */
const VALID_OTP_SECRET = 'o'.repeat(32);

/**
 * Config cơ sở hợp lệ cho các test khẳng định "không ném".
 *
 * Mọi secret bắt buộc đều phải có mặt ở đây: thêm một secret mới vào validator
 * mà không cập nhật helper này là mọi test "accepts" đỏ ngay — chính là tín hiệu
 * mong muốn, chứ không phải thứ cần neutralize bằng default rỗng.
 */
function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { internalHmacSecret: VALID_SECRET, otpHmacSecret: VALID_OTP_SECRET, ...overrides };
}

describe('validateAccountConfig', () => {
  it('accepts a valid secret', () => {
    expect(() => validateAccountConfig(validConfig())).not.toThrow();
  });

  it('rejects a missing secret', () => {
    expect(() => validateAccountConfig({ internalHmacSecret: undefined })).toThrow(
      /NUXT_INTERNAL_HMAC_SECRET/u,
    );
  });

  it('rejects an empty secret instead of falling back to an unauthenticated path', () => {
    // Secret rỗng là trường hợp nguy hiểm nhất: `verifyRequest` chạy trơn và chấp nhận
    // MỌI chữ ký. Vì vậy rỗng phải throw chứ không được coi là "không cấu hình thì bỏ qua".
    expect(() => validateAccountConfig({ internalHmacSecret: '' })).toThrow(
      /NUXT_INTERNAL_HMAC_SECRET/u,
    );
  });

  it('rejects a non-string secret', () => {
    expect(() => validateAccountConfig({ internalHmacSecret: 12345 })).toThrow(
      /NUXT_INTERNAL_HMAC_SECRET/u,
    );
  });

  it('rejects a secret shorter than the minimum length', () => {
    expect(() => validateAccountConfig({ internalHmacSecret: 'k'.repeat(31) })).toThrow(
      /ít nhất 32 ký tự/u,
    );
  });

  it('never reveals the configured secret itself in the error message', () => {
    // Message lỗi đọc được trong log của platform, nên nó chỉ được nêu **ngưỡng** và
    // tên biến — không bao giờ nêu độ dài thật hay bất kỳ ký tự nào của secret.
    let message = '';
    try {
      validateAccountConfig({ internalHmacSecret: 'x'.repeat(5) });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('xxxxx');
    expect(message).toContain('NUXT_INTERNAL_HMAC_SECRET');
  });

  it('rejects a non-integer skew window', () => {
    expect(() => validateAccountConfig(validConfig({ internalAuthSkewSeconds: 1.5 }))).toThrow(
      /NUXT_INTERNAL_AUTH_SKEW_SECONDS/u,
    );
  });

  it('rejects a non-positive skew window', () => {
    expect(() => validateAccountConfig(validConfig({ internalAuthSkewSeconds: 0 }))).toThrow(
      /NUXT_INTERNAL_AUTH_SKEW_SECONDS/u,
    );
  });

  it('rejects a skew window above the protocol cap', () => {
    // Trần là **hằng giao thức** của `internal-auth-contracts`, không phải ngưỡng cục bộ: nếu
    // `account` nhận `86400` trong khi `auth` từ chối nó, hai service chạy hai cửa sổ khác
    // nhau và bên rộng hơn quyết định cửa sổ replay thật. Test neo đúng biên qua biên:
    // `MAX_SKEW_SECONDS` phải **qua**, `MAX_SKEW_SECONDS + 1` phải **rơi**.
    expect(() =>
      validateAccountConfig(validConfig({ internalAuthSkewSeconds: MAX_SKEW_SECONDS })),
    ).not.toThrow();
    expect(() =>
      validateAccountConfig(validConfig({ internalAuthSkewSeconds: MAX_SKEW_SECONDS + 1 })),
    ).toThrow(/NUXT_INTERNAL_AUTH_SKEW_SECONDS/u);
  });

  it('rejects the library floor exactly one below MIN_SKEW_SECONDS', () => {
    // Biên dưới dùng **cùng hằng** với `auth` (trước đây mỗi bên tự hardcode một luật).
    expect(() =>
      validateAccountConfig(validConfig({ internalAuthSkewSeconds: MIN_SKEW_SECONDS })),
    ).not.toThrow();
    expect(() =>
      validateAccountConfig(validConfig({ internalAuthSkewSeconds: MIN_SKEW_SECONDS - 1 })),
    ).toThrow(/NUXT_INTERNAL_AUTH_SKEW_SECONDS/u);
  });

  it('accepts an absent skew window so the library default stays authoritative', () => {
    // Không đặt ⇒ `verifyRequest` dùng `DEFAULT_SKEW_SECONDS`. Chỉ có một nơi định
    // nghĩa mặc định, trong `internal-auth-contracts`, để không có hai nguồn sự thật cho
    // một luật.
    expect(() => validateAccountConfig(validConfig({ internalAuthSkewSeconds: '' }))).not.toThrow();
    expect(() => validateAccountConfig(validConfig())).not.toThrow();
  });
});

/**
 * Seam `DATA_MODE` ở lớp boot gate — artifact có yêu cầu mock phải **chặn**,
 * không được nuốt về `real` trong im lặng. Dưới dev, `mock` là giá trị hợp lệ.
 * Giá trị mode nằm dưới `public` của runtime config — đúng hình dạng config
 * thật, không phải trường phẳng riêng cho validator.
 */
describe('validateAccountConfig — account data mode', () => {
  it('accepts an unset data mode in an artifact', () => {
    expect(() =>
      validateAccountConfig(validConfig({ public: { accountDataMode: undefined }, isDev: false })),
    ).not.toThrow();
    expect(() =>
      validateAccountConfig(validConfig({ public: { accountDataMode: '' }, isDev: false })),
    ).not.toThrow();
    expect(() => validateAccountConfig(validConfig({ isDev: false }))).not.toThrow();
  });

  it('blocks an explicit mock request in an artifact', () => {
    expect(() =>
      validateAccountConfig(validConfig({ public: { accountDataMode: 'mock' }, isDev: false })),
    ).toThrow(/data_mode_mock_in_artifact/u);
  });

  it('treats a near-miss set value as fail-closed real, not as a mock request', () => {
    // Chuỗi gần đúng không bao giờ resolve ra mock ở bất kỳ môi trường nào —
    // resolver rơi về `real` (fail closed); gate chỉ chặn yêu cầu mock tường
    // minh trong artifact, không chặn giá trị vô nghĩa.
    expect(() =>
      validateAccountConfig(validConfig({ public: { accountDataMode: 'Mock' }, isDev: false })),
    ).not.toThrow();
  });

  it('accepts mock under dev', () => {
    expect(() =>
      validateAccountConfig(validConfig({ public: { accountDataMode: 'mock' }, isDev: true })),
    ).not.toThrow();
  });

  it('accepts real in both runtimes', () => {
    expect(() =>
      validateAccountConfig(validConfig({ public: { accountDataMode: 'real' }, isDev: false })),
    ).not.toThrow();
    expect(() =>
      validateAccountConfig(validConfig({ public: { accountDataMode: 'real' }, isDev: true })),
    ).not.toThrow();
  });
});

describe('validateAccountConfig — OTP HMAC secret', () => {
  it('rejects a missing OTP secret', () => {
    expect(() => validateAccountConfig({ internalHmacSecret: VALID_SECRET })).toThrow(
      /NUXT_OTP_HMAC_SECRET/u,
    );
  });

  it('rejects an empty OTP secret', () => {
    expect(() => validateAccountConfig(validConfig({ otpHmacSecret: '' }))).toThrow(
      /NUXT_OTP_HMAC_SECRET/u,
    );
  });

  it('rejects a non-string OTP secret', () => {
    expect(() => validateAccountConfig(validConfig({ otpHmacSecret: 98765 }))).toThrow(
      /NUXT_OTP_HMAC_SECRET/u,
    );
  });

  it('rejects an OTP secret shorter than the minimum length', () => {
    expect(() => validateAccountConfig(validConfig({ otpHmacSecret: 'o'.repeat(31) }))).toThrow(
      /NUXT_OTP_HMAC_SECRET/u,
    );
  });

  it('never reveals the OTP secret itself in the error message', () => {
    // Cùng luật với internal secret: log platform đọc được message, nên chỉ nêu
    // tên biến và ngưỡng — không nêu bất kỳ ký tự nào của secret.
    let message = '';
    try {
      validateAccountConfig(validConfig({ otpHmacSecret: 'p'.repeat(5) }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('ppppp');
    expect(message).toContain('NUXT_OTP_HMAC_SECRET');
  });

  it('keeps both secrets independent: a valid OTP secret cannot cover for a bad internal one', () => {
    // Hai secret phục vụ hai hợp đồng khác nhau (internal envelope và OTP digest);
    // một cái hợp lệ không được làm luồng kiểm của cái kia bị bỏ qua.
    expect(() => validateAccountConfig(validConfig({ internalHmacSecret: '' }))).toThrow(
      /NUXT_INTERNAL_HMAC_SECRET/u,
    );
    expect(() => validateAccountConfig(validConfig({ otpHmacSecret: undefined }))).toThrow(
      /NUXT_OTP_HMAC_SECRET/u,
    );
  });
});

describe('validateAccountConfig — mail service URL', () => {
  it('accepts an absent mail URL: sending fails closed at request time instead', () => {
    // URL rỗng là "chưa cấu hình mail" — hợp lệ ở tầng config (Worker vẫn phục vụ
    // session/logout), còn luồng OTP tự fail closed ở request khi cần gửi.
    expect(() => validateAccountConfig(validConfig())).not.toThrow();
    expect(() => validateAccountConfig(validConfig({ mailServiceUrl: '' }))).not.toThrow();
  });

  it('accepts an https origin', () => {
    expect(() =>
      validateAccountConfig(
        validConfig({
          mailServiceUrl: 'https://mail.example.com',
          mailInternalAuthSecret: 'm'.repeat(32),
        }),
      ),
    ).not.toThrow();
  });

  it('accepts an http origin for local transactional-mail dev', () => {
    expect(() =>
      validateAccountConfig(
        validConfig({
          mailServiceUrl: 'http://127.0.0.1:8787',
          mailInternalAuthSecret: 'm'.repeat(32),
        }),
      ),
    ).not.toThrow();
  });

  it('accepts an https origin together with a dedicated mail credential', () => {
    // Credential của path Account↔Mail là một secret riêng (không dùng chung với
    // internal HMAC); bộ URL + secret hợp lệ phải đi qua cùng nhau.
    expect(() =>
      validateAccountConfig(
        validConfig({
          mailServiceUrl: 'https://mail.example.com',
          mailInternalAuthSecret: 'm'.repeat(32),
        }),
      ),
    ).not.toThrow();
  });

  it('requires NUXT_MAIL_INTERNAL_AUTH_SECRET when the mail path is enabled', () => {
    // Receiver xác thực envelope trước mọi logic nghiệp vụ ⇒ thiếu credential =
    // mọi request mail là 401, tức luồng OTP chết im lặng. Fail-closed ở request
    // đầu làm lỗi cấu hình lộ ra trước khi có người dùng chờ mã.
    expect(() =>
      validateAccountConfig(validConfig({ mailServiceUrl: 'https://mail.example.com' })),
    ).toThrow(/NUXT_MAIL_INTERNAL_AUTH_SECRET/u);
  });

  it('does not require the mail credential when the mail path is off', () => {
    // URL rỗng = đường mail tắt — không request nào chạm receiver nên không cần
    // secret. Bắt buộc luôn sẽ phá chế độ "chưa cấu hình mail" của README.
    expect(() =>
      validateAccountConfig(validConfig({ mailInternalAuthSecret: undefined })),
    ).not.toThrow();
  });

  it('rejects a mail credential shorter than the minimum length', () => {
    // Cùng ngưỡng 32 ký tự với internal HMAC secret — một key ngắn làm HMAC dễ đoán
    // hơn, và đây là credential xác thực service-to-service.
    expect(() =>
      validateAccountConfig(
        validConfig({
          mailServiceUrl: 'https://mail.example.com',
          mailInternalAuthSecret: 'm'.repeat(31),
        }),
      ),
    ).toThrow(/ít nhất 32 ký tự/u);
  });

  it('never reveals the configured mail credential in the error message', () => {
    // Message lỗi đọc được trong log platform — nêu tên biến, không nêu giá trị.
    let message = '';
    try {
      validateAccountConfig(
        validConfig({
          mailServiceUrl: 'https://mail.example.com',
          mailInternalAuthSecret: 'm'.repeat(31),
        }),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('mmmm');
    expect(message).toContain('NUXT_MAIL_INTERNAL_AUTH_SECRET');
  });

  it('rejects a mail credential shared with the internal HMAC secret', () => {
    // Envelope không mang principal (`docs/applications/transactional-mail/
    // 01-architecture.md` §7.4): phía nhận suy ra principal từ credential đã khớp,
    // nên một secret dùng cho cả hai path là cấu hình mơ hồ — chặn lúc config thay
    // vì nhận một loạt envelope trong đó chỉ một path thực sự hợp lệ.
    expect(() =>
      validateAccountConfig(
        validConfig({
          mailServiceUrl: 'https://mail.example.com',
          mailInternalAuthSecret: VALID_SECRET,
        }),
      ),
    ).toThrow(/NUXT_MAIL_INTERNAL_AUTH_SECRET/u);
  });

  it('accepts an http origin for local transactional-mail dev', () => {
    expect(() =>
      validateAccountConfig(
        validConfig({
          mailServiceUrl: 'http://127.0.0.1:8787',
          mailInternalAuthSecret: 'm'.repeat(32),
        }),
      ),
    ).not.toThrow();
  });

  it('rejects a URL without an http(s) scheme', () => {
    expect(() =>
      validateAccountConfig(validConfig({ mailServiceUrl: 'ftp://mail.example.com' })),
    ).toThrow(/NUXT_MAIL_SERVICE_URL/u);
  });

  it('rejects a bare host without a scheme', () => {
    expect(() =>
      validateAccountConfig(validConfig({ mailServiceUrl: 'mail.example.com' })),
    ).toThrow(/NUXT_MAIL_SERVICE_URL/u);
  });

  it('rejects a non-string mail URL', () => {
    expect(() => validateAccountConfig(validConfig({ mailServiceUrl: 42 }))).toThrow(
      /NUXT_MAIL_SERVICE_URL/u,
    );
  });
});

describe('validateAccountConfig — auth issuer URL', () => {
  it('accepts an absent issuer: the confirm-URL flow fails closed at verify time instead', () => {
    // Rỗng = "chưa cấu hình auth issuer" — hợp lệ ở tầng config (luồng đăng nhập
    // account không phụ thuộc), luồng có handle tự fail-closed ở verify không cấp URL.
    expect(() => validateAccountConfig(validConfig())).not.toThrow();
    expect(() => validateAccountConfig(validConfig({ authIssuer: '' }))).not.toThrow();
  });

  it('accepts an https origin', () => {
    expect(() =>
      validateAccountConfig(validConfig({ authIssuer: 'https://auth.ecoma.io' })),
    ).not.toThrow();
  });

  it('accepts an http origin for local auth dev', () => {
    expect(() =>
      validateAccountConfig(validConfig({ authIssuer: 'http://127.0.0.1:8787' })),
    ).not.toThrow();
  });

  it('rejects a URL that carries a path — only an origin is accepted', () => {
    // `new URL('/authorize/confirm', issuer)` bỏ path của base, nên issuer có
    // path là cấu hình sai dựng ra URL sai — phải lộ ở đây chứ không ở runtime.
    expect(() =>
      validateAccountConfig(validConfig({ authIssuer: 'https://auth.ecoma.io/sub' })),
    ).toThrow(/NUXT_AUTH_ISSUER/u);
  });

  it('rejects a URL without an http(s) scheme', () => {
    expect(() => validateAccountConfig(validConfig({ authIssuer: 'ftp://auth.ecoma.io' }))).toThrow(
      /NUXT_AUTH_ISSUER/u,
    );
  });

  it('rejects a bare host without a scheme', () => {
    expect(() => validateAccountConfig(validConfig({ authIssuer: 'auth.ecoma.io' }))).toThrow(
      /NUXT_AUTH_ISSUER/u,
    );
  });

  it('rejects a non-string issuer', () => {
    expect(() => validateAccountConfig(validConfig({ authIssuer: 42 }))).toThrow(
      /NUXT_AUTH_ISSUER/u,
    );
  });
});

/**
 * `lazyConfigValidator` — thời điểm gọi: request đầu, không phải module-init.
 *
 * Trên Workers, `createNitroApp()` chạy top-level của `index.mjs` khi module
 * Worker load, còn secret chỉ được nối vào runtime config ở request. Validate
 * lúc init đọc config **chưa có secret** và ném ⇒ module không load được ⇒ kể
 * cả deployment đúng cũng chết. Các test dưới đây giữ ba tính chất của phiên
 * bản trì hoãn: (1) không validate trước khi được ensure, (2) config thiếu vẫn
 * ném và **vẫn** ném ở lần sau — cờ chưa được set, (3) sau khi hợp lệ thì đắt
 * nhất một boolean check.
 */
describe('lazyConfigValidator', () => {
  it('does not validate until the first ensure call', () => {
    const readConfig = vi.fn<(event: unknown) => Record<string, unknown>>(() => validConfig());
    lazyConfigValidator(readConfig);
    expect(readConfig).not.toHaveBeenCalled();
  });

  it('throws on the first request when the config is missing and keeps throwing', () => {
    // Fail-closed của phiên bản trì hoãn: ném ở giữa ⇒ cờ chưa set ⇒ request sau
    // thử lại và vẫn ném. Không có đường "thử một lần rồi cho qua".
    const ensure = lazyConfigValidator(() => ({ internalHmacSecret: '' }));
    expect(() => ensure({})).toThrow(/NUXT_INTERNAL_HMAC_SECRET/u);
    expect(() => ensure({})).toThrow(/NUXT_INTERNAL_HMAC_SECRET/u);
  });

  it('validates once after a successful first request', () => {
    const readConfig = vi.fn<(event: unknown) => Record<string, unknown>>(() => validConfig());
    const ensure = lazyConfigValidator(readConfig);
    const event = { marker: 'request-1' };
    ensure(event);
    ensure({ marker: 'request-2' });
    // Đúng một lần đọc config — và đọc đúng event của request đầu.
    expect(readConfig).toHaveBeenCalledTimes(1);
    expect(readConfig).toHaveBeenCalledWith(event);
  });

  it('retries and succeeds once the config becomes valid', () => {
    let config: Record<string, unknown> = { internalHmacSecret: VALID_SECRET };
    const ensure = lazyConfigValidator(() => config);
    expect(() => ensure({})).toThrow(/NUXT_OTP_HMAC_SECRET/u);
    config = validConfig();
    expect(() => ensure({})).not.toThrow();
    // Đã hợp lệ: lần tiếp theo không ném và không đọc lại config thừa.
    expect(() => ensure({})).not.toThrow();
  });
});

/**
 * Cấu hình `kid` của internal HMAC (issue #64).
 *
 * ⚠️ Mỗi test ở đây là một CÁCH CẤU HÌNH SAI mà nếu lọt qua sẽ thành lỗ hổng:
 * hai `kid` chia một secret làm mất ý nghĩa của selector, và một `kid` sai hình dạng
 * là header rác đi ra ngoài.
 */
describe('validateAccountConfig — the kid of the internal HMAC', () => {
  it('accepts a config without a kid, because that is the transition state', () => {
    expect(() => validateAccountConfig(validConfig())).not.toThrow();
  });

  it('accepts a valid kid', () => {
    expect(() => validateAccountConfig(validConfig({ internalHmacKid: '0123abcd' }))).not.toThrow();
  });

  it('rejects a malformed kid', () => {
    expect(() => validateAccountConfig(validConfig({ internalHmacKid: 'not-hex' }))).toThrow(
      /NUXT_INTERNAL_HMAC_KID/u,
    );
  });

  it('rejects a kid that is not a string', () => {
    expect(() => validateAccountConfig(validConfig({ internalHmacKid: 12345 }))).toThrow(
      /NUXT_INTERNAL_HMAC_KID/u,
    );
  });

  it('never states the kid value in the error message', () => {
    // `kid` sai có thể là nhầm dán secret, và message này đọc được trong log platform.
    let message = '';
    try {
      validateAccountConfig(validConfig({ internalHmacKid: 'sup3rs3cret' }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('NUXT_INTERNAL_HMAC_KID');
    expect(message).not.toContain('sup3rs3cret');
  });

  it('accepts a complete previous pair', () => {
    expect(() =>
      validateAccountConfig(
        validConfig({
          internalHmacKid: '0123abcd',
          internalHmacPreviousKid: 'abcd0123',
          internalHmacPreviousSecret: 'p'.repeat(32),
        }),
      ),
    ).not.toThrow();
  });

  it('rejects a previous secret without a previous kid', () => {
    expect(() =>
      validateAccountConfig(
        validConfig({
          internalHmacKid: '0123abcd',
          internalHmacPreviousSecret: 'p'.repeat(32),
        }),
      ),
    ).toThrow(/NUXT_INTERNAL_HMAC_PREVIOUS_KID/u);
  });

  it('rejects a previous kid without a previous secret', () => {
    expect(() =>
      validateAccountConfig(
        validConfig({
          internalHmacKid: '0123abcd',
          internalHmacPreviousKid: 'abcd0123',
        }),
      ),
    ).toThrow(/NUXT_INTERNAL_HMAC_PREVIOUS_SECRET/u);
  });

  it('rejects a current kid equal to the previous kid', () => {
    // Hai khoá khác nhau không được chia một `kid` — nếu chung thì `kid` không còn
    // chọn được khoá nào.
    expect(() =>
      validateAccountConfig(
        validConfig({
          internalHmacKid: '0123abcd',
          internalHmacPreviousKid: '0123abcd',
          internalHmacPreviousSecret: 'p'.repeat(32),
        }),
      ),
    ).toThrow(/NUXT_INTERNAL_HMAC_KID/u);
  });

  it('rejects two different kids sharing one secret', () => {
    // Cùng giá trị secret ⇒ "kid nào cũng đúng" — xoá chủ ý của selector.
    expect(() =>
      validateAccountConfig(
        validConfig({
          internalHmacKid: '0123abcd',
          internalHmacPreviousKid: 'abcd0123',
          internalHmacPreviousSecret: VALID_SECRET,
        }),
      ),
    ).toThrow(/NUXT_INTERNAL_HMAC_SECRET/u);
  });

  it('rejects a previous secret with surrounding whitespace instead of trimming it silently', () => {
    expect(() =>
      validateAccountConfig(
        validConfig({
          internalHmacKid: '0123abcd',
          internalHmacPreviousKid: 'abcd0123',
          internalHmacPreviousSecret: ` ${'p'.repeat(32)}`,
        }),
      ),
    ).toThrow(/NUXT_INTERNAL_HMAC_PREVIOUS_SECRET/u);
  });
});
