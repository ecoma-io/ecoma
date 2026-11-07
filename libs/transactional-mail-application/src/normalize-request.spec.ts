import { describe, expect, it } from 'vitest';

import {
  MAIL_DEFAULT_LOCALE,
  MAIL_VARIABLES_KEY_PATTERN,
  MAIL_VARIABLES_MAX_KEYS,
  MAIL_VARIABLES_MAX_STRING_LENGTH,
  normalizeLocale,
  normalizeRecipient,
  validateRequestShapeVariables,
} from './normalize-request';

/** Ngưỡng toàn cục là **public API contract do service enforce** — không phải contract library. */
/**
 * `variables` hợp lệ với `count` key — dùng để chạm hai đầu ngưỡng 50 key.
 */
function variablesWithNKeys(count: number): Record<string, unknown> {
  return Object.fromEntries(Array.from({ length: count }, (_unused, index) => [`k${index}`, 'v']));
}

describe('normalizeRecipient — trim then reject', () => {
  it('trims space, tab, CR and LF at both ends only', () => {
    expect(normalizeRecipient('  user@example.com  ')).toEqual({
      ok: true,
      value: 'user@example.com',
    });
    expect(normalizeRecipient('\t\r\nuser@example.com\n\r\t')).toEqual({
      ok: true,
      value: 'user@example.com',
    });
  });

  it('rejects a value that is empty after trimming', () => {
    expect(normalizeRecipient('')).toEqual({ ok: false, reason: 'invalid_recipient' });
    expect(normalizeRecipient('   \t\r\n')).toEqual({
      ok: false,
      reason: 'invalid_recipient',
    });
  });

  it('requires exactly one @ with a non-empty side on each of the two', () => {
    // FR-002 bước 2: `@example.com` và `user@` đều bị từ chối.
    expect(normalizeRecipient('@example.com')).toEqual({
      ok: false,
      reason: 'invalid_recipient',
    });
    expect(normalizeRecipient('user@')).toEqual({ ok: false, reason: 'invalid_recipient' });
    expect(normalizeRecipient('a@b@example.com')).toEqual({
      ok: false,
      reason: 'invalid_recipient',
    });
    expect(normalizeRecipient('no-at-sign')).toEqual({
      ok: false,
      reason: 'invalid_recipient',
    });
  });

  it('rejects an ASCII control character anywhere in the address', () => {
    // U+0000–U+001F và U+007F. Control char là header/transport injection nên bị chặn ở cả
    // local-part lẫn domain.
    expect(normalizeRecipient('user\u0000@example.com')).toEqual({
      ok: false,
      reason: 'invalid_recipient',
    });
    expect(normalizeRecipient('user\n@example.com')).toEqual({
      ok: false,
      reason: 'invalid_recipient',
    });
    expect(normalizeRecipient('user\u000b@example.com')).toEqual({
      ok: false,
      reason: 'invalid_recipient',
    });
    expect(normalizeRecipient('user@example.com\u007f')).toEqual({
      ok: false,
      reason: 'invalid_recipient',
    });
  });
});

/**
 * Thứ tự hai bước của FR-002 là **cố ý**: trim (bước 1) **trước**, kiểm control char (bước 2).
 *
 * Hệ quả cụ thể: CR/LF ở **hai đầu** bị trim mất nên không còn là control char để từ chối, còn
 * control char ở **giữa** chuỗi thì bị từ chối. Đảo thứ tự (kiểm trước, trim sau) sẽ từ chối một
 * địa chỉ mà FR-002 cho là hợp lệ — đó là khác biệt correctness, không phải chi tiết trình bày.
 */
describe('normalizeRecipient — trim runs before the control-character check', () => {
  it('accepts an address whose only control characters are trailing CR or LF', () => {
    expect(normalizeRecipient('user@example.com\r')).toEqual({
      ok: true,
      value: 'user@example.com',
    });
    expect(normalizeRecipient('user@example.com\n')).toEqual({
      ok: true,
      value: 'user@example.com',
    });
  });

  it('still rejects a control character that survives the trim', () => {
    expect(normalizeRecipient('user\r@example.com')).toEqual({
      ok: false,
      reason: 'invalid_recipient',
    });
  });
});

describe('normalizeRecipient — domain lowercased, local part case preserved', () => {
  it('lowercases the domain but never the whole address', () => {
    // FR-002 bước 4: `An@example.com` và `an@example.com` là **hai** giá trị recipient khác nhau.
    const upperLocal = normalizeRecipient('An@Example.COM');
    const lowerLocal = normalizeRecipient('an@example.com');

    expect(upperLocal).toEqual({ ok: true, value: 'An@example.com' });
    expect(lowerLocal).toEqual({ ok: true, value: 'an@example.com' });
    expect(upperLocal.ok && lowerLocal.ok && upperLocal.value === lowerLocal.value).toBe(false);
  });

  it('does not strip dots or plus tags', () => {
    // FR-002 bước 5: service không sở hữu semantics dot/plus của provider, nên không áp.
    expect(normalizeRecipient('first.last+tag@example.com')).toEqual({
      ok: true,
      value: 'first.last+tag@example.com',
    });
  });
});

describe('normalizeRecipient — IDN becomes A-label before lowercase', () => {
  it('converts an internationalized domain to punycode A-labels', () => {
    // WHATWG `URL` tự punycode theo UTS-46; không tự viết punycode cũng tránh được chỗ sai ở nhãn
    // nhiều ký tự.
    expect(normalizeRecipient('user@bücher.example')).toEqual({
      ok: true,
      value: 'user@xn--bcher-kva.example',
    });
  });

  it('punycodes before lowercasing, so a mixed-case IDN still matches its lowercase form', () => {
    // Nếu lowercase trước khi punycode thì vẫn ra cùng kết quả ở ví dụ này; ca này ghim rằng
    // **một** địa chỉ có hai dạng khác nhau về chữ hoa/thường vẫn chuẩn hoá về **một** giá trị.
    expect(normalizeRecipient('user@BÜCHER.example')).toEqual({
      ok: true,
      value: 'user@xn--bcher-kva.example',
    });
    expect(normalizeRecipient('user@bücher.example')).toEqual(
      normalizeRecipient('user@BÜCHER.example'),
    );
  });

  it('rejects a domain the URL parser refuses', () => {
    // Parser ném ⇒ người gọi từ chối; không có nhánh "cứ để nguyên chuỗi gốc".
    expect(normalizeRecipient('user@')).toEqual({ ok: false, reason: 'invalid_recipient' });
    expect(normalizeRecipient('user@exa mple.com')).toEqual({
      ok: false,
      reason: 'invalid_recipient',
    });
  });
});

describe('normalizeLocale', () => {
  it('falls back to the service default locale for undefined or blank input', () => {
    expect(MAIL_DEFAULT_LOCALE).toBe('en');
    expect(normalizeLocale(undefined)).toEqual({ ok: true, value: 'en' });
    expect(normalizeLocale('')).toEqual({ ok: true, value: 'en' });
    expect(normalizeLocale('   \t\r\n')).toEqual({ ok: true, value: 'en' });
  });

  it('trims and lowercases the whole string', () => {
    expect(normalizeLocale('  EN-US ')).toEqual({ ok: true, value: 'en-us' });
    expect(normalizeLocale('en-US')).toEqual({ ok: true, value: 'en-us' });
  });

  it('accepts the short BCP-47 syntax the profile allows', () => {
    for (const locale of ['en', 'vie', 'en-us', 'zh-hant-tw', 'pt-br']) {
      expect(normalizeLocale(locale)).toEqual({ ok: true, value: locale });
    }
  });

  it('rejects a string that does not match the short syntax', () => {
    // Đây là **ràng buộc syntax**, không phải kiểm region subtag có tồn tại thật hay không:
    // `zz` không phải region thật nhưng vẫn hợp lệ về mặt hình thức và phải qua.
    for (const locale of ['e', 'english', 'en_us', 'en-', '-en', 'en-US-', 'e1234', 'en--us']) {
      expect(normalizeLocale(locale)).toEqual({ ok: false, reason: 'invalid_locale' });
    }

    expect(normalizeLocale('zz')).toEqual({ ok: true, value: 'zz' });
  });
});

/**
 * Hồi quy ReDoS của trim (CodeQL `js/polynomial-redos`).
 *
 * Một run whitespace bị chặn giữa hai ký tự thường (`a` + `\t`×n + `b`) là input bệnh của
 * `/^[ \t\r\n]+|[ \t\r\n]+$/gu`: nhánh `$` được thử lại từ **mỗi** vị trí trong run, mỗi lần
 * greedy-consume run rồi fail tại `$` — O(n²) đã đo trên V8 (n=40.000 → ~1 s; n=80.000 →
 * ~4 s; n=100.000 → ~9 s kể cả khi chia thành hai replace tuần tự, vì nhánh `$` vẫn bị
 * quét từ mỗi vị trí).
 *
 * Test ghim bằng thời gian tuyệt đối: bản O(n²) với n=100.000 mất hàng giây, còn trim O(n)
 * qua `charCodeAt` cỡ vài ms — ngưỡng 200 ms ở giữa hai khoảng đó, đủ rộng để không flake
 * dưới tải CI nhưng vẫn bắt được cả biến thể backtracking đã từng cài.
 */
describe('trim complexity — regression for the two-anchored-branch ReDoS', () => {
  it('trims a pathological whitespace run in time that stays linear in the input length', () => {
    const pathological = `a${'\t'.repeat(100_000)}b`;

    const start = performance.now();
    // Trim chạy trước mọi nhánh từ chối, nên request bị từ chối vẫn đo được đúng đường
    // thực thi của trim.
    expect(normalizeRecipient(pathological)).toEqual({ ok: false, reason: 'invalid_recipient' });
    expect(normalizeLocale(pathological)).toEqual({ ok: false, reason: 'invalid_locale' });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(200);
  });

  it('still trims exactly space, tab, CR and LF at both ends of a mixed run', () => {
    // Ngữ nghĩa FR-002 bước 1 không đổi: đúng bốn ký tự, hai đầu, kể cả khi run bị chặn giữa.
    expect(normalizeRecipient(' \t\r\n user@example.com \r\n\t')).toEqual({
      ok: true,
      value: 'user@example.com',
    });
    expect(normalizeLocale('\t\r en-us \n\r')).toEqual({ ok: true, value: 'en-us' });
    expect(normalizeLocale('\r\t\r\n')).toEqual({ ok: true, value: 'en' });
  });
});

describe('validateRequestShapeVariables — global thresholds of the service', () => {
  it('accepts an empty object, because no variables and empty variables are the same request', () => {
    expect(validateRequestShapeVariables({})).toEqual({ ok: true });
  });

  it('accepts every JSON scalar, including null', () => {
    expect(
      validateRequestShapeVariables({
        text: 'a',
        count: 0,
        flag: false,
        empty: null,
        negative: -1,
        fraction: 1.5,
      }),
    ).toEqual({ ok: true });
  });

  it('rejects an object or an array value', () => {
    // FR-003 tầng shape: object/array bị từ chối ở đây, **không** phải ở contract library.
    expect(validateRequestShapeVariables({ a: { b: 1 } })).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
    expect(validateRequestShapeVariables({ a: [1] })).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
  });

  it('rejects a non-finite number rather than letting it serialize as null', () => {
    // FR-002: `NaN`/`±Infinity` MUST bị từ chối trước khi tính fingerprint, và **không** fallback
    // về `null`.
    expect(validateRequestShapeVariables({ a: Number.NaN })).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
    expect(validateRequestShapeVariables({ a: Number.POSITIVE_INFINITY })).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
    expect(validateRequestShapeVariables({ a: Number.NEGATIVE_INFINITY })).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
  });

  it('caps the key count at 50 and accepts exactly 50', () => {
    expect(validateRequestShapeVariables(variablesWithNKeys(MAIL_VARIABLES_MAX_KEYS))).toEqual({
      ok: true,
    });
    expect(validateRequestShapeVariables(variablesWithNKeys(MAIL_VARIABLES_MAX_KEYS + 1))).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
  });

  it('rejects a key outside the pattern and accepts one at its 64-character bound', () => {
    for (const key of ['', 'has space', 'has-dash', 'has.dot', 'a'.repeat(65), 'a-b']) {
      expect(validateRequestShapeVariables({ [key]: 'v' })).toEqual({
        ok: false,
        reason: 'invalid_request',
      });
    }

    const longest = 'a'.repeat(64);

    expect(MAIL_VARIABLES_KEY_PATTERN.test(longest)).toBe(true);
    expect(validateRequestShapeVariables({ [longest]: 'v' })).toEqual({ ok: true });
  });

  it('caps a string value at 10000 UTF-16 code units, counting surrogates as two', () => {
    const atLimit = 'a'.repeat(MAIL_VARIABLES_MAX_STRING_LENGTH);

    expect(validateRequestShapeVariables({ a: atLimit })).toEqual({ ok: true });
    expect(validateRequestShapeVariables({ a: `${atLimit}a` })).toEqual({
      ok: false,
      reason: 'invalid_request',
    });

    // Ca biên có ký tự astral: mỗi emoji tốn **hai** code unit, nên 5000 emoji là đúng ngưỡng —
    // đo bằng code point sẽ chấp nhận gấp đôi số ký tự thật.
    const astral = '😀'.repeat(5_000);

    expect(astral.length).toBe(10_000);
    expect(validateRequestShapeVariables({ a: astral })).toEqual({ ok: true });
    expect(validateRequestShapeVariables({ a: `${astral}😀` })).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
  });
});
