import { copyJsonCompatible, isPlainObject, scanJsonDataObject } from './shared';

/**
 * `payload` của `Delivery Command` — nội dung hiển thị do application cấp, materialize tại
 * control plane (`docs/applications/push-notification/02-requirements.md` FR-013).
 *
 * ⚠️ **`data` là opaque với worker.** "Opaque" nghĩa là worker **không diễn giải nội dung**
 * (worker §15) — **không** nghĩa là bỏ qua tính hợp lệ JSON: envelope được serialize thành
 * UTF-8 JSON để tính ngân sách byte (FR-008, canonical serialization FR-013), nên một giá trị
 * không serialize được (`undefined`, `BigInt`, `function`, `NaN`/`Infinity`, circular reference,
 * `Date`/`Map`/`Set`, getter…) làm ngân sách và wire form mất ý nghĩa. Validator ở đây kiểm
 * **tính tương thích JSON** của `data` mà không đi vào **ý nghĩa** của từng khoá.
 *
 * Payload là **closed schema**: đúng bốn khoá `title`, `body`, `url`, `data`, không hơn.
 * `title`/`body` bắt buộc vì một notification không có chúng thì không có gì để hiển thị.
 */

/** Khoá được phép có mặt trong `payload`. */
export const NOTIFICATION_PAYLOAD_FIELDS = ['title', 'body', 'url', 'data'] as const;

/** Khoá bắt buộc có mặt trong `payload`. */
export const REQUIRED_NOTIFICATION_PAYLOAD_FIELDS = [
  'title',
  'body',
] as const satisfies readonly (typeof NOTIFICATION_PAYLOAD_FIELDS)[number][];

/** Nội dung hiển thị của một notification. */
export interface NotificationPayload {
  /** Tiêu đề hiển thị. */
  readonly title: string;
  /** Nội dung hiển thị. */
  readonly body: string;
  /** Deep link do application cấp; control plane không ghép/suy diễn. */
  readonly url?: string;
  /** Dữ liệu tuỳ application; opaque với worker. */
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Lý do từ chối `payload`. */
export type NotificationPayloadRejectionReason =
  | 'invalid_payload'
  | 'missing_field'
  | 'unexpected_field'
  | 'invalid_field_type';

/** Kết quả validate `payload`. */
export type NotificationPayloadValidation =
  | { readonly ok: true; readonly payload: NotificationPayload }
  | {
      readonly ok: false;
      readonly reason: NotificationPayloadRejectionReason;
      readonly detail: string;
    };

/** Kết quả một lần copy + kiểm giá trị JSON — `kind` là chuỗi hằng, không lấy từ đầu vào. */

/**
 * Validate `payload` của envelope.
 *
 * Thứ tự kiểm: shape → **khoá lạ trước khoá thiếu** (chính sách unknown-field-before-missing
 * của canonical FR-013) → chính sách JSON-data (symbol key/getter/non-enumerable) → khoá bắt
 * buộc → kiểu từng field → tính tương thích JSON của `data`.
 *
 * ⚠️ `"có mặt"` có **một** định nghĩa: own property (`Object.hasOwn`), không phải `in`.
 * Mọi khoá đi qua `scanJsonDataObject` (helper chính sách dùng chung trong `shared.ts`):
 * khoá lạ bị chặn trước khoá thiếu, getter bị từ chối **trước** khi đọc giá trị, field
 * non-enumerable bị từ chối thay vì bị bỏ qua lặng lẽ.
 *
 * ⚠️ `detail` chỉ nêu **tên** khoá đã qua `safeFieldName` hoặc `kind` là chuỗi hằng — không
 * bao giờ nối **giá trị** của payload (nội dung hiển thị người dùng cuối; `detail` có thể
 * đi vào log).
 */
export function validateNotificationPayload(payload: unknown): NotificationPayloadValidation {
  if (!isPlainObject(payload)) {
    return { ok: false, reason: 'invalid_payload', detail: 'payload phải là object JSON.' };
  }
  const record = payload;

  const scan = scanJsonDataObject(record, 'payload', NOTIFICATION_PAYLOAD_FIELDS);
  if (!scan.ok) {
    return { ok: false, reason: scan.reason, detail: scan.detail };
  }

  for (const field of REQUIRED_NOTIFICATION_PAYLOAD_FIELDS) {
    if (!Object.hasOwn(record, field)) {
      return { ok: false, reason: 'missing_field', detail: `payload thiếu khoá: ${field}.` };
    }
  }

  if (typeof record.title !== 'string') {
    return { ok: false, reason: 'invalid_field_type', detail: 'title phải là string.' };
  }
  if (typeof record.body !== 'string') {
    return { ok: false, reason: 'invalid_field_type', detail: 'body phải là string.' };
  }
  if (Object.hasOwn(record, 'url') && typeof record.url !== 'string') {
    return { ok: false, reason: 'invalid_field_type', detail: 'url phải là string khi có mặt.' };
  }

  const basePayload: NotificationPayload = {
    title: record.title,
    body: record.body,
    ...(Object.hasOwn(record, 'url') ? { url: record.url as string } : {}),
  };
  if (!Object.hasOwn(record, 'data')) {
    return { ok: true, payload: basePayload };
  }
  if (!isPlainObject(record.data)) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: 'data phải là object JSON không phải mảng khi có mặt.',
    };
  }

  // `copyJsonCompatible` (`shared.ts`) bắt `RangeError` của engine và trả về `kind` hằng —
  // cùng giới hạn độ sâu mà `JSON.stringify` (canonical serialization) cũng có, nên một
  // payload quá sâu là **từ chối**, không phải exception thoát ra ngoài boundary.
  const copied = copyJsonCompatible(record.data, new Set<object>([record]));
  if (!copied.ok) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: `data chứa giá trị không tương thích JSON: ${copied.kind}.`,
    };
  }

  return {
    ok: true,
    payload: {
      ...basePayload,
      data: copied.value as Readonly<Record<string, unknown>>,
    },
  };
}
