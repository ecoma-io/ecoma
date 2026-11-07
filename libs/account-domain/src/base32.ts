/**
 * Base32 (RFC 4648 §6) encode/decode — alphabwet chuẩn, chữ HOA + đệm `=`.
 *
 * ## Vì sao file này tồn tại
 *
 * Secret của TOTP đi tới user dưới dạng **otpauth:// URI** và QR code, mà mọi
 * authenticator app (Google Authenticator, Aegis, 1Password...) decode secret bằng
 * Base32 theo RFC 4648 (alphabet `A–Z` + `2–7`). Không runtime nào (Workers, Node,
 * jsdom) có builtin cho Base32 — chỉ có Base64 — nên codec này phải tự viết.
 *
 * Nằm ở `type:domain` vì nó là **encoding thuần** không I/O, không đồng hồ, không
 * phụ thuộc runtime nào ngoài Web API (`TextEncoder`) — cùng biên với `subject.ts`.
 */

/**
 * Encode byte → Base32 chuẩn RFC 4648 (alphabet `A–Z2–7`, đệm `=`).
 *
 * Vòng lặp bit thuần: gom từng byte vào accumulator 16 bit, trích từng nhóm 5 bit
 * khi đủ. Số ký tự đệm theo công thức của RFC: `ceil(len/5)*8 − len` ký tự `=`
 * khi len không chia hết cho 5.
 */
export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    // Nạp 8 bit vào accumulator; acc luôn giữ <= 12 bit nên không tràn số.
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    // Nhóm cuối chưa đủ 5 bit: đệm bit 0 bên phải rồi map. (RFC 4648 §6.)
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  // Đệm tới bội của 8 ký tự.
  while (out.length % 8 !== 0) {
    out += '=';
  }
  return out;
}

/**
 * Decode Base32 chuẩn RFC 4648 → byte.
 *
 * ⚠️ **Chấp nhận cả chữ thường + bỏ khoảng trắng**: secret hiển thị trên UI thường
 * được nhóm 4 ký tự bằng dấu cách để dễ chép; `otpauth` chuẩn chỉ chứa chữ hoa.
 * Nhập từ user đi qua hàm này, nên việc chuẩn hoá này thuộc hợp đồng decode, không
 * phải việc của từng call site.
 *
 * @throws {Base32DecodeError} Chuỗi rỗng, ký tự ngoài alphabet, hoặc đệm sai vị trí
 *   (đệm phải ở cuối và độ dài chuỗi phải là bội của 8).
 */
export function base32Decode(input: string): Uint8Array {
  // Chuẩn hoá: chữ thường → hoa, bỏ khoảng trắng và dấu gạch nối (UI grouping).
  const cleaned = input.toUpperCase().replace(/[\s-]/gu, '');

  if (cleaned.length === 0) {
    throw new Base32DecodeError('empty');
  }
  if (cleaned.length % 8 !== 0) {
    throw new Base32DecodeError('length');
  }

  // Xoá đệm cuối và kiểm đệm chỉ nằm ở cuối. Chấp nhận chuỗi không có đệm
  // (đúng hình dạng mà Google Authenticator sinh trong otpauth URI: không đệm).
  // Cắt bằng vòng lặp từ cuối (O(k) với k = số đệm ≤ 6) thay vì regex `=+$`:
  // đầu vào là chuỗi do người dùng cung cấp với độ dài không bị chặn, và
  // CodeQL js/polynomial-redos gắn cờ chính hình dạng regex này.
  let stripped = cleaned;
  while (stripped.endsWith('=')) {
    stripped = stripped.slice(0, -1);
  }
  if (stripped.includes('=')) {
    throw new Base32DecodeError('padding');
  }
  // Đệm (nếu có) phải đúng độ dài mà RFC đòi: đệm lấp tròn chuỗi tới bội của 8
  // ký tự. Sai độ dài đệm là chuỗi lỗi — chấp nhận âm thầm sẽ che một lỗi encode.
  const paddingLength = cleaned.length - stripped.length;
  if (paddingLength > 0 && paddingLength !== (8 - (stripped.length % 8)) % 8) {
    throw new Base32DecodeError('padding');
  }

  const out = new Uint8Array(Math.floor((stripped.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let outIndex = 0;
  for (const char of stripped) {
    const nibble = BASE32_LOOKUP[char];
    if (nibble === undefined) {
      throw new Base32DecodeError('character');
    }
    value = (value << 5) | nibble;
    bits += 5;
    if (bits >= 8) {
      out[outIndex] = (value >>> (bits - 8)) & 0xff;
      outIndex += 1;
      bits -= 8;
    }
  }
  return out;
}

/** Lỗi decode — caller dùng nó để trả lỗi "mã không hợp lệ" cho user. */
export class Base32DecodeError extends Error {
  constructor(
    /** Lý do tóm tắt — không chứa giá trị input (secret không được log). */
    readonly reason: 'empty' | 'length' | 'padding' | 'character',
  ) {
    super(`base32 decode failed: ${reason}`);
    this.name = 'Base32DecodeError';
  }
}

/** Alphabet chuẩn RFC 4648 — giữ `=` ra ngoài, đệm được nối riêng. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Bảng tra ngược — chỉ dùng trong `base32Decode`. */
const BASE32_LOOKUP: Record<string, number> = {};
for (let i = 0; i < BASE32_ALPHABET.length; i++) {
  const char = BASE32_ALPHABET[i];
  if (char !== undefined) {
    BASE32_LOOKUP[char] = i;
  }
}
