/**
 * Taxonomy lỗi của tầng domain `llm-marketplace`.
 *
 * Pattern: `libs/llm-seller-tenant-domain/src/errors.ts`, `libs/llm-seller-governance-domain/src/errors.ts` và
 * `libs/llm-inference-domain/src/errors.ts` — một domain error chỉ mang `code` ổn
 * định + `message` ngắn gọn, không field nào cho identifier thật, provider model
 * name, endpoint URL, credential hash hay payload tuỳ ý. Error object đi thẳng ra
 * log và response, nên nó là nơi rò rỉ dễ nhất.
 *
 * Message là ENGLISH theo language policy của repo: đây là runtime string, không
 * phải documentation.
 */

/** Mã lỗi ổn định — contract với consumer, không đổi nghĩa theo thời gian. */
export type LlmMarketplaceDomainErrorCode =
  // Định danh và validate.
  | 'invalid_model_offer_id'
  | 'invalid_model_offer'
  | 'invalid_upstream_endpoint_id'
  | 'invalid_upstream_endpoint'
  | 'invalid_endpoint_pool_id'
  | 'invalid_endpoint_pool'
  | 'invalid_provider_credential_id'
  | 'invalid_provider_credential'
  | 'invalid_seller_tenant_id'
  | 'invalid_actor'
  | 'invalid_timestamp'
  | 'invalid_normalized_model_id'
  | 'invalid_provider_model_name'
  | 'invalid_provider_key'
  | 'invalid_public_alias'
  | 'invalid_capability'
  | 'invalid_capability_set'
  | 'invalid_endpoint_url'
  | 'invalid_endpoint_protocol'
  | 'invalid_endpoint_weight'
  | 'invalid_endpoint_health'
  | 'invalid_credential_hash'
  | 'invalid_credential_plaintext'
  | 'invalid_eligibility_verdict'
  | 'invalid_fallback_config'
  | 'invalid_provider_model_identity'
  // Ngữ cảnh và trùng lặp.
  | 'ambiguous_context'
  | 'inconsistent_context'
  | 'duplicate_model_offer_id'
  | 'duplicate_upstream_endpoint_id'
  | 'duplicate_endpoint_pool_id'
  | 'duplicate_provider_credential_id'
  | 'duplicate_provider_model'
  | 'duplicate_fallback_entry'
  // Vòng đời offer.
  | 'offer_already_active'
  | 'offer_already_inactive'
  | 'offer_retired'
  | 'invalid_offer_transition'
  | 'public_alias_immutable'
  | 'timestamp_regression'
  | 'endpoint_pool_missing'
  | 'endpoint_pool_not_healthy'
  | 'seller_not_eligible'
  | 'eligibility_tenant_mismatch'
  // Endpoint và pool.
  | 'endpoint_health_unchanged'
  | 'endpoint_not_in_pool'
  | 'endpoint_pool_mismatch'
  | 'pool_offer_mismatch'
  // Fallback config.
  | 'fallback_pool_not_in_offer'
  | 'fallback_endpoint_not_in_pool'
  // Credential.
  | 'credential_already_revoked'
  | 'credential_revoked'
  | 'credential_provider_mismatch'
  | 'credential_tenant_mismatch';

/**
 * Message của từng mã — nguồn duy nhất của factory. Message là ENGLISH: runtime
 * string không viết tiếng Việt.
 *
 * Freeze: consumer chỉ được **đọc** bảng này. Không freeze thì một call site có
 * thể sửa message và mọi error sinh ra sau đó mang text không canonical.
 */
export const LLM_MARKETPLACE_DOMAIN_ERROR_MESSAGES: Record<LlmMarketplaceDomainErrorCode, string> =
  Object.freeze({
    invalid_model_offer_id: 'Model offer ID is not valid.',
    invalid_model_offer: 'The model offer record is not valid.',
    invalid_upstream_endpoint_id: 'Upstream endpoint ID is not valid.',
    invalid_upstream_endpoint: 'The upstream endpoint record is not valid.',
    invalid_endpoint_pool_id: 'Endpoint pool ID is not valid.',
    invalid_endpoint_pool: 'The endpoint pool record is not valid.',
    invalid_provider_credential_id: 'Provider credential ID is not valid.',
    invalid_provider_credential: 'The provider credential record is not valid.',
    invalid_seller_tenant_id: 'Seller tenant ID is not valid.',
    invalid_actor: 'Actor account ID is not valid.',
    invalid_timestamp: 'Timestamp is not a valid epoch millisecond value.',
    invalid_normalized_model_id: 'Normalized model ID is not valid.',
    invalid_provider_model_name: 'Provider model name is not valid.',
    invalid_provider_key: 'Provider key is not valid.',
    invalid_public_alias: 'Public alias is not valid.',
    invalid_capability: 'Capability is not valid.',
    invalid_capability_set: 'The capability set is not valid.',
    invalid_endpoint_url: 'The upstream endpoint URL is not valid.',
    invalid_endpoint_protocol: 'The upstream endpoint protocol is not valid.',
    invalid_endpoint_weight: 'The upstream endpoint weight is not valid.',
    invalid_endpoint_health: 'The upstream endpoint health value is not valid.',
    invalid_credential_hash: 'The provider credential hash is not valid.',
    invalid_credential_plaintext: 'The provider credential plaintext is not valid.',
    invalid_eligibility_verdict: 'The Seller operational eligibility verdict is not valid.',
    invalid_fallback_config: 'The Seller endpoint fallback configuration is not valid.',
    invalid_provider_model_identity: 'The provider model identity is not valid.',
    ambiguous_context: 'The domain context is ambiguous.',
    inconsistent_context: 'The domain context is inconsistent with the owning aggregate.',
    duplicate_model_offer_id: 'The model offer ID is duplicated.',
    duplicate_upstream_endpoint_id: 'The upstream endpoint ID is duplicated.',
    duplicate_endpoint_pool_id: 'The endpoint pool ID is duplicated.',
    duplicate_provider_credential_id: 'The provider credential ID is duplicated.',
    duplicate_provider_model: 'The provider model identity is duplicated for this offer.',
    duplicate_fallback_entry: 'The fallback configuration entry is duplicated.',
    offer_already_active: 'The model offer is already active.',
    offer_already_inactive: 'The model offer is already inactive.',
    offer_retired: 'The model offer is retired and can no longer change state.',
    invalid_offer_transition: 'The model offer state transition is not allowed.',
    public_alias_immutable: 'The public alias cannot be changed in this offer state.',
    timestamp_regression: 'The timestamp precedes a fact already recorded.',
    endpoint_pool_missing: 'At least one endpoint pool is required.',
    endpoint_pool_not_healthy: 'No endpoint pool of the offer is healthy.',
    seller_not_eligible: 'The Seller is not operationally eligible.',
    eligibility_tenant_mismatch: 'The eligibility verdict belongs to another Seller tenant.',
    endpoint_health_unchanged: 'The upstream endpoint already has this health status.',
    endpoint_not_in_pool: 'The upstream endpoint does not belong to the endpoint pool.',
    endpoint_pool_mismatch: 'The upstream endpoint belongs to another endpoint pool.',
    pool_offer_mismatch: 'The endpoint pool belongs to another model offer.',
    fallback_pool_not_in_offer: 'The fallback pool does not belong to the model offer.',
    fallback_endpoint_not_in_pool: 'The fallback endpoint does not belong to the referenced pool.',
    credential_already_revoked: 'The provider credential has already been revoked.',
    credential_revoked: 'The provider credential is revoked.',
    credential_provider_mismatch: 'The provider credential is scoped to another provider.',
    credential_tenant_mismatch: 'The provider credential is owned by another Seller tenant.',
  });

/** Error domain: `code` ổn định + `message` ngắn gọn. */
export interface LlmMarketplaceDomainError {
  readonly code: LlmMarketplaceDomainErrorCode;
  readonly message: string;
}

/**
 * Dựng domain error. Constructor duy nhất của taxonomy: chỉ ghép `code` với
 * message lấy từ `LLM_MARKETPLACE_DOMAIN_ERROR_MESSAGES`, không có chỗ nào lọt dữ
 * liệu call site.
 *
 * @throws TypeError nếu `code` không có trong taxonomy.
 */
export function llmMarketplaceDomainError(
  code: LlmMarketplaceDomainErrorCode,
): LlmMarketplaceDomainError {
  const message = Object.hasOwn(LLM_MARKETPLACE_DOMAIN_ERROR_MESSAGES, code)
    ? LLM_MARKETPLACE_DOMAIN_ERROR_MESSAGES[code]
    : undefined;
  if (message === undefined) {
    throw new TypeError(`LLM Marketplace domain error code is not valid: ${String(code)}`);
  }
  return Object.freeze({ code, message });
}

/**
 * Type guard: có phải object mang `code` thuộc taxonomy không.
 *
 * Dùng `Object.hasOwn`, không dùng `in`: `in` đi cả prototype chain nên
 * `{ code: 'toString' }` sẽ lọt guard trong khi factory ném `TypeError`. Message
 * phải khớp nguyên văn bảng chuẩn: error object không phải chỗ mang dữ liệu call
 * site, kể cả khi kẻ gọi chỉ sửa `message`.
 */
export function isLlmMarketplaceDomainError(value: unknown): value is LlmMarketplaceDomainError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const ownKeys = Object.keys(value);
  if (ownKeys.length !== 2 || !ownKeys.includes('code') || !ownKeys.includes('message')) {
    return false;
  }
  const code = (value as { code?: unknown }).code;
  if (typeof code !== 'string' || !Object.hasOwn(LLM_MARKETPLACE_DOMAIN_ERROR_MESSAGES, code)) {
    return false;
  }
  return (
    (value as { message?: unknown }).message ===
    LLM_MARKETPLACE_DOMAIN_ERROR_MESSAGES[code as LlmMarketplaceDomainErrorCode]
  );
}
