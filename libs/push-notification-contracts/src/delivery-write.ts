/**
 * Hai operation ghi kèm fencing token của private delivery runtime API:
 * `POST /internal/deliveries/:delivery_id/release` và `.../outcome`
 * (`docs/applications/push-notification/01-architecture.md` §8.1).
 *
 * Hai operation được đặt cùng file vì chúng **chia sẻ** một vocabulary từ chối và một luật
 * `state`, và tách ra sẽ tạo hai bản sao trôi khỏi nhau:
 *
 * - **Tập `reason` hẹp hơn `claim`:** chỉ `stale_write` và `terminal`. Một execution **đã
 *   thắng lease** vẫn ghi được outcome kể cả khi subscription bị disable hay notification
 *   hết hạn *sau* thời điểm claim, nên `expired`/`ineligible_*` **không** thể áp cho nhánh
 *   ghi. Trộn hai tập lại sẽ mô tả sai quyền của execution đang giữ lease.
 * - **`stale_write` không phải `terminal`:** `status ≠ 'processing'` hoặc lease đã hết vẫn
 *   là delivery **non-terminal**, nên `terminal` sẽ mô tả sai state.
 * - **`release` không phải kết cục:** `release` trả lease (`processing → queued`,
 *   `dispatch_generation` **không đổi**), **không** ghi `failed`, **không** kết thúc delivery.
 *   `outcome` mới ghi `delivered`/`failed` — và **chỉ** hai giá trị đó: `expired`/`cancelled`
 *   thuộc control plane, worker **MUST NOT** ghi.
 */

import {
  FORBIDDEN_DELIVERY_MATERIAL_FIELDS,
  isNonEmptyString,
  isPlainObject,
  isPositiveInteger,
  isTerminalDeliveryStatus,
  presenceProbeDetail,
  scanJsonDataObject,
  type TerminalDeliveryStatus,
} from './shared';

/* -------------------------------------------------------------------------------------- */
/* Vocabulary từ chối dùng chung                                                          */
/* -------------------------------------------------------------------------------------- */

/** `reason` của `409` trên `release`/`outcome` — **đóng**. */
export const LEASE_FENCED_REJECTION_REASONS = ['stale_write', 'terminal'] as const;

/** Union `reason` của `409` trên `release`/`outcome`. */
export type LeaseFencedRejectionReason = (typeof LEASE_FENCED_REJECTION_REASONS)[number];

/** `reason` duy nhất được kèm `state` — mọi `reason` khác **MUST NOT**. */
export const LEASE_FENCED_REASON_WITH_STATE =
  'terminal' as const satisfies LeaseFencedRejectionReason;

/** Body `409` của `release`/`outcome` — **đóng**: `reason`, `state` chỉ khi `terminal`. */
export interface LeaseFencedRejection {
  readonly reason: LeaseFencedRejectionReason;
  readonly state?: TerminalDeliveryStatus;
}

/**
 * Field mà `409` của `release`/`outcome` **MUST NOT** chứa.
 *
 * Cùng lý do như `409` của `claim`: caller **đang** giữ lease không có nghĩa là response lỗi
 * được trả secret; delivery material **chỉ** đi kèm `200` của `claim`. Danh sách dùng chung
 * `FORBIDDEN_DELIVERY_MATERIAL_FIELDS` — `claim`/`release`/`outcome` có **vocabulary reason
 * khác nhau** (6 vs 2) nhưng tập material bị cấm là **một**, và trước đây chúng trôi lệch
 * nhau từng dòng (`dispatch_generation` thiếu ở đây).
 */
export const FORBIDDEN_LEASE_FENCED_REJECTION_FIELDS = FORBIDDEN_DELIVERY_MATERIAL_FIELDS;

/** Lý do từ chối một body `409` (ở tầng parse). */
export type LeaseFencedRejectionValidationReason =
  | 'invalid_payload'
  | 'missing_field'
  | 'unknown_reason'
  | 'unexpected_field'
  | 'invalid_field_type'
  | 'state_not_allowed'
  | 'state_required'
  | 'runtime_material_leak';

/** Kết quả validate body `409` của `release`/`outcome`. */
export type LeaseFencedRejectionValidation =
  | { readonly ok: true; readonly rejection: LeaseFencedRejection }
  | {
      readonly ok: false;
      readonly reason: LeaseFencedRejectionValidationReason;
      readonly detail: string;
    };

/** Kiểm tra một giá trị có phải `reason` hợp lệ của `release`/`outcome`. */
export function isLeaseFencedRejectionReason(value: unknown): value is LeaseFencedRejectionReason {
  return (
    typeof value === 'string' &&
    (LEASE_FENCED_REJECTION_REASONS as readonly string[]).includes(value)
  );
}

/**
 * Validate body `409` của `release` và `outcome`.
 *
 * Body là **đóng**: chỉ `reason` và `state` được phép, nên `dispatch_generation` (một field
 * worker đã biết) cũng bị chặn — contract không cần echo lại nó; nó thuộc
 * `FORBIDDEN_DELIVERY_MATERIAL_FIELDS` nên được báo là `runtime_material_leak`, cùng
 * phân loại với `claim` thay vì rơi thành field lạ.
 */
export function validateLeaseFencedRejection(payload: unknown): LeaseFencedRejectionValidation {
  if (!isPlainObject(payload)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Response 409 phải là object JSON.' };
  }
  const record = payload;

  const hostilePresence = presenceProbeDetail(
    record,
    'Response 409',
    FORBIDDEN_LEASE_FENCED_REJECTION_FIELDS,
  );
  if (hostilePresence !== undefined) {
    return { ok: false, reason: 'invalid_payload', detail: hostilePresence };
  }

  for (const field of FORBIDDEN_LEASE_FENCED_REJECTION_FIELDS) {
    if (Object.hasOwn(record, field)) {
      return {
        ok: false,
        reason: 'runtime_material_leak',
        detail: `Response 409 chứa runtime material bị cấm: ${field}.`,
      };
    }
  }

  const scan = scanJsonDataObject(record, 'Response 409', ['reason', 'state']);
  if (!scan.ok) {
    return { ok: false, reason: scan.reason, detail: scan.detail };
  }

  // Cùng policy phân loại với `409` của claim: `reason` là field **bắt buộc** và là enum
  // **đóng**, nên vắng hẳn / sai kiểu / ngoài tập đóng là ba lỗi khác nhau. Hai vocabulary
  // `reason` của claim và của write **không** bị ép chung (`terminal`/`lease_held`/… so với
  // `stale_write`/`terminal`); chỉ lớp *parse* dùng chung cách phân loại.
  if (!Object.hasOwn(record, 'reason')) {
    return { ok: false, reason: 'missing_field', detail: 'Response 409 thiếu field: reason.' };
  }
  if (typeof record.reason !== 'string') {
    return { ok: false, reason: 'invalid_field_type', detail: 'reason phải là chuỗi.' };
  }
  if (!isLeaseFencedRejectionReason(record.reason)) {
    return {
      ok: false,
      reason: 'unknown_reason',
      detail: 'reason không thuộc tập đóng (closed reason set).',
    };
  }

  if (record.reason === LEASE_FENCED_REASON_WITH_STATE) {
    if (!Object.hasOwn(record, 'state')) {
      return {
        ok: false,
        reason: 'state_required',
        detail: 'Response 409 với reason "terminal" phải kèm state.',
      };
    }
    if (!isTerminalDeliveryStatus(record.state)) {
      return {
        ok: false,
        reason: 'invalid_field_type',
        detail: 'state của reason "terminal" phải là terminal delivery state.',
      };
    }
    return { ok: true, rejection: { reason: 'terminal', state: record.state } };
  }

  if (Object.hasOwn(record, 'state')) {
    return {
      ok: false,
      reason: 'state_not_allowed',
      detail: 'Response 409 chỉ được kèm state khi reason là "terminal".',
    };
  }

  return { ok: true, rejection: { reason: record.reason } };
}

/**
 * Dựng body `409` hợp lệ — buộc `state` chỉ xuất hiện ở nhánh `terminal`.
 *
 * Ném lỗi khi bất biến bị vi phạm (cùng pattern với `claimRejection`) và chạy **validator
 * canonical** trên kết quả — `reason` ép kiểu từ JSON không thể lọt ra ngoài.
 */
export function leaseFencedRejection(
  reason: LeaseFencedRejectionReason,
  state?: TerminalDeliveryStatus,
): LeaseFencedRejection {
  // Cùng lý do với `claimRejection`: kiểm tập ĐÓNG trước khi nối `reason` vào thông điệp
  // lỗi, nên chuỗi do caller kiểm soát (kể cả có xuống dòng) không bao giờ vào log.
  if (!isLeaseFencedRejectionReason(reason)) {
    throw new Error('leaseFencedRejection: reason phải thuộc tập đóng lease-fenced rejection.');
  }
  if (reason === LEASE_FENCED_REASON_WITH_STATE) {
    if (state === undefined) {
      throw new Error('leaseFencedRejection: reason "terminal" bắt buộc có state.');
    }
  } else if (state !== undefined) {
    throw new Error(`leaseFencedRejection: reason "${reason}" không được kèm state.`);
  }
  const candidate = reason === LEASE_FENCED_REASON_WITH_STATE ? { reason, state } : { reason };
  const checked = validateLeaseFencedRejection(candidate);
  if (!checked.ok) {
    throw new Error(
      `leaseFencedRejection: body không qua validator (${checked.reason}): ${checked.detail}`,
    );
  }
  return checked.rejection;
}

/* -------------------------------------------------------------------------------------- */
/* `release`                                                                              */
/* -------------------------------------------------------------------------------------- */

/** Request `release` — **chỉ** fencing token; không outcome, không payload, không credential. */
export interface ReleaseRequest {
  readonly dispatch_generation: number;
}

/** Body `200` của `release` — luôn `queued` với generation **không đổi**. */
export interface ReleaseAck {
  readonly delivery_id: string;
  readonly status: 'queued';
  readonly dispatch_generation: number;
}

/** Kết quả một lần `release` — union phân biệt thành công/từ chối. */
export type ReleaseResult =
  | { readonly ok: true; readonly ack: ReleaseAck }
  | { readonly ok: false; readonly rejection: LeaseFencedRejection };

/** Kết quả validate body `200` của `release`. */
export type ReleaseValidation =
  | { readonly ok: true; readonly ack: ReleaseAck }
  | { readonly ok: false; readonly reason: WriteAckRejectionReason; readonly detail: string };

/**
 * Validate body `200` của `release`.
 *
 * `status` **MUST** là `queued`: một `200` mang status khác (`processing`, `delivered`) là
 * lỗi contract, vì `release` không có kết cục nào khác ngoài việc trả lease.
 */
export function validateReleaseAck(payload: unknown): ReleaseValidation {
  const result = validateWriteAck(payload, 'release');
  if (!result.ok) {
    return result;
  }
  if (result.ack.status !== 'queued') {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: 'release 200: status phải là "queued".',
    };
  }
  return {
    ok: true,
    ack: {
      delivery_id: result.ack.delivery_id,
      status: 'queued',
      dispatch_generation: result.ack.dispatch_generation,
    },
  };
}

/** Dựng body `200` của `release` — chạy `validateReleaseAck` trước khi trả về. */
export function releaseAck(input: {
  readonly delivery_id: string;
  readonly dispatch_generation: number;
}): ReleaseAck {
  const candidate = {
    delivery_id: input.delivery_id,
    status: 'queued',
    dispatch_generation: input.dispatch_generation,
  } as const satisfies ReleaseAck;
  const checked = validateReleaseAck(candidate);
  if (!checked.ok) {
    throw new Error(`releaseAck: body không qua validator (${checked.reason}): ${checked.detail}`);
  }
  return checked.ack;
}

/** Lý do từ chối một request body của `release`/`outcome` (ở tầng parse). */
export type WriteRequestRejectionReason =
  | 'invalid_payload'
  | 'unexpected_field'
  | 'missing_field'
  | 'invalid_field_type';

/**
 * Kết quả validate request body của `release`.
 *
 * Từng operation có **union success riêng** thay vì một union gộp `ReleaseRequest |
 * OutcomeRequest`: consumer nhận kết quả đã narrowing đúng kiểu, không cần probe field
 * hay cast.
 */
export type ReleaseRequestValidation =
  | { readonly ok: true; readonly request: ReleaseRequest }
  | {
      readonly ok: false;
      readonly reason: WriteRequestRejectionReason;
      readonly detail: string;
    };

/** Kết quả validate request body của `outcome` — narrowing theo từng operation. */
export type OutcomeRequestValidation =
  | { readonly ok: true; readonly request: OutcomeRequest }
  | {
      readonly ok: false;
      readonly reason: WriteRequestRejectionReason;
      readonly detail: string;
    };

/**
 * Validate request body của `release` — **đúng** `dispatch_generation`.
 *
 * Fencing token là thứ duy nhất request này được mang: nó không mang outcome (đó là việc của
 * `outcome`) và không mang payload/credential. `dispatch_generation` phải là số nguyên dương
 * — generation là bộ đếm đơn điệu bắt đầu từ 1 khi claim đầu tiên tăng nó.
 */
export function validateReleaseRequest(payload: unknown): ReleaseRequestValidation {
  const shape = validateWriteRequestShape(payload, 'release', ['dispatch_generation']);
  if (!shape.ok) {
    return shape;
  }
  if (!isPositiveInteger(shape.record.dispatch_generation)) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: 'release request: dispatch_generation phải là số nguyên dương.',
    };
  }
  return { ok: true, request: { dispatch_generation: shape.record.dispatch_generation } };
}

/**
 * Validate request body của `outcome` — **đúng** `dispatch_generation` và `outcome`.
 *
 * `outcome` **MUST** thuộc `delivered`/`failed`: gửi `expired`/`cancelled` qua đây là cố ghi
 * một terminal state thuộc control plane, nên bị từ chối thay vì được chấp nhận như một giá
 * trị lạ.
 */
export function validateOutcomeRequest(payload: unknown): OutcomeRequestValidation {
  const shape = validateWriteRequestShape(payload, 'outcome', ['dispatch_generation', 'outcome']);
  if (!shape.ok) {
    return shape;
  }
  if (!isPositiveInteger(shape.record.dispatch_generation)) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: 'outcome request: dispatch_generation phải là số nguyên dương.',
    };
  }
  if (!isDeliveryOutcomeValue(shape.record.outcome)) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: 'outcome request: outcome phải là "delivered" hoặc "failed".',
    };
  }
  return {
    ok: true,
    request: {
      dispatch_generation: shape.record.dispatch_generation,
      outcome: shape.record.outcome,
    },
  };
}

/**
 * Kiểm shape chung của request `release`/`outcome`: object, không field lạ, đủ field.
 *
 * `allowed` là danh sách **đóng** các field được phép, nên `release` không thể nhận `outcome`
 * và `outcome` không thể nhận field nào khác ngoài hai field của nó.
 */
function validateWriteRequestShape(
  payload: unknown,
  label: string,
  allowed: readonly string[],
):
  | { readonly ok: true; readonly record: Record<string, unknown> }
  | { readonly ok: false; readonly reason: WriteRequestRejectionReason; readonly detail: string } {
  if (!isPlainObject(payload)) {
    return {
      ok: false,
      reason: 'invalid_payload',
      detail: `${label} request phải là object JSON.`,
    };
  }
  const record = payload;

  // Thứ tự kiểm: field lạ trước, field thiếu sau — field sai không bao giờ bị báo nhầm
  // thành "thiếu". `scanJsonDataObject` cũng chặn symbol key/getter/non-enumerable mà
  // không hề đọc getter.
  const scan = scanJsonDataObject(record, `${label} request`, allowed);
  if (!scan.ok) {
    return { ok: false, reason: scan.reason, detail: scan.detail };
  }

  for (const field of allowed) {
    if (!Object.hasOwn(record, field)) {
      return {
        ok: false,
        reason: 'missing_field',
        detail: `${label} request thiếu field: ${field}.`,
      };
    }
  }

  return { ok: true, record };
}

/* -------------------------------------------------------------------------------------- */
/* `outcome`                                                                              */
/* -------------------------------------------------------------------------------------- */

/**
 * Kết cục mà delivery plane được phép ghi — **đóng**.
 *
 * **Không** có `expired`/`cancelled`: hai state đó thuộc control plane (reconciliation (c),
 * và `cancelled` không có actor ở v1), nên worker **MUST NOT** ghi chúng qua `outcome`.
 */
export const DELIVERY_OUTCOME_VALUES = ['delivered', 'failed'] as const;

/** Union kết cục của `outcome`. */
export type DeliveryOutcomeValue = (typeof DELIVERY_OUTCOME_VALUES)[number];

/** Request `outcome` — fencing token + kết cục; **không** provider response body/credential. */
export interface OutcomeRequest {
  readonly dispatch_generation: number;
  readonly outcome: DeliveryOutcomeValue;
}

/** Body `200` của `outcome`. */
export interface OutcomeAck {
  readonly delivery_id: string;
  readonly status: DeliveryOutcomeValue;
  readonly dispatch_generation: number;
}

/** Kết quả một lần `outcome` — union phân biệt thành công/từ chối. */
export type OutcomeResult =
  | { readonly ok: true; readonly ack: OutcomeAck }
  | { readonly ok: false; readonly rejection: LeaseFencedRejection };

/** Kết quả validate body `200` của `outcome`. */
export type OutcomeValidation =
  | { readonly ok: true; readonly ack: OutcomeAck }
  | { readonly ok: false; readonly reason: WriteAckRejectionReason; readonly detail: string };

/** Kiểm tra một giá trị có phải kết cục hợp lệ. */
export function isDeliveryOutcomeValue(value: unknown): value is DeliveryOutcomeValue {
  return (
    typeof value === 'string' && (DELIVERY_OUTCOME_VALUES as readonly string[]).includes(value)
  );
}

/** Validate body `200` của `outcome`. */
export function validateOutcomeAck(payload: unknown): OutcomeValidation {
  const result = validateWriteAck(payload, 'outcome');
  if (!result.ok) {
    return result;
  }
  if (!isDeliveryOutcomeValue(result.ack.status)) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: 'outcome 200: status phải là "delivered" hoặc "failed".',
    };
  }
  return {
    ok: true,
    ack: {
      delivery_id: result.ack.delivery_id,
      status: result.ack.status,
      dispatch_generation: result.ack.dispatch_generation,
    },
  };
}

/** Dựng body `200` của `outcome` — chạy `validateOutcomeAck` trước khi trả về. */
export function outcomeAck(input: {
  readonly delivery_id: string;
  readonly outcome: DeliveryOutcomeValue;
  readonly dispatch_generation: number;
}): OutcomeAck {
  const candidate = {
    delivery_id: input.delivery_id,
    status: input.outcome,
    dispatch_generation: input.dispatch_generation,
  } as const satisfies OutcomeAck;
  const checked = validateOutcomeAck(candidate);
  if (!checked.ok) {
    throw new Error(`outcomeAck: body không qua validator (${checked.reason}): ${checked.detail}`);
  }
  return checked.ack;
}

/* -------------------------------------------------------------------------------------- */
/* Ack shape dùng chung cho hai operation                                                  */
/* -------------------------------------------------------------------------------------- */

/** Lý do từ chối một body `200` của `release`/`outcome` (ở tầng parse). */
export type WriteAckRejectionReason =
  | 'invalid_payload'
  | 'unexpected_field'
  | 'missing_field'
  | 'invalid_field_type';

/** Ack thô sau khi kiểm shape — `status` chưa bị ép về literal nào. */
interface WriteAckShape {
  readonly ok: true;
  readonly ack: {
    readonly delivery_id: string;
    readonly status: string;
    readonly dispatch_generation: number;
  };
}

/**
 * Kiểm shape chung của `200` trên `release` và `outcome`.
 *
 * Hai operation ghi cùng một ack shape (`delivery_id`, `status`, `dispatch_generation`) và
 * chỉ khác tập `status` hợp lệ, nên shape được kiểm một lần ở đây; phần khác biệt do
 * `validateReleaseAck`/`validateOutcomeAck` xử lý. Không gộp để tránh hai bản kiểm shape
 * trôi khỏi nhau, mà vẫn giữ `detail` nói đúng operation nào.
 */
function validateWriteAck(
  payload: unknown,
  label: string,
):
  | WriteAckShape
  | { readonly ok: false; readonly reason: WriteAckRejectionReason; readonly detail: string } {
  if (!isPlainObject(payload)) {
    return { ok: false, reason: 'invalid_payload', detail: `${label} 200 phải là object JSON.` };
  }
  const record = payload;

  const allowed = ['delivery_id', 'status', 'dispatch_generation'] as const;

  // Field lạ trước, field thiếu sau; symbol key/getter/non-enumerable bị chặn trong scan
  // mà không đọc getter — cùng thứ tự với mọi validator khác của library.
  const scan = scanJsonDataObject(record, `${label} 200`, allowed);
  if (!scan.ok) {
    return { ok: false, reason: scan.reason, detail: scan.detail };
  }

  for (const field of allowed) {
    if (!Object.hasOwn(record, field)) {
      return { ok: false, reason: 'missing_field', detail: `${label} 200 thiếu field: ${field}.` };
    }
  }

  if (!isNonEmptyString(record.delivery_id)) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: `${label} 200: delivery_id phải là chuỗi không rỗng.`,
    };
  }
  if (typeof record.status !== 'string') {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: `${label} 200: status phải là string.`,
    };
  }
  if (!isPositiveInteger(record.dispatch_generation)) {
    return {
      ok: false,
      reason: 'invalid_field_type',
      detail: `${label} 200: dispatch_generation phải là số nguyên dương.`,
    };
  }

  return {
    ok: true,
    ack: {
      delivery_id: record.delivery_id,
      status: record.status,
      dispatch_generation: record.dispatch_generation,
    },
  };
}
