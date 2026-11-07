/**
 * Digest và phân loại lý do quarantine cho một Queue command bị reject.
 *
 * Nguồn canonical: `docs/applications/transactional-mailer-job/03-operations.md` §3.1
 * (bản ghi quarantine đã sanitize) và `01-architecture.md` §13 (security boundary).
 *
 * ## Vì sao `quarantine_id` là HMAC chứ không phải hash trần
 *
 * Raw body của một command bị reject **có thể chứa secret** — đó chính là lý do các field
 * đó bị cấm (§3.1). SHA-256 trần của một payload như vậy bị brute-force offline được, nên
 * digest ghi xuống database sẽ là một đường rò dữ liệu y hệt giá trị gốc. HMAC với Worker
 * Secret làm digest không đoán lại được từ bên ngoài mà vẫn ổn định (cùng body + cùng key
 * ⇒ cùng id), nên nó vẫn dùng được làm khoá chính tổ hợp cho `ON CONFLICT` mà không trở
 * thành kênh đọc ngược.
 *
 * ## Data policy — file này không có đường thoát để lộ payload
 *
 * {@link computeQuarantineId} băm **đúng byte trên dây** rồi trả digest dạng hex. Nó không
 * log, không trả raw body, không giữ byte đầu vào ở bất kỳ state nào nào.
 * {@link quarantineReasonFor} chỉ nhận *reason* của validator, không nhận payload.
 *
 * ⚠️ **Khoá là Worker Secret `MAIL_QUARANTINE_HMAC_KEY`** — không phải
 * `MAIL_PROVIDER_TOKEN`, cũng không phải credential ký internal-auth: ba secret khác nhau
 * (`01-architecture.md` §13). Ở đây chỉ nhận `keyHex` từ composition root; file này không
 * đọc `env` và không có giá trị default.
 */
import type { MailSendCommandValidationReason } from '@ecoma-io/transactional-mail-contracts';

import { MailJobValidationError, sanitizeFieldName, type QuarantineReason } from './mail-job-model';

/** Tiền tố của `quarantine_id`, phân biệt digest này với mọi định danh khác trong D1. */
export const QUARANTINE_ID_PREFIX = 'qlt_';

/** Số byte hex của `quarantine_id` sau tiền tố — SHA-256 sinh ra đúng 32 byte. */
const QUARANTINE_DIGEST_BYTES = 32;

/** Chiều dài phần hex trong `quarantine_id` — 32 byte × 2 ký tự. */
const QUARANTINE_HEX_LENGTH = QUARANTINE_DIGEST_BYTES * 2;

/** Hình dạng của `quarantine_id`: tiền tố + đúng 64 hex lowercase. */
export const QUARANTINE_ID_PATTERN = /^qlt_[0-9a-f]{64}$/u;

/**
 * Chiều dài tối thiểu của khoá HMAC, tính bằng **byte** (không phải hex character).
 *
 * HMAC-SHA-256 với khoá ngắn hơn 32 byte là mất tính bảo mật trong khi digest vẫn trông bình
 * thường — đúng cái fail-open mà `MAIL_QUARANTINE_HMAC_KEY` (64 hex = 32 byte) sinh ra để
 * tránh. Thiếu khoá thì mọi command reject không tạo được record (§3.1), nên phải chặn ở
 * đây chứ không phải để digest ra một giá trị yếu.
 */
const MIN_HMAC_KEY_BYTES = 32;

const HEX_KEY_PATTERN = /^[0-9a-fA-F]+$/u;

const HEX_DIGITS = '0123456789abcdef';

/**
 * `detail` mà validator gắn cho lý do liên quan tới `delivery_id`.
 *
 * `validateMailSendCommand` đặt `detail` bằng **hằng của contract** cho các lý do nó soi
 * được một tên field (`libs/transactional-mail-contracts/src/mail-command.ts`), không phải
 * dữ liệu từ payload — nên phép so sánh ở {@link quarantineReasonFor} là so với hằng của
 * chính contract, không phải với input của người dùng. Hằng được ghi ở đúng một chỗ và dùng
 * cho cả hai lý do `missing-field`/`wrong-type`.
 */
const DELIVERY_ID_FIELD_NAME = 'delivery_id';

/**
 * Tên field dự phòng cho `forbidden-field` khi key của producer không vượt qua sanitizer.
 *
 * Cần vì `quarantine_forbidden_field_name_check` **bắt buộc** `field_name IS NOT NULL` khi
 * `reason = 'forbidden-field'` (migration `0002`). Giá trị dự phòng là **hằng của worker**,
 * không phải dữ liệu của payload: nó không cho biết gì về nội dung command, và bản ghi vẫn
 * trả lời được câu hỏi mà nó phải trả lời ("command này bị reject vì có field cấm"), trong
 * khi tên key thật là dữ liệu không tin cậy mà ta từ chối ghi.
 */
export const QUARANTINE_UNKNOWN_FIELD_NAME = 'unknown';

/** WebCrypto đúng phần lib này gọi — khai cục bộ thay vì kéo lib `dom` vào tsconfig. */
interface SubtleCryptoLike {
  importKey(
    format: 'raw',
    keyData: Uint8Array,
    algorithm: { readonly name: 'HMAC'; readonly hash: 'SHA-256' },
    extractable: false,
    keyUsages: readonly ['sign'],
  ): Promise<object>;
  sign(algorithm: 'HMAC', key: object, data: Uint8Array): Promise<ArrayBuffer>;
}

/** `TextEncoder` đúng phần lib này gọi — xem {@link SubtleCryptoLike}. */
interface Utf8EncoderLike {
  encode(input: string): Uint8Array;
}

interface TextEncoderConstructorLike {
  new (): Utf8EncoderLike;
}

/**
 * `crypto.subtle` của runtime.
 *
 * Không khai global `crypto` trong lib này: lib `runtime:edge` typecheck với `types: []`
 * và `lib: es2022`, và khai một global từ module application sẽ rò ra mọi consumer của
 * package. Đọc qua `globalThis` giữ đúng phần giao thực có thật của cả Workers lẫn Node
 * (WebCrypto có ở cả hai) và **fail-closed** khi runtime không có: không có đường nào băm
 * thay bằng hash trần, vì hash trần là chính thứ bị loại.
 *
 * @throws {TypeError} Khi runtime không có WebCrypto.
 */
function subtleCrypto(): SubtleCryptoLike {
  const webCrypto = (globalThis as { readonly crypto?: { readonly subtle?: SubtleCryptoLike } })
    .crypto;
  if (webCrypto?.subtle === undefined) {
    throw new TypeError(
      'WebCrypto (globalThis.crypto.subtle) is required to compute a quarantine id',
    );
  }
  return webCrypto.subtle;
}

/**
 * `TextEncoder` của runtime — cùng lý do không khai global như {@link subtleCrypto}.
 *
 * @throws {TypeError} Khi runtime không có `TextEncoder`.
 */
function textEncoder(): Utf8EncoderLike {
  const ctor = (globalThis as { readonly TextEncoder?: TextEncoderConstructorLike }).TextEncoder;
  if (ctor === undefined) {
    throw new TypeError('TextEncoder (globalThis.TextEncoder) is required to encode command bytes');
  }
  return new ctor();
}

/**
 * UTF-8 encode một chuỗi thành byte.
 *
 * Digest phải chạy trên **đúng byte trên dây**, mà raw body của Queue message tới worker là
 * một chuỗi. `JSON.parse` xong rồi `JSON.stringify` lại là một payload khác (thứ tự khoá và
 * whitespace), nên byte phải lấy từ chuỗi gốc chứ không phải từ object đã parse.
 *
 * @param input Chuỗi raw body của Queue message.
 * @returns Byte UTF-8 của chuỗi đó.
 */
export function encodeUtf8(input: string): Uint8Array {
  return textEncoder().encode(input);
}

/** Byte → hex lowercase, mỗi byte thành đúng hai ký tự. */
function toHexLowercase(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += HEX_DIGITS[byte >>> 4] + HEX_DIGITS[byte & 0x0f];
  }
  return hex;
}

/**
 * Hex → byte, fail-closed trên mọi input không phải hex.
 *
 * `Number.parseInt` **không** đủ: nó bỏ qua ký tự không parse được ở cuối
 * (`parseInt('1z', 16) === 1`) và chấp nhận dấu `+`/khoảng trắng ở đầu — hai cách đó biến một
 * khoá sai thành một khoá khác mà không có gì đỏ. Vì vậy ký tự được kiểm bằng pattern trước
 * khi decode.
 *
 * @param keyHex Chuỗi hex khoá HMAC.
 * @param field Tên tham số, dùng trong thông báo lỗi (không nêu giá trị — khoá là secret).
 * @returns Byte của khoá.
 * @throws {MailJobValidationError} Khi chuỗi rỗng, lẻ số ký tự, quá ngắn, hoặc có ký tự ngoài
 * `[0-9a-fA-F]`. Lỗi này xảy ra **trước** khi chạm database.
 */
function decodeHexKey(keyHex: string, field: string): Uint8Array {
  if (keyHex.length === 0 || keyHex.length % 2 !== 0 || !HEX_KEY_PATTERN.test(keyHex)) {
    throw new MailJobValidationError(
      `${field} must be a non-empty hexadecimal string with an even number of characters`,
      'hex-key-malformed',
    );
  }

  const bytes = new Uint8Array(keyHex.length / 2);
  if (bytes.length < MIN_HMAC_KEY_BYTES) {
    throw new MailJobValidationError(
      `${field} must be at least ${MIN_HMAC_KEY_BYTES} bytes (${MIN_HMAC_KEY_BYTES * 2} hex characters)`,
      'hex-key-too-short',
    );
  }

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(keyHex.slice(index * 2, index * 2 + 2), 16);
  }

  return bytes;
}

/**
 * `quarantine_id` của một raw body: HMAC-SHA-256(key, rawBody) dạng hex, có tiền tố.
 *
 * Digest ổn định theo **raw bytes** nên cùng một command bị reject lại sẽ upsert vào đúng một
 * bản ghi (counter tăng) thay vì nhân bản; hai Queue message khác nhau cùng body vẫn là hai
 * bản ghi khác nhau, vì khoá chính của bảng là cặp `(quarantine_id, queue_message_id)`.
 *
 * @param input.keyHex Khoá HMAC dạng hex, ít nhất {@link MIN_HMAC_KEY_BYTES} byte; composition
 * root truyền vào từ Worker Secret.
 * @param input.rawBody Byte thân command **nguyên văn**, lấy từ chuỗi Queue gốc bằng
 * {@link encodeUtf8} — không phải từ object đã parse.
 * @returns {@link QUARANTINE_ID_PREFIX} + 64 ký tự hex lowercase.
 * @throws {MailJobValidationError} Khi `keyHex` không phải hex dài hợp lệ.
 * @throws {TypeError} Khi runtime không có WebCrypto.
 */
export async function computeQuarantineId(input: {
  readonly keyHex: string;
  readonly rawBody: Uint8Array;
}): Promise<string> {
  const subtle = subtleCrypto();
  const key = await subtle.importKey(
    'raw',
    decodeHexKey(input.keyHex, 'quarantineKeyHex'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const mac = await subtle.sign('HMAC', key, input.rawBody);
  const digest = new Uint8Array(mac);
  if (digest.length !== QUARANTINE_DIGEST_BYTES) {
    // SHA-256 không thể trả độ dài khác; nhánh này chỉ để một digest bị cắt ngắn không biến
    // thành `quarantine_id` âm thầm ngắn hơn rồi khớp nhầm với bản ghi khác.
    throw new TypeError(`HMAC-SHA-256 must produce ${QUARANTINE_DIGEST_BYTES} bytes`);
  }

  const id = `${QUARANTINE_ID_PREFIX}${toHexLowercase(digest)}`;
  if (id.length !== QUARANTINE_ID_PREFIX.length + QUARANTINE_HEX_LENGTH) {
    throw new TypeError('quarantine id must be the prefix followed by 64 hex characters');
  }
  return id;
}

/**
 * Map một lý do validation của `validateMailSendCommand` sang `quarantine.reason`.
 *
 * Tập đích là `QUARANTINE_REASON_VALUES` (bốn giá trị, §3.1) trong khi validator có **năm**
 * lý do, nên phép map là nhiều-một và sự mất thông tin là cố ý:
 *
 * - `unparseable` → `unparseable-body`: không có object để soi field nào.
 * - `unsupported-version` → `unsupported-version`: version đọc được nhưng không hỗ trợ.
 * - `forbidden-field` → `forbidden-field`: có tên key cụ thể để điều tra.
 * - `missing-field` / `wrong-type` chỉ thành `missing-delivery-id` khi lỗi nằm ở
 *   `delivery_id`. Thiếu/sai kiểu `version` thuộc `unparseable-body`: command đó không đọc
 *   được như một command, và — quan trọng hơn — nó không được tuyên bố "thiếu delivery id"
 *   khi thực tế ta chưa đọc được id nào.
 *
 * @param validationReason Lý do validator trả về.
 * @param validationDetail `detail` đi kèm — chỉ **tên field của contract** với
 * `missing-field`/`wrong-type`, và key của producer với `forbidden-field`. Truyền
 * `undefined` khi validator không đặt `detail`. Tham số này bắt buộc (dù có thể `undefined`)
 * vì cùng một lý do hợp lệ cho ra hai `reason` khác nhau tuỳ theo `detail`; bỏ nó đi được
 * sẽ biến `missing-field` thành một quyết định im lặng.
 */
export function quarantineReasonFor(
  validationReason: MailSendCommandValidationReason,
  validationDetail: string | undefined,
): QuarantineReason {
  switch (validationReason) {
    case 'unparseable':
      return 'unparseable-body';
    case 'unsupported-version':
      return 'unsupported-version';
    case 'forbidden-field':
      return 'forbidden-field';
    case 'missing-field':
    case 'wrong-type':
      return validationDetail === DELIVERY_ID_FIELD_NAME
        ? 'missing-delivery-id'
        : 'unparseable-body';
  }
}

/**
 * Tên key vi phạm đã sanitize, hoặc `undefined` khi không có tên nào đáng ghi.
 *
 * Chỉ hai nhánh có `detail`: `missing-field`/`wrong-type` với tên field là **hằng của
 * contract**, và `forbidden-field` với key **do producer gửi**. Key của `forbidden-field` là
 * dữ liệu không tin cậy, nên nó đi qua {@link sanitizeFieldName} — hàm này **ném** khi key
 * mang ký tự ngoài tập identifier-ish (`"a b"`, `"a\"b"`, key 200 ký tự).
 *
 * Việc đó **không** được biến thành lỗi xử lý: `reason` đã quyết định đủ để bản ghi hữu ích,
 * còn thiếu tên key chỉ là mất một chi tiết điều tra. Vì vậy lỗi sanitizer bị nuốt và
 * `fieldName` bị bỏ trống thay vì làm một command reject trở thành exception.
 *
 * ⚠️ Nhánh `forbidden-field` vẫn **bắt buộc** có tên: CHECK của schema đòi `field_name IS
 * NOT NULL` cho lý do đó. `processMailCommand` phải thay {@link QUARANTINE_UNKNOWN_FIELD_NAME}
 * vào khi hàm này trả `undefined` — xem `forbiddenFieldName` trong file kia.
 *
 * @param detail `detail` thô từ kết quả validation.
 * @returns Tên field đã kiểm, hoặc `undefined` khi `detail` rỗng/không hợp lệ.
 */
export function optionalSanitizedFieldName(detail: string | undefined): string | undefined {
  if (detail === undefined || detail.length === 0) {
    return undefined;
  }

  try {
    return sanitizeFieldName(detail, 'quarantineFieldName');
  } catch {
    return undefined;
  }
}
