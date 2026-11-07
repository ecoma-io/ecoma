/**
 * Entitlement **event contract** — envelope của sự kiện thay đổi entitlement
 * mà Staff Access phát khi trạng thái sản phẩm của một nhân sự đổi.
 *
 * Source of truth (docs/domains/staff-access/):
 * - `README.md` §3: thay đổi entitlement được ghi cùng transactional outbox
 *   trong một transaction (invariant A8) và truyền đến sản phẩm bằng event bất
 *   đồng bộ; **cơ chế cụ thể và cách bảo đảm revocation latency là quyết định
 *   chưa chốt** (ADR-0002, Phase 2).
 * - [ADR-0009](../../domains/staff-access/adr/0009-no-internal-authorization-result-contract.md):
 *   event entitlement **KHÔNG** phải internal authorization-result contract —
 *   nó truyền **tính khả dụng sản phẩm**, không truyền verdict allow/deny cho
 *   từng request; không sync call trên đường request.
 * - ADR-0002: ngưỡng revocation latency `normal` ≤ 60s / `high` ≤ 5s là
 *   **target**, không phải bảo đảm; cơ chế đáp ứng thuộc Phase 2.
 *
 * ⚠️ **Đây là envelope, KHÔNG phải transport.** Contract này không nói gì về
 * hàng đợi, tên queue, batch pull hay sync call; ADR-0009 cấm đường sync-call
 * per-request, và cơ chế delivery của Phase 2 (P2.2 outbox relay / P2.5) ghim
 * bằng ADR riêng. Trong contract này KHÔNG có tên queue/topic, KHÔNG có SLA,
 * KHÔNG có promise guarantee — chỉ shape của payload đi qua bất kỳ kênh nào.
 *
 * ⚠️ Tập type event **mở** — `entitlement.granted`/`entitlement.revoked` là hai
 * giá trị có hôm nay; thêm loại event mới (vd suspend toàn bộ) là mở rộng có
 * kiểm, không phá consumer xử lý theo `type`.
 */

/** Loại event entitlement có hôm nay — tập mở (xem doc đầu file). */
export type EntitlementEventType = 'entitlement.granted' | 'entitlement.revoked';

export const ENTITLEMENT_EVENT_TYPES = ['entitlement.granted', 'entitlement.revoked'] as const;

/** Type guard cho {@link EntitlementEventType}. */
export function isEntitlementEventType(value: unknown): value is EntitlementEventType {
  return (
    typeof value === 'string' && (ENTITLEMENT_EVENT_TYPES as readonly string[]).includes(value)
  );
}

/** Producer khai báo nguồn phát — hằng duy nhất của lib này. */
export const ENTITLEMENT_EVENT_PRODUCER = 'staff-access';

/**
 * Nhóm trường mà một entitlement event **cấm** mang — cùng ranh giới ADR-0009
 * với read model: event truyền tính khả dụng sản phẩm, không truyền kết quả
 * authorize, permission hay role.
 */
export const FORBIDDEN_ENTITLEMENT_EVENT_FIELDS = [
  'verdict',
  'decision',
  'allow',
  'deny',
  'allowed',
  'denied',
  'permissions',
  'roles',
  'assignments',
  'scope',
  'risk_class',
  'authorization',
  'queue',
  'topic',
  'transport',
] as const;

/** Envelope event entitlement. */
export interface EntitlementEvent {
  /** UUIDv4 của lần phát — idempotency key của consumer. */
  readonly event_id: string;
  /** Loại event — tập mở, xem {@link EntitlementEventType}. */
  readonly type: EntitlementEventType;
  /** Staff member bị tác động — định danh của Staff Access (không phải `sub`). */
  readonly staff_id: string;
  /** Sản phẩm. */
  readonly product: 'backoffice' | 'pact-broker' | 'remote-cache';
  /**
   * Số phiên tăng đơn điệu theo `(staff_id, product)` — giống `revision` của
   * read model (`entitlement-read-contract.ts`). Event là **nguồn sinh** read
   * model: revision của event và của entry read model cho cùng thay đổi bằng
   * nhau, consumer so revision thay vì so `occurred_at`.
   */
  readonly revision: number;
  /** Thời điểm trạng thái đổi — ISO 8601 có offset/Z (không phải thời điểm deliver). */
  readonly occurred_at: string;
  /** Nguồn phát — luôn `'staff-access'`. */
  readonly producer: typeof ENTITLEMENT_EVENT_PRODUCER;
}

/** Lý do từ chối một entitlement event. */
export type EntitlementEventRejectionReason =
  | 'invalid_payload'
  | 'invalid_event_id'
  | 'invalid_type'
  | 'invalid_product'
  | 'invalid_revision'
  | 'invalid_occurred_at'
  | 'invalid_producer'
  | 'forbidden_field';

/** Shape tổng quát của validation result trong lib này. */
export type EntitlementEventValidation<T> =
  | { readonly ok: true; readonly payload: T }
  | {
      readonly ok: false;
      readonly reason: EntitlementEventRejectionReason;
      readonly detail: string;
    };

/** Kết quả validate một event. */
export type EntitlementEventEntryValidation = EntitlementEventValidation<EntitlementEvent>;

const ENTITLEMENT_EVENT_KEYS = [
  'event_id',
  'type',
  'staff_id',
  'product',
  'revision',
  'occurred_at',
  'producer',
] as const;

/** Pattern UUID hình thức — bất kỳ variant nào, dùng để chặn chuỗi rỗng/kỳ dị. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Kiểm tra timestamp ISO 8601 hình thức (chuỗi, parse được, có múi giờ rõ). */
function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (Number.isNaN(Date.parse(value))) return false;
  return /(?:Z|[+-]\d{2}:?\d{2})$/u.test(value);
}

/**
 * Kiểm tra một entitlement event — cấm trường authorization/transport trước,
 * rồi kiểm shape từng trường.
 *
 * ⚠️ Không nối **giá trị** trường bị cấm vào `detail`; chỉ nêu tên trường.
 */
export function validateEntitlementEvent(value: unknown): EntitlementEventEntryValidation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Entitlement event must be an object.' };
  }
  const record = value as Record<string, unknown>;

  for (const field of FORBIDDEN_ENTITLEMENT_EVENT_FIELDS) {
    if (field in record) {
      return {
        ok: false,
        reason: 'forbidden_field',
        detail: `Entitlement event carries a forbidden field: ${field}.`,
      };
    }
  }

  const keys = Object.keys(record);
  for (const key of ENTITLEMENT_EVENT_KEYS) {
    if (!keys.includes(key)) {
      return {
        ok: false,
        reason: 'invalid_payload',
        detail: `Entitlement event is missing required field: ${key}.`,
      };
    }
  }
  for (const key of keys) {
    if (!(ENTITLEMENT_EVENT_KEYS as readonly string[]).includes(key)) {
      return {
        ok: false,
        reason: 'forbidden_field',
        detail: `Entitlement event carries a field outside the contract: ${key}.`,
      };
    }
  }

  if (typeof record.event_id !== 'string' || !UUID_PATTERN.test(record.event_id)) {
    return {
      ok: false,
      reason: 'invalid_event_id',
      detail: 'event_id must be a UUID string.',
    };
  }
  if (!isEntitlementEventType(record.type)) {
    return {
      ok: false,
      reason: 'invalid_type',
      detail: 'type must be "entitlement.granted" or "entitlement.revoked".',
    };
  }
  if (typeof record.staff_id !== 'string' || record.staff_id.length === 0) {
    return {
      ok: false,
      reason: 'invalid_payload',
      detail: 'staff_id must be a non-empty string.',
    };
  }
  if (
    record.product !== 'backoffice' &&
    record.product !== 'pact-broker' &&
    record.product !== 'remote-cache'
  ) {
    return {
      ok: false,
      reason: 'invalid_product',
      detail: 'product is not a known internal product.',
    };
  }
  if (
    typeof record.revision !== 'number' ||
    !Number.isInteger(record.revision) ||
    record.revision < 1 ||
    record.revision > Number.MAX_SAFE_INTEGER
  ) {
    return {
      ok: false,
      reason: 'invalid_revision',
      detail: 'revision must be a positive integer.',
    };
  }
  if (!isIsoTimestamp(record.occurred_at)) {
    return {
      ok: false,
      reason: 'invalid_occurred_at',
      detail: 'occurred_at must be an ISO 8601 timestamp with an explicit offset or Z.',
    };
  }
  if (record.producer !== ENTITLEMENT_EVENT_PRODUCER) {
    return {
      ok: false,
      reason: 'invalid_producer',
      detail: `producer must be "${ENTITLEMENT_EVENT_PRODUCER}".`,
    };
  }

  return {
    ok: true,
    payload: {
      event_id: record.event_id,
      type: record.type,
      staff_id: record.staff_id,
      product: record.product,
      revision: record.revision,
      occurred_at: record.occurred_at,
      producer: record.producer,
    },
  };
}

/**
 * Dựng event hợp lệ — một chỗ dựng duy nhất; producer bị ghim, caller không
 * tự khai nguồn khác.
 */
export function entitlementEvent(input: {
  readonly eventId: string;
  readonly type: EntitlementEventType;
  readonly staffId: string;
  readonly product: EntitlementEvent['product'];
  readonly revision: number;
  readonly occurredAt: string;
}): EntitlementEvent {
  return {
    event_id: input.eventId,
    type: input.type,
    staff_id: input.staffId,
    product: input.product,
    revision: input.revision,
    occurred_at: input.occurredAt,
    producer: ENTITLEMENT_EVENT_PRODUCER,
  };
}
