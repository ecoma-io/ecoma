/**
 * Taxonomy lỗi của tầng domain `llm-seller-tenant`.
 *
 * Pattern: `libs/llm-consumer-tenant-domain/src/errors.ts` và
 * `libs/llm-seller-pricing-domain/src/errors.ts` — một domain error chỉ mang
 * `code` ổn định + `message` ngắn gọn, không field nào cho identifier thật
 * (tenant, `sub`, permission value), reason nội bộ hay payload tuỳ ý.
 *
 * Lý do: error object đi thẳng ra log và response, nên nó là nơi rò rỉ dễ
 * nhất — nó mang theo ngữ cảnh của lỗi. Muốn thêm ngữ cảnh chẩn đoán thì thêm
 * mã mới, không gắn dữ liệu vào mã cũ.
 *
 * `llm-seller-governance` có taxonomy riêng và **không** tái dùng mã ở đây
 * (ADR-0018): hai context tiến hoá độc lập, nên một mã chỉ tồn tại ở context
 * thực sự sở hữu hành vi sinh ra nó.
 *
 * Message là ENGLISH theo language policy của repo: đây là runtime string,
 * không phải documentation.
 */

/** Mã lỗi ổn định — contract với consumer, không đổi nghĩa theo thời gian. */
export type LlmSellerDomainErrorCode =
  // Định danh và validate.
  | 'invalid_seller_tenant_id'
  | 'invalid_seller_tenant'
  | 'invalid_seller_tenant_name'
  | 'invalid_actor'
  | 'invalid_timestamp'
  | 'invalid_membership_id'
  | 'invalid_membership'
  | 'invalid_grant_id'
  | 'invalid_grant'
  | 'invalid_permission_id'
  // Ngữ cảnh.
  | 'ambiguous_context'
  | 'inconsistent_context'
  // Ownership, membership, grant.
  | 'actor_not_owner'
  | 'owner_already_owner'
  | 'new_owner_not_active_member'
  | 'missing_former_owner_membership'
  | 'duplicate_membership_id'
  | 'membership_already_active'
  | 'membership_already_revoked'
  | 'membership_not_found'
  | 'duplicate_grant_id'
  | 'duplicate_grant'
  | 'grant_already_revoked';

/**
 * Message của từng mã — bảng đọc nguồn duy nhất của factory. Message là
 * ENGLISH: runtime string không viết tiếng Việt.
 *
 * Freeze: consumer chỉ được **đọc** bảng này. Không freeze thì một call site
 * có thể sửa message và mọi error sinh ra sau đó mang text không canonical.
 */
export const LLM_SELLER_DOMAIN_ERROR_MESSAGES: Record<LlmSellerDomainErrorCode, string> =
  Object.freeze({
    invalid_seller_tenant_id: 'Seller tenant ID is not valid.',
    invalid_seller_tenant: 'The Seller tenant record is not valid.',
    invalid_seller_tenant_name: 'Seller tenant name is not valid.',
    invalid_actor: 'Actor account ID is not valid.',
    invalid_timestamp: 'Timestamp is not a valid epoch millisecond value.',
    invalid_membership_id: 'Membership ID is not valid.',
    invalid_membership: 'The membership record is not valid.',
    invalid_grant_id: 'Permission grant ID is not valid.',
    invalid_grant: 'The permission grant record is not valid.',
    invalid_permission_id: 'Permission ID is not valid.',
    ambiguous_context: 'The domain context is ambiguous.',
    inconsistent_context: 'The domain context is inconsistent with the tenant.',
    actor_not_owner: 'The actor is not the owner of this Seller tenant.',
    owner_already_owner: 'The target account is already the owner.',
    new_owner_not_active_member: 'The new owner must be an active member of the tenant.',
    missing_former_owner_membership:
      'A membership ID is required to keep the former owner as an active member.',
    duplicate_membership_id: 'The membership ID is duplicated in the tenant.',
    membership_already_active: 'An active membership already exists for this account.',
    membership_already_revoked: 'The membership has already been revoked.',
    membership_not_found: 'Membership not found.',
    duplicate_grant_id: 'The permission grant ID is duplicated in the tenant.',
    duplicate_grant: 'The permission grant already exists for this membership.',
    grant_already_revoked: 'The permission grant has already been revoked.',
  });

/** Error domain: `code` ổn định + `message` ngắn gọn. */
export interface LlmSellerDomainError {
  readonly code: LlmSellerDomainErrorCode;
  readonly message: string;
}

/**
 * Dựng domain error. Constructor duy nhất của taxonomy: chỉ ghép `code` với
 * message lấy từ `LLM_SELLER_DOMAIN_ERROR_MESSAGES`, không có chỗ nào lọt dữ
 * liệu call site.
 *
 * @throws TypeError nếu `code` không có trong taxonomy.
 */
export function llmSellerDomainError(code: LlmSellerDomainErrorCode): LlmSellerDomainError {
  const message = Object.hasOwn(LLM_SELLER_DOMAIN_ERROR_MESSAGES, code)
    ? LLM_SELLER_DOMAIN_ERROR_MESSAGES[code]
    : undefined;
  if (message === undefined) {
    throw new TypeError(`LLM Seller domain error code is not valid: ${String(code)}`);
  }
  return Object.freeze({ code, message });
}

/**
 * Type guard: có phải object mang `code` thuộc taxonomy không.
 *
 * Dùng `Object.hasOwn`, không dùng `in`: `in` đi cả prototype chain nên
 * `{ code: 'toString' }` sẽ lọt guard trong khi factory ném `TypeError`.
 */
export function isLlmSellerDomainError(value: unknown): value is LlmSellerDomainError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const ownKeys = Object.keys(value);
  if (ownKeys.length !== 2 || !ownKeys.includes('code') || !ownKeys.includes('message')) {
    return false;
  }
  const code = (value as { code?: unknown }).code;
  if (typeof code !== 'string' || !Object.hasOwn(LLM_SELLER_DOMAIN_ERROR_MESSAGES, code)) {
    return false;
  }
  // Message phải đúng nguyên văn bảng chuẩn: error object không phải chỗ mang
  // dữ liệu call site, kể cả khi kẻ gọi chỉ sửa `message`.
  return (
    (value as { message?: unknown }).message ===
    LLM_SELLER_DOMAIN_ERROR_MESSAGES[code as LlmSellerDomainErrorCode]
  );
}
