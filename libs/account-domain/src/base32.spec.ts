import { describe, expect, it } from 'vitest';

import { Base32DecodeError, base32Decode, base32Encode } from './base32';

/** Vector tính sẵn bằng `base64`/RFC 4648 §10 — neo thuật toán, không snapshot. */
const RFC4648_VECTORS: readonly (readonly [Uint8Array, string])[] = [
  [new Uint8Array([]), ''],
  [new Uint8Array([0x66]), 'MY======'],
  [new Uint8Array([0x66, 0x6f]), 'MZXQ===='],
  [new Uint8Array([0x66, 0x6f, 0x6f]), 'MZXW6==='],
  [new Uint8Array([0x66, 0x6f, 0x6f, 0x62]), 'MZXW6YQ='],
  [new Uint8Array([0x66, 0x6f, 0x6f, 0x62, 0x61]), 'MZXW6YTB'],
  [new Uint8Array([0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72]), 'MZXW6YTBOI======'],
];

describe('base32Encode — RFC 4648 §10 vectors', () => {
  it('matches every RFC 4648 test vector', () => {
    for (const [bytes, expected] of RFC4648_VECTORS) {
      expect(base32Encode(bytes)).toBe(expected);
    }
  });

  it('round-trips every RFC 4648 vector through decode', () => {
    for (const [bytes, encoded] of RFC4648_VECTORS) {
      if (bytes.length === 0) {
        continue; // decode của chuỗi rỗng ném — xem ca riêng.
      }
      expect([...base32Decode(encoded)]).toEqual([...bytes]);
    }
  });

  it('encodes the RFC 6238 test secret on the alphabet authenticator apps read', () => {
    // Secret '12345678901234567890123456789012' (RFC 6238 §B, SHA-256) Base32.
    const secret = new TextEncoder().encode('12345678901234567890123456789012');
    expect(base32Encode(secret)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA====');
  });
});

describe('base32Decode — normalization', () => {
  it('accepts lowercase and strips spaces and dashes', () => {
    const decoded = base32Decode('mzxw 6ytb-oi== ====');
    expect([...decoded]).toEqual([...new TextEncoder().encode('foobar')]);
  });

  it('accepts an unpadded string, the shape otpauth URIs carry', () => {
    // Vector §10: 'MZXW6YTB' KHÔNG đệm là 'fooba' (5 byte) — chuỗi 8 ký tự mang
    // đúng 40 bit; 'foobar' cần đủ 10 ký tự 'MZXW6YTBOI' + đệm.
    expect([...base32Decode('MZXW6YTB')]).toEqual([...new TextEncoder().encode('fooba')]);
  });

  it('rejects the empty string', () => {
    expect(() => base32Decode('')).toThrow(Base32DecodeError);
  });

  it('rejects a length that is not a multiple of eight', () => {
    expect(() => base32Decode('MZXW6YT')).toThrow(Base32DecodeError);
  });

  it('rejects a character outside the alphabet, including 0, 1, 8 and 9', () => {
    // `0`, `1`, `8`, `9` là bốn ký tự người dùng hay gõ nhầm — chúng KHÔNG thuộc
    // alphabet Base32, và decode phải từ chối thay vì âm thầm đoán.
    for (const char of ['0', '1', '8', '9', '!', 'à']) {
      expect(() => base32Decode(`MZXW6YTB${char}==`)).toThrow(Base32DecodeError);
    }
  });

  it('rejects padding in the middle', () => {
    expect(() => base32Decode('MZ==6YTB')).toThrow(Base32DecodeError);
  });

  it('reports the reason in the error, never the input value', () => {
    // Secret là dữ liệu xác thực — message lỗi không được chứa nó.
    const SECRET = 'SUPERSECRETVALUE234';
    let caught: unknown;
    try {
      base32Decode(`${SECRET}====`);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Base32DecodeError);
    expect((caught as Base32DecodeError).message).not.toContain(SECRET);
  });
});
