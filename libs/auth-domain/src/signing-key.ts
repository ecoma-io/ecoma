/**
 * Custody của khoá ký ES256 (FR-023..FR-025).
 *
 * ⚠️ Ba luật mà mọi cài đặt của port này buộc phải theo, và cả ba đều đến từ
 * việc Cloudflare KHÔNG có managed signing service: Secrets Store chỉ có
 * `get()`, trả về một giá trị, không ký được gì. Nên private key phải là thứ
 * `auth` giữ:
 *
 * 1. **KHÔNG sinh ephemeral key lúc mỗi Worker startup.** Một khoá sinh lúc
 *    khởi động nghĩa là mọi instance đều ký bằng khoá khác nhau, JWKS đổi mỗi
 *    lần deploy, và token đã cấu không còn verify được. Tệ hơn: nếu khoá đó
 *    rò ra, nó chỉ sống một đời Worker.
 * 2. **Thiếu secret thì KHÔNG cấp token**, chứ không phải tự sinh khoá để chạy
 *    tiếp. Đây là fail-closed dạng cấu hình.
 * 3. **Private key không được chạm vào log, error, JWKS hay config dump.**
 *
 * `db-auth` chỉ giữ metadata khoá — không giữ private key, theo FR-023.
 *
 * Đây là PORT của tầng domain: hình dạng mà domain/application tiêu thụ (ký,
 * công bố public JWK) — KHÔNG phải cách parse PEM hay nạp `jose`. Việc import
 * khoá là thao tác trên thư viện mã hoá, tức infrastructure; bản cài đặt
 * (`SigningKeyProvider`, đường `importPKCS8`/`exportJWK`) nằm ở
 * `auth-infrastructure` và thực thi đúng interface này.
 */

/** Thuật toán ký duy nhất được chấp nhận. */
export const SIGNING_ALGORITHM = 'ES256' as const;

/** Nhãn `kty` tương ứng. */
export const SIGNING_KEY_TYPE = 'EC' as const;

/** Đường cong duy nhất được chấp nhận: P-256. */
export const SIGNING_CURVE = 'P-256' as const;

/** Metadata khoá ký — thứ DUY NHẤT `db-auth` được giữ về khoá. */
export interface SigningKeyMetadata {
  kid: string;
  alg: typeof SIGNING_ALGORITHM;
  kty: typeof SIGNING_KEY_TYPE;
  crv: typeof SIGNING_CURVE;
  /** Khoá còn dùng để phát hành không. */
  status: 'active' | 'retiring' | 'compromised';
  createdAt: Date;
  notBefore?: Date;
}

/** Public JWK đúng những trường JWKS được phép chứa. */
export interface PublicJwk {
  kty: typeof SIGNING_KEY_TYPE;
  crv: typeof SIGNING_CURVE;
  /** Điểm x/y trên đường cong — công khai theo định nghĩa. */
  x: string;
  y: string;
  alg: typeof SIGNING_ALGORITHM;
  use: 'sig';
  kid: string;
}

/**
 * Port của khoá ký: handle non-extractable để ký + public JWK cho JWKS.
 *
 * ⚠️ Hợp đồng mà tầng domain/application nhìn thấy — thuộc tính bảo mật của
 * nó là một phần của port:
 * - `privateKey()` trả handle **non-extractable** (WebCrypto từ chối export);
 * - `publicJwk()` trả object DỰNG LẠI từ allow-list `{x, y}` — không bao giờ
 *   chứa `d` hay bất kỳ private material nào;
 * - thiếu/sai PEM thì ném `AuthConfigurationError` lúc dựng (fail-closed,
 *   luật 2 ở đầu file), KHÔNG sinh khoá thay thế.
 *
 * Cài đặt tham chiếu: `SigningKeyProvider` ở `auth-infrastructure` (đường
 * `jose.importPKCS8`/`exportJWK` + kiểm hình dạng PEM PKCS#8).
 */
export interface SigningKeyProvider {
  /** `kid` đã ghim — khớp bản ghi metadata trong `db-auth` và trong JWKS. */
  readonly kid: string;

  /**
   * Key handle để ký.
   *
   * ⚠️ Handle này NON-EXTRACTABLE. Đừng "tiện tay" đổi nó thành extractable để
   * lấy JWK — dùng `publicJwk()`.
   */
  privateKey(): Promise<CryptoKey>;

  /**
   * Public JWK cho JWKS.
   *
   * ⚠️ Object trả về được DỰNG LẠI từ allow-list, không phải object mà
   * `exportJWK` trả — đó là chỗ an toàn đến từ.
   */
  publicJwk(): Promise<PublicJwk>;

  /** Alias đọc rõ hơn tại chỗ gọi. */
  key(): Promise<CryptoKey>;
}
