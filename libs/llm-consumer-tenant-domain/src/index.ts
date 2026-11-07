/**
 * `@ecoma-io/llm-consumer-tenant-domain` — tầng domain thuần của bounded context
 * `llm-consumer-tenant` (Consumer tenant, membership, workspace, permission
 * grant, authorization và suspension record).
 *
 * Đây là Consumer tenant, **không** phải Seller tenant: hai ownership boundary
 * độc lập, membership/grant ở tenant này không ngụ ý quyền ở tenant kia
 * (ADR-0018 §2, ADR-0019).
 *
 * Target architecture: `docs/domains/llm-consumer-tenant/domain-model.md`.
 *
 * Thuần khiết:
 * - **Không** import Nx project khác (kể cả `type:contracts`).
 * - **Không** SQL, **Không** Node builtin, **Không** I/O.
 * - Mọi tham số thời gian do caller truyền vào; domain không đọc đồng hồ.
 * - Không persistence, không HTTP, không Worker handler, không event dispatch.
 *
 * ## Ranh giới chưa chốt — không âm thầm chốt trong lib này
 *
 * - **Chuyển ownership tenant** (điều kiện, consent, audit) chưa có quyết
 *   định. Lib bảo đảm "đúng một owner" bằng cấu trúc dữ liệu và không có
 *   operation transfer.
 * - **Vòng đời pháp lý** (archive/terminate/delete tenant hoặc workspace,
 *   physical deletion, retention, legal hold/export/anonymization) chưa chốt.
 *   Lib không có transition nào cho các trạng thái đó.
 * - **Nội dung permission catalog** thuộc governance của catalog; lib chỉ giữ
 *   định danh opaque và ngữ nghĩa scope. Nó không định nghĩa danh sách
 *   permission nghiệp vụ.
 * - **Danh mục lý do/policy suspension** là dữ liệu cấu hình mở; lib không
 *   liệt kê lý do.
 * - **Thực thi billing** (giao dịch, số dư, ledger, reconciliation) thuộc
 *   `payment`/`llm-financial`; lib chỉ trả quyết định authorization.
 */

export {
  LLM_TENANT_DOMAIN_ERROR_MESSAGES,
  isLlmTenantDomainError,
  llmTenantDomainError,
  type LlmTenantDomainError,
  type LlmTenantDomainErrorCode,
} from './errors';
export {
  LLM_TENANT_BILLING_MANAGEMENT_PERMISSION,
  MAX_OPAQUE_ID_LENGTH,
  createMembershipId,
  createPermissionId,
  createTenantActorId,
  createTenantId,
  createWorkspaceId,
  isEpochMillis,
  isMembershipId,
  isPermissionId,
  isTenantActorId,
  isTenantId,
  isWorkspaceId,
  llmTenantFailure,
  llmTenantOk,
  type LlmTenantFailure,
  type LlmTenantOk,
  type LlmTenantResult,
  type MembershipId,
  type PermissionId,
  type TenantActorId,
  type TenantId,
  type WorkspaceId,
} from './shared';
export {
  MAX_TENANT_NAME_LENGTH,
  createTenant,
  isTenantName,
  isTenantOwner,
  type CreateTenantInput,
  type Tenant,
} from './tenant';
export {
  LLM_TENANT_MEMBERSHIP_STATUS,
  LLM_TENANT_MEMBERSHIP_STATUSES,
  findMembership,
  isMembershipActive,
  isMembershipStatus,
  provisionMembership,
  revokeMembership,
  type Membership,
  type MembershipStatus,
  type ProvisionMembershipInput,
  type RevokeMembershipInput,
} from './membership';
export {
  assertWorkspaceBelongsToTenant,
  createWorkspace,
  findWorkspace,
  type CreateWorkspaceInput,
  type Workspace,
} from './workspace';
export {
  createGrant,
  isGrantEffectiveForMembership,
  isPermissionGrant,
  type CreateGrantInput,
  type GrantIssuanceContext,
  type GrantScope,
  type PermissionGrant,
  type TenantGrantScope,
  type WorkspaceGrantScope,
} from './grants';
export {
  authorizeTenantAction,
  type AuthorizationBasis,
  type AuthorizationDenialReason,
  type AuthorizationRequest,
  type AuthorizationTarget,
  type PermissionSemantics,
  type TenantAuthorizationDecision,
} from './authorization';
export {
  authorizeBillingManagement,
  type BillingAuthorizationBasis,
  type BillingAuthorizationDecision,
  type BillingAuthorizationDenialReason,
  type BillingAuthorizationRequest,
} from './billing';
export {
  createSuspensionRecord,
  evaluateSuspensions,
  isSuspensionEffective,
  isSuspensionRecordShapeValid,
  type CreateSuspensionRecordInput,
  type EvaluateSuspensionsInput,
  type SuspensionEvaluation,
  type SuspensionPolicyDefinition,
  type SuspensionRecord,
  type SuspensionRecordId,
  type SuspensionScope,
  type SuspensionTarget,
} from './suspension';
