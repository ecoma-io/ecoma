import { describe, expect, it } from 'vitest';

import {
  FINGERPRINT_KEY_TAG,
  FINGERPRINT_PROFILE_PREFIX,
  canonicalRequestString,
  computeRequestFingerprint,
} from './request-fingerprint';
import { jcsCanonicalize } from './jcs';

/**
 * Khoá fixture **CHỈ dùng cho test** (FR-002): 32 byte theo pattern, KHÔNG dùng ở Production.
 * Digest ở bảng golden được tính từ đúng khoá này, nên đổi khoá fixture là đổi cả bảng.
 */
const K_TEST = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

/** Fingerprint dưới khoá fixture, hoặc ném nếu có nhánh thất bại. */
async function fingerprintOf(
  template: string,
  locale: string,
  recipient: string,
  variables: Record<string, unknown>,
): Promise<string> {
  return fingerprintOfWithKey(K_TEST, template, locale, recipient, variables);
}

/** Fingerprint dưới một khoá bất kỳ — dùng để chứng minh khoá thật sự tham gia. */
async function fingerprintOfWithKey(
  keyHex: string,
  template: string,
  locale: string,
  recipient: string,
  variables: Record<string, unknown>,
): Promise<string> {
  const result = await computeRequestFingerprint({
    keyHex,
    template,
    locale,
    recipient,
    variables,
  });

  if (!result.ok) {
    throw new Error(`unexpected_failure:${result.reason}`);
  }

  return result.value;
}

describe('computeRequestFingerprint — golden vectors of FR-002', () => {
  /**
   * Bảng digest nguyên bản của FR-002, dùng key fixture `k_test`.
   *
   * ⚠️ Đây là **digest fixture**: implementation ra số khác là implementation sai (JCS hoặc
   * canonical sai), KHÔNG phải vector sai. Không sửa digest ở đây để làm test xanh.
   */
  it.each([
    {
      vector: 1,
      template: 'reset-password',
      locale: 'en',
      recipient: 'user@example.com',
      variables: { a: '1', b: '2' },
      expected: 'p1.k1:055e25b39fd486e9551a2c27d9d8e81d25aa04a8c3ac9b8464673799a22d5c4c',
    },
    {
      vector: 2,
      template: 'reset-password',
      locale: 'en',
      recipient: 'user@example.com',
      variables: { b: '2', a: '1' },
      // Đổi thứ tự key phải ra **cùng** digest #1 — JCS sort key.
      expected: 'p1.k1:055e25b39fd486e9551a2c27d9d8e81d25aa04a8c3ac9b8464673799a22d5c4c',
    },
    {
      vector: 3,
      template: 'reset-password',
      locale: 'en',
      recipient: 'user@example.com',
      variables: { user: { id: 'u1', name: 'An' }, items: [1, 'x', null] },
      expected: 'p1.k1:fdc5f9abc382569544f2bd5f00c6ee2182f539fa850ef4ecd7431340efe8d75e',
    },
    {
      vector: 4,
      template: 'reset-password',
      locale: 'en',
      recipient: 'user@example.com',
      variables: { otp: null, t: 'reset' },
      expected: 'p1.k1:5d8e73654a5a9ec64442493065154164553472ad7e42e959cd182274a9d166fe',
    },
    {
      vector: 5,
      template: 'reset-password',
      locale: 'en',
      recipient: 'user@example.com',
      variables: { t: 'reset' },
      expected: 'p1.k1:ccf26ff52ecc36396db61756cc065922334382dfb79bb66d0c0f0979a8602a7a',
    },
    {
      vector: 6,
      template: 'reset-password',
      locale: 'en',
      recipient: 'user@example.com',
      variables: { otp: '123456' },
      expected: 'p1.k1:5e224c55734970878f5b06a9c4c2a2ecf1639b61f0c251154e91500877a96607',
    },
    {
      /**
       * Vector #7 — `recipient` sau trim, tức giá trị mà `normalizeRecipient` đã trả về.
       *
       * `computeRequestFingerprint` nhận **giá trị đã chuẩn hoá** theo đúng ranh giới FR-002 chốt:
       * một hàm chuẩn hoá cho cả fingerprint và lưu trữ. Không trim ở đây — nếu hàm này tự trim
       * thì sẽ có **hai** nơi chuẩn hoá, và chỗ thứ hai nằm ngoài hàm mà fingerprint và cột
       * `recipient` cùng dùng. Quan hệ `#6 = #7` được kiể ở `normalize-request.spec.ts`, nơi
       * trim thật sự xảy ra.
       */
      vector: 7,
      template: 'reset-password',
      locale: 'en',
      recipient: 'user@example.com',
      variables: { otp: '123456' },
      expected: 'p1.k1:5e224c55734970878f5b06a9c4c2a2ecf1639b61f0c251154e91500877a96607',
    },
    {
      vector: 8,
      template: 'reset-password',
      locale: 'en',
      recipient: 'user@example.com',
      variables: { name: 'Nguyễn Văn An', city: 'Hà Nội' },
      expected: 'p1.k1:39025eb6c962dbb1387e05acd37358abe4cd70f232d518a94ce9478c2b795648',
    },
    {
      vector: 9,
      template: 'reset-password',
      locale: 'en',
      recipient: 'user@example.com',
      variables: { otp: '654321' },
      expected: 'p1.k1:5e584b18b3c57edd8df389141ce91d46fe33d9234558c5547b068b642fa8ec08',
    },
    {
      vector: 10,
      template: 'reset-password',
      locale: 'en',
      recipient: 'other@example.com',
      variables: { otp: '123456' },
      expected: 'p1.k1:9861697b934ef29aeca33c94fa1a458a4fe65c49e963f4eb5ba5bd46a27051fb',
    },
  ])('reproduces golden vector #$vector exactly', async (fixture) => {
    await expect(
      fingerprintOf(fixture.template, fixture.locale, fixture.recipient, fixture.variables),
    ).resolves.toBe(fixture.expected);
  });

  it('separates the four relationships the table is read for', async () => {
    // Bốn quan hệ bắt buộc của bảng golden. Chúng là assert **bằng nhau / khác nhau**, không
    // phải một digest cụ thể, nên không cần bảng digest riêng.
    const base = await fingerprintOf('reset-password', 'en', 'user@example.com', {
      otp: '123456',
    });
    const keyOrderSwapped = await fingerprintOf('reset-password', 'en', 'user@example.com', {
      otp: '123456',
    });
    const otherOtp = await fingerprintOf('reset-password', 'en', 'user@example.com', {
      otp: '654321',
    });
    const otherRecipient = await fingerprintOf('reset-password', 'en', 'other@example.com', {
      otp: '123456',
    });
    const explicitNull = await fingerprintOf('reset-password', 'en', 'user@example.com', {
      otp: null,
      t: 'reset',
    });
    const absent = await fingerprintOf('reset-password', 'en', 'user@example.com', {
      t: 'reset',
    });

    // #1 = #2 — thứ tự key vô nghĩa.
    expect(keyOrderSwapped).toBe(base);
    // #4 ≠ #5 — `null` ≠ vắng mặt.
    expect(explicitNull).not.toBe(absent);
    // #9 ≠ #6 — đổi `variables`.
    expect(otherOtp).not.toBe(base);
    // #10 ≠ #6 — đổi `recipient`.
    expect(otherRecipient).not.toBe(base);
  });
});

describe('canonicalRequestString — the byte-length prefix of tier 1', () => {
  it('reproduces the canonical bytes of vector #1, including the 17-byte JCS length', () => {
    expect(
      canonicalRequestString({
        template: 'reset-password',
        locale: 'en',
        recipient: 'user@example.com',
        jcsVariables: '{"a":"1","b":"2"}',
      }),
    ).toBe('v1\n14:reset-password\n2:en\n16:user@example.com\n17:{"a":"1","b":"2"}\n');
  });

  it('reproduces the canonical bytes of vector #3 and the 53-byte length', () => {
    // Vector #3 kiểm canonicalization (sort key đệ quy, giữ thứ tự array), **không** kiểm tính
    // hợp lệ của request: ở v1 shape này bị tầng shape từ chối, nhưng digest bảng vẫn giữ nguyên.
    const jcsVariables = jcsCanonicalize({ user: { id: 'u1', name: 'An' }, items: [1, 'x', null] });

    expect(new TextEncoder().encode(jcsVariables).length).toBe(53);
    expect(
      canonicalRequestString({
        template: 'reset-password',
        locale: 'en',
        recipient: 'user@example.com',
        jcsVariables,
      }),
    ).toBe(
      'v1\n14:reset-password\n2:en\n16:user@example.com\n53:{"items":[1,"x",null],"user":{"id":"u1","name":"An"}}\n',
    );
  });

  it('counts UTF-8 bytes, not UTF-16 code units, in the length prefix', () => {
    // `{"name":"Nguyễn Văn An"}` dài **24** UTF-16 code unit nhưng **27** byte UTF-8: đo bằng
    // `String#length` là tiền tố độ dài sai, và một độ dài sai làm hai input khác nhau có thể
    // trùng chuỗi canonical.
    const jcsVariables = '{"name":"Nguyễn Văn An"}';

    expect(jcsVariables.length).toBe(24);
    expect(new TextEncoder().encode(jcsVariables).length).toBe(27);
    expect(
      canonicalRequestString({
        template: 'reset-password',
        locale: 'en',
        recipient: 'user@example.com',
        jcsVariables,
      }),
    ).toBe('v1\n14:reset-password\n2:en\n16:user@example.com\n27:{"name":"Nguyễn Văn An"}\n');
  });

  it('keeps two different field splits at different byte boundaries distinct', () => {
    // Length prefix là thứ chống va chạm: `("ab", "c")` và `("a", "bc")` cho cùng chuỗi nối thật,
    // nên nếu bỏ tiền tố độ dài thì hai input đó sẽ băm ra cùng một digest.
    const splitOne = canonicalRequestString({
      template: 'ab',
      locale: 'c',
      recipient: 'r',
      jcsVariables: '{}',
    });
    const splitTwo = canonicalRequestString({
      template: 'a',
      locale: 'bc',
      recipient: 'r',
      jcsVariables: '{}',
    });

    expect(splitOne).not.toBe(splitTwo);
  });

  it('treats an absent variables object as the canonical empty object', () => {
    // FR-002: không truyền `variables` và truyền `variables: {}` là **cùng** một request nghiệp vụ
    // → cùng fingerprint. Canonical `2:{}`.
    expect(
      canonicalRequestString({
        template: 'reset-password',
        locale: 'en',
        recipient: 'user@example.com',
        jcsVariables: jcsCanonicalize({}),
      }),
    ).toContain('2:{}\n');
  });
});

describe('computeRequestFingerprint — key version and failure modes', () => {
  it('tags the digest with the profile and key version independently', () => {
    expect(FINGERPRINT_PROFILE_PREFIX).toBe('p1');
    expect(FINGERPRINT_KEY_TAG).toBe('k1');
  });

  it('emits lowercase hex of exactly 64 characters after the prefix', async () => {
    const value = await fingerprintOf('reset-password', 'en', 'user@example.com', { t: 'reset' });

    expect(value).toMatch(/^p1\.k1:[0-9a-f]{64}$/u);
  });

  it('changes the digest when the key changes', async () => {
    // Khoá **có** vai trò: cùng một canonical request dưới hai khoá phải ra hai digest khác nhau.
    // Đây là bằng chứng cho thấy đây là HMAC chứ không phải hash trần của canonical bytes.
    const otherKey = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';

    const withOtherKey = await fingerprintOfWithKey(
      otherKey,
      'reset-password',
      'en',
      'user@example.com',
      { t: 'reset' },
    );

    expect(withOtherKey).not.toBe(
      'p1.k1:ccf26ff52ecc36396db61756cc065922334382dfb79bb66d0c0f0979a8602a7a',
    );
    // Tiền tố vẫn là `p1.k1:` — đổi khoá **không** đổi profile, và hai tag độc lập.
    expect(withOtherKey).toMatch(/^p1\.k1:[0-9a-f]{64}$/u);
  });

  it('rejects a non-finite number instead of serializing it as null', async () => {
    // FR-002: `1e400` là JSON hợp lệ nhưng parse ra `Infinity`; nó **không** được serialize thành
    // `null` — nếu thế thì `{"a":Infinity}` và `{"a":null}` sẽ cùng fingerprint, và hai request
    // khác nhau lại thành một.
    await expect(
      computeRequestFingerprint({
        keyHex: K_TEST,
        template: 'reset-password',
        locale: 'en',
        recipient: 'user@example.com',
        variables: { a: Number.POSITIVE_INFINITY },
      }),
    ).resolves.toEqual({ ok: false, reason: 'non_finite_number' });

    await expect(
      computeRequestFingerprint({
        keyHex: K_TEST,
        template: 'reset-password',
        locale: 'en',
        recipient: 'user@example.com',
        variables: { a: Number.NaN },
      }),
    ).resolves.toEqual({ ok: false, reason: 'non_finite_number' });
  });

  it('throws on a malformed key hex rather than hashing with a wrong key', async () => {
    // `keyHex` là Worker Secret của service, không phải input của caller: nó sai thì phải nổi
    // lên (caller map `503`) chứ không âm thầm ra một fingerprint sai.
    await expect(
      computeRequestFingerprint({
        keyHex: 'zz',
        template: 'reset-password',
        locale: 'en',
        recipient: 'user@example.com',
        variables: {},
      }),
    ).rejects.toThrow('invalid_fingerprint_key_hex');

    await expect(
      computeRequestFingerprint({
        keyHex: 'abc',
        template: 'reset-password',
        locale: 'en',
        recipient: 'user@example.com',
        variables: {},
      }),
    ).rejects.toThrow('invalid_fingerprint_key_hex');
  });
});
