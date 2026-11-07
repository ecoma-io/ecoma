/**
 * Lớp bọc WebCrypto — chỉ để **nhất quán với `runtime:edge` thật**, không đổi hành vi.
 *
 * ## Vì sao file này tồn tại
 *
 * `@cloudflare/workers-types` (bản `5.20261015.1` mà repo dùng) khai báo
 * `SubtleCryptoDeriveKeyAlgorithm` với field **`$public`**:
 *
 * ```ts
 * interface SubtleCryptoDeriveKeyAlgorithm {
 *   name: string; …; $public?: CryptoKey; …
 * }
 * ```
 *
 * Nhưng **runtime thật (workerd) không chấp nhận `$public`** — nó ném `TypeError`, và chỉ
 * nhận field chuẩn `public` của WebCrypto (ECDH/ECDSA/HKDF theo W3C). Đây là lệch giữa
 * `.d.ts` và implementation của Cloudflare, không phải đặc điểm nào đó của Web Push.
 *
 * Vì repo cấm `any` và cấm ép kiểu trần, mọi chỗ chạm `deriveBits` với ECDH đều đi qua
 * `ecdhDeriveParams` ở đây — một chỗ **có tên, có lý do, có test chứng minh**. Test
 * `workers-runtime.spec.ts` chạy đoạn này trên **workerd thật** (qua Miniflare) và
 * chứng minh `public` chạy còn `$public` ném lỗi, nên nếu Cloudflare sửa type, `pnpm nx
 * test` sẽ đỏ và ai đó phải xoá lớp bọc này đi.
 *
 * ⚠️ **Đừng tự nhân bản cast này ở nơi khác.** Dùng helper.
 *
 * @see {@link https://github.com/cloudflare/workers-types | cloudflare/workers-types} —
 *   `SubtleCryptoDeriveKeyAlgorithm.$public` không khớp workerd.
 */

/**
 * Thuật toán ECDH kèm public key của bên kia, đúng hình dạng **runtime** chấp nhận.
 *
 * ⚠️ Kiểu trả về là khai báo **cục bộ**, không phải `SubtleCryptoDeriveKeyAlgorithm` của
 * `@cloudflare/workers-types`. Lý do nằm ở chỗ dùng: `deriveBits` nhận `EcdhKeyDeriveParams`,
 * tức là kiểu **có** field `public`. Nếu ta trả về kiểu của workers-types thì mọi call site
 * — kể cả call site trong file `.spec.ts`, vốn biên dịch với `types` khác — sẽ đỏ với
 * `TS2769: Property 'public' is missing`. Việc chuỗi project-reference của repo có che
 * lỗi này hay không là thứ ta không được dựa vào; kiểu trả về phải đúng ở mọi nơi.
 */
export interface EcdhDeriveParams {
  readonly name: 'ECDH';
  readonly public: CryptoKey;
}

export function ecdhDeriveParams(publicKey: CryptoKey): EcdhDeriveParams {
  // `public` là field chuẩn W3C mà workerd đọc; `.d.ts` hiện chỉ khai báo `$public`.
  return { name: 'ECDH', public: publicKey };
}

/**
 * Thuật toán ECDSA kèm hash — tương thực type của Workers nên không cần cast.
 *
 * `generateKey`/`sign` ở Workers dùng `SubtleCryptoImportKeyAlgorithm`-style object có
 * `hash`, nên hàm này chỉ gom lại cho một chỗ để test không phải viết lại literal.
 */
export function ecdsaSignParams(): { name: 'ECDSA'; hash: 'SHA-256' } {
  return { name: 'ECDSA', hash: 'SHA-256' };
}

/** `CryptoKeyPair` từ `generateKey` — Workers khai báo kiểu trả về là union, nên phải thu hẹp. */
export interface GeneratedKeyPair {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
}

/**
 * Thu hẹp kết quả `generateKey` về `CryptoKeyPair`.
 *
 * `@cloudflare/workers-types` khai báo `generateKey` trả `Promise<CryptoKey | CryptoKeyPair>`
 * cho mọi trường hợp, dù algorithm EC luôn cho cặp. Đây là hệ quả của việc gộp
 * symmetric/asymmetric vào một chữ ký — ta kiểm runtime thay vì ép kiểu.
 *
 * @throws {TypeError} khi runtime trả `CryptoKey` (chữ ký đơn) cho một algorithm EC.
 */
export function asKeyPair(generated: CryptoKey | CryptoKeyPair): GeneratedKeyPair {
  if ('privateKey' in generated && 'publicKey' in generated) {
    return { privateKey: generated.privateKey, publicKey: generated.publicKey };
  }
  throw new TypeError('generateKey did not return a key pair for an asymmetric algorithm');
}

/** Thu hẹp kết quả `exportKey('jwk', …)` về `JsonWebKey`. */
export function asJsonWebKey(exported: ArrayBuffer | JsonWebKey): JsonWebKey {
  if (Array.isArray(exported) || exported instanceof ArrayBuffer) {
    throw new TypeError('exportKey did not return a JSON Web Key');
  }
  return exported;
}

/** Thu hẹp kết quả `exportKey`/`decrypt`/`sign` về `Uint8Array` cho phép `subarray` + `.byteLength`. */
export function asBytes(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer);
}

/**
 * Thu hẹp kết quả `exportKey(..., 'raw')` về `ArrayBuffer`.
 *
 * Cùng lý do như {@link asJsonWebKey}: Workers khai báo `exportKey` trả union
 * `ArrayBuffer | JsonWebKey` vì đường `'jwk'` trả object còn đường khác trả buffer. Ta kiểm
 * runtime thay vì ép kiểu, nên một đổi API ngoài ý muốn sẽ ném lỗi ngay.
 *
 * @throws {TypeError} khi `exportKey` trả JSON Web Key cho đường `'raw'`.
 */
export function asRawBytes(exported: ArrayBuffer | JsonWebKey): ArrayBuffer {
  if (!(exported instanceof ArrayBuffer)) {
    throw new TypeError('exportKey did not return raw bytes for a non-JWK format');
  }
  return exported;
}
