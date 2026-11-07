/**
 * Tầng 1 của canonical serialization profile `v1` + **HMAC-SHA-256 có khoá** (FR-002).
 *
 * ⚠️ `request_fingerprint` **không** phải hash trần. `variables` chứa giá trị entropy thấp (OTP 6
 * chữ số, mã reset ngắn, `recipient` đoán được nếu attacker biết `principal_id`); với hash trần,
 * kẻ đọc được D1 `mail` hoặc một bản backup rò rỉ có thể brute-force offline đúng tập giá trị nhỏ
 * đó và biến cột này thành oracle xác nhận giá trị đoán. HMAC chỉ bảo vệ khi khoá **không** nằm
 * cùng nơi với dữ liệu — nó **không** bảo vệ trước kẻ có cả D1 và Worker Secret, và **không**
 * loại bỏ được kênh xác nhận online qua `200`/`409` (đánh đổi đã chốt ở FR-002).
 *
 * Khoá là Worker Secret của `transactional-mail`, **không tái sử dụng**: khác khoá HMAC của
 * private-interface authentication, khác provider credential của `transactional-mailer-job`.
 * `transactional-mailer-job` không có khoá này và không thể tính fingerprint.
 *
 * ⚠️ Module này **không** tự quyết định keyring: `computeRequestFingerprint` nhận `keyHex`
 * của version hiện tại từ caller và luôn ghi đúng hai tag `p1.k1:`. Keyring (tra cứu version
 * khoá theo tiền tố, giữ khoá cũ cho verify, `503` khi tag lạ) là việc của tầng trên — ở đây
 * chỉ có **một** profile và **một** version khoá khi **tạo**. Phía **verify replay**,
 * {@link parseStoredFingerprintTag}/{@link verifyStoredRequestFingerprint} đọc tag từ giá trị
 * đã persist và tính lại HMAC bằng khoá do caller tra từ keyring — vậy nên rotation không phá
 * một replay hợp lệ (FR-002, mục keyring).
 */

import { JcsUnsupportedValueError, jcsCanonicalize } from './jcs';

/**
 * Khai báo global tối thiểu cho hai API WHATWG mà file này dùng: WebCrypto và `TextEncoder`.
 *
 * ⚠️ **Vì sao khai ở đây chứ không dùng `@cloudflare/workers-types`:** lib mang tag
 * `runtime:universal` — cam kết chạy được trên cả Cloudflare Workers lẫn Node (vitest chạy trên
 * Node). Type dưới global Workers sẽ cho qua cả API Workers-only và code vô hạn được chấp nhận
 * trong khi chết lúc chạy Node. Khai đúng phần dùng là ràng buộc chặt nhất.
 *
 * Khai ở **phạm vi module** (file này là module) nên nó che global chứ không đụng đến file khác.
 */
declare const crypto: {
  readonly subtle: {
    importKey(
      format: string,
      keyData: Uint8Array,
      algorithm: { readonly name: string; readonly hash: string },
      extractable: boolean,
      usages: readonly string[],
    ): Promise<object>;
    sign(algorithm: string, key: object, data: Uint8Array): Promise<ArrayBuffer>;
  };
};

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

/** Tag của **profile canonical** (`v1` ở tầng 1 của FR-002). */
export const FINGERPRINT_PROFILE_PREFIX = 'p1';

/** Tag của **version khoá HMAC** — tách biệt và độc lập với profile. */
export const FINGERPRINT_KEY_TAG = 'k1';

/**
 * Chuỗi canonical tầng 1 (FR-002, `_Tầng 1 — chuỗi canonical request`).
 *
 * Ghép **bốn** trường theo **đúng thứ tự**, mỗi trường có tiền tố **độ dài byte UTF-8** thập
 * phân để hai tổ hợp đầu vào khác nhau **không thể** trùng chuỗi.
 *
 * ⚠️ `jcsVariables` là **canonical bytes sẵn có** (output của `jcsCanonicalize`), không phải
 * object — hàm này không JCS-hoá lần nữa, nên `canonicalRequestString` là hàm thuần và test
 * ghim được đúng chuỗi byte.
 */
export function canonicalRequestString(input: {
  readonly template: string;
  readonly locale: string;
  readonly recipient: string;
  readonly jcsVariables: string;
}): string {
  return (
    `v1\n${utf8ByteLength(input.template)}:${input.template}\n` +
    `${utf8ByteLength(input.locale)}:${input.locale}\n` +
    `${utf8ByteLength(input.recipient)}:${input.recipient}\n` +
    `${utf8ByteLength(input.jcsVariables)}:${input.jcsVariables}\n`
  );
}

/** Thành phần tạo fingerprint — đều là giá trị **đã chuẩn hoá** (FR-002). */
export interface ComputeRequestFingerprintInput {
  /** Khoá fingerprint dạng hex; key `current` của keyring, không phải khoá của row đang đọc. */
  readonly keyHex: string;
  /**
   * Tag version khoá ghi vào prefix (ví dụ `k2` sau rotation). Bỏ trống ⇒ `k1`: một caller
   * không biết keyring vẫn được ghim về version đầu tiên thay vì đoán. Caller không được tự
   * ghép prefix — prefix do hàm này sinh là thứ parse được bằng
   * {@link parseStoredFingerprintTag}.
   */
  readonly keyTag?: string;
  readonly template: string;
  readonly locale: string;
  readonly recipient: string;
  readonly variables: Record<string, unknown>;
}

/**
 * Kết quả tính fingerprint.
 *
 * `non_finite_number` là nhánh **bắt buộc**, không phải defensive coding: FR-002 chốt rằng
 * `NaN`/`±Infinity` phải bị validation từ chối **trước** khi tính fingerprint và **không** được
 * fallback về `null`. Ở v1 tầng shape (`validateRequestShapeVariables`) đã chặn trước rồi, nhưng
 * hàm vẫn tự bảo vệ để một đường gọi mới không lọt — và để lỗi hiện ra **tại đây** thay vì trở
 * thành fingerprint của dữ liệu sai.
 */
export type ComputeRequestFingerprintResult =
  | {
      readonly ok: true;
      readonly value: `${typeof FINGERPRINT_PROFILE_PREFIX}.${string}:${string}`;
    }
  | { readonly ok: false; readonly reason: 'non_finite_number' };

/**
 * Tính `HMAC-SHA-256(k_fingerprint, canonical_request)` dạng hex, gắn tiền tố profile + version
 * khoá.
 *
 * KHÔNG đưa vào fingerprint: template version do server chọn, `correlation_id`, mọi tracing
 * metadata, `principal_id`/`Idempotency-Key` (hai cái cuối là scope/key ở tầng uniqueness, không
 * phải nội dung request).
 */
export async function computeRequestFingerprint(
  input: ComputeRequestFingerprintInput,
): Promise<ComputeRequestFingerprintResult> {
  let jcsVariables: string;

  try {
    jcsVariables = jcsCanonicalize(input.variables);
  } catch (error) {
    /**
     * Chỉ `JcsUnsupportedValueError` là nhánh đã biết (`non_finite_number`). Lỗi khác — ví dụ
     * khoá hex sai độ dài — là **lỗi cấu hình** và phải nổi lên để caller map `503`, không được
     * đóng gói thành `400` của caller.
     */
    if (error instanceof JcsUnsupportedValueError && error.message === 'non_finite_number') {
      return { ok: false, reason: 'non_finite_number' };
    }

    throw error;
  }

  const canonicalRequest = canonicalRequestString({
    template: input.template,
    locale: input.locale,
    recipient: input.recipient,
    jcsVariables,
  });

  const key = await crypto.subtle.importKey(
    'raw',
    hexToBytes(input.keyHex),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(canonicalRequest),
  );

  return {
    ok: true,
    value: `${FINGERPRINT_PROFILE_PREFIX}.${input.keyTag ?? FINGERPRINT_KEY_TAG}:${bytesToHex(
      new Uint8Array(signature),
    )}`,
  };
}

/** Số **byte UTF-8** của chuỗi, viết dạng thập phân ASCII khi ghép canonical request. */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Hai tag đọc được từ tiền tố của một giá trị `request_fingerprint` đã persist
 * (`<profileTag>.<keyTag>:<64 hex>` — ví dụ `p1.k1`).
 */
export interface StoredFingerprintTag {
  readonly profileTag: string;
  readonly keyTag: string;
}

/**
 * Tách hai tag khỏi tiền tố của một giá trị fingerprint **đã lưu** (FR-002, mục keyring:
 * "Replay đọc row … lấy hai tag từ tiền tố").
 *
 * Hàm này **không** quyết định tag nào hợp lệ — profile `p1`/key `k1` có thể đã rời keyring
 * (xoá khoá cũ trước khi hết retention là lỗi vận hành, nhưng vẫn phải fail-closed `503`
 * thay vì `409`). Nó chỉ parse **hình thức**: thiếu `.`/`:`, đoạn hex ngắn hơn 64, hay ký tự
 * không phải hex đều là một giá trị lưu hỏng — không thể verify bằng khoá nào cả, và caller
 * map sang `503` như mọi nhánh "không verify được" khác (FR-002 chốt: `503`, không `409`,
 * không fallback hash trần).
 *
 * Chấp nhận hex hoa **ở đây** (khác `FINGERPRINT_KEY_HEX` của config chặn hoa): giá trị lưu
 * do chính service này sinh ra luôn lowercase, nhưng một giá trị hỏng phải đi đúng nhánh
 * fail-closed thay vì lọt qua một quy tắc thứ hai — parse hình thức là một lớp, quy tắc
 * keyring là lớp khác.
 */
export function parseStoredFingerprintTag(stored: string): StoredFingerprintTag | null {
  const tagSeparator = stored.indexOf('.');
  const valueSeparator = stored.indexOf(':');

  if (tagSeparator < 0 || valueSeparator < tagSeparator + 1) {
    return null;
  }

  const profileTag = stored.slice(0, tagSeparator);
  const keyTag = stored.slice(tagSeparator + 1, valueSeparator);
  const hex = stored.slice(valueSeparator + 1);

  if (profileTag.length === 0 || keyTag.length === 0 || !/^[0-9a-fA-F]{64}$/u.test(hex)) {
    return null;
  }

  return { profileTag, keyTag };
}

/**
 * Ghép lại tag dạng `<profileTag>.<keyTag>` — khoá của keyring config.
 *
 * `parseStoredFingerprintTag` tách một giá trị lưu thành hai thành phần; hàm này là chiều
 * ngược lại, cho phép caller so một tag đã đọc với entry của keyring mà không tự nối chuỗi
 * (một caller tự nối là một chuẩn hoá thứ hai có thể lệch — đúng thứ FR-002 cấm).
 */
export function fingerprintProfileKeyTag(
  tag: Pick<StoredFingerprintTag, 'profileTag' | 'keyTag'>,
): string {
  return `${tag.profileTag}.${tag.keyTag}`;
}

/**
 * Verify một fingerprint **đã lưu** bằng đúng khoá của tag nó mang (FR-002 — replay sau
 * rotation).
 *
 * Điểm khác {@link computeRequestFingerprint}: hàm đó **luôn** dùng `k1` current và **luôn**
 * ghi tag mới; hàm này nhận sẵn tag đã đọc từ row và **khoá tương ứng do caller tra từ
 * keyring** — module này vẫn không biết keyring (JSDoc đầu file), caller là tầng idempotency
 * của use case.
 *
 * Cùng một canonical request được dựng lại từ **bốn** trường đã chuẩn hoá của request hiện
 * tại; HMAC được tính bằng khoá của row rồi so **chuỗi** với giá trị lưu. Sai một bit hex
 * cũng là lệch — không có đường "gần đúng".
 *
 * @throws {Error} Khi `keyHex` không decode được (lỗi cấu hình — caller phải để nó nổi lên
 *   thành `503`, không được bắt thành `409`).
 */
export async function verifyStoredRequestFingerprint(input: {
  /** Giá trị `request_fingerprint` **nguyên văn** đọc từ row — đối chiếu đích. */
  readonly stored: string;
  /** Tag đọc từ {@link parseStoredFingerprintTag} — profile + version khoá của row. */
  readonly storedTag: StoredFingerprintTag;
  /** Hex của khoá tương ứng tag trên, tra từ keyring của config; sai hex sẽ ném. */
  readonly keyHex: string;
  /** Bốn trường **đã chuẩn hoá** của request hiện tại — cùng đầu vào lúc tạo. */
  readonly template: string;
  readonly locale: string;
  readonly recipient: string;
  readonly variables: Record<string, unknown>;
}): Promise<boolean> {
  let jcsVariables: string;

  try {
    jcsVariables = jcsCanonicalize(input.variables);
  } catch (error) {
    // Một request hiện tại không canonicalize được không thể khớp một row đã lưu: row đó
    // được tạo từ một canonical string thật. `lone_surrogate`/`non_finite_number` — cả hai
    // đều là "không trùng", không phải lỗi verify.
    if (error instanceof JcsUnsupportedValueError) {
      return false;
    }
    throw error;
  }

  const canonicalRequest = canonicalRequestString({
    template: input.template,
    locale: input.locale,
    recipient: input.recipient,
    jcsVariables,
  });

  const key = await crypto.subtle.importKey(
    'raw',
    hexToBytes(input.keyHex),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(canonicalRequest),
  );

  const computed = `${fingerprintProfileKeyTag(input.storedTag)}:${bytesToHex(
    new Uint8Array(signature),
  )}`;

  return computed === input.stored;
}

/**
 * Hex → bytes.
 *
 * `keyHex` là **Worker Secret** của service, không phải input của caller; hàm **ném** khi nó sai
 * (độ dài lẻ, ký tự ngoài `[0-9a-fA-F]`) thay vì âm thầm cho qua — một khoá sai sẽ ra fingerprint
 * sai một cách im lặng, đúng loại correctness bug mà FR-002 yêu cầu fail closed.
 */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/u.test(hex)) {
    throw new Error('invalid_fingerprint_key_hex');
  }

  const bytes = new Uint8Array(hex.length / 2);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}

/** Bytes → hex chữ thường, mỗi byte đúng 2 ký tự. */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
