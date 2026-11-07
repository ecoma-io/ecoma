import { exportPKCS8, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { AuthConfigurationError } from '@ecoma-io/auth-domain';
import { SigningKeyProvider } from '@ecoma-io/auth-infrastructure';
import { DEFAULT_SKEW_SECONDS } from '@ecoma-io/auth-contracts';

import { type AuthEnv, loadAuthConfig, resolveInternalSecret } from './config';

/**
 * Nạp cấu hình là nơi quyết định Worker có phát hành token được hay không.
 *
 * ⚠️ Mỗi test ở đây là một CÁCH CẤU HÌNH SAI mà nếu lọt qua sẽ thành lỗ hổng.
 * Suite xanh vì vậy có giá trị; suite đỏ nghĩa là có một đường mà lỗi đi vào.
 */

let pem: string;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  pem = await exportPKCS8(privateKey);
});

/** `K_auth`: 32 byte base64url, đúng dạng Worker Secret thật. */
const HANDLE_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function makeEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
  return {
    HYPERDRIVE: { connectionString: 'hyperdrive-internal-placeholder' },
    ACCOUNT_SERVICE: { fetch: async () => new Response('{}') },
    AUTH_SIGNING_KEY: pem,
    AUTH_SIGNING_KEY_ID: 'kid-2026-01',
    AUTH_HANDLE_KEY: HANDLE_KEY,
    AUTH_HANDLE_KEY_VERSION: '1',
    AUTH_INTERNAL_SECRET: 'internal-secret-test',
    AUTH_ISSUER: 'https://auth.ecoma.io',
    AUTH_AUDIENCE: 'https://api.ecoma.io',
    // oidc-provider ký cookie phiên bằng keygrip — thiếu là fail-closed.
    AUTH_COOKIE_KEYS: 'test-cookie-key-1,test-cookie-key-2',
    AUTH_ACCOUNT_BASE_URL: 'https://account.ecoma.io',
    ...overrides,
  };
}

describe('loadAuthConfig — fail-closed', () => {
  it('loads a complete configuration', async () => {
    const config = await loadAuthConfig(makeEnv());
    expect(config.issuer).toBe('https://auth.ecoma.io');
    expect(config.audience).toBe('https://api.ecoma.io');
    expect(config.signingKeyProvider.kid).toBe('kid-2026-01');
    expect(config.handleKeyVersion).toBe(1);
  });

  it('MISSING signing key — throws, NEVER generates a fake key', async () => {
    // ⚠️ Đây là D4. Một khoá sinh lúc khởi động đổi mỗi lần deploy: JWKS đổi
    // theo và mọi token đã cấu không còn verify được.
    await expect(loadAuthConfig(makeEnv({ AUTH_SIGNING_KEY: undefined }))).rejects.toThrow(
      AuthConfigurationError,
    );
  });

  it('MISSING Hyperdrive binding — throws', async () => {
    await expect(loadAuthConfig(makeEnv({ HYPERDRIVE: undefined }))).rejects.toThrow(
      /HYPERDRIVE|db-auth/u,
    );
  });

  it('MISSING ACCOUNT_SERVICE — throws, because it cannot fail-closed', async () => {
    // ⚠️ Không có binding tới Account thì không có cách nào hỏi trạng thái
    // account, và "không hỏi được coi như khoẻ" đúng là lỗ hổng.
    await expect(loadAuthConfig(makeEnv({ ACCOUNT_SERVICE: undefined }))).rejects.toThrow(
      /ACCOUNT_SERVICE/u,
    );
  });

  it('empty secret, whitespace only, is also rejected', async () => {
    await expect(loadAuthConfig(makeEnv({ AUTH_HANDLE_KEY: '   ' }))).rejects.toThrow(
      /AUTH_HANDLE_KEY/u,
    );
  });

  it('NO default value for any secret', async () => {
    // Lặp qua từng secret: thiếu bất kỳ cái nào cũng phải ném.
    const secrets = [
      'AUTH_SIGNING_KEY',
      'AUTH_SIGNING_KEY_ID',
      'AUTH_HANDLE_KEY',
      'AUTH_HANDLE_KEY_VERSION',
      'AUTH_INTERNAL_SECRET',
      'AUTH_ISSUER',
      'AUTH_AUDIENCE',
      'AUTH_COOKIE_KEYS',
      'AUTH_ACCOUNT_BASE_URL',
    ] as const;

    for (const secret of secrets) {
      await expect(loadAuthConfig(makeEnv({ [secret]: undefined }))).rejects.toThrow(
        AuthConfigurationError,
      );
    }
  });

  it('AUTH_HANDLE_KEY_VERSION with a malformed value — throws', async () => {
    await expect(loadAuthConfig(makeEnv({ AUTH_HANDLE_KEY_VERSION: '0x1' }))).rejects.toThrow(
      /AUTH_HANDLE_KEY_VERSION/u,
    );
    await expect(loadAuthConfig(makeEnv({ AUTH_HANDLE_KEY_VERSION: '0' }))).rejects.toThrow(
      /AUTH_HANDLE_KEY_VERSION/u,
    );
    await expect(loadAuthConfig(makeEnv({ AUTH_HANDLE_KEY_VERSION: ' 1' }))).rejects.toThrow(
      /AUTH_HANDLE_KEY_VERSION/u,
    );
  });

  it('PEM is not PKCS#8 — throws loudly', async () => {
    await expect(
      loadAuthConfig(
        makeEnv({
          AUTH_SIGNING_KEY:
            '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\n-----END EC PRIVATE KEY-----',
        }),
      ),
    ).rejects.toThrow(/PKCS#8/u);
  });

  it('error message NEVER contains a secret value', async () => {
    // ⚠️ Một thông báo lỗi chứa secret là một secret nằm trong log.
    let message = '';
    try {
      await loadAuthConfig(makeEnv({ AUTH_SIGNING_KEY: undefined }));
    } catch (error: unknown) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(pem);
    expect(message).not.toContain('internal-secret-test');
  });
});

describe('AUTH_INTERNAL_SKEW_SECONDS — a protocol constant, not a free-form field', () => {
  it('unset or an empty string ⇒ DEFAULT_SKEW_SECONDS of the lib', async () => {
    const unset = await loadAuthConfig(makeEnv());
    const empty = await loadAuthConfig(makeEnv({ AUTH_INTERNAL_SKEW_SECONDS: '' }));

    expect(unset.internalAuthSkewSeconds).toBe(DEFAULT_SKEW_SECONDS);
    expect(empty.internalAuthSkewSeconds).toBe(DEFAULT_SKEW_SECONDS);
  });

  it('a valid decimal integer ⇒ exactly that number, and 0 is rejected', async () => {
    const config = await loadAuthConfig(makeEnv({ AUTH_INTERNAL_SKEW_SECONDS: '120' }));

    expect(config.internalAuthSkewSeconds).toBe(120);
    await expect(loadAuthConfig(makeEnv({ AUTH_INTERNAL_SKEW_SECONDS: '0' }))).rejects.toThrow(
      /AUTH_INTERNAL_SKEW_SECONDS/u,
    );
  });

  it.each([
    ['leading whitespace', ' 300'],
    ['trailing whitespace', '300 '],
    ['decimal part', '3.0'],
    ['hex literal', '0x10'],
    ['exponent notation', '1e3'],
    ['leading plus', '+300'],
    ['negative', '-1'],
    ['trailing letter', '300x'],
    ['whitespace-only string', '   '],
    ['trailing newline', '300\n'],
  ])('rejects a value that is not a decimal digit string: %s', async (_label, value) => {
    // ⚠️ Mọi giá trị ở đây đều LỌT qua `Number.isInteger(Number(value))` — trừ
    // `'300x'`/`'   '` — nên một phép kiểm bằng `Number.isInteger` sẽ nhận im lặng
    // `'0x10'` thành 16, `'1e3'` thành 1000. Đó không phải chi tiết hình thức: skew
    // quyết định cửa sổ replay của envelope VÀ TTL của nonce.
    //
    // `'300\n'` là ca tinh tế nhất: trong JavaScript `$` **không** khớp trước một
    // ký tự xuống dòng cuối (đó là hành vi của Python), nên `/^\d+$/u` từ chối nó —
    // nhưng `Number('300\n')` vẫn là 300, nên bỏ regex mà chỉ dùng `Number()` là
    // nhận im lặng một giá trị có ký tự lạ.
    await expect(loadAuthConfig(makeEnv({ AUTH_INTERNAL_SKEW_SECONDS: value }))).rejects.toThrow(
      /AUTH_INTERNAL_SKEW_SECONDS/u,
    );
  });

  it('rejects a skew above the cap — a typo must not open a 24h replay window', async () => {
    // ⚠️ `86400` vẫn là "số nguyên không âm": nếu chỉ kiểm kiểu thì một Worker Secret
    // gõ sai sẽ im lặng mở cửa sổ replay lên 24 giờ và kéo TTL nonce theo, làm phình
    // bảng `auth.internal_nonces`. Trần biến lỗi gõ tay thành lỗi cấu hình.
    await expect(loadAuthConfig(makeEnv({ AUTH_INTERNAL_SKEW_SECONDS: '86400' }))).rejects.toThrow(
      /AUTH_INTERNAL_SKEW_SECONDS/u,
    );
  });

  it('3600 is exactly at the cap, 3601 is over it', async () => {
    // ⚠️ Biên của một trần là chỗ dễ sai nhất: đổi `>` thành `>=` không làm test nào
    // đỏ nếu chỉ có một ca ở xa ngưỡng.
    const atCap = await loadAuthConfig(makeEnv({ AUTH_INTERNAL_SKEW_SECONDS: '3600' }));
    expect(atCap.internalAuthSkewSeconds).toBe(3600);
    await expect(loadAuthConfig(makeEnv({ AUTH_INTERNAL_SKEW_SECONDS: '3601' }))).rejects.toThrow(
      /AUTH_INTERNAL_SKEW_SECONDS/u,
    );
  });

  it('NEVER names the value in the error message: it would reach the error log (F-07)', async () => {
    // ⚠️ Bất biến này chỉ có một đường kiểm được: bắt **chính** message và tìm giá trị
    // trong đó. Assert `toThrow(/AUTH_INTERNAL_SKEW_SECONDS/u)` ở các test trên không
    // nói gì về việc message có kèm giá trị hay không, nên một bản cài đặt
    // `` `... khong hop le: ${value}` `` vẫn làm toàn bộ suite xanh.
    //
    // Vì sao đây là chuyện bảo mật chứ không phải văn phong: một operator có thể dán
    // nhầm `AUTH_INTERNAL_SECRET` (một chuỗi base64 dài) vào `AUTH_INTERNAL_SKEW_SECONDS`.
    // Message lỗi là thứ đi thẳng vào `console.error`/log thu thập của Worker, và ở đó
    // secret sẽ nằm lại lâu hơn nhiều so với một request. Đây đúng là F-07.
    // Cố ý KHÔNG dùng một chuỗi mang hình dạng credential của provider nào (`sk_live_…`,
    // `ghp_…`): quét secret của repo sẽ chặn push vì nó, và khi đó người sửa phải đi xin
    // allowlist cho một giá trị chưa bao giờ là secret thật. Thứ test này cần chỉ là một
    // giá trị (a) không phải chuỗi chữ số để lọt vào nhánh định dạng, và (b) to như một
    // secret thật để ca "lọt vào message" là ca đáng sợ. Base64 43 ký tự đúng hình dạng
    // `AUTH_INTERNAL_SECRET` mà không khớp pattern của provider nào.
    //
    // ⚠️ **Tên biến không được chứa từ khoá `secret`.** `generic-api-key` của gitleaks
    // khớp theo *từ khoá cạnh giá trị*, không theo giá trị: đo bằng binary 8.30.1 đúng
    // như CI chạy, `const secretLookingValue = '<base64 55 ký tự>'` bị báo (entropy 4.63)
    // còn **cùng giá trị đó** dưới tên `pastedSkewValue` thì sạch. Đây là fixture, không
    // phải secret, nhưng một tên biến mang từ khoá làm required check `Gitleaks` đỏ — và
    // cách chữa đúng là đổi tên, không phải thêm allowlist vào `.gitleaks.toml` (allowlist
    // cho một giá trị chưa bao giờ là secret là cách dạy cho gate biết im lặng).
    const pastedSkewValue = 'Zm9vYmFyYmF6cXV1eGNvcmdlZ3JhdWx0Z2FycGx5c3R1ZmYxMjM0NTY';
    const cases = [
      // Nhánh "không phải chuỗi chữ số".
      pastedSkewValue,
      // Nhánh dưới biên (`0` sao cho nó lọt regex nhưng < 1 là không thể với `\d+`;
      // dùng `00` để vẫn là chuỗi chữ số mà giá trị là 0).
      '00',
      // Nhánh trên trần.
      '99999999',
    ];

    for (const value of cases) {
      let message = '';
      try {
        await loadAuthConfig(makeEnv({ AUTH_INTERNAL_SKEW_SECONDS: value }));
      } catch (error: unknown) {
        message = (error as Error).message;
      }
      expect(message).toContain('AUTH_INTERNAL_SKEW_SECONDS');
      // Không giá trị nào lọt vào message, kể cả nhánh trên trần (nhánh đó nhắc
      // **trần**, tức hằng của chính file này, không phải đầu vào của operator).
      expect(message).not.toContain(value);
      expect(message).not.toContain('sk_live');
    }
  });
});

describe('JWKS — publishes only the public key', () => {
  it('the public JWK has no private field', async () => {
    const config = await loadAuthConfig(makeEnv());
    const jwk = await config.signingKeyProvider.publicJwk();

    // ⚠️ Một trường `d` trong JWKS là một lần rò private key ra internet.
    expect(jwk).not.toHaveProperty('d');
    expect(Object.keys(jwk).toSorted()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
  });

  it('PEM does not appear in the JWKS', async () => {
    const config = await loadAuthConfig(makeEnv());
    const serialized = JSON.stringify(await config.signingKeyProvider.publicJwk());

    expect(serialized).not.toContain(pem);
    expect(serialized).not.toContain('PRIVATE KEY');
    // Đoạn base64 đặc trưng của PEM cũng không được xuất hiện.
    const body = pem.split('\n').filter((line) => line.length > 10)[1] ?? '';
    expect(body.length).toBeGreaterThan(10);
    expect(serialized).not.toContain(body);
  });

  it('the provider shares the JWKS that SigningKeyProvider produces', async () => {
    // Hai chỗ dựng JWKS khác nhau là hai bề mặt công khai có thể lệch.
    const config = await loadAuthConfig(makeEnv());
    const direct = await SigningKeyProvider.fromPem({ pem, kid: 'kid-2026-01' });
    expect(await config.signingKeyProvider.publicJwk()).toEqual(await direct.publicJwk());
  });
});

/**
 * Cấu hình `kid` của envelope internal (issue #64).
 *
 * ⚠️ Mỗi test ở đây là một CÁCH CẤU HÌNH SAI. Suite xanh có giá trị; suite đỏ nghĩa
 * là có một đường mà lỗi đi vào. Đặc biệt: mọi lỗi ở đây phải nổ **lúc boot**, không
 * phải lúc có request — một cặp `kid`/secret lệch là cấu hình sai của toàn bộ kênh
 * internal, và lỗi lúc runtime biểu hiện thành `401` mà không nói vì sao.
 */
describe('loadAuthConfig — the kid of the internal envelope', () => {
  it('loads with an empty map when no kid is set (transition)', async () => {
    const config = await loadAuthConfig(makeEnv());
    expect(config.internalKid).toBeUndefined();
    expect(config.internalSecretsByKid.size).toBe(0);
  });

  it('maps exactly one entry to the current secret for a valid kid', async () => {
    const config = await loadAuthConfig(makeEnv({ AUTH_INTERNAL_KID: '0123abcd' }));
    expect(config.internalKid).toBe('0123abcd');
    expect(config.internalSecretsByKid.get('0123abcd')).toBe('internal-secret-test');
  });

  it('maps two entries for a complete previous pair', async () => {
    const config = await loadAuthConfig(
      makeEnv({
        AUTH_INTERNAL_KID: '0123abcd',
        AUTH_INTERNAL_PREVIOUS_KID: 'abcd0123',
        AUTH_INTERNAL_PREVIOUS_SECRET: 'the-previous-internal-secret',
      }),
    );
    expect(config.internalSecretsByKid.size).toBe(2);
    expect(config.internalSecretsByKid.get('0123abcd')).toBe('internal-secret-test');
    expect(config.internalSecretsByKid.get('abcd0123')).toBe('the-previous-internal-secret');
  });

  it('throws at boot for a malformed kid, never silently sending a garbage header', async () => {
    await expect(loadAuthConfig(makeEnv({ AUTH_INTERNAL_KID: 'not-hex' }))).rejects.toThrow(
      AuthConfigurationError,
    );
  });

  it('throws at boot for a kid that is too short', async () => {
    await expect(loadAuthConfig(makeEnv({ AUTH_INTERNAL_KID: '0123abc' }))).rejects.toThrow(
      AuthConfigurationError,
    );
  });

  it('rejects a kid with surrounding whitespace instead of trimming it silently', async () => {
    await expect(loadAuthConfig(makeEnv({ AUTH_INTERNAL_KID: ' 0123abcd ' }))).rejects.toThrow(
      AuthConfigurationError,
    );
  });

  it('throws at boot when a previous secret is set without a previous kid', async () => {
    await expect(
      loadAuthConfig(
        makeEnv({
          AUTH_INTERNAL_KID: '0123abcd',
          AUTH_INTERNAL_PREVIOUS_SECRET: 'the-previous-internal-secret',
        }),
      ),
    ).rejects.toThrow(AuthConfigurationError);
  });

  it('throws at boot when a previous kid is set without a previous secret', async () => {
    await expect(
      loadAuthConfig(
        makeEnv({
          AUTH_INTERNAL_KID: '0123abcd',
          AUTH_INTERNAL_PREVIOUS_KID: 'abcd0123',
        }),
      ),
    ).rejects.toThrow(AuthConfigurationError);
  });

  it('throws at boot when the current kid equals the previous kid', async () => {
    // Hai khoá khác nhau không được chia một `kid`: nếu chung, `kid` không còn chọn
    // được khoá nào.
    await expect(
      loadAuthConfig(
        makeEnv({
          AUTH_INTERNAL_KID: '0123abcd',
          AUTH_INTERNAL_PREVIOUS_KID: '0123abcd',
          AUTH_INTERNAL_PREVIOUS_SECRET: 'the-previous-internal-secret',
        }),
      ),
    ).rejects.toThrow(AuthConfigurationError);
  });

  it('throws at boot when two secrets share the same value', async () => {
    // Cùng giá trị nhưng hai `kid` khác nhau ⇒ "kid nào cũng đúng" — xoá chủ ý của
    // selector.
    await expect(
      loadAuthConfig(
        makeEnv({
          AUTH_INTERNAL_KID: '0123abcd',
          AUTH_INTERNAL_PREVIOUS_KID: 'abcd0123',
          AUTH_INTERNAL_PREVIOUS_SECRET: 'internal-secret-test',
        }),
      ),
    ).rejects.toThrow(AuthConfigurationError);
  });

  it('never puts the kid or secret value in the error message', async () => {
    // Một operator có thể dán nhầm secret vào ô `kid`. Nếu message nêu giá trị, nó
    // lọt ra error log của Worker (F-07).
    const error = await loadAuthConfig(makeEnv({ AUTH_INTERNAL_KID: 'sup3rs3cret' })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AuthConfigurationError);
    expect((error as Error).message).not.toContain('sup3rs3cret');
  });
});

describe('resolveInternalSecret — the resolver of the internal envelope', () => {
  it('resolves the secret of the current kid', async () => {
    const config = await loadAuthConfig(makeEnv({ AUTH_INTERNAL_KID: '0123abcd' }));
    const resolve = resolveInternalSecret(config);
    await expect(resolve('0123abcd')).resolves.toBe('internal-secret-test');
  });

  it('resolves the secret of the previous kid — the overlap window of a rotation', async () => {
    const config = await loadAuthConfig(
      makeEnv({
        AUTH_INTERNAL_KID: '0123abcd',
        AUTH_INTERNAL_PREVIOUS_KID: 'abcd0123',
        AUTH_INTERNAL_PREVIOUS_SECRET: 'the-previous-internal-secret',
      }),
    );
    const resolve = resolveInternalSecret(config);
    await expect(resolve('abcd0123')).resolves.toBe('the-previous-internal-secret');
  });

  it('throws for an unknown kid, so the lib turns it into bad_signature (fail-closed)', async () => {
    const config = await loadAuthConfig(makeEnv({ AUTH_INTERNAL_KID: '0123abcd' }));
    const resolve = resolveInternalSecret(config);
    await expect(resolve('ffffffff')).rejects.toThrow(/khong co trong registry/u);
  });

  it('treats every kid as unknown when no kid is configured, so a kid-carrying envelope is bad_signature', async () => {
    // Không có `kid` nào trong registry ⇒ không có khoá nào để khớp. Đây là hành vi
    // fail-closed, KHÔNG phải "chấp nhận bằng secret mặc định".
    const config = await loadAuthConfig(makeEnv());
    const resolve = resolveInternalSecret(config);
    await expect(resolve('0123abcd')).rejects.toThrow(/khong co trong registry/u);
  });

  /**
   * Pha **nạp trước** của runbook xoay secret — bước 2 trong
   * `docs/applications/auth/03-operations.md` §3.3.
   *
   * ⚠️ Ở pha này slot `previous` chứa khoá **MỚI** (chưa dùng để ký), và entry
   * `current` — vốn **chính là** secret đang ký — vẫn là khoá cũ. Test này khóa đúng
   * cái hành vi đó, vì nhầm hai nghĩa của slot `previous` là lỗi khiến runbook hướng
   * dẫn người vận hành làm sai.
   */
  it('preload phase: the previous slot holds the NEW key while current stays the signing key', async () => {
    const config = await loadAuthConfig(
      makeEnv({
        AUTH_INTERNAL_KID: '0123abcd',
        AUTH_INTERNAL_PREVIOUS_KID: 'abcd0123',
        AUTH_INTERNAL_PREVIOUS_SECRET: 'the-preloaded-internal-secret',
      }),
    );
    const resolve = resolveInternalSecret(config);

    // Khoá mới đã nạp trước ⇒ verify được (đối tác sắp ký bằng nó).
    await expect(resolve('abcd0123')).resolves.toBe('the-preloaded-internal-secret');
    // Nhưng Worker vẫn **ký** bằng khoá cũ: `internalSecret` không đổi khi nạp trước.
    expect(config.internalSecret).toBe('internal-secret-test');
    expect(config.internalKid).toBe('0123abcd');
  });

  it('preload phase: the Worker still verifies both keys', async () => {
    // Điều kiện cho phép hai Worker đi qua bước 2 ở hai thời điểm khác nhau mà không
    // gián đoạn: trong lúc nạp trước, mỗi Worker verify được cả khoá cũ lẫn khoá mới.
    const config = await loadAuthConfig(
      makeEnv({
        AUTH_INTERNAL_KID: '0123abcd',
        AUTH_INTERNAL_PREVIOUS_KID: 'abcd0123',
        AUTH_INTERNAL_PREVIOUS_SECRET: 'the-preloaded-internal-secret',
      }),
    );
    const resolve = resolveInternalSecret(config);
    await expect(resolve('0123abcd')).resolves.toBe('internal-secret-test');
    await expect(resolve('abcd0123')).resolves.toBe('the-preloaded-internal-secret');
  });
});

/**
 * Registry resource server (`AUTH_RESOURCES`) — một client id chỉ được map vào
 * MỘT audience. Mapping mơ hồ (trùng trong cùng entry hoặc giữa hai entry) là
 * cấu hình sai: glue chọn theo thứ tự mảng sẽ cho kết quả phụ thuộc thứ tự viết.
 * Fail-closed lúc boot, cùng bộ luật với kid trùng / secret trùng giá trị.
 */
describe('AUTH_RESOURCES — duplicate client ids are rejected at boot', () => {
  it('rejects a client id duplicated inside one entry', async () => {
    await expect(
      loadAuthConfig(
        makeEnv({
          AUTH_RESOURCES: JSON.stringify([
            { audience: 'https://api.ecoma.io', clientIds: ['backoffice', 'backoffice'] },
          ]),
        }),
      ),
    ).rejects.toThrow(/client id trung lap/u);
  });

  it('rejects a client id duplicated across two entries', async () => {
    await expect(
      loadAuthConfig(
        makeEnv({
          AUTH_RESOURCES: JSON.stringify([
            { audience: 'https://api.ecoma.io', clientIds: ['backoffice'] },
            { audience: 'https://other.ecoma.io', clientIds: ['backoffice'] },
          ]),
        }),
      ),
    ).rejects.toThrow(/client id trung lap/u);
  });

  it('the returned registry is frozen against mutation after parse', async () => {
    const config = await loadAuthConfig(
      makeEnv({
        AUTH_RESOURCES: JSON.stringify([
          { audience: 'https://api.ecoma.io', clientIds: ['backoffice'] },
        ]),
      }),
    );
    expect(Object.isFrozen(config.resources)).toBe(true);
    expect(Object.isFrozen(config.resources[0]?.clientIds)).toBe(true);
  });

  it('a registry without AUTH_RESOURCES keeps only the primary, frozen', async () => {
    const config = await loadAuthConfig(makeEnv());
    expect(config.resources).toEqual([{ audience: 'https://api.ecoma.io', clientIds: [] }]);
    expect(Object.isFrozen(config.resources)).toBe(true);
  });

  it('every clientIds array in the registry is frozen, including defaults', async () => {
    const config = await loadAuthConfig(
      makeEnv({
        AUTH_RESOURCES: JSON.stringify([
          { audience: 'https://api.ecoma.io' },
          { audience: 'https://other.ecoma.io', clientIds: ['backoffice'] },
        ]),
      }),
    );
    for (const resource of config.resources) {
      expect(Object.isFrozen(resource.clientIds)).toBe(true);
    }
  });

  it('freezing is deep: pushing into a default clientIds throws in strict mode', async () => {
    const config = await loadAuthConfig(makeEnv());
    const primary = config.resources[0];
    expect(primary).toBeDefined();
    expect(() => {
      'use strict';
      (primary.clientIds as string[]).push('intruder');
    }).toThrow(/is not extensible/u);
  });
});
