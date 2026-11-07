/**
 * Workspace — không gian làm việc thuộc **đúng một** tenant.
 *
 * Source of truth: `docs/domains/llm-consumer-tenant/domain-model.md` §4, §5.
 *
 * Quy tắc:
 * - Mọi workspace thuộc đúng một tenant; `tenantId` là field bắt buộc và không
 *   đổi qua API của module này.
 * - Tham chiếu workspace xuyên tenant bị từ chối ở **mọi** hàm tra cứu: tìm
 *   workspace theo `(tenantId, workspaceId)` trả "không thấy" khi workspace
 *   tồn tại nhưng thuộc tenant khác.
 * - Vòng đời archive/delete **chưa chốt** nên workspace không có `status` và
 *   không có transition nào trong module này.
 *
 * Namespace/storage scope derive từ cặp `(tenantId, workspaceId)`; domain không
 * tự sinh khoá lưu trữ.
 */

import {
  isEpochMillis,
  isTenantId,
  isWorkspaceId,
  llmTenantFailure,
  llmTenantOk,
  type LlmTenantResult,
  type TenantId,
  type WorkspaceId,
} from './shared';
import { isTenantName } from './tenant';

/** Workspace thuộc một tenant. */
export interface Workspace {
  readonly id: WorkspaceId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly createdAt: number;
}

/** Input tạo workspace. */
export interface CreateWorkspaceInput {
  readonly id: unknown;
  readonly tenantId: unknown;
  readonly name: unknown;
  readonly createdAt: unknown;
}

/**
 * Tạo workspace trong một tenant.
 *
 * @param existing Các workspace hiện có của **cùng tenant**. Caller chịu trách
 *   nhiệm chỉ truyền workspace của tenant đang xét; hàm kiểm lại từng phần tử
 *   và fail closed khi tập input lẫn tenant khác (`inconsistent_context`).
 *   Trùng `id` trong cùng tenant bị từ chối (`duplicate_workspace_id`).
 */
export function createWorkspace(
  input: CreateWorkspaceInput,
  existing: readonly Workspace[] = [],
): LlmTenantResult<Workspace> {
  if (!isWorkspaceId(input.id)) {
    return llmTenantFailure('invalid_workspace_id');
  }
  if (!isTenantId(input.tenantId)) {
    return llmTenantFailure('invalid_tenant_id');
  }
  if (!isTenantName(input.name)) {
    return llmTenantFailure('invalid_tenant_name');
  }
  if (!isEpochMillis(input.createdAt)) {
    return llmTenantFailure('invalid_timestamp');
  }
  if (existing.some((workspace) => workspace.tenantId !== input.tenantId)) {
    return llmTenantFailure('inconsistent_context');
  }
  if (existing.some((workspace) => workspace.id === input.id)) {
    return llmTenantFailure('duplicate_workspace_id');
  }
  return llmTenantOk(
    Object.freeze({
      id: input.id,
      tenantId: input.tenantId,
      name: input.name,
      createdAt: input.createdAt,
    }),
  );
}

/**
 * Tìm workspace trong một tenant.
 *
 * Chỉ trả workspace khi **cả** `tenantId` và `workspaceId` khớp. Một workspace
 * tồn tại ở tenant khác là "không thấy" trong ngữ cảnh này — không có đường
 * nào để đọc workspace xuyên tenant qua hàm này.
 */
export function findWorkspace(
  workspaces: readonly Workspace[],
  tenantId: TenantId,
  workspaceId: WorkspaceId,
): Workspace | undefined {
  return workspaces.find(
    (workspace) => workspace.tenantId === tenantId && workspace.id === workspaceId,
  );
}

/**
 * Xác nhận workspace thuộc tenant, dùng ở biên authorization.
 *
 * Fail closed khi workspace không có trong tập của tenant — kể cả khi
 * `workspaceId` tồn tại ở một tenant khác.
 */
export function assertWorkspaceBelongsToTenant(
  workspaces: readonly Workspace[],
  tenantId: TenantId,
  workspaceId: WorkspaceId,
): LlmTenantResult<Workspace> {
  const workspace = findWorkspace(workspaces, tenantId, workspaceId);
  return workspace === undefined
    ? llmTenantFailure('workspace_not_in_tenant')
    : llmTenantOk(workspace);
}
