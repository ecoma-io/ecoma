/**
 * Crypto primitives bằng **WebCrypto**, không `node:crypto`.
 *
 * ⚠️ Project mang tag `runtime:edge`: Workers với `nodejs_compat` có
 * `node:crypto` qua polyfill, nhưng esbuild bundle `platform: neutral` với
 * conditions `workerd` không resolve được prefix `node:` (lỗi build "Could
 * not resolve node:crypto"). `globalThis.crypto` là API hiện diện ở cả
 * Workers lẫn Node — cùng quy ước với
 * `libs/push-notification-infrastructure/src/credential-cipher.ts`.
 *
 * SHA-256 hex và 32-byte base64url ở đây phải khớp byte-for-byte với
 * `node:crypto` version (test integration ghim qua round-trip create →
 * authenticate): SHA-256 là hàm chuẩn, base64url không padding là cùng
 * bảng chữ cái ở hai nền tảng.
 */

/** SHA-256 của chuỗi UTF-8, hex lowercase — shape của `token_hash`. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 32 byte entropy (192 bit) từ CSPRNG, base64url không padding — shape
 * machine token. `crypto.getRandomValues` là CSPRNG của nền tảng, đủ cho
 * credential (không phải nguồn deterministic nào khác).
 */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // base64url: thay `+/` bằng `-_` và bỏ `=` (RFC 4648 §5, không padding).
  let base64 = '';
  for (const byte of bytes) {
    base64 += String.fromCharCode(byte);
  }
  return btoa(base64).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}
