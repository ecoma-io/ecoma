/**
 * Use case `provisionEntitlementMembership` — áp dụng event entitlement vào
 * membership Pact Broker (roadmap P3.2, issue #457) trên tenant canonical
 * READ ONLY (issue #21: serving path không tạo tenant).
 *
 * ⚠️ Đây là application layer: **không SQL, không HTTP framework, không Node
 * builtin**. Mọi I/O đi qua port (`MembershipRepo`, `EntitlementSyncRepo`), mọi
 * ngưỡng là tham số. Quyết định áp dụng event dùng `shouldApplyEntitlementEvent`
 * (pure, P2.3) — compare-and-drop theo `revision`.
 *
 * ⚠️ Tenant canonical `ecoma` được provision TRƯỚC bởi đường bootstrap
 * (first_party, xem `apps/pact-broker-api/db/bootstrap-tenant.mts`). Serving
 * path chỉ ĐỌC qua `getTenantByName` — không có khả năng tạo tenant. Grant
 * gặp tenant thiếu hoặc không active → ném `CanonicalTenantUnavailableError`
 * fail-closed (consumer chuyển thành message.retry → DLQ sau `max_retries`),
 * không tự sửa dữ liệu. Revoke gặp tenant thiếu → `no-tenant`, bỏ qua lặng.
 *
 * Ranh giới entitlement ≠ authorization (ADR-0009): event chỉ mang "tính khả
 * dụng sản phẩm", không mang role/permission. Khi event `entitlement.granted`
 * cho `product: 'pact-broker'`, provision membership role `Member` vào
 * `pact.tenant_members` của tenant canonical (sub = event.staff_id, vì `sub`
 * là tham chiếu opaque không FK — xem
 * `docs/applications/pact-broker/01-architecture.md` §3.1). Event
 * `entitlement.revoked`: ghi nhận revision để consumer idempotent, KHÔNG xóa
 * membership (P3.3 sở hữu logic thu hồi). Event cho sản phẩm khác
 * `pact-broker`: bỏ qua lặng (không phải sản phẩm của bounded context này).
 *
 * ⚠️ `staff_id` → `sub`: event mang `staff_id` (định danh Staff Access
 * directory, không phải `sub`), không thể mở rộng envelope (contract P1.2 đã
 * lock), và one-service-one-database cấm pact-broker-api query db-staff-access
 * để resolve staff_id→sub. Do đó `sub` nhận trực tiếp `event.staff_id` — hợp
 * lệ vì `sub` là opaque, không FK, mapping sub→staff là server-side của Staff
 * Access (ADR-0012 §4).
 */

import { shouldApplyEntitlementEvent } from '@ecoma-io/staff-access-contracts';
import type { EntitlementEvent } from '@ecoma-io/staff-access-contracts';

/** Sản phẩm mà bounded context pact-broker quan tâm — provision membership khi granted. */
export const PRODUCT_PACT_BROKER = 'pact-broker';

/** Role ban đầu khi provision entitlement: Member (trừ khi quy trình quản trị rõ ràng khác). */
export const DEFAULT_MEMBER_ROLE = 'member';

/**
 * Tên tenant canonical mà serving path entitlement đọc (ADR-0020 decision 9:
 * mọi `ecoma-internal` còn lại đọc là `ecoma`). Không phụ thuộc môi trường —
 * cấu hình chỉ cung cấp kết nối, không cung cấp định danh tenant.
 */
export const CANONICAL_TENANT_NAME = 'ecoma';

/**
 * Lỗi fail-closed khi tenant canonical thiếu hoặc không active lúc grant.
 * Consumer bắt lỗi này qua catch của batch → message.retry → DLQ sau
 * `max_retries`: một grant không thể áp dụng không được biến thành ack.
 */
export class CanonicalTenantUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalTenantUnavailableError';
  }
}

/** Kết quả một lượt áp dụng event. */
export interface ProvisionEntitlementMembershipResult {
  /** Có áp dụng event vào DB hay không. */
  readonly applied: boolean;
  /** Lý do: `first`/`newer`/`duplicate`/`stale`/`invalid`/`not-product`/`no-tenant`. */
  readonly reason:
    | 'first'
    | 'newer'
    | 'duplicate'
    | 'stale'
    | 'invalid'
    | 'not-product'
    | 'no-tenant';
}

/** Port đọc/ghi revision đã áp dụng cho cặp (staff_id, product). */
export interface EntitlementSyncRepo {
  /** Revision lớn nhất đã áp dụng, hoặc `null` nếu chưa thấy event nào. */
  readRevision(staffId: string, product: string): Promise<number | null>;
  /** CAS ghi revision đã áp dụng cho cặp (staff_id, product). Trả true nếu tiến lên. */
  writeRevision(
    staffId: string,
    product: string,
    revision: number,
    provenance?: {
      readonly eventId?: string;
      readonly source?: 'entitlement' | 'bootstrap' | 'admin';
    },
  ): Promise<boolean>;
}

/** Bản ghi tenant dạng read-only mà port tra cứu trả về (không dùng để ghi). */
export interface TenantLookup {
  readonly id: string;
  readonly name: string;
  readonly status: string;
}

/** Port tra cứu tenant (read-only) + upsert membership. */
export interface MembershipRepo {
  /**
   * Tra cứu tenant theo tên — READ ONLY, trả `null` khi không tồn tại.
   * Serving path entitlement cố tình KHÔNG có khả năng tạo tenant: việc
   * provision tenant thuộc đường bootstrap/quản trị, không thuộc đường cung.
   */
  getTenantByName(name: string): Promise<TenantLookup | null>;
  /**
   * Upsert membership `(tenant_id, sub, role)` — DO NOTHING nếu đã có.
   * Provenance entitlement được ghi kèm khi membership do entitlement tạo.
   */
  upsertMember(
    tenantId: string,
    sub: string,
    role: string,
    provenance?: {
      readonly eventId: string;
      readonly revision: number;
      readonly source: 'entitlement' | 'bootstrap' | 'admin';
    },
  ): Promise<void>;
  /** Đánh dấu projection entitlement bị revoke cho membership đã confluent (không xóa row, không đổi role). */
  markEntitlementRevoked(
    tenantId: string,
    sub: string,
    eventId: string,
    revision: number,
  ): Promise<void>;
}

/**
 * Áp dụng một entitlement event vào membership Pact Broker trên tenant
 * canonical read-only.
 *
 * @returns `{ applied, reason }` — composition root dịch ra log một dòng,
 * không dựng response HTTP hay lỗi exposing nội bộ.
 */
export async function provisionEntitlementMembership(
  event: EntitlementEvent,
  deps: { membership: MembershipRepo; sync: EntitlementSyncRepo },
): Promise<ProvisionEntitlementMembershipResult> {
  // Chỉ quan tâm sản phẩm của chính bounded context này.
  if (event.product !== PRODUCT_PACT_BROKER) {
    return { applied: false, reason: 'not-product' };
  }

  // So revision theo cặp (staff_id, product) — compare-and-drop.
  const current = await deps.sync.readRevision(event.staff_id, event.product);
  const decision = shouldApplyEntitlementEvent(current, event);
  if (!decision.apply) {
    return { applied: false, reason: decision.reason };
  }

  if (event.type === 'entitlement.revoked') {
    // Revoke by projection: KHÔNG xóa membership, KHÔNG đổi role. CAS revision
    // TRƯỚC (thứ tự giữ nguyên từ P3.3): ghi nhận revision của event revoked
    // là durable trước khi mark projection sau đó (mark idempotent theo
    // revision, chỉ áp source='entitlement').
    const advanced = await deps.sync.writeRevision(event.staff_id, event.product, event.revision);
    if (!advanced) {
      return { applied: false, reason: 'duplicate' };
    }
    // Tra cứu read-only SAU CAS. Thiếu tenant canonical → `no-tenant`: KHÔNG
    // tạo tenant, KHÔNG rollback revision (event revoked đã được ghi nhận,
    // không có membership nào để mark). Lookup ném lỗi (DB lỗi thật) thì lan
    // lên để Queue retry — không nuốt bằng try/catch.
    const tenant = await deps.membership.getTenantByName(CANONICAL_TENANT_NAME);
    if (tenant === null) {
      return { applied: false, reason: 'no-tenant' };
    }
    // Mark projection revoked on the entitlement-sourced membership if present.
    // Customer-managed memberships (source != 'entitlement') are NOT touched.
    await deps.membership.markEntitlementRevoked(
      tenant.id,
      event.staff_id,
      event.event_id,
      event.revision,
    );
    return { applied: false, reason: decision.reason };
  }

  // `entitlement.granted`: tra cứu tenant canonical READ ONLY TRƯỚC CAS. Thứ
  // tự này là bắt buộc: nếu CAS chạy trước mà lookup fail-closed sau đó,
  // revision đã tiến nhưng membership chưa ghi — redelivery bị drop như
  // duplicate và membership write mất vĩnh viễn. Lookup trước CAS bảo đảm
  // khi ném lỗi thì chưa có side effect nào được ghi.
  const tenant = await deps.membership.getTenantByName(CANONICAL_TENANT_NAME);
  if (tenant === null || tenant.status !== 'active') {
    throw new CanonicalTenantUnavailableError(
      tenant === null
        ? `canonical tenant ${CANONICAL_TENANT_NAME} is missing; entitlement grant fails closed (bootstrap the canonical tenant first)`
        : `canonical tenant ${CANONICAL_TENANT_NAME} is ${tenant.status}; entitlement grant fails closed`,
    );
  }
  // CAS atomic: writeRevision trả false nếu revision không tiến lên (lost race).
  // Khi lost race → coi như duplicate/stale, không side effect.
  const advanced = await deps.sync.writeRevision(event.staff_id, event.product, event.revision, {
    eventId: event.event_id,
    source: 'entitlement',
  });
  if (!advanced) {
    return { applied: false, reason: 'duplicate' };
  }
  // Upsert membership role Member với provenance entitlement (staff_id → sub
  // mapping recorded as provenance, KHÔNG coi staff_id là sub theo contract).
  await deps.membership.upsertMember(tenant.id, event.staff_id, DEFAULT_MEMBER_ROLE, {
    eventId: event.event_id,
    revision: event.revision,
    source: 'entitlement',
  });

  return { applied: true, reason: decision.reason };
}

export type { EntitlementEvent };
