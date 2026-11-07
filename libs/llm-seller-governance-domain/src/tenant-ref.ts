/**
 * Tham chiếu tenant/membership mà governance đọc — khai báo **tại biên** của
 * governance, không import model của `llm-seller-tenant`.
 *
 * ADR-0018 giới hạn phụ thuộc của governance vào tenant đúng ở
 * identity/value primitive. Appeal cần biết owner và membership đang `active`
 * của tenant để xét eligibility, nhưng không được kéo model aggregate root của
 * tenant vào — nếu không, một thay đổi shape của SellerTenant sẽ buộc rebuild
 * và re-review governance.
 *
 * Shape ở đây là tập con tối thiểu đúng bằng field mà governance đọc; guard
 * giữ nguyên độ chặt của guard tương ứng bên tenant để dữ liệu hỏng vẫn bị từ
 * chối thay vì lọt qua.
 */

import {
  isEpochMillis,
  isMembershipId,
  isSellerActorId,
  isSellerTenantId,
  type MembershipId,
  type SellerActorId,
  type SellerTenantId,
} from './shared';

/** Tập con của Seller tenant mà governance đọc. */
export interface GovernanceTenantRef {
  readonly id: SellerTenantId;
  readonly owner: SellerActorId;
}

/** Tập con của một membership incarnation mà governance đọc. */
export interface GovernanceMembershipRef {
  readonly id: MembershipId;
  readonly tenantId: SellerTenantId;
  readonly actor: SellerActorId;
  readonly status: 'active' | 'revoked';
  readonly createdAt: number;
  readonly revokedAt: number | null;
}

/** Type guard cho `GovernanceTenantRef`. */
export function isGovernanceTenantRef(value: unknown): value is GovernanceTenantRef {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { id?: unknown; owner?: unknown };
  return isSellerTenantId(candidate.id) && isSellerActorId(candidate.owner);
}

/** Type guard cho `GovernanceMembershipRef`. */
export function isGovernanceMembershipRef(value: unknown): value is GovernanceMembershipRef {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as {
    id?: unknown;
    tenantId?: unknown;
    actor?: unknown;
    status?: unknown;
    createdAt?: unknown;
    revokedAt?: unknown;
  };
  if (
    !isMembershipId(candidate.id) ||
    !isSellerTenantId(candidate.tenantId) ||
    !isSellerActorId(candidate.actor) ||
    !isEpochMillis(candidate.createdAt)
  ) {
    return false;
  }
  if (candidate.status === 'active') {
    return candidate.revokedAt === null;
  }
  if (candidate.status === 'revoked') {
    return isEpochMillis(candidate.revokedAt);
  }
  return false;
}

/** Membership đang `active`? */
export function isGovernanceMembershipActive(membership: GovernanceMembershipRef): boolean {
  return membership.status === 'active' && membership.revokedAt === null;
}
