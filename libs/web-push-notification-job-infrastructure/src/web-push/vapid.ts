/**
 * Ký JWT VAPID theo **RFC 8292 §2** (JWS `ES256`) và ghép header `Authorization`.
 *
 * ⚠️ **Private key của VAPID là provider credential** (worker §18): nó đi vào đây dạng
 * tham số, **không bao giờ** vào kết quả, log, error message hay DLQ. JWT được trả về
 * chỉ để ghép thành header rồi bị bỏ — không giữ lại ở đâu.
 *
 * ⚠️ **Vì sao không DER-encode chữ ký.** WebCrypto `ECDSA.sign` trả chữ ký JOSE raw
 * `r || s` (64 octet cho P-256). RFC 7515 §3.4 yêu cầu đúng dạng raw này cho `ES256`, và
 * DER là dạng của ASN.1/PKCS#1 (`RS256`), không phải của JOSE. Encoding lại thành DER là
 * sai thuật toán, không phải chỉ khác biểu diễn.
 */

import { decodeBase64UrlExact, toBase64Url } from './base64url';
import { VAPID_EXPIRY_SECONDS } from './constants';
import { asBytes } from './webcrypto';

const P256 = { namedCurve: 'P-256' } as const;

/** Điểm EC uncompressed X9.62 của P-256 (65 octet) — giá trị của tham số `k` (RFC 8292 §3.2). */
const UNCOMPRESSED_POINT_OCTETS = 65;

/** Chữ ký JOSE `ES256` = `r || s`, mỗi 32 octet (RFC 7518 §3.4). */
const JOSE_SIGNATURE_OCTETS = 64;

/** Algorithm JOSE cho ECDSA P-256 + SHA-256 (RFC 7518 §3.4). */
const JOSE_ES256 = { name: 'ECDSA', hash: 'SHA-256' } as const;

/**
 * Input ký VAPID — **không** chứa `sub` bắt buộc vì RFC 8292 §2.1 để nó là OPTIONAL.
 */
export interface VapidTokenInput {
  /** Private key VAPID dạng base64url của **DER PKCS#8**. */
  readonly privateKeyDerBase64Url: string;
  /** Claim `aud` — origin của push resource URL, **không** phải hostname server (RFC 8292 §2). */
  readonly audience: string;
  /** Thời điểm hiện tại (epoch seconds) — `exp` tính từ đây, không đọc đồng hồ trong module. */
  readonly nowSeconds: number;
  /** Claim `sub` — contact URI `mailto:`/`https:`; `null` thì **bỏ hẳn** khỏi payload. */
  readonly subject: string | null;
}

/**
 * Private key VAPID **không** dùng được để ký.
 *
 * Phân loại: đây là provider credential hỏng, **không** phải endpoint chết. Port
 * `WebPushPermanentFailureClass` chỉ cho provider chứng minh mới được phát ra
 * `endpoint_invalid`, nên ta ném lỗi để caller map thành `transient`/`before_send` —
 * bounded retry đưa nó tới DLQ cho người xử lý (control plane §7.2 remediation).
 */
export class VapidSigningKeyError extends Error {
  public constructor() {
    // Message rỗng: private key là secret provider, không được phản chiếu vào log/DLQ.
    super('vapid signing key rejected');
    this.name = 'VapidSigningKeyError';
  }
}

/**
 * Tạo JWT VAPID `ES256`.
 *
 * Header `{ typ: 'JWT', alg: 'ES256' }`, payload claim `aud` + `exp` (+ `sub` khi có).
 * RFC 8292 §2.1: `sub` là **OPTIONAL** ("MAY include"), nên `subject === null` vẫn ký
 * hợp lệ — ta chỉ bỏ claim, không từ chối.
 *
 * @throws {VapidSigningKeyError} khi private key không phải PKCS#8 hợp lệ cho P-256.
 */
export async function createVapidToken(input: VapidTokenInput): Promise<string> {
  const privateKeyDer = decodeBase64UrlAny(input.privateKeyDerBase64Url);
  if (privateKeyDer === null) {
    throw new VapidSigningKeyError();
  }

  let privateKey: CryptoKey;
  try {
    // `extractable: false` — khoá sau khi vào WebCrypto thì không export được ra nữa,
    // giảm bề mặt rò rỉ. `deriveBits` usage không liên quan; chỉ `sign`.
    privateKey = await crypto.subtle.importKey(
      'pkcs8',
      privateKeyDer,
      { name: 'ECDSA', ...P256 },
      false,
      ['sign'],
    );
  } catch {
    throw new VapidSigningKeyError();
  }

  // Header và payload base64url **không padding** (RFC 7515 §2: base64url, bỏ padding).
  const header = toBase64Url(
    new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })),
  );
  const claims: { aud: string; exp: number; sub?: string } = {
    aud: input.audience,
    exp: input.nowSeconds + VAPID_EXPIRY_SECONDS,
  };
  if (input.subject !== null) {
    claims.sub = input.subject;
  }
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(claims)));

  const signingInput = new TextEncoder().encode(`${header}.${payload}`);
  const signature = asBytes(await crypto.subtle.sign(JOSE_ES256, privateKey, signingInput));
  // RFC 7515 §3.4: `ES256` dùng chữ ký raw r||s. Không encode lại.
  return `${header}.${payload}.${toBase64Url(signature)}`;
}

/**
 * Ghép header `Authorization` theo **RFC 8292 §3** và WP6.
 *
 * Định dạng: `vapid t=<jwt>, k=<base64url uncompressed public key>` — tham số `t` mang JWT
 * (§3.1), `k` mang ECDSA public key uncompressed base64url (§3.2).
 *
 * @param publicKeyBase64Url giá trị tham số `k` **nguyên văn** từ runtime material —
 *   adapter không re-derive từ private key, vì `vapid_key_id` của subscription phải khớp
 *   key đã dùng lúc tạo subscription (WP2). Derive lại có thể ra cùng điểm nhưng đường đó
 *   không bảo chứng được việc khớp `vapid_key_id`.
 */
export function buildVapidAuthorizationHeader(
  vapidToken: string,
  publicKeyBase64Url: string,
): string {
  return `vapid t=${vapidToken}, k=${publicKeyBase64Url}`;
}

/**
 * Kiểm public key VAPID có đúng dạng uncompressed P-256 không — dùng cho quyết định
 * `vapid_key_missing` **trước** khi gọi fetch.
 *
 * Vì sao cần: WP1 nói push service trả `401` khi thiếu xác thực và `403` khi sai; nhưng ta
 * có thể phát hiện trước bằng shape, đỡ một vòng mạng vô nghĩa. Ta **vẫn** phân loại là
 * `vapid_key_missing` (permanent của attempt) chứ không phải `endpoint_invalid`, vì
 * credential hỏng không nói gì về sức sống của endpoint.
 */
export function isValidVapidPublicKey(publicKeyBase64Url: string): boolean {
  const point = decodeBase64UrlExact(publicKeyBase64Url, UNCOMPRESSED_POINT_OCTETS);
  return point !== null && point[0] === 0x04;
}

/** Số octet của chữ ký JOSE `ES256` — hằng số cho test/assert. */
export const VAPID_JOSE_SIGNATURE_OCTETS = JOSE_SIGNATURE_OCTETS;

/**
 * Algorithm JOSE dùng cho header JWT — export để test tái dựng `verify()`.
 *
 * `crypto.subtle.verify` cần **đúng** object algorithm này cùng public key, nên test phải
 * dùng chung hằng số thay vì viết lại literal ở spec (lệch một chữ là test xanh sai).
 */
export const VAPID_JOSE_ALGORITHM = JOSE_ES256;

/** Trần hạn JWT theo RFC 8292 §2: `exp` không được quá 24 giờ kể từ thời điểm request. */
export const VAPID_MAX_EXPIRY_SECONDS = 24 * 60 * 60;

/** Decode base64url bất kỳ độ dài (PKCS#8 không có độ dài cố định) — `null` khi hỏng. */
function decodeBase64UrlAny(value: string): Uint8Array | null {
  if (value.length === 0) {
    return null;
  }
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}
