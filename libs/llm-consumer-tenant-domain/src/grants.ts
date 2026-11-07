/**
 * Permission grant trực tiếp cho member — không có role entity, không có
 * custom-role administration.
 *
 * Source of truth: `docs/domains/llm-consumer-tenant/domain-model.md` §2, §2, §1;
 * quyết định trong `docs/domains/llm-financial/adr/0001-independent-seller-console-tenant.md`.
 *
 * Quy tắc scope:
 * - Grant có **đúng một** scope: `tenant` hoặc `workspace`.
 * - **Không có kế thừa ngầm.** Grant tenant scope **không** authorize thao tác
 *   trên một workspace — trừ khi permission đó được khai báo tường minh là
 *   tenant-wide workspace administration (`./authorization.ts`,
 *   `PermissionSemantics`).
 * - Grant workspace scope chỉ áp dụng cho **đúng** workspace đó, và workspace
 *   đó phải thuộc tenant của grant.
 *
 * Grant trỏ tới **một lần membership cụ thể** (`membershipId`), không chỉ tới
 * `sub`:
 * - Revoke membership làm mọi grant của lần đó mất hiệu lực ở đường
 *   authorization, và provision lại tạo `id` mới nên grant cũ **không** sống
 *   lại. Nếu grant chỉ khoá theo `sub`, revoke rồi provision lại sẽ khôi phục
 *   quyền cũ mà không có quyết định cấp quyền mới — đây là lý do membershipId
 *   là một phần danh tính của grant.
 * - Grant chỉ cấp cho membership **active** trong cùng tenant. Owner không cần
 *   grant: quyền owner là quan hệ riêng trên tenant.
 *
 * Grant không mang thời hạn hiệu lực: thu hồi grant là xoá bản ghi ở tầng
 * application. Không có TTL cho grant trong model này.
 */

import {
  isMembershipId,
  isPermissionId,
  isTenantId,
  isWorkspaceId,
  llmTenantFailure,
  llmTenantOk,
  type LlmTenantResult,
  type MembershipId,
  type PermissionId,
  type TenantId,
  type WorkspaceId,
} from './shared';
import { isMembershipActive, type Membership } from './membership';
import { findWorkspace, type Workspace } from './workspace';

/** Scope tenant: áp dụng cho chính tenant, không cho workspace cụ thể. */
export interface TenantGrantScope {
  readonly kind: 'tenant';
}

/** Scope workspace: áp dụng cho đúng một workspace. */
export interface WorkspaceGrantScope {
  readonly kind: 'workspace';
  readonly workspaceId: WorkspaceId;
}

/** Scope của một grant. */
export type GrantScope = TenantGrantScope | WorkspaceGrantScope;

/** Một permission grant trực tiếp cho một membership trong một tenant. */
export interface PermissionGrant {
  readonly tenantId: TenantId;
  readonly membershipId: MembershipId;
  readonly permission: PermissionId;
  readonly scope: GrantScope;
}

/** Input tạo grant. */
export interface CreateGrantInput {
  readonly tenantId: unknown;
  readonly membershipId: unknown;
  readonly permission: unknown;
  readonly scope: unknown;
}

/** Bối cảnh cần để kiểm grant mới có hợp lệ không. */
export interface GrantIssuanceContext {
  /** Membership của **cùng tenant**. */
  readonly memberships: readonly Membership[];
  /** Workspace của **cùng tenant**. */
  readonly workspaces: readonly Workspace[];
  /** Grant hiện có của **cùng tenant**. */
  readonly grants: readonly PermissionGrant[];
}

function isGrantScope(value: unknown): value is GrantScope {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const scope = value as { kind?: unknown; workspaceId?: unknown };
  if (scope.kind === 'tenant') {
    return !Object.hasOwn(scope, 'workspaceId');
  }
  return scope.kind === 'workspace' && isWorkspaceId(scope.workspaceId);
}

function sameScope(left: GrantScope, right: GrantScope): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  return left.kind === 'tenant' || left.workspaceId === (right as WorkspaceGrantScope).workspaceId;
}

/**
 * Tạo một permission grant.
 *
 * Từ chối khi:
 * - định danh/permission/scope không đọc được (`invalid_*`,
 *   `invalid_permission_id`);
 * - bối cảnh lẫn tenant khác (`inconsistent_context`);
 * - membership không tồn tại hoặc không active (`membership_not_found`);
 * - grant workspace scope trỏ tới workspace không thuộc tenant
 *   (`workspace_not_in_tenant`);
 * - đã tồn tại grant cùng `(membershipId, permission, scope)`
 *   (`duplicate_grant`) — trùng lặp là dữ liệu mâu thuẫn, không âm thầm
 *   idempotent.
 *
 * Grant của hai membership khác nhau (dù cùng `sub`) không phải trùng lặp:
 * chúng thuộc hai lần membership khác nhau và có hiệu lực độc lập.
 */
export function createGrant(
  input: CreateGrantInput,
  context: GrantIssuanceContext,
): LlmTenantResult<PermissionGrant> {
  if (!isTenantId(input.tenantId)) {
    return llmTenantFailure('invalid_tenant_id');
  }
  if (!isMembershipId(input.membershipId)) {
    return llmTenantFailure('invalid_membership_id');
  }
  if (!isPermissionId(input.permission)) {
    return llmTenantFailure('invalid_permission_id');
  }
  if (!isGrantScope(input.scope)) {
    return llmTenantFailure('invalid_permission_policy');
  }
  if (
    context.memberships.some((membership) => membership.tenantId !== input.tenantId) ||
    context.workspaces.some((workspace) => workspace.tenantId !== input.tenantId) ||
    context.grants.some((grant) => grant.tenantId !== input.tenantId)
  ) {
    return llmTenantFailure('inconsistent_context');
  }

  const membership = context.memberships.find(
    (candidate) => candidate.id === input.membershipId && candidate.tenantId === input.tenantId,
  );
  if (membership === undefined || !isMembershipActive(membership)) {
    return llmTenantFailure('membership_not_found');
  }

  if (
    input.scope.kind === 'workspace' &&
    findWorkspace(context.workspaces, input.tenantId, input.scope.workspaceId) === undefined
  ) {
    return llmTenantFailure('workspace_not_in_tenant');
  }

  const duplicated = context.grants.some(
    (grant) =>
      grant.tenantId === input.tenantId &&
      grant.membershipId === input.membershipId &&
      grant.permission === input.permission &&
      sameScope(grant.scope, input.scope as GrantScope),
  );
  if (duplicated) {
    return llmTenantFailure('duplicate_grant');
  }

  return llmTenantOk(
    Object.freeze({
      tenantId: input.tenantId,
      membershipId: input.membershipId,
      permission: input.permission,
      scope: Object.freeze({ ...input.scope }) as GrantScope,
    }),
  );
}

/** Type guard cho `PermissionGrant` đọc từ storage/contract. */
export function isPermissionGrant(value: unknown): value is PermissionGrant {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const grant = value as Partial<PermissionGrant>;
  return (
    isTenantId(grant.tenantId) &&
    isMembershipId(grant.membershipId) &&
    isPermissionId(grant.permission) &&
    isGrantScope(grant.scope)
  );
}

/**
 * Grant có còn hiệu lực cho một membership **đang active** không.
 *
 * Hàm chỉ trả `true` khi grant trỏ đúng `membershipId` đó — grant của một lần
 * membership đã revoke không bao giờ được tính cho lần membership mới. Caller
 * phải truyền membership active đã resolve; hàm không tự chọn membership.
 */
export function isGrantEffectiveForMembership(
  grant: PermissionGrant,
  membership: Membership,
): boolean {
  return (
    grant.tenantId === membership.tenantId &&
    grant.membershipId === membership.id &&
    isMembershipActive(membership)
  );
}
