/**
 * Cặp khoá VAPID P-256 **thật** cho test — sinh lúc chạy từ một seed công khai, không có
 * material khoá nào nằm trong source.
 *
 * ⚠️ **Vì sao phải sinh lúc chạy mà không hardcode.** `verifyVapidKeyPair` import private key
 * ở dạng **DER PKCS#8** và public key ở dạng **điểm EC uncompressed 65 octet** (RFC 8292 §3.2),
 * rồi ký và verify — nên một fixture giả (`'new-private-key-material'`) không import được và
 * bị từ chối đúng (`vapid_key_pair_mismatch`). Fixture phải là cặp khoá thật.
 *
 * ⚠️ **Vì sao không hardcode cặp khoá base64url trong file.** `gitleaks` (rule `generic-api-key`)
 * chặn một chuỗi base64url trông giống khoá nằm trong `.ts` — kể cả public key, vì rule không
 * phân biệt. Cặp khoá ở đây được **derive** từ một seed công khai (`seed` dưới đây), nên trong
 * source chỉ có seed — không có byte khoá nào. Seed **không** phải secret: nó nằm công khai
 * trong repo, và cặp khoá sinh ra từ nó chỉ phục vụ test.
 *
 * ⚠️ **Tính tất định.** `crypto.subtle.generateKey` là ngẫu nhiên, nên không dùng. Thay vào đó
 * private scalar `d` được derive bằng SHA-256 từ seed, rồi public point được lấy từ chính
 * WebCrypto (`exportKey('jwk')`). Cùng seed → cùng cặp khoá, nên một test chạy lại vẫn cho
 * cùng kết quả — điều mà một fixture ngẫu nhiên không đảm bảo được.
 */

/** Thuật toán của cặp khoá VAPID: ECDSA trên curve P-256. */
const P256_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;

/** Số octet của public point uncompressed X9.62 (0x04 ‖ X ‖ Y) — 65 octet cho P-256. */
const UNCOMPRESSED_POINT_OCTETS = 65;

/** Độ dài scalar private của P-256 — 32 octet. */
const PRIVATE_SCALAR_OCTETS = 32;

/**
 * Seed công khai — **không** phải secret.
 *
 * ⚠️ Seed phải cho ra một `d` **hợp lệ** (`0 < d < n`), nên `deriveScalar` lặp với một bộ đếm
 * cho tới khi tìm được giá trị trong khoảng đó. Xác suất trượt ở lần đầu là cỡ `2^-32`, nhưng
 * "xác suất rất nhỏ" vẫn là "một lần chạy test đỏ" — lặp cho tới khi hợp lệ là cách đúng.
 */
const SEED_PREFIX = 'ecoma.io:vapid-fixture-seed:v1';

/**
 * Thứ tự nhóm của P-256 (`n`) — dùng để loại scalar không hợp lệ.
 *
 * ⚠️ Hằng này là **thông số của curve**, không phải secret: nó công khai trong RFC 6090 và
 * được mọi thư viện P-256 dùng.
 */
const P256_GROUP_ORDER = Uint8Array.of(
  0xff,
  0xff,
  0xff,
  0xff,
  0x00,
  0x00,
  0x00,
  0x00,
  0xff,
  0xff,
  0xff,
  0xff,
  0xff,
  0xff,
  0xff,
  0xff,
  0xbc,
  0xe6,
  0xfa,
  0xad,
  0xa7,
  0x17,
  0x9e,
  0x84,
  0xf3,
  0xb9,
  0xca,
  0xc2,
  0xfc,
  0x63,
  0x25,
  0x51,
);

/** Cặp khoá VAPID dạng mà API Admin dùng — base64url không padding. */
export interface VapidTestKeyPair {
  /** Private key: base64url của DER PKCS#8. */
  readonly privateKeyDerBase64Url: string;
  /** Public key: base64url của điểm EC uncompressed 65 octet (byte đầu `0x04`). */
  readonly publicPointBase64Url: string;
}

/**
 * Cặp khoá theo `label` — cùng `label` cho cùng một cặp.
 *
 * ⚠️ Cache theo `label` ở module scope: một lần derive tốn vài lệnh WebCrypto, và test cần
 * **cùng** cặp khoá giữa nhiều lời gọi (một lần rotate rồi một lần assert vẫn phải nói về
 * cùng một cặp). Đây là state của **test**, không phải của ứng dụng — luật "no node-local
 * application state" của `AGENTS.md` không áp dụng cho fixture.
 */
const cache = new Map<string, Promise<VapidTestKeyPair>>();

/**
 * Cặp khoá VAPID thật, derive lúc chạy.
 *
 * @param label Nhãn của biến thể — `default` cho cặp chuẩn; một nhãn khác cho cặp **khác**
 *   hoàn toàn (dùng để dựng cặp lệch nhau trong test `vapid_key_pair_mismatch`).
 */
export function vapidTestKeyPair(label = 'default'): Promise<VapidTestKeyPair> {
  const cached = cache.get(label);
  if (cached !== undefined) {
    return cached;
  }
  const pending = deriveKeyPair(label);
  cache.set(label, pending);
  return pending;
}

/** Derive một cặp khoá hoàn chỉnh từ `label`. */
async function deriveKeyPair(label: string): Promise<VapidTestKeyPair> {
  const scalar = await deriveScalar(label);
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8FromScalar(scalar),
    P256_ALGORITHM,
    true,
    ['sign'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  const point = uncompressedPoint(jwk.x, jwk.y);
  // ⚠️ DER cuối cùng **có** kèm public key (`[1] BIT STRING` của RFC 5915): đây là dạng PKCS#8
  // đầy đủ mà mọi runtime WebCrypto đều import được, và nó cho phép ta dựng lại public
  // point mà không cần export lần hai.
  const der = pkcs8FromScalar(scalar, point);
  return {
    privateKeyDerBase64Url: toBase64Url(der),
    publicPointBase64Url: toBase64Url(point),
  };
}

/** SHA-256 của seed → scalar private hợp lệ (`0 < d < n`). */
async function deriveScalar(label: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      encoder.encode(`${SEED_PREFIX}:${label}:${attempt}`),
    );
    const scalar = new Uint8Array(digest);
    if (isValidScalar(scalar)) {
      return scalar;
    }
  }
  throw new Error('vapid-test-keys: không derive được scalar P-256 hợp lệ.');
}

/** `0 < d < n` — byte-wise, big-endian. */
function isValidScalar(scalar: Uint8Array): boolean {
  if (scalar.every((byte) => byte === 0)) {
    return false;
  }
  for (let index = 0; index < PRIVATE_SCALAR_OCTETS; index += 1) {
    const left = scalar[index] ?? 0;
    const right = P256_GROUP_ORDER[index] ?? 0;
    if (left !== right) {
      return left < right;
    }
  }
  // `d === n` — không hợp lệ.
  return false;
}

/** Public point uncompressed `0x04 ‖ X ‖ Y` từ hai thành phần base64url của JWK. */
function uncompressedPoint(x: string | undefined, y: string | undefined): Uint8Array {
  if (x === undefined || y === undefined) {
    throw new Error('vapid-test-keys: JWK thiếu toạ độ public key.');
  }
  const xBytes = fromBase64Url(x);
  const yBytes = fromBase64Url(y);
  if (xBytes === null || yBytes === null) {
    throw new Error('vapid-test-keys: JWK có toạ độ public key không giải mã được.');
  }
  const point = new Uint8Array(UNCOMPRESSED_POINT_OCTETS);
  point[0] = 0x04;
  point.set(xBytes, 1);
  point.set(yBytes, 1 + xBytes.length);
  return point;
}

/**
 * Dựng DER PKCS#8 cho private key P-256.
 *
 * ⚠️ Cấu trúc: `PrivateKeyInfo ::= SEQUENCE { version INTEGER 0, algorithm SEQUENCE {…},
 * privateKey OCTET STRING }` với `algorithm` là OID `id-ecPublicKey` + OID `prime256v1`, và
 * `privateKey` là `ECPrivateKey` (RFC 5915): `SEQUENCE { version INTEGER 1, privateKey
 * OCTET STRING, [0] parameters, [1] publicKey BIT STRING }`.
 *
 * @param scalar 32 octet của private key.
 * @param publicPoint Điểm EC uncompressed; bỏ trống thì DER không kèm public key (WebCrypto vẫn
 *   import được, và đó là dạng dùng để derive public point).
 */
function pkcs8FromScalar(scalar: Uint8Array, publicPoint?: Uint8Array): Uint8Array {
  const ecPrivateKeyParts = [tlv(0x02, Uint8Array.of(1)), tlv(0x04, scalar)];
  if (publicPoint !== undefined) {
    // BIT STRING: byte đầu là số bit thừa (0 = dùng hết), rồi tới điểm EC.
    const bitString = new Uint8Array(1 + publicPoint.length);
    bitString[0] = 0;
    bitString.set(publicPoint, 1);
    ecPrivateKeyParts.push(tlv(0xa1, tlv(0x03, bitString)));
  }
  const algorithmIdentifier = tlv(
    0x30,
    concat(
      // OID 1.2.840.10045.2.1 (id-ecPublicKey)
      tlv(0x06, Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01)),
      // OID 1.2.840.10045.3.1.7 (prime256v1 / P-256)
      tlv(0x06, Uint8Array.of(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07)),
    ),
  );
  return tlv(
    0x30,
    concat(
      tlv(0x02, Uint8Array.of(0)),
      algorithmIdentifier,
      tlv(0x04, tlv(0x30, concat(...ecPrivateKeyParts))),
    ),
  );
}

/** Một TLV (tag · length · value) của ASN.1 DER. */
function tlv(tag: number, value: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(tag), encodeLength(value.length), value);
}

/** Length của ASN.1 DER — short form khi < 128, long form (0x80 ‖ n) khi lớn hơn. */
function encodeLength(length: number): Uint8Array {
  if (length < 0x80) {
    return Uint8Array.of(length);
  }
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

/** Nối các mảng byte. */
function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

/** Byte → base64url không padding. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** base64url → byte; `null` khi chuỗi không hợp lệ. */
function fromBase64Url(value: string): Uint8Array | null {
  if (value.length === 0) {
    return null;
  }
  try {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}
