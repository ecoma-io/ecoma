/**
 * Taxonomy lỗi của tầng domain `llm-consumer-tenant`.
 *
 * Pattern: `libs/staff-access-domain/src/errors.ts` và
 * `libs/llm-seller-pricing-domain/src/errors.ts` — một domain error chỉ mang `code`
 * ổn định + `message` ngắn gọn, không field nào cho identifier thật (tenant,
 * workspace, `sub`), token, permission value hay payload tuỳ ý.
 *
 * Lý do: error object đi thẳng ra log và response, nên nó là nơi rò rỉ dễ
 * nhất — nó mang theo ngữ cảnh của lỗi. Muốn thêm ngữ cảnh chẩn đoán thì thêm
 * mã mới, không gắn dữ liệu vào mã cũ.
 *
 * Message là ENGLISH theo language policy của repo: đây là runtime string,
 * không phải documentation.
 */

/** Mã lỗi ổn định — contract với consumer, không đổi nghĩa theo thời gian. */
export type LlmTenantDomainErrorCode =
  | 'invalid_tenant_id'
  | 'invalid_workspace_id'
  | 'invalid_membership_id'
  | 'invalid_actor'
  | 'invalid_tenant_name'
  | 'invalid_timestamp'
  | 'invalid_permission_id'
  | 'invalid_permission_policy'
  | 'invalid_suspension_record'
  | 'invalid_suspension_window'
  | 'membership_already_active'
  | 'membership_already_revoked'
  | 'membership_not_found'
  | 'duplicate_membership_id'
  | 'duplicate_grant'
  | 'workspace_not_in_tenant'
  | 'duplicate_workspace_id'
  | 'ambiguous_context'
  | 'inconsistent_context';

/**
 * Message của từng mã — bảng đọc nguồn duy nhất của factory. Message là
 * ENGLISH: runtime string không viết tiếng Việt.
 *
 * Freeze: consumer chỉ được **đọc** bảng này. Không freeze thì một call site
 * có thể sửa message và mọi error sinh ra sau đó mang text không canonical.
 */
export const LLM_TENANT_DOMAIN_ERROR_MESSAGES: Record<LlmTenantDomainErrorCode, string> =
  Object.freeze({
    invalid_tenant_id: 'Tenant ID is not valid.',
    invalid_workspace_id: 'Workspace ID is not valid.',
    invalid_membership_id: 'Membership ID is not valid.',
    invalid_actor: 'Actor account ID is not valid.',
    invalid_tenant_name: 'Tenant name is not valid.',
    invalid_timestamp: 'Timestamp is not a valid epoch millisecond value.',
    invalid_permission_id: 'Permission ID is not valid.',
    invalid_permission_policy: 'Permission policy is not valid.',
    invalid_suspension_record: 'Suspension record is not valid.',
    invalid_suspension_window: 'The suspension validity window is not valid.',
    membership_already_active: 'An active membership already exists for this account.',
    membership_already_revoked: 'The membership has already been revoked.',
    membership_not_found: 'Membership not found.',
    duplicate_membership_id: 'The membership ID is duplicated in the tenant.',
    duplicate_grant: 'The permission grant already exists with the same scope.',
    workspace_not_in_tenant: 'The workspace does not belong to the tenant.',
    duplicate_workspace_id: 'The workspace ID is duplicated in the tenant.',
    ambiguous_context: 'The authorization context is ambiguous.',
    inconsistent_context: 'The authorization context is inconsistent with the tenant.',
  });

/** Error domain: `code` ổn định + `message` ngắn gọn. */
export interface LlmTenantDomainError {
  readonly code: LlmTenantDomainErrorCode;
  readonly message: string;
}

/**
 * Dựng domain error. Constructor duy nhất của taxonomy: chỉ ghép `code` với
 * message lấy từ `LLM_TENANT_DOMAIN_ERROR_MESSAGES`, không có chỗ nào lọt dữ
 * liệu call site.
 *
 * @throws TypeError nếu `code` không có trong taxonomy.
 */
export function llmTenantDomainError(code: LlmTenantDomainErrorCode): LlmTenantDomainError {
  const message = Object.hasOwn(LLM_TENANT_DOMAIN_ERROR_MESSAGES, code)
    ? LLM_TENANT_DOMAIN_ERROR_MESSAGES[code]
    : undefined;
  if (message === undefined) {
    throw new TypeError(`LLM Tenant domain error code is not valid: ${String(code)}`);
  }
  return { code, message };
}

/**
 * Type guard: có phải object mang `code` thuộc taxonomy không.
 *
 * Dùng `Object.hasOwn`, không dùng `in`: `in` đi cả prototype chain nên
 * `{ code: 'toString' }` sẽ lọt guard trong khi factory ném `TypeError`.
 */
export function isLlmTenantDomainError(value: unknown): value is LlmTenantDomainError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const ownKeys = Object.keys(value);
  if (ownKeys.length !== 2 || !ownKeys.includes('code') || !ownKeys.includes('message')) {
    return false;
  }
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' && Object.hasOwn(LLM_TENANT_DOMAIN_ERROR_MESSAGES, code);
}
