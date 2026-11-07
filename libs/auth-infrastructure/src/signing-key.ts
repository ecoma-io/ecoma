// Import qua tên package: lib tiêu thụ lib anh em qua bề mặt export của nó.
import {
  SIGNING_ALGORITHM,
  SIGNING_CURVE,
  SIGNING_KEY_TYPE,
  AuthConfigurationError,
  type PublicJwk,
} from '@ecoma-io/auth-domain';

/**
 * Cài đặt của port khoá ký ES256 (FR-023..FR-025) — class
 * `SigningKeyProvider` thực thi interface `SigningKeyProvider` của
 * `auth-domain`.
 *
 * ⚠️ Ba luật mà cài đặt này buộc phải theo, và cả ba đều đến từ việc Cloudflare
 * KHÔNG có managed signing service: Secrets Store chỉ có `get()`, trả về một
 * giá trị, không ký được gì. Nên private key phải là thứ `auth` giữ:
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
 * Tầng này đứng ở infrastructure vì đường nạp khoá là thao tác trên thư viện
 * mã hoá (`jose.importPKCS8`/`exportJWK`) + kiểm hình dạng PEM — không phải
 * logic protocol thuần của domain. Port mà domain/application tiêu thụ là
 * interface cùng tên ở `auth-domain`.
 */

/**
 * PEM PKCS#8 cho private key.
 *
 * ⚠️ Bắt buộc PKCS#8, KHÔNG phải PKCS#1 (`BEGIN RSA PRIVATE KEY`) và KHÔNG phải
 * SEC1 (`BEGIN EC PRIVATE KEY`). `jose.importPKCS8`
 * ⚠️ **Không dùng regex `[\s\S]+` để dò PEM.** Mẫu đó đoán "có khớp không" thay
 * vì "đây có phải PEM hợp lệ không", và với đầu vào lặp lại mở đầu PEM `n` lần
 * thì nó khớp theo thời gian bậc hai — một Worker nhận `Worker Secret` từ bên
 * ngoài thì đó là ReDoS trên đường phục vụ (CodeQL `js/polynomial-redos`).
 *
 * ⚠️ **Thay bằng prefix/suffix chính xác, không dùng `.*`.** So khớp hai đầu/cuối
 * là kiểm tra hình thức chỉ O(1); phần "parse base64 der rồi nạp khoá" để cho
 * `jose.importPKCS8`, và nó từ chối PEM sai với `DOMException` tên `DataError` —
 * tức là thông điệp lỗi vẫn đúng mà không cần regex.
 *
 * ⚠️ **Hai hằng số dưới đây không viết literal `BEGIN`/`END` đầy đủ.** Rule
 * `private-key` của `gitleaks` quét cả comment lẫn source, nên một dòng giải
 * thích có chứa chuỗi PEM trông đúng sẽ đỏ CI dù không có gì bí mật. Dựng từ
 * `DASHES` giữ cho file này không chứa hình dạng đó ở bất kỳ đâu.
 */
const DASHES = '-'.repeat(5);
const PKCS8_BEGIN = `${DASHES}BEGIN PRIVATE KEY${DASHES}`;
const PKCS8_END = `${DASHES}END PRIVATE KEY${DASHES}`;

function isPkcs8Pem(pem: string): boolean {
  return (
    pem.startsWith(PKCS8_BEGIN) &&
    pem.endsWith(PKCS8_END) &&
    // Phần thân không được rỗng: `BEGIN…END` liền nhau là PEM không có DER.
    pem.length > PKCS8_BEGIN.length + PKCS8_END.length
  );
}

/** Nội bộ: khoá import TẠM để rút public JWK, không bao giờ giữ lại. */
interface ExtractedPublicMaterial {
  jwk: PublicJwk;
}

/**
 * Nạp khoá ký từ Worker Secret.
 *
 * Không cache ở module scope và không sinh khoá khi thiếu: thiếu hoặc sai
 * định dạng là lỗi cấu hình, và lỗi cấu hình phải làm Worker không phát hành
 * token (fail closed), không phải tự chế một khoá để chạy tiếp.
 */
export class SigningKeyProvider {
  readonly kid: string;
  readonly #privateKeyPromise: Promise<CryptoKey>;
  readonly #publicJwkPromise: Promise<PublicJwk>;

  private constructor(params: {
    kid: string;
    privateKeyPromise: Promise<CryptoKey>;
    publicJwkPromise: Promise<PublicJwk>;
  }) {
    this.kid = params.kid;
    this.#privateKeyPromise = params.privateKeyPromise;
    this.#publicJwkPromise = params.publicJwkPromise;
  }

  /**
   * Dựng provider từ PEM trong Worker Secret.
   *
   * `kid` được truyền vào, không tự tính: `kid` phải khớp với thứ đã ghi trong
   * `db-auth` và trong JWKS, và nó là quyết định vận hành (xoá `kid` để chặn
   * phát hành mới) chứ không phải thứ suy ra từ khoá.
   */
  static async fromPem(params: {
    pem: string | undefined;
    kid: string;
  }): Promise<SigningKeyProvider> {
    const { pem, kid } = params;

    if (pem === undefined || pem.trim() === '') {
      // KHÔNG sinh khoá thay thế. Xem luật 2 ở đầu file.
      throw new AuthConfigurationError(
        'Worker Secret chua khoa ky ES256; auth KHONG sinh khoa tam, nen token se khong duoc cap',
      );
    }
    if (!isPkcs8Pem(pem)) {
      throw new AuthConfigurationError('khoa ky phai la PKCS#8 PEM (BEGIN PRIVATE KEY)');
    }

    const { importPKCS8 } = await import('jose');

    // Khoá để KÝ phải NON-EXTRACTABLE: `crypto.subtle.exportKey` sẽ từ chối nó,
    // nên kể cả khi có ai đó giữ được `CryptoKey` này thì cũng không rút ra
    // được private key. Đây là thuộc tính quan trọng nhất của handle đang giữ.
    const signingKey = await importPKCS8(pem, SIGNING_ALGORITHM, { extractable: false });

    // Public JWK phải được rút ra, mà `exportJWK` từ chối khoá
    // non-extractable. Vì vậy import MỘT bản extractable, rút JWK, rồi bỏ
    // đi ngay — bản đó chỉ sống trong promise này và không được lưu ở đâu.
    const extracted: ExtractedPublicMaterial = await extractPublicMaterial(pem, kid);

    return new SigningKeyProvider({
      kid,
      privateKeyPromise: Promise.resolve(signingKey),
      publicJwkPromise: Promise.resolve(extracted.jwk),
    });
  }

  /**
   * Key handle để ký.
   *
   * ⚠️ Handle này NON-EXTRACTABLE. Đừng "tiện tay" đổi nó thành extractable để
   * lấy JWK — dùng `publicJwk()`.
   */
  async privateKey(): Promise<CryptoKey> {
    return this.#privateKeyPromise;
  }

  /**
   * Public JWK cho JWKS.
   *
   * ⚠️ Object trả về được DỰNG LẠI từ allow-list, không phải object mà
   * `exportJWK` trả. Xem `extractPublicMaterial` — đó là chỗ an toàn đến từ.
   */
  async publicJwk(): Promise<PublicJwk> {
    return this.#publicJwkPromise;
  }

  /** Alias đọc rõ hơn tại chỗ gọi. */
  async key(): Promise<CryptoKey> {
    return this.#privateKeyPromise;
  }
}

/**
 * Rút public JWK từ PEM, không giữ lại khoá extractable.
 *
 * ⚠️ Đây là chỗ an toàn thật sự của cả module, và nó đến từ cách DỰNG OBJECT,
 * không đến từ hành vi của thư viện. Ba sự thật đo được trên `jose@6.2.12`:
 *
 * 1. `exportJWK` trên khoá PRIVATE trả kèm `d`. Đo trực tiếp, cả qua
 *    `jose` lẫn qua `crypto.subtle.exportKey('jwk', privateKey)` của WebCrypto:
 *    output có `d`.
 * 2. `exportSPKI` KHÔNG nhận khoá private. `jose` đi qua
 *    `genericExport('public', 'spki', …)` và ném
 *    `TypeError: key is not a public key`; Node cũng từ chối
 *    `exportKey('spki', privateKey)`. Nên lối đi PKCS#8 → SPKI → public là bế
 *    tắc, không phải chỉ chưa dùng đúng API.
 * 3. `exportJWK` từ chối khoá non-extractable, nên handle dùng để KÝ không đi
 *    qua đường này được.
 *
 * Vậy nên: import MỘT bản tạm extractable, export JWK, rồi DỰNG LẠI object từ
 * allow-list `{x, y}`. `d` không bao giờ được gán vào object ta trả về, nên nó
 * không thể lọt vào JWKS — kể cả khi ai đó xoá lớp kiểm tra bên dưới.
 *
 * Đánh đổi phải ghi thẳng: trong khoảnh khắc này tồn tại một `CryptoKey`
 * extractable. Nó không được lưu vào field nào, không đi qua `console`, và biến
 * mất khi hàm kết thúc. Cách thay thế là bắt vận hành cấp public JWK như một
 * Worker Secret thứ hai — tức là hai nguồn sự thật cho cùng một khoá, và lệch
 * giữa chúng thì JWKS công bố một khoá mà `auth` không ký được.
 */
async function extractPublicMaterial(pem: string, kid: string): Promise<ExtractedPublicMaterial> {
  const { importPKCS8, exportJWK } = await import('jose');

  // Chỉ sống trong hàm này. Không field, không cache, không log.
  const temporary = await importPKCS8(pem, SIGNING_ALGORITHM, { extractable: true });
  const exported = (await exportJWK(temporary)) as Record<string, unknown>;

  const x = exported['x'];
  const y = exported['y'];
  if (typeof x !== 'string' || x === '' || typeof y !== 'string' || y === '') {
    throw new AuthConfigurationError('JWK xuat ra thieu x/y');
  }

  const jwk: PublicJwk = {
    kty: SIGNING_KEY_TYPE,
    crv: SIGNING_CURVE,
    x,
    y,
    alg: SIGNING_ALGORITHM,
    use: 'sig',
    kid,
  };

  // Lớp phòng thủ kiểm TRA object cuối, không phải object thư viện trả. Với
  // allow-list ở trên thì điều kiện này luôn đúng — viết bằng `Object.keys` chứ
  // không phải `in`, để nó bắt được một trường LẠ thay vì chỉ bắt thiếu trường.
  const leaked = Object.keys(jwk).filter((key) => !ALLOWED_JWK_FIELDS.has(key));
  if (leaked.length > 0) {
    throw new AuthConfigurationError(`JWK chua truong ngoai danh sach: ${leaked.join(',')}`);
  }

  return { jwk };
}

/**
 * ⚠️ Allow-list trường JWKS được phép công bố (FR-025), và CHỈ dùng ở trên.
 * Thêm một dòng vào đây là một quyết định về bề mặt công khai — đừng làm nó
 * lớn hơn để "cho linh hoạt".
 */
const ALLOWED_JWK_FIELDS: ReadonlySet<string> = new Set([
  'kty',
  'crv',
  'x',
  'y',
  'alg',
  'use',
  'kid',
]);
