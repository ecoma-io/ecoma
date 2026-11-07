/**
 * Kiểm chứng loader cấu hình của `transactional-mail`.
 *
 * ⚠️ Mỗi test ở đây là **một cÁCH CẤU HÌNH SAI**. Nếu một cách lọt qua, nó thành lỗ hổng
 * hoặc thành hành vi sai chạy im lặng — hai thứ mà không có test nào đỏ báo.
 *
 * ⚠️ Suite này **tắt cache** (`{ cache: false }`) ở mọi lời gọi loader. Cache là tính
 * năng thật của production, nhưng nó là node-local state dùng chung cho cả suite — bật
 * nó ở đây thì `it` thứ N nhận config của `it` trước, và test sau sẽ xanh vì lý do sai
 * hoàn toàn. Hành vi cache được kiểm ở một `describe` riêng ở cuối file.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SKEW_SECONDS,
  MAX_SKEW_SECONDS,
  MIN_SKEW_SECONDS,
} from '@ecoma-io/internal-auth-contracts';

import {
  FINGERPRINT_KEYRING_ENV,
  INTERNAL_AUTH_SKEW_ENV,
  TEMPLATE_URL_ALLOWED_HOSTS_ENV,
  TransactionalMailConfigError,
  type TransactionalMailConfig,
  type TransactionalMailEnv,
  loadTransactionalMailConfig,
  resetTransactionalMailConfigCacheForTests,
} from './config';
import {
  PERMISSION_DELIVERY_OUTCOME,
  PERMISSION_DELIVERY_READ,
  PERMISSION_MESSAGE_CREATE,
} from './principal';

/** Khoá fingerprint hợp lệ: 64 hex chữ thường. */
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

/** Keyring JSON hợp lệ: hai profile, `current` trỏ `p1.k2`. */
const KEYRING = JSON.stringify({ current: 'p1.k2', keys: { 'p1.k1': KEY_A, 'p1.k2': KEY_B } });

/** Bốn secret credential — mỗi principal một giá trị **khác nhau**. */
const SECRET_ACCOUNT = 'secret-svc-account-0001';
const SECRET_AUTH = 'secret-svc-auth-0002';
const SECRET_PAYMENT = 'secret-svc-payment-0003';
const SECRET_MAILER_JOB = 'secret-svc-mailer-job-0004';

/** Keyring JSON hợp lệ — tách riêng để các test khác tự dựng biến thể của mình. */
function keyringJson(): string {
  return KEYRING;
}

/** `env` đầy đủ và hợp lệ; mọi test bắt đầu từ đây rồi ghi đè đúng một biến. */
function makeEnv(overrides: Partial<TransactionalMailEnv> = {}): TransactionalMailEnv {
  return {
    [FINGERPRINT_KEYRING_ENV]: keyringJson(),
    MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT: SECRET_ACCOUNT,
    MAIL_INTERNAL_AUTH_SECRET_SVC_AUTH: SECRET_AUTH,
    MAIL_INTERNAL_AUTH_SECRET_SVC_PAYMENT: SECRET_PAYMENT,
    MAIL_INTERNAL_AUTH_SECRET_SVC_TRANSACTIONAL_MAILER_JOB: SECRET_MAILER_JOB,
    MAIL_RATE_LIMIT_PRINCIPAL_LIMIT: '60',
    MAIL_RATE_LIMIT_PRINCIPAL_WINDOW_MS: '60000',
    MAIL_RATE_LIMIT_SYSTEM_LIMIT: '10000',
    MAIL_RATE_LIMIT_SYSTEM_WINDOW_MS: '60000',
    MAIL_RATE_LIMIT_KEY_LIMIT: '20',
    MAIL_RATE_LIMIT_KEY_WINDOW_MS: '60000',
    MAIL_RENDER_MAX_BYTES: '64000',
    MAIL_PUBLISH_LEASE_MS: '30000',
    MAIL_PUBLISH_BATCH_LIMIT: '10',
    MAIL_PUBLISH_MAX_ATTEMPTS: '5',
    MAIL_PUBLISH_BACKOFF_BASE_MS: '1000',
    MAIL_RECONCILER_MAX_AGE_MS: '600000',
    MAIL_RECONCILER_BATCH_LIMIT: '50',
    MAIL_RECOVERY_MAX_CYCLES: '5',
    MAIL_NONCE_PRUNE_BATCH_LIMIT: '500',
    MAIL_RETENTION_CONTENT_MS: '2592000000',
    MAIL_RETENTION_STALE_ALERT_MS: '86400000',
    ...overrides,
  };
}

/** Nạp không cache — mọi lời gọi trong suite đi qua đây trừ `describe` của cache. */
function load(env: TransactionalMailEnv): Promise<TransactionalMailConfig> {
  return loadTransactionalMailConfig(env, { cache: false });
}

describe('keyring fingerprint', () => {
  it('parses current profile and keys as raw bytes', async () => {
    const config = await load(makeEnv());
    expect(config.fingerprintKeyring.currentProfile).toBe('p1.k2');
    expect([...config.fingerprintKeyring.keys.keys()]).toEqual(['p1.k1', 'p1.k2']);
    // Khoá phải là BYTE, không phải chuỗi hex — `crypto.subtle` nhận byte, và giữ hex
    // trong config chỉ thêm một bước decode ở mọi chỗ dùng.
    expect(config.fingerprintKeyring.keys.get('p1.k1')).toEqual(
      new Uint8Array(KEY_A.length / 2).fill(0xaa),
    );
    expect(config.fingerprintKeyring.keys.get('p1.k2')?.byteLength).toBe(32);
  });

  it('keeps retired profiles in the keyring so persisted fingerprints stay verifiable', async () => {
    // `current` không phải phần tử duy nhất: giá trị đã persist mang tag của profile đã ký.
    const config = await load(makeEnv());
    expect(config.fingerprintKeyring.keys.size).toBe(2);
  });

  it('rejects malformed JSON without echoing the secret in the message', async () => {
    // ⚠️ JSON hỏng vì một ký tự trong khoá ⇒ message của `JSON.parse` **chứa toàn bộ
    // chuỗi**, tức khoá hex. Test này ghim rằng message của loader không chứa nó.
    const brokenKeyring = `{ "current": "p1.k1", "keys": { "p1.k1": "${KEY_A}z" } }`;
    const error = await load(makeEnv({ [FINGERPRINT_KEYRING_ENV]: brokenKeyring })).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TransactionalMailConfigError);
    expect((error as Error).message).toContain(FINGERPRINT_KEYRING_ENV);
    expect((error as Error).message).not.toContain(KEY_A);
  });

  it('rejects a missing keyring', async () => {
    await expect(load(makeEnv({ [FINGERPRINT_KEYRING_ENV]: undefined }))).rejects.toThrow(
      TransactionalMailConfigError,
    );
  });

  it('rejects a current profile that is not present in keys', async () => {
    const env = makeEnv({
      [FINGERPRINT_KEYRING_ENV]: JSON.stringify({
        current: 'p1.k9',
        keys: { 'p1.k1': KEY_A },
      }),
    });
    // Nêu TÊN profile tag (public — nó nằm trong mọi fingerprint đã persist), không nêu khoá.
    await expect(load(env)).rejects.toThrow(/p1\.k9/u);
  });

  it.each([
    ['uppercase hex', KEY_A.toUpperCase()],
    ['too short', 'aa'],
    ['too long', 'a'.repeat(66)],
    ['not hex', 'z'.repeat(64)],
  ])('rejects a key that is %s', async (_label, keyValue) => {
    const env = makeEnv({
      [FINGERPRINT_KEYRING_ENV]: JSON.stringify({ current: 'p1.k1', keys: { 'p1.k1': keyValue } }),
    });
    await expect(load(env)).rejects.toThrow(TransactionalMailConfigError);
  });

  it('rejects an empty keys map', async () => {
    const env = makeEnv({
      [FINGERPRINT_KEYRING_ENV]: JSON.stringify({ current: 'p1.k1', keys: {} }),
    });
    await expect(load(env)).rejects.toThrow(TransactionalMailConfigError);
  });
});

describe('credential registry', () => {
  it('loads four principals in fixed order, current before previous', async () => {
    const config = await load(
      makeEnv({
        MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT_PREVIOUS: 'secret-svc-account-prev',
        MAIL_INTERNAL_AUTH_SECRET_SVC_AUTH_PREVIOUS: 'secret-svc-auth-prev',
      }),
    );
    expect(config.credentialRegistry.map((entry) => `${entry.principal}:${entry.kind}`)).toEqual([
      'svc.account:current',
      'svc.account:previous',
      'svc.auth:current',
      'svc.auth:previous',
      'svc.payment:current',
      'svc.transactional-mailer-job:current',
    ]);
  });

  it('keeps each secret verbatim, including surrounding whitespace', async () => {
    // Không trim: hai bên ký/verify phải thấy đúng cùng một chuỗi.
    const padded = `  ${SECRET_AUTH}  `;
    const config = await load(makeEnv({ MAIL_INTERNAL_AUTH_SECRET_SVC_AUTH: padded }));
    const authEntry = config.credentialRegistry.find((entry) => entry.principal === 'svc.auth');
    expect(authEntry?.secret).toBe(padded);
  });

  it('treats previous as optional', async () => {
    const config = await load(makeEnv());
    expect(config.credentialRegistry.filter((entry) => entry.kind === 'previous')).toEqual([]);
    expect(config.credentialRegistry).toHaveLength(4);
  });

  it.each([
    'MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT',
    'MAIL_INTERNAL_AUTH_SECRET_SVC_AUTH',
    'MAIL_INTERNAL_AUTH_SECRET_SVC_PAYMENT',
    'MAIL_INTERNAL_AUTH_SECRET_SVC_TRANSACTIONAL_MAILER_JOB',
  ])('requires current secret %s', async (variableName) => {
    await expect(load(makeEnv({ [variableName]: undefined }))).rejects.toThrow(
      new RegExp(variableName, 'u'),
    );
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
  ])('rejects a %s current secret', async (_label, value) => {
    await expect(load(makeEnv({ MAIL_INTERNAL_AUTH_SECRET_SVC_PAYMENT: value }))).rejects.toThrow(
      /MAIL_INTERNAL_AUTH_SECRET_SVC_PAYMENT/u,
    );
  });

  it('rejects a whitespace-only previous secret', async () => {
    await expect(
      load(makeEnv({ MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT_PREVIOUS: ' ' })),
    ).rejects.toThrow(/MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT_PREVIOUS/u);
  });

  it('ignores an undefined previous secret', async () => {
    const config = await load(
      makeEnv({ MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT_PREVIOUS: undefined }),
    );
    expect(config.credentialRegistry).toHaveLength(4);
  });

  it('rejects two current secrets sharing one value and names both variables', async () => {
    const error = await load(makeEnv({ MAIL_INTERNAL_AUTH_SECRET_SVC_AUTH: SECRET_ACCOUNT })).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TransactionalMailConfigError);
    const message = (error as Error).message;
    expect(message).toContain('MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT');
    expect(message).toContain('MAIL_INTERNAL_AUTH_SECRET_SVC_AUTH');
    // Message chỉ nói TÊN biến — không bao giờ nói giá trị.
    expect(message).not.toContain(SECRET_ACCOUNT);
  });

  it('rejects a previous secret colliding with another principal current', async () => {
    const error = await load(
      makeEnv({ MAIL_INTERNAL_AUTH_SECRET_SVC_PAYMENT_PREVIOUS: SECRET_AUTH }),
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransactionalMailConfigError);
    const message = (error as Error).message;
    expect(message).toContain('MAIL_INTERNAL_AUTH_SECRET_SVC_AUTH');
    expect(message).toContain('MAIL_INTERNAL_AUTH_SECRET_SVC_PAYMENT_PREVIOUS');
    expect(message).not.toContain(SECRET_AUTH);
  });

  it('rejects two previous secrets sharing one value', async () => {
    const env = makeEnv({
      MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT_PREVIOUS: 'shared-previous-secret',
      MAIL_INTERNAL_AUTH_SECRET_SVC_AUTH_PREVIOUS: 'shared-previous-secret',
    });
    const error = await load(env).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransactionalMailConfigError);
    expect((error as Error).message).toContain('MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT_PREVIOUS');
    expect((error as Error).message).toContain('MAIL_INTERNAL_AUTH_SECRET_SVC_AUTH_PREVIOUS');
  });

  it('rejects a previous secret equal to its own current secret', async () => {
    const error = await load(
      makeEnv({ MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT_PREVIOUS: SECRET_ACCOUNT }),
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransactionalMailConfigError);
    expect((error as Error).message).toContain('MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT_PREVIOUS');
  });

  it('rejects a lone surrogate in a previous secret', async () => {
    // Cùng luật của `current`: lone surrogate qua TextEncoder thành U+FFFD, nên hai secret
    // "khác nhau" theo `===` lại là cùng key material HMAC — chặn lúc boot, fail-closed.
    const surrogate = 'prev-\uD800-value';
    const error = await load(
      makeEnv({ MAIL_INTERNAL_AUTH_SECRET_SVC_AUTH_PREVIOUS: surrogate }),
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransactionalMailConfigError);
    const message = (error as Error).message;
    expect(message).toContain('MAIL_INTERNAL_AUTH_SECRET_SVC_AUTH_PREVIOUS');
    // Message nói tên biến, không echo giá trị secret.
    expect(message).not.toContain(surrogate);
  });

  it('rejects a previous secret encoding the same bytes as a current secret of another principal', async () => {
    // `"�A"` và `"\uD800A"` là hai chuỗi theo `===` nhưng `TextEncoder` encode cùng byte
    // (cùng key material HMAC). Duplicate check của registry so `===` trên chuỗi, nên trước
    // fix cặp này vào được registry dù `current` đã bị gate lone surrogate chặn — chứng minh
    // nhánh `previous` là lỗ duy nhất còn mở.
    const previousEquivalent = '�-mailer-equivalent';
    const surrogateForm = '\uD800-mailer-equivalent';
    const error = await load(
      makeEnv({
        MAIL_INTERNAL_AUTH_SECRET_SVC_TRANSACTIONAL_MAILER_JOB: previousEquivalent,
        MAIL_INTERNAL_AUTH_SECRET_SVC_AUTH_PREVIOUS: surrogateForm,
      }),
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransactionalMailConfigError);
    const message = (error as Error).message;
    expect(
      message.includes('MAIL_INTERNAL_AUTH_SECRET_SVC_AUTH_PREVIOUS') ||
        message.includes('MAIL_INTERNAL_AUTH_SECRET_SVC_TRANSACTIONAL_MAILER_JOB'),
    ).toBe(true);
    expect(message).not.toContain(previousEquivalent);
    expect(message).not.toContain(surrogateForm);
  });

  it('maps permissions per principal, independent of credential kind', async () => {
    const config = await load(makeEnv());
    expect(config.permissionsByPrincipal.get('svc.account')).toEqual([PERMISSION_MESSAGE_CREATE]);
    expect(config.permissionsByPrincipal.get('svc.auth')).toEqual([PERMISSION_MESSAGE_CREATE]);
    expect(config.permissionsByPrincipal.get('svc.payment')).toEqual([PERMISSION_MESSAGE_CREATE]);
    expect(config.permissionsByPrincipal.get('svc.transactional-mailer-job')).toEqual([
      PERMISSION_DELIVERY_READ,
      PERMISSION_DELIVERY_OUTCOME,
    ]);
    // Mailer KHÔNG được `message.create` và ngược lại — đây là ranh giới hai chiều của
    // bảng consumer §7.4, và một allowlist "cho tất cả" sẽ phá nó.
    expect(config.permissionsByPrincipal.get('svc.transactional-mailer-job')).not.toContain(
      PERMISSION_MESSAGE_CREATE,
    );
    expect(config.permissionsByPrincipal.get('svc.account')).not.toContain(
      PERMISSION_DELIVERY_READ,
    );
  });

  it('maps template allowlists per principal — evidence-based, default empty', async () => {
    // SR-001: chỉ principal có bằng chứng dùng thật mới được grant. `svc.account` dùng
    // `account.login-otp` (`OTP_LOGIN_TEMPLATE` + seed migration `0009`); ba principal còn
    // lại chưa có đường gọi nào trong repo ⇒ explicit empty, mọi template của họ đều 403
    // cho tới khi có template được approve. Nhầm "rỗng" thành "được tất cả" là lỗi fail-open
    // — assertion này ghim chiều fail-closed.
    const config = await load(makeEnv());
    expect(config.templatesByPrincipal.get('svc.account')).toEqual(['account.login-otp']);
    expect(config.templatesByPrincipal.get('svc.auth')).toEqual([]);
    expect(config.templatesByPrincipal.get('svc.payment')).toEqual([]);
    expect(config.templatesByPrincipal.get('svc.transactional-mailer-job')).toEqual([]);
  });
});

describe('error messages never carry secret values', () => {
  /** Giá trị độc hại **dài hơn** ba khoảng trắng, để assert "không lặp lại giá trị" có nghĩa. */
  const WHITESPACE_POISON = '     ';
  /**
   * Một lỗi cấu hình nối **giá trị** bí mật vào message là rò secret vào error log của
   * Worker — và `JSON.parse` là nguồn rò rỉ kinh điển ở đây: message của nó chứa **toàn bộ**
   * chuỗi JSON, tức khoá fingerprint.
   *
   * ⚠️ Suite này không kiểm từng message một cách rời rạc. Nó liệt kê **mọi** biến chứa bí
   * mật, đặt từng biến vào một giá trị độc hại, làm loader ném, rồi đòi message phải sạch
   * trước MỌI giá trị đó. Thêm một nhánh lỗi mới ở loader không cần thêm test mới — chỉ
   * cần biến nó nhận secret thì bị bắt ngay.
   */
  const SECRET_BEARING_VARIABLES: readonly (readonly [string, string])[] = [
    ['MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT', 'poison-account-secret'],
    ['MAIL_INTERNAL_AUTH_SECRET_SVC_AUTH', 'poison-auth-secret'],
    ['MAIL_INTERNAL_AUTH_SECRET_SVC_PAYMENT', 'poison-payment-secret'],
    ['MAIL_INTERNAL_AUTH_SECRET_SVC_TRANSACTIONAL_MAILER_JOB', 'poison-mailer-job-secret'],
    ['MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT_PREVIOUS', 'poison-account-previous-secret'],
    [FINGERPRINT_KEYRING_ENV, 'poison-fingerprint-key-material'],
  ];

  it('does not echo a secret when a credential entry is rejected', async () => {
    const POISON = 'poison-duplicated-secret-value';
    // `null` = giá trị độc hại khác nhau cho từng case, assert theo chính giá trị đó.
    const cases: readonly { readonly env: TransactionalMailEnv; readonly poison: string }[] = [
      // Chỉ có khoảng trắng: giá trị độc hại là MỘT khoảng trắng dài, đủ để `not.toContain`
      // có nghĩa (ba khoảng trắng trở lên xuất hiện trong message tiếng Việt không dấu,
      // nên một giá trị ngắn sẽ đỏ vì lý do sai).
      {
        env: makeEnv({ MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT: WHITESPACE_POISON }),
        poison: WHITESPACE_POISON,
      },
      {
        env: makeEnv({
          MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT_PREVIOUS: WHITESPACE_POISON,
        }),
        poison: WHITESPACE_POISON,
      },
      // Trùng nhau: message liệt kê TÊN biến của cả hai, không nêu giá trị. Mỗi case
      // dùng **giá trị độc hại riêng** vì một giá trị trùng ở đây là điều kiện của lỗi.
      {
        env: makeEnv({
          MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT: POISON,
          MAIL_INTERNAL_AUTH_SECRET_SVC_AUTH: POISON,
        }),
        poison: POISON,
      },
      {
        env: makeEnv({
          MAIL_INTERNAL_AUTH_SECRET_SVC_AUTH: POISON,
          MAIL_INTERNAL_AUTH_SECRET_SVC_PAYMENT_PREVIOUS: POISON,
        }),
        poison: POISON,
      },
    ];
    for (const { env, poison } of cases) {
      const error = await load(env).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(TransactionalMailConfigError);
      expect((error as Error).message).not.toContain(poison);
    }
  });

  it('does not echo a whitespace secret verbatim under any variable', async () => {
    // Khoảng trắng thuần là một giá trị bí mật cũng phải giấu: một message in ra nó là
    // message mà mắt thường không đọc thấy nhưng log pipeline vẫn lưu. Vòng lặp đi qua
    // **mọi** biến mang bí mật, không chỉ một — một nhánh lỗi mới ở loader không cần thêm
    // test mới, chỉ cần nhận secret thì bị bắt ngay.
    for (const [variable] of SECRET_BEARING_VARIABLES) {
      const error = await load(makeEnv({ [variable]: WHITESPACE_POISON })).catch(
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(TransactionalMailConfigError);
      expect((error as Error).message).not.toContain(WHITESPACE_POISON);
    }
  });

  it('does not echo key material when the keyring fails to parse', async () => {
    // ⚠️ Dạng JSON hỏng ở đây là **giá trị không có dấu nháy** — đây là dạng mà message
    // của `JSON.parse` (`Unexpected token 'p', ..." "p1.k1": <cắt>`…`) **thật sự chứa
    // nguyên văn giá trị** vào lỗi. Một dạng hỏng khác (trailing garbage, thiếu dấu
    // phẩy) chỉ nêu vị trí, tức kiểm bằng dạng đó sẽ xanh dù loader có nối lỗi vào
    // message — một kiểm tra tưởng có tác dụng mà không bắt được gì.
    const poisonKey = 'poison-fingerprint-key-material';
    const env = makeEnv({
      [FINGERPRINT_KEYRING_ENV]: `{ "current": "p1.k1", "keys": { "p1.k1": ${poisonKey} } }`,
    });
    const error = await load(env).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransactionalMailConfigError);
    // ⚠️ Đây là lỗi rò rỉ kinh điển: message của `JSON.parse` **trích một đoạn chuỗi
    // JSON** vào lỗi (`..." "p1.k1": <cắt>"... is not valid JSON`) — đủ để lộ **tiền tố
    // của khoá**. Loader phải bỏ qua message đó và chỉ nói TÊN biến.
    //
    // ⚠️ Assert **tiền tố**, không assert toàn bộ khoá: `JSON.parse` cắt chuỗi ở độ dài cố
    // định (`"p1.k1": poison-fin"`), nên `not.toContain(<khoá đầy đủ>)` sẽ xanh ngay cả
    // khi loader nối cả message vào — một kiểm tra tưởng có tác dụng mà không bắt được
    // gì. Tiền tố ở đây được chọn **khớp đúng** đoạn bị cắt, không phải một tiền tố dài
    // hơn (sẽ không xuất hiện trong message đã cắt và vì thế luôn xanh).
    expect((error as Error).message).not.toContain('poison-fin');
    expect((error as Error).message).toContain(FINGERPRINT_KEYRING_ENV);
  });

  it('does not echo key material when a key is the wrong shape', async () => {
    const poisonKey = 'poison-fingerprint-key-material';
    const env = makeEnv({
      [FINGERPRINT_KEYRING_ENV]: JSON.stringify({
        current: 'p1.k1',
        keys: { 'p1.k1': poisonKey },
      }),
    });
    const error = await load(env).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TransactionalMailConfigError);
    expect((error as Error).message).not.toContain(poisonKey);
  });

  it('names the variable for every rejected credential entry', async () => {
    for (const [variable] of SECRET_BEARING_VARIABLES) {
      const env = makeEnv({ [variable]: '   ' });
      const error = await load(env).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(TransactionalMailConfigError);
      expect((error as Error).message).toContain(variable);
    }
  });
});

describe('skew', () => {
  it('falls back to the protocol default when the variable is absent', async () => {
    const config = await load(makeEnv({ [INTERNAL_AUTH_SKEW_ENV]: undefined }));
    expect(config.skewSeconds).toBe(DEFAULT_SKEW_SECONDS);
  });

  it('accepts both protocol bounds inclusively', async () => {
    const lower = await load(makeEnv({ [INTERNAL_AUTH_SKEW_ENV]: String(MIN_SKEW_SECONDS) }));
    const upper = await load(makeEnv({ [INTERNAL_AUTH_SKEW_ENV]: String(MAX_SKEW_SECONDS) }));
    expect(lower.skewSeconds).toBe(MIN_SKEW_SECONDS);
    expect(upper.skewSeconds).toBe(MAX_SKEW_SECONDS);
  });

  it.each([
    ['below the lower bound', String(MIN_SKEW_SECONDS - 1)],
    ['above the upper bound', String(MAX_SKEW_SECONDS + 1)],
    ['zero', '0'],
    ['negative', '-1'],
    ['exponent notation', '1e3'],
    ['decimal', '300.0'],
    ['padded with spaces', ' 300 '],
    ['hexadecimal', '0x10'],
  ])('rejects skew %s instead of silently defaulting', async (_label, value) => {
    await expect(load(makeEnv({ [INTERNAL_AUTH_SKEW_ENV]: value }))).rejects.toThrow(
      new RegExp(INTERNAL_AUTH_SKEW_ENV, 'u'),
    );
  });
});

describe('operational values', () => {
  const OPERATIONAL_VARIABLES = [
    'MAIL_RATE_LIMIT_PRINCIPAL_LIMIT',
    'MAIL_RATE_LIMIT_PRINCIPAL_WINDOW_MS',
    'MAIL_RATE_LIMIT_SYSTEM_LIMIT',
    'MAIL_RATE_LIMIT_SYSTEM_WINDOW_MS',
    'MAIL_RATE_LIMIT_KEY_LIMIT',
    'MAIL_RATE_LIMIT_KEY_WINDOW_MS',
    'MAIL_RENDER_MAX_BYTES',
    'MAIL_PUBLISH_LEASE_MS',
    'MAIL_PUBLISH_BATCH_LIMIT',
    'MAIL_PUBLISH_MAX_ATTEMPTS',
    'MAIL_PUBLISH_BACKOFF_BASE_MS',
    'MAIL_RECONCILER_MAX_AGE_MS',
    'MAIL_RECONCILER_BATCH_LIMIT',
    'MAIL_RECOVERY_MAX_CYCLES',
    'MAIL_NONCE_PRUNE_BATCH_LIMIT',
    'MAIL_RETENTION_CONTENT_MS',
    'MAIL_RETENTION_STALE_ALERT_MS',
  ] as const;

  it('nests every operational value into the documented shape', async () => {
    const config = await load(makeEnv());
    expect(config.rateLimits).toEqual({
      principal: { limit: 60, windowMs: 60000 },
      system: { limit: 10000, windowMs: 60000 },
      idempotencyKey: { limit: 20, windowMs: 60000 },
    });
    expect(config.render).toEqual({ maxRenderBytes: 64000 });
    expect(config.publish).toEqual({
      leaseMs: 30000,
      batchLimit: 10,
      maxAttempts: 5,
      backoffBaseMs: 1000,
    });
    expect(config.reconciler).toEqual({
      maxAgeMs: 600000,
      batchLimit: 50,
      maxRecoveryCycles: 5,
    });
    expect(config.noncePrune).toEqual({ batchLimit: 500 });
    expect(config.retention).toEqual({ contentMs: 2592000000, staleAlertMs: 86400000 });
  });

  it.each(OPERATIONAL_VARIABLES)('requires %s and names it when absent', async (variableName) => {
    const error = await load(makeEnv({ [variableName]: undefined })).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TransactionalMailConfigError);
    expect((error as Error).message).toContain(variableName);
  });

  it.each(OPERATIONAL_VARIABLES)(
    'rejects %s when it is not a decimal integer string',
    async (variableName) => {
      // `Number('1e3')`/`Number(' 60 ')`/`Number('60.5')` đều ra một số hợp lệ trong JS —
      // regex mới chặn được mọi dạng đó.
      await expect(load(makeEnv({ [variableName]: '1e3' }))).rejects.toThrow(
        new RegExp(variableName, 'u'),
      );
    },
  );

  it.each(OPERATIONAL_VARIABLES)('rejects %s when it is zero', async (variableName) => {
    // 0 là "chạy được nhưng không bao giờ làm gì" — phải là lỗi cấu hình, không phải tắt hạng mục.
    await expect(load(makeEnv({ [variableName]: '0' }))).rejects.toThrow(
      new RegExp(variableName, 'u'),
    );
  });
});

describe('template URL allowlist', () => {
  it('is an empty list when absent', async () => {
    const config = await load(makeEnv({ [TEMPLATE_URL_ALLOWED_HOSTS_ENV]: undefined }));
    expect(config.templateUrlAllowedHosts).toEqual([]);
  });

  it('lowercases hosts, trims around commas and drops empty tokens', async () => {
    const config = await load(
      makeEnv({ [TEMPLATE_URL_ALLOWED_HOSTS_ENV]: 'Assets.Example.com , ,CDN.example.com' }),
    );
    expect(config.templateUrlAllowedHosts).toEqual(['assets.example.com', 'cdn.example.com']);
  });
});

describe('cache', () => {
  // Mỗi test tự xoá ô cache của module (`resetTransactionalMailConfigCacheForTests`),
  // nên kết quả không phụ thuộc thứ tự chạy — kể cả khi vitest shuffle. Test "same
  // instance" nhờ thế kiểm đúng ý nghĩa của nó: cache LẠNH, hai lời gọi cùng nhận
  // MỘT promise (không phải hai config trùng giá trị do trùng `env`).
  beforeEach(() => {
    resetTransactionalMailConfigCacheForTests();
  });

  it('does not cache a configuration error, so a fixed env reloads', async () => {
    const broken = makeEnv({ MAIL_PUBLISH_LEASE_MS: undefined });
    await expect(loadTransactionalMailConfig(broken)).rejects.toThrow(TransactionalMailConfigError);
    // Nếu lỗi bị nhớ, lời gọi này trả lại chính rejection đó (hoặc config của env trước)
    // và Worker chết vĩnh viễn cho tới khi restart — tức cách phục hồi duy nhất là deploy.
    const reloaded = await loadTransactionalMailConfig(makeEnv());
    expect(reloaded.publish.leaseMs).toBe(30000);
  });

  it('returns the same instance on repeated calls', async () => {
    const first = await loadTransactionalMailConfig(makeEnv());
    const second = await loadTransactionalMailConfig(makeEnv());
    expect(second).toBe(first);
  });

  it('caches by promise, so concurrent first callers share one load', async () => {
    // `cached ??= await load()` chỉ gán SAU khi resolve, nên N request đầu đến đồng thời
    // trên isolate vừa ấm sẽ cùng chạy loader. Gán promise thì lời gọi đầu "đặt cọc" và
    // các lời gọi sau await đúng promise đó — cùng object trả về.
    const env = makeEnv();
    const [a, b, c] = await Promise.all([
      loadTransactionalMailConfig(env),
      loadTransactionalMailConfig(env),
      loadTransactionalMailConfig(env),
    ]);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
});
