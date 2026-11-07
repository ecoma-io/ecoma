/**
 * Mã hoá at rest cho provider credential bằng WebCrypto AES-256-GCM (`01-architecture.md`
 * §9 loại secret 1, `03-operations.md` §7.3). // gitleaks:allow (regex trúng cụm "secret 1" trong văn bản; không có giá trị nào)
 *
 * ⚠️ **Vì sao WebCrypto chứ không phải `node:crypto`.** Project mang tag `runtime:edge` và
 * `.oxlintrc.json` cấm import builtin Node trong mọi project `runtime:edge`; hơn nữa Worker
 * không có `node:crypto` ở chế độ đó. `globalThis.crypto.subtle` là API duy nhất hiện có ở
 * cả test runner lẫn Workers runtime.
 *
 * ⚠️ **Định dạng ciphertext: `iv (12 byte) ‖ ciphertext ‖ tag (16 byte)` — và phần `iv` là
 * do ta tự ghép.** `crypto.subtle.encrypt` **không** trả IV: output của nó là
 * `ciphertext ‖ tag` (đo được: plaintext 14 byte → output 30 byte), vì WebCrypto coi IV là
 * tham số đầu vào của lệnh, không phải thứ nó tự lưu lại. Nếu không tự ghép IV vào đầu thì
 * `decrypt` không bao giờ lấy lại được IV gốc và **mọi** lần đọc credential đều ném — kể cả
 * ngay sau khi `encrypt` vừa chạy. Do đó `encrypt` ghép `iv` vào trước `sealed`, và `decrypt`
 * cắt đúng 12 byte đầu làm IV rồi mới gọi WebCrypto với phần còn lại.
 *
 * ⚠️ **Thứ tự byte bên trong phần còn lại là của WebCrypto, không phải của ta.** Tag GCM luôn
 * đi **sau** ciphertext và không thể tách ra độc lập (đó là điều làm GCM là AEAD), nên ta
 * không thể ghép `iv ‖ tag ‖ ciphertext` — và cũng không nên: mọi record đã ghi bằng một thứ
 * tự định nghĩa khác sẽ không đọc được sau deploy.
 *
 * ⚠️ Bốn byte đệm nào cũng **không** có: IV dài 12 byte là một phần của ciphertext đã lưu,
 * nên `credential_ciphertext` tự chứa mọi thứ cần để giải mã — không cần một cột IV riêng
 * và không cần một quy ước ngoài D1.
 *
 * ⚠️ **Keyring đọc được theo version trên record, ghi bằng version hiện hành.** Đây là cả nội
 * dung của `K1 active → K2 introduced (read K1+K2, ghi mới dùng K2) → …` (§7.3). Thiếu
 * `defaultVersion` trong `decrypt` là cố ý: một record mã hoá bằng `K1` phải **luôn** đọc bằng
 * `K1`, kể cả sau khi `K2` thành current — nếu không thì toàn bộ credential cũ mất khả năng
 * ký VAPID ngay lúc rotation, đúng kịch bản §7.2 cấm.
 */

import type { CredentialCipher } from '@ecoma-io/push-notification-application';

/** Số byte IV của AES-GCM — đặc tả WebCrypto dùng 96 bit, 12 byte. */
const IV_LENGTH_BYTES = 12;

/** Độ dài khóa AES-256: 32 byte. */
const AES_256_KEY_BYTES = 32;

/** Thông điệp của lỗi giải mã — **không** chứa ciphertext, key hay version. */
const DECRYPT_FAILED =
  'Giải mã credential thất bại: sai khóa, sai version, hoặc ciphertext đã bị can thiệp.';

export interface CredentialCipherOptions {
  /**
   * Root key của từng version, theo **tên version** (`K1`, `K2`, …).
   *
   * ⚠️ Giá trị là **raw bytes của khóa** (32 byte cho AES-256), không phải base64/hex. Việc
   * giải mã base64 là trách nhiệm của composition root — hạ tầng nhận đã phải là key bytes.
   * Nhận chuỗi ở đây sẽ biến "secret sai định dạng" thành một lỗi WebCrypto khó chẩn đoán
   * đúng nguyên nhân.
   */
  readonly keysByVersion: Readonly<Record<string, Uint8Array>>;
  /** Version dùng cho ghi mới — phải có mặt trong `keysByVersion`. */
  readonly currentVersion: string;
}

/**
 * Cipher WebCrypto AES-256-GCM.
 *
 * ⚠️ **Không cache `CryptoKey` theo version trong một module-level singleton.** Cache phải
 * thuộc về **instance** này: composition root tạo cipher từ Worker Secret của môi trường đang
 * chạy, và một cache sống lâu hơn instance sẽ giữ key của môi trường cũ — đúng loại
 * node-local state mà kiến trúc cấm (`AGENTS.md`, "no node-local application state").
 */
export class WebCryptoCredentialCipher implements CredentialCipher {
  readonly #currentVersion: string;
  readonly #keysByVersion: Readonly<Record<string, Uint8Array>>;

  constructor(options: CredentialCipherOptions) {
    if (typeof options.currentVersion !== 'string' || options.currentVersion === '') {
      throw new Error('WebCryptoCredentialCipher: currentVersion là bắt buộc.');
    }
    if (!isRecord(options.keysByVersion) || Object.keys(options.keysByVersion).length === 0) {
      throw new Error('WebCryptoCredentialCipher: phải có ít nhất một root key theo version.');
    }
    const current = options.keysByVersion[options.currentVersion];
    if (current === undefined) {
      // Fail **lúc khởi tạo**, không phải lúc ghi credential đầu tiên. Lúc ghi thì lỗi xảy ra
      // giữa một rotation và đã có credential trong DB cần `K2` nhưng `K2` không có trong
      // keyring — tức mất khả năng ký VAPID khi đang cần nhất.
      throw new Error(
        `WebCryptoCredentialCipher: currentVersion "${options.currentVersion}" không có trong keyring.`,
      );
    }
    for (const [version, key] of Object.entries(options.keysByVersion)) {
      assertKeyLength(version, key);
    }
    this.#currentVersion = options.currentVersion;
    this.#keysByVersion = options.keysByVersion;
  }

  async encrypt(plaintext: string): Promise<{ ciphertext: Uint8Array; version: string }> {
    if (typeof plaintext !== 'string' || plaintext === '') {
      // Một credential rỗng sẽ mã hoá thành một record mà giải mã ra `''`, và sau đó
      // provider handshake fail với một lỗi không truy được về chỗ gốc.
      throw new Error('CredentialCipher.encrypt: plaintext phải là chuỗi không rỗng.');
    }
    const key = await this.#rawKey(this.#currentVersion);
    // IV ngẫu nhiên 12 byte cho **mỗi** lần mã hoá. Dùng IV cố định sẽ phá tan thuộc tính
    // IND-CPA của GCM: hai credential giống nhau cho ra ciphertext giống nhau, và attacker
    // đọc được plaintext nào bằng nhau.
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
    const plaintextBytes = new TextEncoder().encode(plaintext);
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintextBytes);
    // ⚠️ Ghép `iv` vào trước kết quả của WebCrypto. Xem header file: output của
    // `crypto.subtle.encrypt` là `ciphertext ‖ tag` và **không** chứa IV, nên bỏ dòng này
    // thì `decrypt` không lấy lại được IV gốc.
    const ciphertext = new Uint8Array(IV_LENGTH_BYTES + sealed.byteLength);
    ciphertext.set(iv, 0);
    ciphertext.set(new Uint8Array(sealed), IV_LENGTH_BYTES);
    return { ciphertext, version: this.#currentVersion };
  }

  async decrypt(ciphertext: Uint8Array, version: string): Promise<string> {
    if (!(ciphertext instanceof Uint8Array) || ciphertext.length <= IV_LENGTH_BYTES) {
      // Ngắn hơn IV thì chắc chắn là dữ liệu hỏng — không phải "sai khóa". Gọi `subtle.decrypt`
      // với IV quá ngắn sẽ ném `DataError` khó phân biệt với lỗi authentication.
      throw new Error(DECRYPT_FAILED);
    }
    const raw = this.#keysByVersion[version];
    if (raw === undefined) {
      // Version không có trong keyring là một **cấu hình sai**, không phải một credential
      // hỏng — hai lỗi này dẫn tới hai remediation hoàn toàn khác nhau (thêm key vào keyring
      // vs. kiểm tra ciphertext), nên thông điệp phải phân biệt.
      throw new Error(`Giải mã credential thất bại: không có root key cho version "${version}".`);
    }
    const iv = ciphertext.subarray(0, IV_LENGTH_BYTES);
    const body = ciphertext.subarray(IV_LENGTH_BYTES);
    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        await this.#rawKey(version),
        body,
      );
    } catch {
      // `subtle.decrypt` ném `OperationError` khi tag không khớp (sai khóa / can thiệp).
      // Không gắn nguyên nhân vào message: `catch` này không cho biết lỗi của WebCrypto là
      // gì, và báo "sai khóa" khi thực ra là ciphertext hỏng sẽ đưa operator đi sai hướng.
      throw new Error(DECRYPT_FAILED);
    }
    return new TextDecoder().decode(plaintext);
  }

  /** Nhập key thô thành `CryptoKey` **không extractable** — không thể đọc ngược ra bytes. */
  async #rawKey(version: string): Promise<CryptoKey> {
    const material = this.#keysByVersion[version];
    if (material === undefined) {
      throw new Error(`Giải mã credential thất bại: không có root key cho version "${version}".`);
    }
    // Cache theo instance: import lại cùng một key ở mỗi lần ghi là công việc thừa, và
    // `CryptoKey` không giữ secret ra ngoài nên không tạo rủi ro node-local state.
    //
    // ⚠️ Cache **promise** chứ không phải `CryptoKey`: `importKey` là async, nên cache một
    // promise sẽ cho phép hai lời gọi đồng thời dùng chung **một** lần import — đúng điều
    // WebCrypto khuyến nghị, và tránh việc hai Worker-isolate gọi `importKey` lặp lại.
    const cached = this.#imported.get(version);
    if (cached !== undefined) {
      return cached;
    }
    const pending = crypto.subtle
      .importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
      // Một lần import thất bại không được được cache: nếu giữ promise đã reject, mọi lời
      // gọi sau đó nhận lại cùng một lỗi vĩnh viễn, kể cả khi key đã được sửa đúng.
      .catch((error: unknown) => {
        this.#imported.delete(version);
        throw error;
      });
    this.#imported.set(version, pending);
    return pending;
  }

  readonly #imported = new Map<string, Promise<CryptoKey>>();
}

function assertKeyLength(version: string, key: Uint8Array | undefined): void {
  if (!(key instanceof Uint8Array)) {
    throw new Error(`WebCryptoCredentialCipher: root key "${version}" không phải Uint8Array.`);
  }
  if (key.byteLength !== AES_256_KEY_BYTES) {
    throw new Error(
      `WebCryptoCredentialCipher: root key "${version}" phải đúng ${AES_256_KEY_BYTES} byte (AES-256), nhận ${key.byteLength}.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, Uint8Array> {
  return typeof value === 'object' && value !== null;
}
