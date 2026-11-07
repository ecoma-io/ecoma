/**
 * Public surface của `@ecoma-io/llm-seller-tenant-domain`.
 *
 * Library này là nửa **tenant** của bounded context LLM Seller (ADR-0018):
 * Seller tenant + ownership transfer, membership, permission grant,
 * authorization ladder và payout permission identifier/scope constants.
 *
 * Restriction record/evaluation, appeal, verification/onboarding, legal/tax
 * profile, evidence reference và operational eligibility thuộc
 * `llm-seller-governance-domain` — **không** thuộc library này.
 *
 * ## Ranh giới
 *
 * - **Thuần TypeScript.** Không database/ORM, không HTTP/network, không
 *   Cloudflare Workers API, không filesystem, không đọc clock, không randomness,
 *   không global mutable state. Mọi thời gian và định danh do caller cấp.
 * - **Không import Nx project khác.** Governance phụ thuộc tenant, không bao
 *   giờ ngược lại: ladder nhận restriction verdict như giá trị khai báo tại
 *   biên (`./restriction-verdict`), không import governance.
 * - **Không sở hữu** offer/provider topology (`llm-marketplace`), ledger/
 *   conversion/settlement/withholding (`llm-financial`, `payout`), Consumer
 *   tenant hay Consumer payment permission (`llm-consumer-tenant`), catalog
 *   permission (`staff-access`).
 *
 * ## Quy ước
 *
 * - Operation trả `LlmSellerResult`: lỗi dữ liệu là domain error, không ném
 *   exception. Chỉ `create*Id` ném `TypeError` khi lập trình sai.
 * - Mọi giá trị trả về đã `Object.freeze`; input không bị mutate.
 * - Đọc dữ liệu từ storage phải chạy lại shape guard (`is*`) trước khi dùng cho
 *   authorization. Operation cũng tự chạy lại guard cho entity/collection nhận
 *   vào và trả domain error thay vì ném exception.
 * - `authorizeSellerAction` đòi caller khai báo `target` và chỉ chấp nhận
 *   restriction verdict được tính cho đúng tenant **và** đúng target.
 *
 * ## Quyết định chưa chốt
 *
 * Domain **không** áp các giá trị sau; chúng là deferred boundary, xem
 * `docs/domains/llm-seller-tenant/domain-model.md` §8:
 *
 * - Catalog permission và ngữ nghĩa từng permission (§8.2).
 * - Chính sách ownership transfer nâng cao (§8.1).
 * - Retention, legal hold, archive/export/anonymization/physical deletion
 *   (§8.3; ADR-0008).
 *
 * Các mục sau thuộc `llm-seller-governance` và được liệt kê ở
 * `docs/domains/llm-seller-governance/domain-model.md` §8: tập policy
 * restriction và thời hạn appeal mặc định (§8.4), role/thẩm quyền reviewer
 * appeal và verification (§8.3), retention/storage provider của evidence
 * (§8.6). Thuế suất, withholding và treaty thuộc `llm-financial`.
 */

export {
  LLM_SELLER_DOMAIN_ERROR_MESSAGES,
  isLlmSellerDomainError,
  llmSellerDomainError,
  type LlmSellerDomainError,
  type LlmSellerDomainErrorCode,
} from './errors';

export {
  LLM_SELLER_AUTHORIZATION_SCOPE,
  LLM_SELLER_PAYOUT_PERMISSION,
  LLM_SELLER_PAYOUT_TARGET,
  MAX_OPAQUE_ID_LENGTH,
  MAX_SELLER_TEXT_LENGTH,
  createGrantId,
  createMembershipId,
  createPermissionId,
  createSellerActorId,
  createSellerTenantId,
  isEpochMillis,
  isGrantId,
  isMembershipId,
  isPermissionId,
  isSellerActorId,
  isSellerTenantId,
  isSellerText,
  llmSellerFailure,
  llmSellerOk,
  type GrantId,
  type LlmSellerFailure,
  type LlmSellerOk,
  type LlmSellerResult,
  type MembershipId,
  type PermissionId,
  type SellerActorId,
  type SellerTenantId,
} from './shared';

export {
  isSameRestrictionTarget,
  isSellerRestrictionTarget,
  isSellerRestrictionVerdict,
  type SellerRestrictionTarget,
  type SellerRestrictionVerdict,
} from './restriction-verdict';

export {
  createSellerTenant,
  isSellerOwner,
  isSellerTenant,
  transferSellerOwnership,
  type CreateSellerTenantInput,
  type SellerOwnershipTransfer,
  type SellerTenant,
  type TransferSellerOwnershipInput,
} from './seller-tenant';

export {
  findActiveMemberships,
  hasActiveMembership,
  isMembershipActive,
  isMembershipInTenant,
  isSellerMembership,
  provisionMembership,
  revokeMembership,
  type ProvisionMembershipInput,
  type RevokeMembershipInput,
  type SellerMembership,
  type SellerMembershipStatus,
} from './membership';

export {
  createGrant,
  findActiveGrants,
  isGrantActiveForMembership,
  isPermissionGrant,
  revokeGrant,
  type CreateGrantInput,
  type GrantContext,
  type PermissionGrant,
  type PermissionGrantStatus,
  type RevokeGrantInput,
} from './grants';

export {
  authorizeSellerAction,
  authorizeSellerPayout,
  type SellerAuthorizationAllowed,
  type SellerAuthorizationBasis,
  type SellerAuthorizationDecision,
  type SellerAuthorizationDenialReason,
  type SellerAuthorizationDenied,
  type SellerAuthorizationRequest,
  type SellerPayoutAuthorizationRequest,
} from './authorization';
