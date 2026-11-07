/**
 * Suspension — nhiều bản ghi độc lập cho cùng một tenant.
 *
 * Source of truth: `docs/domains/llm-consumer-tenant/domain-model.md` §3, §4, §8.
 *
 * Quy tắc:
 * - **Không có `status = suspended`.** Trạng thái "bị hạn chế" là giá trị **suy
 *   ra** từ tập suspension record tại một thời điểm; module này không giữ và
 *   không trả về một cột trạng thái thứ hai.
 * - Mỗi record có vòng đời riêng: `activatesAt`, `expiresAt` (có thể không hạn)
 *   và `liftedAt` (có thể không bao giờ). Lift/expire record này **không** đụng
 *   record khác.
 * - Record áp dụng theo `scope`: toàn tenant, hoặc đúng một workspace.
 * - `policy`/`reason` là **định danh mở**, không phải một catalog cố định trong
 *   lib. Lib không liệt kê lý do billing/compliance/security/administrative;
 *   đó là dữ liệu cấu hình có governance.
 * - Policy **không đọc được** được coi là restrictive (fail closed), không bao
 *   giờ được coi là vô hại.
 * - Suspension không huỷ một request đã qua admission: execution/cancellation
 *   thuộc application/domain tương ứng, không thuộc module này.
 *
 * Cửa sổ hiệu lực là **nửa mở** `[activatesAt, expiresAt)`: record có hiệu lực
 * tại đúng `activatesAt`, và hết hiệu lực tại đúng `expiresAt`. `liftedAt` có
 * hiệu lực khi `liftedAt <= now` (một lần lift đặt lịch cho tương lai chưa có
 * tác dụng).
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
  MAX_OPAQUE_ID_LENGTH,
} from './shared';
import type { Workspace } from './workspace';

/** Định danh record suspension. */
export type SuspensionRecordId = string;

/** Scope áp dụng của một suspension record. */
export type SuspensionScope =
  | { readonly kind: 'tenant' }
  | { readonly kind: 'workspace'; readonly workspaceId: WorkspaceId };

/** Một suspension record độc lập. */
export interface SuspensionRecord {
  readonly id: SuspensionRecordId;
  readonly tenantId: TenantId;
  /** Định danh policy — dữ liệu cấu hình, không phải enum của lib. */
  readonly policy: string;
  /** Định danh lý do — dữ liệu cấu hình, không phải enum của lib. */
  readonly reason: string;
  readonly scope: SuspensionScope;
  readonly activatesAt: number;
  /** `null` = không đặt hạn. */
  readonly expiresAt: number | null;
  /** `null` = chưa được lift. */
  readonly liftedAt: number | null;
}

/**
 * Policy đã được cấu hình. `restrictive: false` là một khai báo tường minh rằng
 * policy đó không chặn thao tác (ví dụ ghi nhận để theo dõi).
 *
 * ⚠️ Policy **không có** trong danh sách này được coi là restrictive — fail
 * closed. Không suy ra "không biết ⇒ không chặn".
 */
export interface SuspensionPolicyDefinition {
  readonly id: string;
  readonly restrictive: boolean;
}

/** Input tạo suspension record. */
export interface CreateSuspensionRecordInput {
  readonly id: unknown;
  readonly tenantId: unknown;
  readonly policy: unknown;
  readonly reason: unknown;
  readonly scope: unknown;
  readonly activatesAt: unknown;
  readonly expiresAt?: unknown;
  readonly liftedAt?: unknown;
}

function isOpaqueLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_OPAQUE_ID_LENGTH &&
    value.trim() === value
  );
}

function isSuspensionScope(value: unknown): value is SuspensionScope {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const scope = value as { kind?: unknown; workspaceId?: unknown };
  if (scope.kind === 'tenant') {
    return !Object.hasOwn(scope, 'workspaceId');
  }
  return scope.kind === 'workspace' && isWorkspaceId(scope.workspaceId);
}

/**
 * Tạo một suspension record.
 *
 * Không kiểm policy có tồn tại hay không: policy là dữ liệu của caller, và
 * policy lạ **vẫn** tạo được record — evaluation sẽ coi nó restrictive. Từ chối
 * khi cấu trúc/window sai: `expiresAt` phải sau `activatesAt`, `liftedAt` không
 * được trước `activatesAt`.
 */
export function createSuspensionRecord(
  input: CreateSuspensionRecordInput,
): LlmTenantResult<SuspensionRecord> {
  if (!isOpaqueLabel(input.id)) {
    return llmTenantFailure('invalid_suspension_record');
  }
  if (!isTenantId(input.tenantId)) {
    return llmTenantFailure('invalid_tenant_id');
  }
  if (!isOpaqueLabel(input.policy) || !isOpaqueLabel(input.reason)) {
    return llmTenantFailure('invalid_suspension_record');
  }
  if (!isSuspensionScope(input.scope)) {
    return llmTenantFailure('invalid_suspension_record');
  }
  if (!isEpochMillis(input.activatesAt)) {
    return llmTenantFailure('invalid_timestamp');
  }

  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null && (!isEpochMillis(expiresAt) || expiresAt <= input.activatesAt)) {
    return llmTenantFailure('invalid_suspension_window');
  }

  const liftedAt = input.liftedAt ?? null;
  if (liftedAt !== null && (!isEpochMillis(liftedAt) || liftedAt < input.activatesAt)) {
    return llmTenantFailure('invalid_suspension_window');
  }

  return llmTenantOk(
    Object.freeze({
      id: input.id,
      tenantId: input.tenantId,
      policy: input.policy,
      reason: input.reason,
      scope: Object.freeze({ ...input.scope }) as SuspensionScope,
      activatesAt: input.activatesAt,
      expiresAt,
      liftedAt,
    }),
  );
}

/** Đích được đánh giá: toàn tenant hoặc một workspace cụ thể. */
export type SuspensionTarget =
  | { readonly kind: 'tenant' }
  | { readonly kind: 'workspace'; readonly workspaceId: unknown };

/** Kết quả đánh giá suspension tại một thời điểm. */
export interface SuspensionEvaluation {
  /** `true` khi còn ít nhất một record hiệu lực và restrictive. */
  readonly blocked: boolean;
  /**
   * `true` khi tập record có phần tử không đọc được (sai hình dạng, sai
   * window, hoặc policy không có trong cấu hình). Khi đó `blocked` cũng là
   * `true`: không chứng minh được là không bị hạn chế thì phải coi là bị hạn
   * chế.
   */
  readonly unevaluable: boolean;
  /** Record đang chặn — chỉ để audit/chẩn đoán, không phải nguồn sự thật khác. */
  readonly blockingRecordIds: readonly SuspensionRecordId[];
  /** Policy không đọc được trong record có hiệu lực — luôn restrictive. */
  readonly unknownPolicies: readonly string[];
}

/** Input đánh giá suspension. */
export interface EvaluateSuspensionsInput {
  readonly tenantId: TenantId;
  readonly records: readonly SuspensionRecord[];
  readonly policies: readonly SuspensionPolicyDefinition[];
  readonly target: SuspensionTarget;
  /** Workspace của tenant, dùng để xác nhận target thuộc tenant. */
  readonly workspaces: readonly Workspace[];
  readonly now: unknown;
}

/**
 * Record có áp dụng cho đích không.
 *
 * - Đích `tenant`: chỉ record scope tenant. Record scope workspace **không**
 *   chặn toàn tenant — một workspace bị hạn chế không phải lý do chặn các
 *   workspace khác.
 * - Đích `workspace`: record scope tenant **và** record scope đúng workspace
 *   đó. Tenant bị hạn chế thì mọi workspace bên trong cũng bị hạn chế; chiều
 *   ngược lại không đúng.
 */
function appliesToTarget(record: SuspensionRecord, target: SuspensionTarget): boolean {
  if (target.kind === 'tenant') {
    return record.scope.kind === 'tenant';
  }
  return (
    record.scope.kind === 'tenant' ||
    (record.scope.kind === 'workspace' && record.scope.workspaceId === target.workspaceId)
  );
}

/** Record có hiệu lực tại `now` không (nửa mở ở cả hai đầu). */
export function isSuspensionEffective(record: SuspensionRecord, now: number): boolean {
  if (record.activatesAt > now) {
    return false;
  }
  if (record.expiresAt !== null && record.expiresAt <= now) {
    return false;
  }
  return record.liftedAt === null || record.liftedAt > now;
}

/**
 * Đánh giá deterministic tại `now`: một đích bị chặn khi tồn tại ít nhất một
 * record **hiệu lực** và **áp dụng cho đích** với policy restrictive.
 *
 * Fail closed:
 * - `now`, `tenantId`, `target` hay dữ liệu vào không đọc được ⇒ trả lỗi.
 * - Record thuộc tenant khác trong tập input ⇒ `inconsistent_context`.
 * - Target workspace không thuộc tenant ⇒ `workspace_not_in_tenant`.
 * - Policy không có trong `policies` ⇒ coi là restrictive.
 * - Record của policy restrictive nhưng `liftedAt`/`expiresAt` không đọc được
 *   thì không thể chứng minh là đã hết hiệu lực ⇒ record vẫn chặn
 *   ({@link isSuspensionEffective} chỉ trả `false` trên dữ liệu hợp lệ; dữ
 *   liệu hỏng bị từ chối trước đó).
 *
 * Khi `blocked` là `false`, đích đang **không bị hạn chế bởi suspension** tại
 * thời điểm đó. Đây là kết quả suy ra, không phải một trạng thái được lưu.
 */
export function evaluateSuspensions(
  input: EvaluateSuspensionsInput,
): LlmTenantResult<SuspensionEvaluation> {
  if (!isEpochMillis(input.now)) {
    return llmTenantFailure('invalid_timestamp');
  }
  if (!isTenantId(input.tenantId)) {
    return llmTenantFailure('invalid_tenant_id');
  }
  if (input.target === null || typeof input.target !== 'object') {
    return llmTenantFailure('ambiguous_context');
  }
  if (input.target.kind !== 'tenant' && input.target.kind !== 'workspace') {
    return llmTenantFailure('ambiguous_context');
  }
  if (input.target.kind === 'workspace' && !isWorkspaceId(input.target.workspaceId)) {
    return llmTenantFailure('ambiguous_context');
  }
  if (!Array.isArray(input.records) || !Array.isArray(input.workspaces)) {
    return llmTenantFailure('ambiguous_context');
  }

  if (input.records.some((record) => !isSuspensionRecordShapeValid(record))) {
    return llmTenantFailure('invalid_suspension_record');
  }
  if (input.records.some((record) => record.tenantId !== input.tenantId)) {
    return llmTenantFailure('inconsistent_context');
  }
  if (input.workspaces.some((workspace) => workspace.tenantId !== input.tenantId)) {
    return llmTenantFailure('inconsistent_context');
  }
  const requestedWorkspaceId =
    input.target.kind === 'workspace' ? input.target.workspaceId : undefined;
  if (
    requestedWorkspaceId !== undefined &&
    !input.workspaces.some((workspace) => workspace.id === requestedWorkspaceId)
  ) {
    return llmTenantFailure('workspace_not_in_tenant');
  }

  // Policy lạ ⇒ restrictive. Không suy "không biết ⇒ cho qua".
  const knownPolicies = new Map<string, boolean>();
  for (const policy of input.policies) {
    if (typeof policy === 'object' && policy !== null && isOpaqueLabel(policy.id)) {
      knownPolicies.set(policy.id, policy.restrictive === true);
    }
  }

  const blockingRecordIds: string[] = [];
  const unknownPolicies = new Set<string>();

  for (const record of input.records) {
    if (!isSuspensionEffective(record, input.now)) {
      continue;
    }
    if (!appliesToTarget(record, input.target)) {
      continue;
    }
    const known = knownPolicies.get(record.policy);
    if (known === false) {
      continue;
    }
    if (known === undefined) {
      unknownPolicies.add(record.policy);
    }
    blockingRecordIds.push(record.id);
  }

  return llmTenantOk(
    Object.freeze({
      blocked: blockingRecordIds.length > 0,
      unevaluable: unknownPolicies.size > 0,
      blockingRecordIds: Object.freeze([...blockingRecordIds]) as readonly string[],
      unknownPolicies: Object.freeze([...unknownPolicies]) as readonly string[],
    }),
  );
}

/**
 * Kiểm hình dạng đầy đủ của record đọc từ storage/contract — record hỏng không
 * được lọt vào evaluation vì "không đọc được" không phải "không chặn".
 */
export function isSuspensionRecordShapeValid(value: unknown): value is SuspensionRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<SuspensionRecord>;
  return (
    isOpaqueLabel(record.id) &&
    isTenantId(record.tenantId) &&
    isOpaqueLabel(record.policy) &&
    isOpaqueLabel(record.reason) &&
    isSuspensionScope(record.scope) &&
    isEpochMillis(record.activatesAt) &&
    (record.expiresAt === null ||
      (isEpochMillis(record.expiresAt) && record.expiresAt > record.activatesAt)) &&
    (record.liftedAt === null ||
      (isEpochMillis(record.liftedAt) && record.liftedAt >= record.activatesAt))
  );
}
