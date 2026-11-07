/**
 * Mã hoá payload Web Push theo **RFC 8291** (`aes128gcm`) trên WebCrypto của Workers.
 *
 * ⚠️ **Vì sao phải tự viết HKDF.** RFC 8291 §3.3 và RFC 8188 §2.2/§2.3 yêu cầu chuỗi
 * HKDF-SHA-256 cụ thể (extract rồi expand với `info` riêng cho từng bước). Workers
 * WebCrypto **không** có primitive HKDF (chỉ có `deriveBits` cho ECDH/ECDSA/AES), và
 * `deriveBits` của WebCrypto không phải HKDF — không thể dùng để thay thế. Vì vậy HKDF
 * ở đây là HMAC-SHA-256 thuần, khớp với phần "expanded into separate discrete steps
 * using HMAC with SHA-256" mà RFC 8291 §3.4 ghi rõ.
 *
 * ⚠️ **Vì sao ECDH key phải sinh mới mỗi message.** RFC 8291 §4: push message **MUST**
 * include ECDH public key của application server trong `keyid`, và §2 nói key pair đó
 * "can be discarded after encrypting the message". RFC 8292 §3.2 **MUST** cho VAPID
 * key khác key trao đổi (push service "SHOULD reject" bằng `400` khi `t` và `k` trùng
 * nhau). Nên adapter **sinh** key pair ECDH mới mỗi lần gửi — không dùng lại, không
 * nhận từ caller. Đây là lý do `p256dh` là public key của *user agent* còn `vapidPublicKey`
 * là public key *ký*, hai thứ khác nhau và không thể trùng.
 */

import { decodeBase64UrlExact, toBase64Url } from './base64url';
import { asBytes, asJsonWebKey, asKeyPair, asRawBytes, ecdhDeriveParams } from './webcrypto';
import { MAX_BODY_OCTETS, MAX_PLAINTEXT_OCTETS, RECORD_SIZE, SALT_OCTETS } from './constants';

const P256 = { namedCurve: 'P-256' } as const;

/** Điểm EC uncompressed X9.62 của P-256: 65 octet, `0x04 || X || Y` (RFC 8291 §4). */
const UNCOMPRESSED_POINT_OCTETS = 65;

/** Kích thước scalar P-256. */
const SCALAR_OCTETS = 32;

/** `auth` của user agent — RFC 8291 §3.2: đúng 16 octet. */
const AUTH_SECRET_OCTETS = 16;

/** HMAC-SHA-256 — một bước HKDF của RFC 8291 §3.4. */
async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return asBytes(await crypto.subtle.sign('HMAC', cryptoKey, data));
}

/** Nối các đoạn byte thành một buffer mới — không mutate input. */
function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Tách điểm EC uncompressed thành tọa độ base64url `x`/`y` cần cho JWK (RFC 7517). */
function toUncompressedJwkCoordinates(point: Uint8Array): { x: string; y: string } {
  return {
    x: toBase64Url(point.subarray(1, 33)),
    y: toBase64Url(point.subarray(33, 65)),
  };
}

/** Điểm EC uncompressed hợp lệ: đúng 65 octet và bắt đầu bằng `0x04`. */
export function isUncompressedP256Point(point: Uint8Array): boolean {
  return point.length === UNCOMPRESSED_POINT_OCTETS && point[0] === 0x04;
}

/** Kết quả mã hoá — **không** chứa gì ngoài byte body đã mã hoá. */
export interface EncryptedPushBody {
  /** `header || ciphertext || tag`, đúng `HEADER_OCTETS + plaintext + 1 + 16` octet. */
  readonly body: Uint8Array;
}

/** Input của bước mã hoá — material của subscription, không phải VAPID. */
export interface PushEncryptionInput {
  /** Public key ECDH của user agent (base64url, 65 octet uncompressed). */
  readonly p256dh: string;
  /** Authentication secret của subscription (base64url, 16 octet). */
  readonly auth: string;
  /** Plaintext đã serialize (UTF-8 bytes từ `payloadJson`). */
  readonly plaintext: Uint8Array;
  /**
   * Salt 16 octet. Hàm **sinh** bằng `crypto.getRandomValues` (RFC 8188 §2.1: cùng một
   * IKM với salt khác nhau sinh CEK khác nhau; RFC 8291 §2 nói server chọn salt ngẫu nhiên).
   * Có tham số này chỉ để test tái lập được vector RFC 8291 Appendix A.
   */
  readonly salt: Uint8Array;
}

/**
 * Material của subscription **không** dùng được để mã hoá.
 *
 * Lý do phân loại: `p256dh`/`auth` là **subscription delivery secret**. Một giá trị hỏng ở
 * đây **không** chứng minh endpoint chết — endpoint có thể còn tốt và chỉ cần user agent
 * tạo lại subscription. Nếu map sang `endpoint_invalid` thì caller sẽ invalidate một
 * subscription có thể dùng được (port `WebPushPermanentFailureClass`: chỉ provider mới
 * được quyền phát ra class này). Ta trả `null` để caller phân loại thành
 * `transient`/`before_send`, để bounded retry đưa nó tới DLQ cho người xử lý.
 */
export class PushEncryptionInputError extends Error {
  public constructor() {
    // Message **cố tình rỗng**: lỗi này có thể đi vào log/DLQ, và message là nơi
    // subscription secret dễ lọt ra nhất (SR-003). Lý do cụ thể để yêu cầu thì ghi ở
    // call site có chủ đích.
    super('web push encryption input rejected');
    this.name = 'PushEncryptionInputError';
  }
}

/**
 * Mã hoá `plaintext` theo RFC 8291 và trả `header || ciphertext`.
 *
 * @throws {PushEncryptionInputError} khi `p256dh`/`auth` sai dạng **hoặc** `salt` sai
 *   kích thước — cả hai đều là material hỏng, không phải endpoint chết.
 * @throws {RangeError} khi `plaintext` vượt trần 3993 octet — caller phải kiểm trước để
 *   trả `payload_too_large` và không gọi fetch.
 */
export async function encryptPushPayload(input: PushEncryptionInput): Promise<EncryptedPushBody> {
  if (input.plaintext.length > MAX_PLAINTEXT_OCTETS) {
    // Ném ở đây và **không** cắt bớt: worker §15 cấm cắt payload âm thầm.
    throw new RangeError('plaintext exceeds web push budget');
  }

  const uaPoint = decodeBase64UrlExact(input.p256dh, UNCOMPRESSED_POINT_OCTETS);
  if (uaPoint === null || !isUncompressedP256Point(uaPoint)) {
    throw new PushEncryptionInputError();
  }

  const authSecret = decodeBase64UrlExact(input.auth, AUTH_SECRET_OCTETS);
  if (authSecret === null) {
    throw new PushEncryptionInputError();
  }

  if (input.salt.length !== SALT_OCTETS) {
    // Salt sinh nội bộ luôn đúng 16 octet; chỉ nhánh này là test hook đưa sai.
    throw new PushEncryptionInputError();
  }

  // --- Bước 1: ECDH (RFC 8291 §3.1) -----------------------------------------------------
  // Key pair **mới** cho mỗi message (RFC 8291 §2/§4). ECDH public key đi vào `keyid`.
  const ecdhPair = asKeyPair(
    await crypto.subtle.generateKey({ name: 'ECDH', ...P256 }, true, ['deriveBits']),
  );
  const asPoint = asBytes(asRawBytes(await crypto.subtle.exportKey('raw', ecdhPair.publicKey)));
  const uaPublicKey = await crypto.subtle.importKey(
    'raw',
    uaPoint,
    { name: 'ECDH', ...P256 },
    false,
    [],
  );
  const ecdhSecret = asBytes(
    await crypto.subtle.deriveBits(ecdhDeriveParams(uaPublicKey), ecdhPair.privateKey, 256),
  );

  // --- Bước 2: HKDF combine (RFC 8291 §3.3) ---------------------------------------------
  // PRK_key = HKDF-Extract(salt=auth_secret, IKM=ecdh_secret)
  const prkKey = await hmacSha256(authSecret, ecdhSecret);
  // key_info = "WebPush: info" || 0x00 || ua_public || as_public
  const keyInfo = concat(
    new TextEncoder().encode('WebPush: info'),
    new Uint8Array([0]),
    uaPoint,
    asPoint,
  );
  // IKM = HKDF-Expand(PRK_key, key_info, L=32) — L ≤ hash output nên chỉ cần một block.
  const ikm = await hmacSha256(prkKey, concat(keyInfo, new Uint8Array([1])));

  // --- Bước 3: HKDF của RFC 8188 (RFC 8291 §3.4) ----------------------------------------
  const prk = await hmacSha256(input.salt, ikm);
  const cek = (
    await hmacSha256(
      prk,
      concat(new TextEncoder().encode('Content-Encoding: aes128gcm'), new Uint8Array([0, 1])),
    )
  ).subarray(0, 16);
  const nonce = (
    await hmacSha256(
      prk,
      concat(new TextEncoder().encode('Content-Encoding: nonce'), new Uint8Array([0, 1])),
    )
  ).subarray(0, 12);

  // --- Bước 4: AES-128-GCM, một record duy nhất (RFC 8188 §2) -------------------------
  // Padding delimiter 0x02 vì đây là record cuối (RFC 8188 §2: "The last record uses a
  // padding delimiter octet set to the value 2"). Zero padding octet sau nó là tuỳ chọn —
  // RFC 8291 §4 yêu cầu `rs` lớn hơn plaintext + delimiter + padding + tag, và 4096 > 4094
  // nên không cần padding. Worker §15: không thêm padding để "đệm" dữ liệu.
  const delimitedPlaintext = concat(input.plaintext, new Uint8Array([0x02]));
  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = asBytes(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: 128 },
      cekKey,
      delimitedPlaintext,
    ),
  );

  // --- Bước 5: header aes128gcm (RFC 8188 §2.1, RFC 8291 §4) ---------------------------
  // `keyid` = as_point nguyên 65 octet (RFC 8291 §4: "forms the entirety of the keyid").
  const header = new Uint8Array(21 + asPoint.length);
  header.set(input.salt, 0);
  const view = new DataView(header.buffer);
  view.setUint32(16, RECORD_SIZE, false); // `rs` là uint32 **network byte order**.
  view.setUint8(20, asPoint.length); // `idlen` là uint8.
  header.set(asPoint, 21);

  const body = concat(header, ciphertext);
  // Bất biến phòng thủ: header 86 + plaintext ≤ 3993 + delimiter 1 + tag 16 = 4096 (WP5).
  // Nếu vòng này đỏ thì phép tính ở `MAX_PLAINTEXT_OCTETS` đã lệch — thấy ngay lỗi thay vì
  // gửi body vượt trần.
  if (body.length > MAX_BODY_OCTETS) {
    throw new RangeError('encrypted body exceeds web push limit');
  }
  return { body };
}

/**
 * Public key ECDH dạng base64url để test tái lập vector — không dùng trên đường gửi.
 *
 * ⚠️ Xuất tất cả các khóa dùng cho test là **duy nhất** đường thoát secret: key pair ECDH
 * là ephemeral theo RFC 8291 nên rò ra sau khi gửi cũng vô hại. Hàm này không được gọi
 * trên đường serving.
 */
export async function generateEphemeralEcdhPairForTest(): Promise<{
  privateScalarBase64Url: string;
  publicPointBase64Url: string;
}> {
  const pair = asKeyPair(
    await crypto.subtle.generateKey({ name: 'ECDH', ...P256 }, true, ['deriveBits', 'deriveKey']),
  );
  const point = asBytes(asRawBytes(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const asJwkPrivate = asJsonWebKey(await crypto.subtle.exportKey('jwk', pair.privateKey));
  return {
    // `d` trong JWK là scalar big-endian 32 octet, base64url — cùng dạng RFC 8291 Appendix A
    // dùng cho `as_private`.
    privateScalarBase64Url: asJwkPrivate.d ?? '',
    publicPointBase64Url: toBase64Url(point),
  };
}

/**
 * Import scalar P-256 raw thành ECDH private key (chỉ test vector cần).
 *
 * WebCrypto **không** cho `importKey('raw', scalar, 'ECDH')` — `raw` chỉ nhận điểm EC công
 * khai. Scalar phải đi qua JWK, và JWK private bắt buộc có cả `x`/`y`. Đây là lý do hàm
 * này tồn tại: nó chỉ dùng để dựng lại vector của RFC 8291 Appendix A, nơi scalar và điểm
 * công khai đều được công bố.
 */
export async function importP256ScalarForTest(
  scalarBase64Url: string,
  pointBase64Url: string,
): Promise<CryptoKey> {
  const scalar = decodeBase64UrlExact(scalarBase64Url, SCALAR_OCTETS);
  const point = decodeBase64UrlExact(pointBase64Url, UNCOMPRESSED_POINT_OCTETS);
  if (scalar === null || point === null || !isUncompressedP256Point(point)) {
    throw new PushEncryptionInputError();
  }
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', ...toUncompressedJwkCoordinates(point), d: toBase64Url(scalar) },
    { name: 'ECDH', ...P256 },
    false,
    ['deriveBits'],
  );
}
