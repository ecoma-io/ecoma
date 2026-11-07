import { describe, expect, it } from 'vitest';

import { JcsUnsupportedValueError, jcsCanonicalize } from './jcs';

/**
 * RFC 8785 (JCS) — ba điểm FR-002 chốt và dễ sai: thứ tự key **đệ quy ở mọi cấp** theo UTF-16
 * code unit, array **có thứ tự**, và số theo ECMA-262 §7.1.12.1.
 *
 * Vector #3 của bảng golden (FR-002) dùng **object lồng + array** làm fixture, và ở v1 request
 * mang shape đó bị tầng shape từ chối — nhưng đó là giới hạn của **request**, không phải của
 * **hàm canonical**. Hàm phải đủ tổng quát đúng RFC 8785, nên các ca ở đây kiểm hàm, không kiểm
 * một request nghiệp vụ hợp lệ.
 */
describe('jcsCanonicalize — scalar', () => {
  it('serializes the three JSON scalars and null literally', () => {
    expect(jcsCanonicalize(null)).toBe('null');
    expect(jcsCanonicalize(true)).toBe('true');
    expect(jcsCanonicalize(false)).toBe('false');
    expect(jcsCanonicalize(0)).toBe('0');
    expect(jcsCanonicalize(-1)).toBe('-1');
  });

  it('serializes numbers with the ECMAScript representation of a double', () => {
    // `String(number)` và `JSON.stringify(number)` là cùng một luật ECMA-262 §7.1.12.1: `1.0` và
    // `1` là **một** giá trị double, và `1e21` không bao giờ ra ký hiệu khoa học kiểu `1e+21`.
    expect(jcsCanonicalize(1.0)).toBe('1');
    expect(jcsCanonicalize(1.5)).toBe('1.5');
    expect(jcsCanonicalize(-2.5)).toBe('-2.5');
    expect(jcsCanonicalize(1e21)).toBe('1e+21');
    expect(jcsCanonicalize(5e-324)).toBe('5e-324');
  });

  it('rejects non-finite numbers instead of falling back to null', () => {
    // FR-002: `NaN`/`Infinity`/`-Infinity` **không** serialize được, và không được fallback về
    // `null` — fallback đó biến hai request khác nhau thành cùng một canonical bytes.
    expect(() => jcsCanonicalize(Number.NaN)).toThrow(JcsUnsupportedValueError);
    expect(() => jcsCanonicalize(Number.POSITIVE_INFINITY)).toThrow(JcsUnsupportedValueError);
    expect(() => jcsCanonicalize(Number.NEGATIVE_INFINITY)).toThrow(JcsUnsupportedValueError);
  });

  it('escapes strings with minimal JSON escaping', () => {
    // `\b \t \n \f \r` là năm ngoại lệ của `\uhhhh` (FR-002); `"` và `\` luôn escape.
    expect(jcsCanonicalize('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(jcsCanonicalize('\b\t\n\f\r')).toBe('"\\b\\t\\n\\f\\r"');
    expect(jcsCanonicalize('\u0000\u001f')).toBe('"\\u0000\\u001f"');
  });

  it('keeps code points other than the escaped ones as-is, including non-ASCII', () => {
    // Không escape `&`, `<`, `/` — JCS escape **tối thiểu**, và escape HTML ở đây sẽ đổi cả
    // fingerprint lẫn nội dung người nhận thấy.
    expect(jcsCanonicalize('a&b<c>d/e')).toBe('"a&b<c>d/e"');
    expect(jcsCanonicalize('Nguyễn Văn An')).toBe('"Nguyễn Văn An"');
  });

  it('rejects a lone surrogate because it has no valid UTF-8 encoding', () => {
    // FR-002: surrogate lẻ (invalid Unicode) MUST bị từ chối.
    expect(() => jcsCanonicalize('\ud800')).toThrow(JcsUnsupportedValueError);
    // Cặp surrogate hợp lệ (một code point astral) thì hợp lệ.
    expect(jcsCanonicalize('😀')).toBe('"\u{1f600}"');
  });

  it('rejects values JSON cannot represent', () => {
    expect(() => jcsCanonicalize(undefined)).toThrow(JcsUnsupportedValueError);
    expect(() => jcsCanonicalize(1n)).toThrow(JcsUnsupportedValueError);
    expect(() => jcsCanonicalize(() => 'x')).toThrow(JcsUnsupportedValueError);
    expect(() => jcsCanonicalize(Symbol('x'))).toThrow(JcsUnsupportedValueError);
  });
});

describe('jcsCanonicalize — key ordering', () => {
  it('sorts keys by UTF-16 code unit and ignores insertion order', () => {
    // Golden vector #2: đổi thứ tự key trong JSON **không** làm đổi canonical bytes.
    expect(jcsCanonicalize({ b: '2', a: '1' })).toBe('{"a":"1","b":"2"}');
    expect(jcsCanonicalize({ a: '1', b: '2' })).toBe('{"a":"1","b":"2"}');
  });

  it('sorts recursively at every level', () => {
    /**
     * Vector #3 của bảng golden. `items` sort **trước** `user` vì `i` < `u`; bên trong `user`,
     * `id` sort trước `name`; và `items` **giữ nguyên** thứ tự `[1,"x",null]`.
     *
     * Fixture này kiểm đúng ba tính chất cùng lúc: sort key đệ quy, giữ thứ tự array, và phân
     * biệt `null` với vắng mặt (`user` không có `email` nên canonical không có `email`).
     */
    expect(jcsCanonicalize({ user: { name: 'An', id: 'u1' }, items: [1, 'x', null] })).toBe(
      '{"items":[1,"x",null],"user":{"id":"u1","name":"An"}}',
    );
  });

  it('sorts nested keys, not just top-level keys', () => {
    // Nếu chỉ sort cấp ngoài thì `{"a":{"z":1,"b":2}}` sẽ ra `{"a":{"z":1,"b":2}}` — giống hệt
    // input, nên ca này không bắt được lỗi "chỉ sort cấp ngoài".
    expect(jcsCanonicalize({ a: { z: 1, b: 2 } })).toBe('{"a":{"b":2,"z":1}}');
  });

  it('sorts by UTF-16 code unit rather than by code point', () => {
    /**
     * Hai key này phân biệt **chỉ** ở chỗ: `U+FF3A` (FULLWIDTH COLON) nằm trong **BMP** nên UTF-16
     * code unit của nó là `0xFF3A`, còn `U+1F600` là **surrogate pair** bắt đầu bằng `0xD83D`.
     * `0xD83D < 0xFF3A`, nên so **code unit** cho `U+1F600` < `U+FF3A`, trong khi so **code
     * point** (`0x1F600 > 0xFF3A`) cho ngược lại. Kết quả canonical khác nhau, và FR-002 chốt
     * code unit.
     */
    expect(jcsCanonicalize({ '\u{1f600}': 1, Ｚ: 2 })).toBe('{"\u{1f600}":1,"Ｚ":2}');
  });

  it('distinguishes an absent field from an explicit null', () => {
    // FR-002: bốn thứ khác nhau — `null`, trường vắng mặt, giá trị mặc định và object rỗng.
    // Vector #4 ≠ #5 của bảng golden chính là quan hệ này.
    expect(jcsCanonicalize({ otp: null, t: 'reset' })).not.toBe(jcsCanonicalize({ t: 'reset' }));
    expect(jcsCanonicalize({})).not.toBe(jcsCanonicalize(null));
  });

  it('produces no whitespace between tokens', () => {
    expect(jcsCanonicalize({ a: [1, 2], b: { c: 3 } })).toBe('{"a":[1,2],"b":{"c":3}}');
  });
});

describe('jcsCanonicalize — arrays', () => {
  it('keeps array order because order is meaning, not form', () => {
    expect(jcsCanonicalize([1, 2])).not.toBe(jcsCanonicalize([2, 1]));
    expect(jcsCanonicalize([1, 2])).toBe('[1,2]');
  });

  it('keeps a hole-free empty array distinct from an empty object', () => {
    expect(jcsCanonicalize([])).toBe('[]');
    expect(jcsCanonicalize({})).toBe('{}');
  });
});

describe('jcsCanonicalize — values outside the v1 request profile', () => {
  it('rejects a non-plain object rather than silently canonicalizing an empty one', () => {
    // `Object.keys(new Date())` là `[]`, nên chấp nhận mọi object sẽ biến `Date` thành `{}` — hai
    // `Date` khác nhau lại ra cùng canonical bytes. Đó là mất tính chất của hàm băm.
    expect(() => jcsCanonicalize(new Date(0))).toThrow(JcsUnsupportedValueError);
    expect(() => jcsCanonicalize(new Map())).toThrow(JcsUnsupportedValueError);
    expect(() => jcsCanonicalize([])).not.toThrow();
  });

  it('rejects an object key that carries a lone surrogate', () => {
    expect(() => jcsCanonicalize({ '\ud800': 1 })).toThrow(JcsUnsupportedValueError);
  });
});
