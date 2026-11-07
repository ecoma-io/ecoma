/**
 * Queue command `mail.send` — canonical contract giữa `transactional-mail` (producer)
 * và `transactional-mailer-job` (consumer).
 *
 * Nguồn duy nhất: `docs/applications/transactional-mail/01-architecture.md` §5
 * ("Command contract: `{ version, delivery_id }` — chỉ hai field").
 *
 * ⚠️ Command là **wake-up signal**, không phải authorization token. Không bao giờ đưa
 * `dispatch_generation` vào command body. Mọi field khác ngoài `version` và `delivery_id`
 * đều bị cấm (`forbidden-field`).
 *
 * `delivery_id` phải là non-empty string. **Không** hard-code tiền tố `dlv_` tại đây:
 * ID strategy vẫn là quyết định mở (`docs/architecture/01-architecture.md` §10) — việc
 * thêm ràng buộc tiền tố sẽ biến một quyết định đang mở thành contract chính thức.
 * Nếu cần, consumer sẽ quarantine với lý do `forbidden-field`/`missing-delivery-id`
 * theo chính sách vận hành hiện hành.
 */

export const MAIL_COMMAND_VERSION = 1 as const;

/** Loại version của Queue command. */
export type MailCommandVersion = typeof MAIL_COMMAND_VERSION;

/**
 * Command shape trên wire.
 * Chỉ `version` (number, === 1) và `delivery_id` (non-empty string).
 */
export interface MailSendCommand {
  version: MailCommandVersion;
  delivery_id: string;
}

/** Tên field được phép trong command. */
export const ALLOWED_MAIL_SEND_COMMAND_FIELDS = ['version', 'delivery_id'] as const;

/** Tập field bắt buộc trong command. */
export const REQUIRED_MAIL_SEND_COMMAND_FIELDS = ['version', 'delivery_id'] as const;

/**
 * Kiểm tra nhanh một field có thuộc command hay không.
 */
export function isAllowedMailSendCommandField(
  field: string,
): field is (typeof ALLOWED_MAIL_SEND_COMMAND_FIELDS)[number] {
  return field === 'version' || field === 'delivery_id';
}

/**
 * Lý do validation thất bại của command.
 * - `missing-field`: thiếu field bắt buộc
 * - `unsupported-version`: version không hợp lệ (không phải number === 1)
 * - `forbidden-field`: payload chứa field không được phép (kể cả field lạ)
 * - `wrong-type`: kiểu field sai
 * - `unparseable`: không parse được JSON/object
 */
export type MailSendCommandValidationReason =
  | 'missing-field'
  | 'unsupported-version'
  | 'forbidden-field'
  | 'wrong-type'
  | 'unparseable';

/**
 * Kết quả validation thành công.
 */
export interface MailSendCommandValidationOk {
  ok: true;
  command: MailSendCommand;
}

/**
 * Kết quả validation thất bại.
 */
export interface MailSendCommandValidationFail {
  ok: false;
  reason: MailSendCommandValidationReason;
  /** Tên field liên quan (ví dụ: 'version', 'delivery_id', 'metadata'). Chỉ tên field, không giá trị. */
  detail?: string;
}

/**
 * Discriminated union kết quả validate MailSendCommand.
 */
export type MailSendCommandValidation = MailSendCommandValidationOk | MailSendCommandValidationFail;

/**
 * Validate `MailSendCommand` theo đúng thứ tự ưu tiên:
 * 1. `unparseable` — không phải object thuần túy
 * 2. `forbidden-field` — phát hiện field khác ngoài {version, delivery_id} (ưu tiên trước missing-field)
 * 3. `missing-field` — thiếu version hoặc delivery_id
 * 4. `wrong-type` — kiểu sai
 * 5. `unsupported-version` — version !== 1 (hoặc không phải number)
 *
 * Thứ tự này giúp worker có thể quarantine đúng lý do mà tài liệu quy định
 * (`docs/applications/transactional-mailer-job/03-operations.md` §3 liệt kê
 * `missing-delivery-id`, `unparseable-body`, `unsupported-version`, `forbidden-field`).
 */
export function validateMailSendCommand(payload: unknown): MailSendCommandValidation {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'unparseable' };
  }

  const obj = payload as Record<string, unknown>;
  const keys = Object.keys(obj);

  // 1) Forbidden fields first (closed schema)
  for (const k of keys) {
    if (!isAllowedMailSendCommandField(k)) {
      return { ok: false, reason: 'forbidden-field', detail: k };
    }
  }

  // 2) Required fields
  if (!Object.prototype.hasOwnProperty.call(obj, 'version')) {
    return { ok: false, reason: 'missing-field', detail: 'version' };
  }
  if (!Object.prototype.hasOwnProperty.call(obj, 'delivery_id')) {
    return { ok: false, reason: 'missing-field', detail: 'delivery_id' };
  }

  // 3) Types
  if (typeof obj.version !== 'number') {
    return { ok: false, reason: 'wrong-type', detail: 'version' };
  }
  if (typeof obj.delivery_id !== 'string') {
    return { ok: false, reason: 'wrong-type', detail: 'delivery_id' };
  }

  // 4) Version constraint
  if (obj.version !== MAIL_COMMAND_VERSION) {
    return { ok: false, reason: 'unsupported-version', detail: 'version' };
  }

  const deliveryId = obj.delivery_id.trim();
  if (deliveryId.length === 0) {
    // delivery_id phải non-empty; worker có thể map thành 'missing-delivery-id' theo ops
    return { ok: false, reason: 'missing-field', detail: 'delivery_id' };
  }

  return {
    ok: true,
    command: {
      version: MAIL_COMMAND_VERSION,
      delivery_id: deliveryId,
    },
  };
}

/**
 * Type guard: kiểm tra nhanh một object có đúng shape MailSendCommand (sau khi đã validate).
 */
export function isMailSendCommand(value: unknown): value is MailSendCommand {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const v = value as Partial<MailSendCommand>;
  return (
    v.version === MAIL_COMMAND_VERSION &&
    typeof v.delivery_id === 'string' &&
    v.delivery_id.trim().length > 0
  );
}
