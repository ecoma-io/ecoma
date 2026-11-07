/**
 * Authorization thuần: quyết định một actor có được thực hiện một permission
 * trên tenant hoặc một workspace cụ thể hay không.
 *
 * Source of truth: `docs/domains/llm-consumer-tenant/domain-model.md` §2, §2, §1;
 * `docs/domains/llm-financial/adr/0001-independent-seller-console-tenant.md`.
 *
 * Nguyên tắc:
 * - **Deny-by-default.** Không có nhánh allow nào khi thiếu dữ liệu: actor,
 *   tenant, workspace hay semantics không đọc được đều deny.
 * - **Owner authority.** Owner của tenant có toàn quyền trên tenant và mọi
 *   workspace của nó, kể cả billing. Không có role toàn cục nào bypass tenant
 *   isolation: quyền owner chỉ đúng trên tenant mà actor là owner.
 * - **Member = explicit grant.** Member không có grant thì deny; không có quyền
 *   suy ra từ membership, từ tenant khác hay từ workspace anh em.
 * - **Grant thuộc về một lần membership.** Chỉ grant trỏ đúng `membershipId`
 *   của membership active hiện tại mới được tính. Grant còn sót lại của một
 *   membership đã revoke không bao giờ authorize.
 * - **Không kế thừa ngầm.** Grant tenant scope **không** authorize thao tác
 *   workspace. Ngoại lệ duy nhất là permission được khai báo tường minh là
 *   tenant-wide workspace administration — một semantic của permission, không
 *   phải quy tắc chung.
 * - **Grant workspace scope** chỉ authorize đúng workspace đó.
 * - **Suspension là đầu vào bắt buộc của đường serving.** Nếu caller truyền
 *   `suspension`, một target đang bị chặn thì deny — kể cả owner. Không truyền
 *   thì quyết định chỉ nói về quyền, và caller phải tự gọi
 *   `evaluateSuspensions`; lib không có hàm nào gộp sẵn hai bước để tránh việc
 *   bỏ quên bước suspension trở thành mặc định.
 * - Domain chỉ quyết định allow/deny. Nó không thực thi payment, không giữ
 *   balance/ledger và không gọi dịch vụ nào.
 *
 * Hàm thuần: không I/O, không đọc đồng hồ, không giữ state. Mọi thời điểm liên
 * quan (ví dụ hết hạn membership) do caller truyền vào.
 */

import {
  isPermissionId,
  isTenantActorId,
  isTenantId,
  isWorkspaceId,
  LLM_TENANT_BILLING_MANAGEMENT_PERMISSION,
  type PermissionId,
  type TenantActorId,
} from './shared';
import { findMembership, type Membership } from './membership';
import type { PermissionGrant } from './grants';
import { findWorkspace, type Workspace } from './workspace';
import { isTenantOwner, type Tenant } from './tenant';
import type { SuspensionEvaluation } from './suspension';

/**
 * Semantic khai báo của permission, đọc từ catalog/configuration đã được
 * governance phê duyệt.
 *
 * `tenantWideWorkspaceAdministration`: permission này, khi được grant ở tenant
 * scope, authorize thao tác trên **mọi** workspace của tenant. Đây là một thuộc
 * tính tường minh của từng permission, không phải một luật kế thừa chung.
 *
 * ⚠️ Danh sách này là **input của caller**, không phải catalog do lib sở hữu.
 * Lib chỉ kiểm tính hợp lệ cấu trúc và từ chối khai báo nguy hiểm (wildcard,
 * billing permission).
 */
export interface PermissionSemantics {
  readonly tenantWideWorkspaceAdministration: readonly PermissionId[];
}

/** Đích của một lần kiểm authorization. */
export type AuthorizationTarget =
  | { readonly kind: 'tenant' }
  | { readonly kind: 'workspace'; readonly workspaceId: unknown };

/** Yêu cầu authorization. */
export interface AuthorizationRequest {
  readonly actor: unknown;
  readonly tenant: Tenant;
  readonly permission: unknown;
  readonly target: AuthorizationTarget;
  readonly memberships: readonly Membership[];
  readonly grants: readonly PermissionGrant[];
  readonly workspaces: readonly Workspace[];
  readonly semantics: PermissionSemantics;
  /**
   * Kết quả đánh giá suspension cho **cùng** target tại **cùng** thời điểm.
   *
   * Bỏ trống chỉ hợp lệ khi caller đã chắc chắn target không bị suspension;
   * cách an toàn là truyền kết quả của `evaluateSuspensions`. Một evaluation
   * đang `blocked` hoặc `unevaluable` luôn deny.
   */
  readonly suspension?: SuspensionEvaluation;
}

/** Lý do deny — tập ĐÓNG để audit không ghép chữ tự do. */
export type AuthorizationDenialReason =
  /** Actor/tenant/permission/target không đọc được. */
  | 'invalid_context'
  /** Bối cảnh lẫn dữ liệu của tenant khác. */
  | 'inconsistent_context'
  /** Workspace không thuộc tenant đang xét (hoặc không tồn tại). */
  | 'workspace_not_in_tenant'
  /** Actor không có membership trong tenant. */
  | 'membership_missing'
  /** Membership đã bị revoke. */
  | 'membership_revoked'
  /** Nhiều hơn một membership active cho cùng actor — dữ liệu hỏng. */
  | 'membership_ambiguous'
  /** Target đang bị suspension chặn. */
  | 'target_suspended'
  /** Không đánh giá được suspension của target. */
  | 'suspension_unevaluable'
  /** Không có grant nào cấp permission cho đích này. */
  | 'permission_not_granted';

/** Cơ sở của một quyết định allow — để audit ghi được lý do. */
export type AuthorizationBasis =
  /** Actor là owner của tenant. */
  | 'owner'
  /** Grant tenant scope trên đúng permission. */
  | 'tenant_grant'
  /** Grant workspace scope trên đúng workspace và đúng permission. */
  | 'workspace_grant'
  /** Grant tenant scope của permission được khai báo tenant-wide workspace admin. */
  | 'tenant_wide_workspace_administration';

/** Kết quả authorization. */
export type TenantAuthorizationDecision =
  | { readonly allowed: true; readonly basis: AuthorizationBasis }
  | { readonly allowed: false; readonly reason: AuthorizationDenialReason };

const DENY_INVALID_CONTEXT: TenantAuthorizationDecision = {
  allowed: false,
  reason: 'invalid_context',
};
const DENY_INCONSISTENT_CONTEXT: TenantAuthorizationDecision = {
  allowed: false,
  reason: 'inconsistent_context',
};
const DENY_WORKSPACE: TenantAuthorizationDecision = {
  allowed: false,
  reason: 'workspace_not_in_tenant',
};
const DENY_MISSING_MEMBERSHIP: TenantAuthorizationDecision = {
  allowed: false,
  reason: 'membership_missing',
};
const DENY_REVOKED: TenantAuthorizationDecision = { allowed: false, reason: 'membership_revoked' };
const DENY_AMBIGUOUS: TenantAuthorizationDecision = {
  allowed: false,
  reason: 'membership_ambiguous',
};
const DENY_SUSPENDED: TenantAuthorizationDecision = {
  allowed: false,
  reason: 'target_suspended',
};
const DENY_SUSPENSION_UNEVALUABLE: TenantAuthorizationDecision = {
  allowed: false,
  reason: 'suspension_unevaluable',
};
const DENY_NOT_GRANTED: TenantAuthorizationDecision = {
  allowed: false,
  reason: 'permission_not_granted',
};

function isSemanticsValid(semantics: unknown): semantics is PermissionSemantics {
  if (typeof semantics !== 'object' || semantics === null) {
    return false;
  }
  const list = (semantics as PermissionSemantics).tenantWideWorkspaceAdministration;
  if (!Array.isArray(list)) {
    return false;
  }
  return list.every(
    (entry) =>
      isPermissionId(entry) &&
      // Wildcard/bao trùm không được khai báo là tenant-wide: ADR-0010 loại
      // permission bao trùm, và một khai báo như vậy biến mọi grant tenant scope
      // thành quyền workspace toàn tenant.
      !entry.includes('*') &&
      // Billing permission cấp quyền khởi tạo/top up cho tenant, không cấp quyền
      // quản trị workspace. Khai báo nó là tenant-wide workspace admin là mở
      // rộng quyền billing sang thao tác workspace — fail closed.
      entry !== LLM_TENANT_BILLING_MANAGEMENT_PERMISSION,
  );
}

/** Suspension cho phép/không cho phép target hay không đánh giá được. */
function suspensionVerdict(
  suspension: SuspensionEvaluation | undefined,
): TenantAuthorizationDecision | undefined {
  if (suspension === undefined) {
    return undefined;
  }
  if (typeof suspension !== 'object' || suspension === null) {
    return DENY_SUSPENSION_UNEVALUABLE;
  }
  // `blocked` không phải `true`/`false` ⇒ không đọc được `blocked` hay
  // `unknownPolicies`; không có hàm đọc được một evaluation ⇒ deny.
  if (
    typeof suspension.blocked !== 'boolean' ||
    typeof suspension.unevaluable !== 'boolean' ||
    !Array.isArray(suspension.unknownPolicies) ||
    !Array.isArray(suspension.blockingRecordIds)
  ) {
    return DENY_SUSPENSION_UNEVALUABLE;
  }
  // Không chứng minh được là không bị hạn chế ⇒ deny với lý do riêng, không gộp
  // vào "đang bị chặn": caller cần phân biệt lỗi dữ liệu policy với một
  // suspension có thật.
  if (suspension.unevaluable) {
    return DENY_SUSPENSION_UNEVALUABLE;
  }
  if (suspension.blocked) {
    return DENY_SUSPENDED;
  }
  return undefined;
}

/**
 * Quyết định authorization cho một request.
 *
 * Thứ tự kiểm (fail-closed, mỗi lớp không suy ra lớp sau):
 * 1. Actor, tenant id, permission, target, semantics đọc được không.
 * 2. Bối cảnh nhất quán: membership/grant/workspace thuộc đúng tenant.
 * 3. Target workspace thuộc đúng tenant — sai thì deny, kể cả khi workspace ID
 *    tồn tại ở tenant khác.
 * 4. Suspension đang chặn target ⇒ deny, **kể cả owner**.
 * 5. Owner của tenant ⇒ allow (`owner`) trên mọi target của tenant.
 * 6. Membership active của actor trong tenant; thiếu ⇒ deny, revoke ⇒ deny,
 *    nhiều hơn một active ⇒ deny (`membership_ambiguous`).
 * 7. Grant trỏ đúng membership active đó, khớp permission **và** khớp scope
 *    của target ⇒ allow.
 *    - Target tenant: chỉ grant tenant scope.
 *    - Target workspace: grant workspace scope của đúng workspace; hoặc grant
 *      tenant scope **chỉ khi** permission được khai báo tenant-wide workspace
 *      administration.
 * 8. Còn lại ⇒ deny.
 */
export function authorizeTenantAction(request: AuthorizationRequest): TenantAuthorizationDecision {
  const {
    actor,
    tenant,
    permission,
    target,
    memberships,
    grants,
    workspaces,
    semantics,
    suspension,
  } = request;

  // (1) Ngữ cảnh đọc được
  if (
    !isTenantActorId(actor) ||
    tenant === null ||
    typeof tenant !== 'object' ||
    !isTenantId(tenant.id) ||
    !isTenantActorId(tenant.owner) ||
    !isPermissionId(permission) ||
    target === null ||
    typeof target !== 'object' ||
    (target.kind !== 'tenant' && target.kind !== 'workspace') ||
    !isSemanticsValid(semantics) ||
    !Array.isArray(memberships) ||
    !Array.isArray(grants) ||
    !Array.isArray(workspaces)
  ) {
    return DENY_INVALID_CONTEXT;
  }

  let workspaceId: unknown;
  if (target.kind === 'workspace') {
    workspaceId = target.workspaceId;
    if (!isWorkspaceId(workspaceId)) {
      return DENY_INVALID_CONTEXT;
    }
  }

  // (2) Bối cảnh nhất quán — dữ liệu lẫn tenant là lỗi, không phải tín hiệu bỏ qua
  if (
    memberships.some((membership) => membership.tenantId !== tenant.id) ||
    grants.some((grant) => grant.tenantId !== tenant.id) ||
    workspaces.some((workspace) => workspace.tenantId !== tenant.id)
  ) {
    return DENY_INCONSISTENT_CONTEXT;
  }

  // (3) Target workspace thuộc tenant
  if (target.kind === 'workspace') {
    if (findWorkspace(workspaces, tenant.id, workspaceId as never) === undefined) {
      return DENY_WORKSPACE;
    }
  }

  // (4) Suspension chặn target — trước cả owner authority
  const suspensionDecision = suspensionVerdict(suspension);
  if (suspensionDecision !== undefined) {
    return suspensionDecision;
  }

  // (5) Owner authority trên chính tenant của mình
  if (isTenantOwner(tenant, actor as TenantActorId)) {
    return { allowed: true, basis: 'owner' };
  }

  // (6) Đúng một membership active
  const actorMemberships = memberships.filter(
    (candidate) => candidate.tenantId === tenant.id && candidate.actor === actor,
  );
  if (actorMemberships.length === 0) {
    return DENY_MISSING_MEMBERSHIP;
  }
  const active = actorMemberships.filter((candidate) => candidate.status === 'active');
  if (active.length === 0) {
    return DENY_REVOKED;
  }
  if (active.length > 1) {
    return DENY_AMBIGUOUS;
  }
  const membership = active[0] as Membership;
  // Bất biến: đúng một bản ghi active cho `(tenant, actor)`; `findMembership`
  // là đường đọc duy nhất và cùng kết luận.
  if (findMembership([membership], tenant.id, actor as TenantActorId) === undefined) {
    return DENY_AMBIGUOUS;
  }

  // (7) Grant của **chính membership đang active**
  const actorGrants = grants.filter(
    (grant) =>
      grant.tenantId === tenant.id &&
      grant.membershipId === membership.id &&
      grant.permission === permission,
  );

  if (target.kind === 'tenant') {
    if (actorGrants.some((grant) => grant.scope.kind === 'tenant')) {
      return { allowed: true, basis: 'tenant_grant' };
    }
    return DENY_NOT_GRANTED;
  }

  const exact = actorGrants.some(
    (grant) => grant.scope.kind === 'workspace' && grant.scope.workspaceId === workspaceId,
  );
  if (exact) {
    return { allowed: true, basis: 'workspace_grant' };
  }

  const tenantWide = semantics.tenantWideWorkspaceAdministration.includes(
    permission as PermissionId,
  );
  if (tenantWide && actorGrants.some((grant) => grant.scope.kind === 'tenant')) {
    return { allowed: true, basis: 'tenant_wide_workspace_administration' };
  }

  return DENY_NOT_GRANTED;
}
