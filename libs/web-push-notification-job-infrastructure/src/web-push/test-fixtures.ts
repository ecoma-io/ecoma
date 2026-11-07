/**
 * Fixture cho suite adapter Web Push — **không** phải assertion.
 *
 * ⚠️ File này nằm trong `src/**` nên nó đi qua `tsconfig.lib.json`, tức là typecheck với
 * `@cloudflare/workers-types` — **không** dùng `Buffer` hay global Node nào ở đây. Mọi
 * helper base64url đi qua `atob`/`btoa` của platform, giống hệt code production.
 *
 * Vector RFC 8291 Appendix A ở đây là **dữ liệu công bố** từ RFC, đã đối chiếu byte-exactly
 * với WebCrypto (xem `rfc8291-vectors.spec.ts`). `as_private` / `ua_public` / `salt` /
 * `auth_secret` là material công khai của ví dụ trong RFC — chúng **không** phải credential
 * thật, chỉ dùng để tái lập vector.
 */

import { fromBase64Url, toBase64Url } from './base64url';
import { asBytes, asKeyPair, asRawBytes } from './webcrypto';

/** B64u helper cho test: byte → base64url không padding. */
export function b64u(bytes: Uint8Array): string {
  return toBase64Url(bytes);
}

/** B64u helper cho test: base64url → byte. Throws khi input hỏng — vector hỏng là lỗi test. */
export function unb64u(value: string): Uint8Array {
  const bytes = fromBase64Url(value);
  if (bytes === null) {
    throw new Error(`fixture base64url is not decodable: ${value.slice(0, 12)}…`);
  }
  return bytes;
}

/** UTF-8 string → byte. */
export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/**
 * Toàn bộ vector của **RFC 8291 Appendix A** ("Intermediate Values for Encryption"),
 * nguyên văn như RFC công bố, chỉ bỏ whitespace nội tuyến mà RFC nói là có thể bỏ.
 *
 * Nguồn: <https://www.rfc-editor.org/rfc/rfc8291.html#appendix-A> — giá trị được trích từ
 * `rfc8291.txt` bằng script, không gõ tay, để không đoán sai ký tự nào.
 */
export const RFC8291_APPENDIX_A = {
  /** Plaintext của ví dụ — giải base64url là "When I grow up, I want to be a watermelon". */
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  /** Public key của application server — đi vào `keyid` của header. */
  as_public:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  /** Scalar private của application server (32 octet raw, **không** phải PKCS#8). */
  as_private: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  /** Public key của user agent — đi vào request của caller dưới tên `p256dh`. */
  ua_public:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth_secret: 'BTBZMqHH6r4Tts7J_aSIgg', // gitleaks:allow (vector công khai RFC 8291 Appendix A)
  ecdh_secret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs', // gitleaks:allow (vector công khai RFC 8291 Appendix A)
  PRK_key: 'Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k', // gitleaks:allow (vector công khai RFC 8291 Appendix A)
  key_info:
    'V2ViUHVzaDogaW5mbwAEJXGyvs3942BVGq8e0PTNNmwRzr5VX4m8t7GGpTM5FzFo7OLr4BhZe9MEebhuPI-OztV3ylkYfpJGmQ22ggCLDgT-M_SrDepxkU21WCP3O1SUj0EwbZIHMtu5pZpTKGSCIA5Zent7wmC6HCJ5mFgJkuk5cwAvMBKiiujwa7t45ewP',
  IKM: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  PRK: '09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc',
  cek_info: 'Q29udGVudC1FbmNvZGluZzogYWVzMTI4Z2NtAA',
  CEK: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce_info: 'Q29udGVudC1FbmNvZGluZzogbm9uY2UA',
  NONCE: '4h_95klXJ5E_qnoN',
  /** Header 86 octet mà RFC in ra. */
  header:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  /** Plaintext + padding delimiter 0x02. */
  padded: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24C',
  /** Ciphertext + AEAD tag mà RFC in ra. */
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
  /**
   * **Toàn bộ** push message mà RFC 8291 §5 in ra (144 octet, khớp `Content-Length: 145`
   * tính cả `\r\n` cuối dòng trong HTTP example).
   *
   * Vector mạnh nhất của bộ: nó gộp header + ciphertext thành đúng byte mà một push
   * service thật sẽ nhận. ⚠️ **Không** suy ra bằng cách nối chuỗi base64 của `header` và
   * `ciphertext` — base64 mã hoá *theo dòng*, nối hai chuỗi đã encode độc lập sẽ sai (đã
   * thử, đỏ). Phải decode rồi encode lại.
   */
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
} as const;

/** Endpoint hợp lệ dùng trong test. */
export const TEST_ENDPOINT = 'https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV';

/** Thời điểm cố định cho mọi test ký JWT — không đọc đồng hồ thật. */
export const FIXED_NOW_MS = 1_755_000_000_000;

/** TTL cố định. */
export const TEST_TTL_SECONDS = 30;

/** Timeout cố định, đủ lớn để không race ở các test không chủ động timeout. */
export const TEST_TIMEOUT_MS = 5_000;

/**
 * Sinh một cặp ECDSA P-256 làm VAPID key trong test.
 *
 * Trả `privateKeyPkcs8Base64Url` (đúng dạng port yêu cầu: base64url DER PKCS#8) và
 * `publicKeyBase64Url` (base64url điểm uncompressed 65 octet — đúng giá trị header `k`).
 */
export async function generateVapidKeyPair(): Promise<{
  privateKeyPkcs8Base64Url: string;
  publicKeyBase64Url: string;
}> {
  const pair = asKeyPair(
    await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]),
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const point = await crypto.subtle.exportKey('raw', pair.publicKey);
  return {
    privateKeyPkcs8Base64Url: b64u(asBytes(asRawBytes(pkcs8))),
    publicKeyBase64Url: b64u(asBytes(asRawBytes(point))),
  };
}

/**
 * Sinh một cặp ECDH P-256 làm material của subscription trong test.
 *
 * RFC 8291 §2 nói application server sinh cặp mới mỗi message; test cần một `p256dh` ổn
 * định để so sánh byte, nên ở đây cặp sinh ra đóng vai user agent.
 */
export async function generateSubscriptionKeyPair(): Promise<{ p256dh: string; auth: string }> {
  const pair = asKeyPair(
    await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
  );
  const point = await crypto.subtle.exportKey('raw', pair.publicKey);
  return {
    p256dh: b64u(asBytes(asRawBytes(point))),
    auth: b64u(crypto.getRandomValues(new Uint8Array(16))),
  };
}

/** Payload JSON 4 field của FR-013 — dùng cho hầu hết test. */
export const TEST_PAYLOAD_JSON = JSON.stringify({
  title: 'Tin moi',
  body: 'Ban co mot viec moi',
  url: '/notifications',
  data: { kind: 'reminder' },
});
