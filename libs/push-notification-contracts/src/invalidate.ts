/**
 * `POST /internal/subscriptions/:subscription_id/invalidate` — operation thứ tư của private
 * delivery runtime API (`docs/applications/push-notification/01-architecture.md` §8.1).
 *
 * ⚠️ Đây là operation **duy nhất** trong API này không nhận `delivery_id`, nên ranh giới của
 * nó phải rõ: nó **chỉ** đổi subscription state (`active → disabled`), **không** đụng delivery
 * state, và **KHÔNG** thu hồi một claim đã thắng. Nếu nó bị hiểu là "huỷ delivery" thì nó
 * thành một đường vòng qua fencing.
 *
 * Điều kiện gọi — "provider chứng minh endpoint chết (thường `404`)" — là **policy phía
 * worker**: control plane **không** verify được bằng chứng đó và **MUST NOT** tự fetch
 * endpoint để kiểm chứng (FR-003 cấm network call kiểm tồn tại). Vì vậy request **rỗng**:
 * nó không nhận evidence, payload hay credential, nên không có dữ liệu nào từ provider đi
 * xuyên qua control plane.
 *
 * `401`/`403` từ provider **KHÔNG** dẫn tới invalidate (provider-level failure, worker §16.8);
 * chỉ nhánh `404`-tương-đương mới gọi. Contract ở đây không thể kiểm điều đó — nó ghi lại để
 * consumer không tự suy diễn thêm.
 */

import {
  FORBIDDEN_DELIVERY_MATERIAL_FIELDS,
  isNonEmptyString,
  isPlainObject,
  presenceProbeDetail,
  scanJsonDataObject,
  type SubscriptionStatus,
} from './shared';

/** Request `invalidate` — **rỗng**; bằng chứng không đi qua contract này. */
export interface InvalidateRequest {
  readonly [key: string]: never;
}

/**
 * Subscription state mà `invalidate` đặt — giá trị **duy nhất** operation này trả ở v1.
 *
 * Là một giá trị **thuộc** lifecycle `FR-004` (`active`/`disabled`/`expired`), **không** phải
 * state riêng của operation: endpoint chết vĩnh viễn (`404`) nghĩa là subscription bị disable,
 * không phải một trạng thái thứ tư. `expired` là state của chính sách vòng đời, không do
 * operation này set.
 */
export const INVALIDATE_RESULT_SUBSCRIPTION_STATUS =
  'disabled' as const satisfies SubscriptionStatus;

/** Body `200` của `invalidate` — **đóng**, đúng hai field. */
export interface InvalidateAck {
  readonly subscription_id: string;
  readonly status: typeof INVALIDATE_RESULT_SUBSCRIPTION_STATUS;
}

/**
 * Field mà `invalidate` **MUST NOT** trả.
 *
 * Gồm toàn bộ delivery material dùng chung (`FORBIDDEN_DELIVERY_MATERIAL_FIELDS`) cộng
 * `delivery_id` — đây là operation **duy nhất** không nhận `delivery_id` nên nó phải bị cấm
 * tuyệt đối, thay vì từng danh sách tự liệt kê rồi trôi lệch nhau.
 */
export const FORBIDDEN_INVALIDATE_ACK_FIELDS = [
  ...FORBIDDEN_DELIVERY_MATERIAL_FIELDS,
  'delivery_id',
] as const;

/** Lý do từ chối một body `200` của `invalidate` (ở tầng parse). */
export type InvalidateResponseRejectionReason =
  | 'invalid_payload'
  | 'unexpected_field'
  | 'missing_field'
  | 'invalid_field_type'
  | 'runtime_material_leak';

/** Kết quả validate body `200` của `invalidate`. */
export type InvalidateValidation =
  | { readonly ok: true; readonly ack: InvalidateAck }
  | {
      readonly ok: false;
      readonly reason: InvalidateResponseRejectionReason;
      readonly detail: string;
    };

/**
 * Validate body `200` của `invalidate`.
 *
 * Idempotency theo kết quả: gọi lặp với cùng `subscription_id` ở state đã `disabled` trả
 * **cùng** `200` — nên validator không có nhánh nào biểu diễn "đã invalidate rồi" như một
 * lỗi transition. Operation này cũng **không** cần `Idempotency-Key`: kết quả của nó là một
 * state cuối, không phải một lần gửi.
 */
export function validateInvalidateAck(payload: unknown): InvalidateValidation {
  if (!isPlainObject(payload)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Invalidate 200 phải là object JSON.' };
  }
  const record = payload;

  const hostilePresence = presenceProbeDetail(
    record,
    'Invalidate 200',
    FORBIDDEN_INVALIDATE_ACK_FIELDS,
  );
  if (hostilePresence !== undefined) {
    return { ok: false, reason: 'invalid_payload', detail: hostilePresence };
  }

  for (const field of FORBIDDEN_INVALIDATE_ACK_FIELDS) {
    if (Object.hasOwn(record, field)) {
      return {
        ok: false,
        reason: 'runtime_material_leak',
        detail: `Invalidate 200 chứa field bị cấm: ${field}.`,
      };
    }
  }

  const scan = scanJsonDataObject(record, 'Invalidate 200', ['subscription_id', 'status']);
  if (!scan.ok) {
    return { ok: false, reason: scan.reason, detail: scan.detail };
  }

  // Thiếu vs sai kiểu là hai lỗi khác nhau: vắng field là `missing_field`, còn chuỗi rỗng
  // là field **có mặt** nhưng sai kiểu — gộp hai nhánh lại che mất chẩn đoán đó.
  if (!Object.hasOwn(record, 'subscription_id')) {
    return {
      ok: false,
      reason: 'missing_field',
      detail: 'Invalidate 200 thiếu field: subscription_id.',
    };
  }
  if (!isNonEmptyString(record.subscription_id)) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: 'Invalidate 200: subscription_id phải là chuỗi không rỗng.',
    };
  }
  if (!Object.hasOwn(record, 'status')) {
    return { ok: false, reason: 'missing_field', detail: 'Invalidate 200 thiếu field: status.' };
  }
  if (record.status !== INVALIDATE_RESULT_SUBSCRIPTION_STATUS) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: `Invalidate 200: status phải là "${INVALIDATE_RESULT_SUBSCRIPTION_STATUS}" (subscription state theo FR-004; "invalidated" không phải một state).`,
    };
  }

  return {
    ok: true,
    ack: { subscription_id: record.subscription_id, status: INVALIDATE_RESULT_SUBSCRIPTION_STATUS },
  };
}

/** Dựng body `200` của `invalidate` — chạy `validateInvalidateAck` trước khi trả về. */
export function invalidateAck(subscriptionId: string): InvalidateAck {
  const candidate = {
    subscription_id: subscriptionId,
    status: INVALIDATE_RESULT_SUBSCRIPTION_STATUS,
  } as const satisfies InvalidateAck;
  const checked = validateInvalidateAck(candidate);
  if (!checked.ok) {
    throw new Error(
      `invalidateAck: body không qua validator (${checked.reason}): ${checked.detail}`,
    );
  }
  return checked.ack;
}

/** Kết quả validate request body của `invalidate`. */
export type InvalidateRequestValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: InvalidateResponseRejectionReason;
      readonly detail: string;
    };

/**
 * Validate request body của `invalidate` — **MUST** là object rỗng.
 *
 * Request rỗng là một phần của ranh giới, không phải chi tiết hình thức: nó ngăn một caller
 * gửi kèm "bằng chứng" (provider response, endpoint đã chết) mà control plane không thể kiểm
 * và **MUST NOT** tin; và nó ngăn request này trở thành đường vận chuyển dữ liệu từ provider
 * xuyên qua control plane.
 */
export function validateInvalidateRequest(payload: unknown): InvalidateRequestValidation {
  if (!isPlainObject(payload)) {
    return {
      ok: false,
      reason: 'invalid_payload',
      detail: 'Invalidate request phải là object JSON.',
    };
  }
  const scan = scanJsonDataObject(payload, 'Invalidate request', []);
  if (!scan.ok) {
    return {
      ok: false,
      reason: scan.reason,
      detail:
        scan.reason === 'unexpected_field'
          ? `Invalidate request MUST rỗng; nhận field ngoài contract: ${scan.field}.`
          : scan.detail,
    };
  }
  return { ok: true };
}
