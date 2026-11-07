/**
 * Private delivery interface — `transactional-mailer-job` → `transactional-mail`
 * (internal, gọi qua Service Binding + internal-auth).
 *
 * Nguồn: `docs/applications/transactional-mail/01-architecture.md` §7.2.
 * - `GET /internal/deliveries/:delivery_id`: trả về envelope `{message, dispatch_generation}`
 * - `POST /internal/deliveries/:delivery_id/outcome`: nhận `{outcome, error_class?, dispatch_generation}`
 *   và trả `{result: 'applied'|'duplicate'|'stale', status}` — thêm `current_dispatch_generation`
 *   khi `result = 'stale'`. Wire shape canonical ở `01-architecture.md` §6.2.2.
 *
 * ⚠️ Contract này chỉ mô tả **shape trên wire**. Việc `error_class` có được phép khi
 * `outcome = 'blocked'` hay cấm trong trường hợp "budget-B blocked sends" là quy tắc
 * nghiệp vụ vận hành (FR-007 mailer-job/02) — validator ở tầng contract chỉ kiểm tra
 * kiểu/field được phép, không áp đặt toàn bộ quy tắc nghiệp vụ trừ khi tài liệu đã
 * **chốt** một cách rõ ràng.
 */

import type { MailContentType, MailErrorClass, MailMessageStatus, MailOutcome } from './shared';
import {
  MAIL_CONTENT_TYPE,
  MAIL_ERROR_CLASS_VALUES,
  MAIL_MESSAGE_STATUS_VALUES,
  MAIL_OUTCOME_VALUES,
  OUTCOME_RESULT_VALUES,
  isNonEmptyString,
  isPositiveSafeInteger,
} from './shared';

/** `DeliveryMessage` trong envelope GET. */
export interface DeliveryMessage {
  delivery_id: string;
  message_id: string;
  app: string;
  status: MailMessageStatus;
  recipient: string;
  subject: string;
  body: string;
  content_type: MailContentType;
}

/** Response của `GET /internal/deliveries/:delivery_id`. */
export interface GetDeliveryResponse {
  message: DeliveryMessage;
  dispatch_generation: number;
}

/** Request body của `POST /internal/deliveries/:delivery_id/outcome`. */
export interface PostDeliveryOutcomeRequest {
  outcome: MailOutcome;
  error_class?: MailErrorClass;
  dispatch_generation: number;
}

/** Response thành công khi `result ∈ {applied, duplicate}`. */
export interface PostDeliveryOutcomeApplied {
  result: 'applied' | 'duplicate';
  /** `mail_messages.status` tại thời điểm ghi (`01-architecture.md` §6.2.2). */
  status: MailMessageStatus;
}

/** Response khi `result = 'stale'` (bao gồm `current_dispatch_generation`). */
export interface PostDeliveryOutcomeStale {
  result: 'stale';
  /** `mail_messages.status` tại thời điểm phân loại. */
  status: MailMessageStatus;
  current_dispatch_generation: number;
}

/** Response body của `POST /internal/deliveries/:delivery_id/outcome`. */
export type PostDeliveryOutcomeResponse = PostDeliveryOutcomeApplied | PostDeliveryOutcomeStale;

/** Field được phép trong `DeliveryMessage`. */
export const DELIVERY_MESSAGE_FIELDS = [
  'delivery_id',
  'message_id',
  'app',
  'status',
  'recipient',
  'subject',
  'body',
  'content_type',
] as const;

/** Field bắt buộc trong `DeliveryMessage`. */
export const REQUIRED_DELIVERY_MESSAGE_FIELDS = DELIVERY_MESSAGE_FIELDS;

/** Field được phép trong `GetDeliveryResponse`. */
export const GET_DELIVERY_RESPONSE_FIELDS = ['message', 'dispatch_generation'] as const;
export const REQUIRED_GET_DELIVERY_RESPONSE_FIELDS = GET_DELIVERY_RESPONSE_FIELDS;

/** Field được phép trong `PostDeliveryOutcomeRequest`. */
export const POST_DELIVERY_OUTCOME_REQUEST_FIELDS = [
  'outcome',
  'error_class',
  'dispatch_generation',
] as const;
export const REQUIRED_POST_DELIVERY_OUTCOME_REQUEST_FIELDS = [
  'outcome',
  'dispatch_generation',
] as const;

/**
 * Field được phép trong response `POST .../outcome` khi `result ∈ {applied, duplicate}`
 * — nguồn: `docs/applications/transactional-mail/01-architecture.md` §6.2.2 (canonical wire shape).
 */
export const POST_DELIVERY_OUTCOME_RESPONSE_FIELDS = ['result', 'status'] as const;

/**
 * Field được phép trong response khi `result = 'stale'` — thêm `current_dispatch_generation`.
 */
export const POST_DELIVERY_OUTCOME_RESPONSE_STALE_FIELDS = [
  'result',
  'status',
  'current_dispatch_generation',
] as const;

/** Lý do validation thất bại. */
export type DeliveryInterfaceValidationReason =
  | 'missing-field'
  | 'forbidden-field'
  | 'wrong-type'
  | 'invalid-value'
  | 'unparseable';

/** Kết quả validation thành công. */
export interface DeliveryInterfaceValidationOk<T> {
  ok: true;
  value: T;
}

/** Kết quả validation thất bại. */
export interface DeliveryInterfaceValidationFail {
  ok: false;
  reason: DeliveryInterfaceValidationReason;
  /** Chỉ tên field liên quan; không bao giờ là giá trị payload. */
  detail?: string;
}

export type DeliveryInterfaceValidation<T> =
  | DeliveryInterfaceValidationOk<T>
  | DeliveryInterfaceValidationFail;

/** Type guard: `DeliveryMessage`. */
export function isDeliveryMessage(value: unknown): value is DeliveryMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Partial<DeliveryMessage>;
  if (!isNonEmptyString(v.delivery_id)) return false;
  if (!isNonEmptyString(v.message_id)) return false;
  if (!isNonEmptyString(v.app)) return false;
  if (typeof v.status !== 'string') return false;
  if (!(MAIL_MESSAGE_STATUS_VALUES as readonly string[]).includes(v.status)) return false;
  if (!isNonEmptyString(v.recipient)) return false;
  if (typeof v.subject !== 'string') return false;
  if (typeof v.body !== 'string') return false;
  if (v.content_type !== MAIL_CONTENT_TYPE) return false;
  return true;
}

/** Validate `DeliveryMessage` (closed schema). */
export function validateDeliveryMessage(
  payload: unknown,
): DeliveryInterfaceValidation<DeliveryMessage> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'unparseable' };
  }
  const obj = payload as Record<string, unknown>;
  const keys = Object.keys(obj);
  for (const k of keys) {
    if (!(DELIVERY_MESSAGE_FIELDS as readonly string[]).includes(k)) {
      return { ok: false, reason: 'forbidden-field', detail: k };
    }
  }
  for (const f of REQUIRED_DELIVERY_MESSAGE_FIELDS) {
    if (!(f in obj)) return { ok: false, reason: 'missing-field', detail: f };
  }
  if (typeof obj.delivery_id !== 'string' || obj.delivery_id.trim().length === 0) {
    return { ok: false, reason: 'wrong-type', detail: 'delivery_id' };
  }
  if (typeof obj.message_id !== 'string' || obj.message_id.trim().length === 0) {
    return { ok: false, reason: 'wrong-type', detail: 'message_id' };
  }
  if (typeof obj.app !== 'string' || obj.app.trim().length === 0) {
    return { ok: false, reason: 'wrong-type', detail: 'app' };
  }
  if (
    typeof obj.status !== 'string' ||
    !(MAIL_MESSAGE_STATUS_VALUES as readonly string[]).includes(obj.status)
  ) {
    return { ok: false, reason: 'invalid-value', detail: 'status' };
  }
  if (typeof obj.recipient !== 'string' || obj.recipient.trim().length === 0) {
    return { ok: false, reason: 'wrong-type', detail: 'recipient' };
  }
  // `subject`/`body` chỉ cần là chuỗi: tài liệu (§7.2, FR-005) liệt kê field của
  // `message` nhưng **không** đặt luật "khác rỗng" cho nội dung đã render. Thêm luật đó
  // sẽ từ chối oan một envelope hợp lệ theo tài liệu. `recipient` thì khác: FR-002 nêu
  // rõ recipient rỗng là không hợp lệ, nên non-empty ở đây là mức kiểm tối thiểu.
  if (typeof obj.subject !== 'string') {
    return { ok: false, reason: 'wrong-type', detail: 'subject' };
  }
  if (typeof obj.body !== 'string') {
    return { ok: false, reason: 'wrong-type', detail: 'body' };
  }
  if (obj.content_type !== MAIL_CONTENT_TYPE) {
    return { ok: false, reason: 'invalid-value', detail: 'content_type' };
  }
  return {
    ok: true,
    value: {
      delivery_id: obj.delivery_id.trim(),
      message_id: obj.message_id.trim(),
      app: obj.app.trim(),
      status: obj.status as MailMessageStatus,
      recipient: obj.recipient.trim(),
      subject: obj.subject.trim(),
      body: obj.body,
      content_type: MAIL_CONTENT_TYPE,
    },
  };
}

/** Validate `GetDeliveryResponse`. */
export function validateGetDeliveryResponse(
  payload: unknown,
): DeliveryInterfaceValidation<GetDeliveryResponse> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'unparseable' };
  }
  const obj = payload as Record<string, unknown>;
  const keys = Object.keys(obj);
  for (const k of keys) {
    if (!(GET_DELIVERY_RESPONSE_FIELDS as readonly string[]).includes(k)) {
      return { ok: false, reason: 'forbidden-field', detail: k };
    }
  }
  for (const f of REQUIRED_GET_DELIVERY_RESPONSE_FIELDS) {
    if (!(f in obj)) return { ok: false, reason: 'missing-field', detail: f };
  }
  if (typeof obj.message !== 'object' || obj.message === null || Array.isArray(obj.message)) {
    return { ok: false, reason: 'wrong-type', detail: 'message' };
  }
  const mv = validateDeliveryMessage(obj.message);
  if (!mv.ok) {
    // propagate detail from message validation if present
    return { ok: false, reason: mv.reason, detail: mv.detail ?? 'message' };
  }
  if (!isPositiveSafeInteger(obj.dispatch_generation)) {
    return { ok: false, reason: 'wrong-type', detail: 'dispatch_generation' };
  }
  return { ok: true, value: { message: mv.value, dispatch_generation: obj.dispatch_generation } };
}

/** Validate `PostDeliveryOutcomeRequest`. */
export function validatePostDeliveryOutcomeRequest(
  payload: unknown,
): DeliveryInterfaceValidation<PostDeliveryOutcomeRequest> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'unparseable' };
  }
  const obj = payload as Record<string, unknown>;
  const keys = Object.keys(obj);
  for (const k of keys) {
    if (!(POST_DELIVERY_OUTCOME_REQUEST_FIELDS as readonly string[]).includes(k)) {
      return { ok: false, reason: 'forbidden-field', detail: k };
    }
  }
  for (const f of REQUIRED_POST_DELIVERY_OUTCOME_REQUEST_FIELDS) {
    if (!(f in obj)) return { ok: false, reason: 'missing-field', detail: f };
  }
  if (
    typeof obj.outcome !== 'string' ||
    !(MAIL_OUTCOME_VALUES as readonly string[]).includes(obj.outcome)
  ) {
    return { ok: false, reason: 'invalid-value', detail: 'outcome' };
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'error_class')) {
    const ec = obj.error_class;
    if (typeof ec !== 'string' || !(MAIL_ERROR_CLASS_VALUES as readonly string[]).includes(ec)) {
      return { ok: false, reason: 'invalid-value', detail: 'error_class' };
    }
  }
  if (!isPositiveSafeInteger(obj.dispatch_generation)) {
    return { ok: false, reason: 'wrong-type', detail: 'dispatch_generation' };
  }
  return {
    ok: true,
    value: {
      outcome: obj.outcome as MailOutcome,
      ...(Object.prototype.hasOwnProperty.call(obj, 'error_class')
        ? { error_class: obj.error_class as MailErrorClass }
        : {}),
      dispatch_generation: obj.dispatch_generation,
    },
  };
}

/** Validate `PostDeliveryOutcomeResponse`. */
export function validatePostDeliveryOutcomeResponse(
  payload: unknown,
): DeliveryInterfaceValidation<PostDeliveryOutcomeResponse> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'unparseable' };
  }
  const obj = payload as Record<string, unknown>;
  const keys = Object.keys(obj);
  // `result` và `status` bắt buộc trong mọi biến thể; `stale` đòi thêm
  // `current_dispatch_generation` (`01-architecture.md` §6.2.2).
  if (!Object.prototype.hasOwnProperty.call(obj, 'result')) {
    return { ok: false, reason: 'missing-field', detail: 'result' };
  }
  if (
    typeof obj.result !== 'string' ||
    !(OUTCOME_RESULT_VALUES as readonly string[]).includes(obj.result)
  ) {
    return { ok: false, reason: 'invalid-value', detail: 'result' };
  }
  if (!Object.prototype.hasOwnProperty.call(obj, 'status')) {
    return { ok: false, reason: 'missing-field', detail: 'status' };
  }
  if (
    typeof obj.status !== 'string' ||
    !(MAIL_MESSAGE_STATUS_VALUES as readonly string[]).includes(obj.status)
  ) {
    return { ok: false, reason: 'invalid-value', detail: 'status' };
  }
  if (obj.result === 'stale') {
    for (const k of keys) {
      if (!(POST_DELIVERY_OUTCOME_RESPONSE_STALE_FIELDS as readonly string[]).includes(k)) {
        return { ok: false, reason: 'forbidden-field', detail: k };
      }
    }
    if (!Object.prototype.hasOwnProperty.call(obj, 'current_dispatch_generation')) {
      return { ok: false, reason: 'missing-field', detail: 'current_dispatch_generation' };
    }
    if (!isPositiveSafeInteger(obj.current_dispatch_generation)) {
      return { ok: false, reason: 'wrong-type', detail: 'current_dispatch_generation' };
    }
    return {
      ok: true,
      value: {
        result: 'stale',
        status: obj.status as MailMessageStatus,
        current_dispatch_generation: obj.current_dispatch_generation,
      },
    };
  }
  // applied or duplicate
  for (const k of keys) {
    if (!(POST_DELIVERY_OUTCOME_RESPONSE_FIELDS as readonly string[]).includes(k)) {
      return { ok: false, reason: 'forbidden-field', detail: k };
    }
  }
  return {
    ok: true,
    value: {
      result: obj.result as 'applied' | 'duplicate',
      status: obj.status as MailMessageStatus,
    },
  };
}
