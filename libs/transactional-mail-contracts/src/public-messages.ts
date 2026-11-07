/**
 * Public API `POST /v1/messages` — contract giữa ứng dụng gọi (consumer) và
 * `transactional-mail` (provider).
 *
 * Nguồn: `docs/applications/transactional-mail/02-requirements.md` FR-001–FR-003 + SR-001
 * (canonical: bảng response 8 trường, error envelope 11 `code`, ví dụ request/response).
 *
 * Lưu ý quan trọng:
 * - `app` trong **request body** bị **bỏ qua** (`02-requirements.md` FR-001 AC:
 *   "`app` truyền trong body bị bỏ qua; `app`/`principal_id` luôn từ authenticated
 *   principal"). Vì vậy validator **không** trả `forbidden-field` cho `app` khi nó xuất
 *   hiện, và cũng **không** kiểm kiểu của nó: FR-001 liệt kê danh sách field phải validate
 *   (bước 3 của thứ tự kiểm tra) và `app` **không** nằm trong đó. `app` không được đưa vào
 *   kết quả validate — nguồn duy nhất của `app` là authenticated principal.
 * - `principal_id` **không** nằm trong danh sách field được phép: nó chỉ đến từ principal.
 * - Không đưa HMAC/secret, rendered email content, provider credential vào contract.
 */

import type { MailMessageStatus } from './shared';
import { MAIL_MESSAGE_STATUS_VALUES, isNonEmptyString } from './shared';

/**
 * `template` trên wire là **tên logical** của template (không phải version), kiểu
 * chuỗi khác rỗng — **không** phải một union đóng.
 *
 * ⚠️ Tập template **không** phải contract đã chốt ở tầng này: service chỉ authorize
 * principal cho "những logical template đã approve cho principal đó"
 * (`02-requirements.md` SR-001) và hiện tại template là **seed**, chưa có admin surface
 * (`01-architecture.md` §10, "CRUD template (Admin API)"). Vì vậy lib cố ý **không**
 * hard-code một danh sách tên template: làm thế sẽ biến một quyết định đang mở thành
 * contract chính thức và sẽ từ chối oan một template hợp lệ mới được seed.
 */
export type MailMessageTemplate = string;

/** Field bắt buộc của request `POST /v1/messages`. */
export const REQUIRED_POST_MESSAGES_REQUEST_FIELDS = ['template', 'recipient'] as const;

/** Field được phép của request `POST /v1/messages`. */
export const ALLOWED_POST_MESSAGES_REQUEST_FIELDS = [
  'template',
  'recipient',
  'locale',
  'variables',
  'correlation_id',
  'app', // bị bỏ qua hoàn toàn per FR-001 (không validate, không đưa vào kết quả)
] as const;

/** Tám trường của response `201`/`200` — closed schema. */
export const POST_MESSAGES_RESPONSE_FIELDS = [
  'id',
  'delivery_id',
  'app',
  'template',
  'template_version',
  'status',
  'created',
  'created_at',
] as const;

/**
 * Request body `POST /v1/messages` sau khi validate.
 *
 * **Không** có `app`: field đó bị bỏ qua (`02-requirements.md` FR-001) và `app`/`principal_id`
 * chỉ đến từ authenticated principal, không bao giờ từ body.
 */
export interface PostMessagesRequest {
  template: MailMessageTemplate;
  recipient: string;
  locale?: string;
  variables?: Record<string, unknown>;
  correlation_id?: string;
}

/** Response 201/200 body. */
export interface PostMessagesResponse {
  id: string;
  delivery_id: string;
  app: string;
  template: MailMessageTemplate;
  template_version: number;
  status: MailMessageStatus;
  /** `true` khi tạo mới (`201`), `false` khi replay idempotent (`200`) — FR-001. */
  created: boolean;
  created_at: string;
}

/** Tên lỗi canonical theo tài liệu. */
export const POST_MESSAGES_ERROR_CODE_VALUES = [
  'unauthorized',
  'forbidden',
  'invalid_request',
  'invalid_recipient',
  'invalid_locale',
  'idempotency_key_conflict',
  'rate_limited',
  'template_not_found',
  'payload_too_large',
  'internal_error',
  'service_unavailable',
] as const;

export type PostMessagesErrorCode = (typeof POST_MESSAGES_ERROR_CODE_VALUES)[number];

export interface PostMessagesErrorBody {
  error: {
    code: PostMessagesErrorCode;
    message: string;
  };
}

/** Lý do validation. */
export type PostMessagesValidationReason =
  | 'missing-field'
  | 'forbidden-field'
  | 'wrong-type'
  | 'invalid-value'
  | 'unparseable';

/** Kết quả validation. */
export interface PostMessagesValidationOk {
  ok: true;
  request: PostMessagesRequest;
}

export interface PostMessagesValidationFail {
  ok: false;
  reason: PostMessagesValidationReason;
  detail?: string;
}

export type PostMessagesValidation = PostMessagesValidationOk | PostMessagesValidationFail;

/** Lý do validation của response. */
export type PostMessagesResponseValidationReason =
  | 'missing-field'
  | 'forbidden-field'
  | 'wrong-type'
  | 'invalid-value'
  | 'unparseable';

export type PostMessagesResponseValidation =
  | { ok: true; response: PostMessagesResponse }
  | { ok: false; reason: PostMessagesResponseValidationReason; detail?: string };

/**
 * Validate response `201`/`200` của `POST /v1/messages`.
 *
 * Closed schema: đúng tám trường trong bảng response (`02-requirements.md` FR-001),
 * không thêm field nào. Trường lạ bị `forbidden-field` để dấu hiệu rò rỉ nội bộ
 * (ví dụ `body`, `recipient_log`, `provider_*`) bị chặn ngay ở contract.
 */
export function validatePostMessagesResponse(payload: unknown): PostMessagesResponseValidation {
  if (!isObject(payload)) {
    return { ok: false, reason: 'unparseable' };
  }
  const obj = payload as Record<string, unknown>;
  const keys = Object.keys(obj);
  for (const k of keys) {
    if (!(POST_MESSAGES_RESPONSE_FIELDS as readonly string[]).includes(k)) {
      return { ok: false, reason: 'forbidden-field', detail: k };
    }
  }
  for (const f of POST_MESSAGES_RESPONSE_FIELDS) {
    if (!(f in obj)) return { ok: false, reason: 'missing-field', detail: f };
  }
  if (!isNonEmptyString(obj.id)) return { ok: false, reason: 'wrong-type', detail: 'id' };
  if (!isNonEmptyString(obj.delivery_id))
    return { ok: false, reason: 'wrong-type', detail: 'delivery_id' };
  if (!isNonEmptyString(obj.app)) return { ok: false, reason: 'wrong-type', detail: 'app' };
  if (!isNonEmptyString(obj.template))
    return { ok: false, reason: 'wrong-type', detail: 'template' };
  if (
    typeof obj.template_version !== 'number' ||
    !Number.isSafeInteger(obj.template_version) ||
    obj.template_version < 1
  ) {
    return { ok: false, reason: 'wrong-type', detail: 'template_version' };
  }
  if (
    typeof obj.status !== 'string' ||
    !(MAIL_MESSAGE_STATUS_VALUES as readonly string[]).includes(obj.status)
  ) {
    return { ok: false, reason: 'invalid-value', detail: 'status' };
  }
  if (typeof obj.created !== 'boolean')
    return { ok: false, reason: 'wrong-type', detail: 'created' };
  if (!isNonEmptyString(obj.created_at))
    return { ok: false, reason: 'wrong-type', detail: 'created_at' };
  return {
    ok: true,
    response: {
      id: obj.id,
      delivery_id: obj.delivery_id,
      app: obj.app,
      template: obj.template,
      template_version: obj.template_version,
      status: obj.status as MailMessageStatus,
      created: obj.created,
      created_at: obj.created_at,
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate `POST /v1/messages` request body.
 * - `app` được phép xuất hiện nhưng **không** gây `forbidden-field` (theo FR-001).
 * - Chỉ reject khi field khác ngoài allowed list (trừ `app` là trường đặc biệt được bỏ qua).
 */
export function validatePostMessagesRequest(payload: unknown): PostMessagesValidation {
  if (!isObject(payload)) {
    return { ok: false, reason: 'unparseable' };
  }
  const obj = payload as Record<string, unknown>;
  const keys = Object.keys(obj);

  // check forbidden: any key not in allowed (treat app as allowed)
  for (const k of keys) {
    if (k === 'app') continue;
    if (!(ALLOWED_POST_MESSAGES_REQUEST_FIELDS as readonly string[]).includes(k)) {
      return { ok: false, reason: 'forbidden-field', detail: k };
    }
  }

  for (const f of REQUIRED_POST_MESSAGES_REQUEST_FIELDS) {
    if (!(f in obj)) return { ok: false, reason: 'missing-field', detail: f };
  }

  if (!isNonEmptyString(obj.template)) {
    return { ok: false, reason: 'wrong-type', detail: 'template' };
  }
  if (!isNonEmptyString(obj.recipient)) {
    return { ok: false, reason: 'wrong-type', detail: 'recipient' };
  }

  if (Object.prototype.hasOwnProperty.call(obj, 'locale') && !isNonEmptyString(obj.locale)) {
    return { ok: false, reason: 'wrong-type', detail: 'locale' };
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'variables')) {
    if (!isObject(obj.variables)) {
      return { ok: false, reason: 'wrong-type', detail: 'variables' };
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(obj, 'correlation_id') &&
    !isNonEmptyString(obj.correlation_id)
  ) {
    return { ok: false, reason: 'wrong-type', detail: 'correlation_id' };
  }
  // `app` KHÔNG được validate: FR-001 nói nó bị bỏ qua, và bước "validate shape" của
  // FR-001 không liệt kê `app`. Kiểm kiểu ở đây sẽ từ chối một request mà tài liệu
  // nói là hợp lệ.

  const req: PostMessagesRequest = {
    template: obj.template,
    recipient: obj.recipient.trim(),
  };
  if (typeof obj.locale === 'string') req.locale = obj.locale.trim();
  if (isObject(obj.variables)) req.variables = obj.variables;
  if (typeof obj.correlation_id === 'string') req.correlation_id = obj.correlation_id.trim();

  return { ok: true, request: req };
}

export function isPostMessagesResponse(value: unknown): value is PostMessagesResponse {
  if (!isObject(value)) return false;
  const v = value as Partial<PostMessagesResponse>;
  if (!isNonEmptyString(v.id)) return false;
  if (!isNonEmptyString(v.delivery_id)) return false;
  if (!isNonEmptyString(v.app)) return false;
  if (!isNonEmptyString(v.template)) return false;
  if (
    typeof v.template_version !== 'number' ||
    !Number.isSafeInteger(v.template_version) ||
    v.template_version < 1
  )
    return false;
  if (
    typeof v.status !== 'string' ||
    !(MAIL_MESSAGE_STATUS_VALUES as readonly string[]).includes(v.status)
  )
    return false;
  if (typeof v.created !== 'boolean') return false;
  if (!isNonEmptyString(v.created_at)) return false;
  return true;
}

export function isPostMessagesErrorBody(value: unknown): value is PostMessagesErrorBody {
  if (!isObject(value)) return false;
  const e = (value as { error?: unknown }).error;
  if (!isObject(e)) return false;
  if (typeof e.code !== 'string') return false;
  if (!(POST_MESSAGES_ERROR_CODE_VALUES as readonly string[]).includes(e.code)) return false;
  if (!isNonEmptyString(e.message)) return false;
  return true;
}
