/**
 * `@ecoma-io/llm-marketplace-domain` — tầng domain thuần của bounded context
 * `llm-marketplace`: model offer, normalized model identity và provider model
 * name, capability, upstream endpoint, endpoint pool, Seller endpoint fallback
 * configuration, provider credential (hash-only, show-once) và offer activation.
 *
 * Target architecture: `docs/domains/llm-marketplace/domain-model.md`.
 *
 * ## Thuần khiết
 *
 * - **Không** import Nx project khác (kể cả `llm-seller-*`, `llm-financial-domain`).
 * - **Không** SQL, **Không** Node builtin, **Không** I/O.
 * - Mọi tham số thời gian do caller truyền vào; domain không đọc đồng hồ.
 * - Không provider SDK, không HTTP client, không DB driver, không ORM, không crypto.
 * - Không persistence, durable idempotency, event dispatch.
 *
 * ## Ranh giới
 *
 * - Seller tenant, restriction/verification/legal-tax/evidence và operational
 *   eligibility **verdict** thuộc `llm-seller-governance`; lib này chỉ khai báo
 *   `SellerOperationalEligibility` tại biên và **tiêu thụ** verdict.
 * - Consumer routing (alias, priority/round-robin/lowest-price, chọn offer,
 *   fallback giữa các offer) thuộc `llm-consumer-routing-domain`. Fallback ở đây
 *   là **Seller endpoint fallback trong một offer**.
 * - Provider cost, customer price, quota và settlement không thuộc lib này.
 * - Plaintext credential chỉ trả **một lần** từ `createProviderCredential`;
 *   domain không hash và không verify plaintext — hashing là trách nhiệm caller.
 *
 * ## Quyết định chưa chốt — không âm thầm chốt trong lib này
 *
 * Xem `docs/domains/llm-marketplace/domain-model.md` §11. Lib không có API
 * nào chốt các mục sau: public seller prefix, quy tắc unique public alias xuyên
 * seller, retention/xoá dữ liệu credential, và chiến lược chọn endpoint trong
 * pool (strategy thuộc routing).
 */

export {
  LLM_MARKETPLACE_DOMAIN_ERROR_MESSAGES,
  isLlmMarketplaceDomainError,
  llmMarketplaceDomainError,
  type LlmMarketplaceDomainError,
  type LlmMarketplaceDomainErrorCode,
} from './errors';

export {
  MAX_CREDENTIAL_HASH_LENGTH,
  MAX_CREDENTIAL_PLAINTEXT_LENGTH,
  MAX_ENDPOINT_PROTOCOL_LENGTH,
  MAX_ENDPOINT_URL_LENGTH,
  MAX_ENDPOINT_WEIGHT,
  MAX_MODEL_NAME_LENGTH,
  MAX_OPAQUE_ID_LENGTH,
  MAX_PROVIDER_KEY_LENGTH,
  MAX_PUBLIC_ALIAS_LENGTH,
  createEndpointPoolId,
  createModelOfferId,
  createProviderCredentialId,
  createSellerActorId,
  createSellerTenantId,
  createUpstreamEndpointId,
  isEndpointPoolId,
  isEpochMillis,
  isModelOfferId,
  isOpaqueLabel,
  isProviderCredentialId,
  isSellerActorId,
  isSellerTenantId,
  isUpstreamEndpointId,
  llmMarketplaceFailure,
  llmMarketplaceOk,
  type EndpointPoolId,
  type LlmMarketplaceFailure,
  type LlmMarketplaceOk,
  type LlmMarketplaceResult,
  type ModelOfferId,
  type ProviderCredentialId,
  type SellerActorId,
  type SellerTenantId,
  type UpstreamEndpointId,
} from './shared';

export {
  MAX_CAPABILITY_LENGTH,
  createCapabilitySet,
  hasCapability,
  isCapability,
  isCapabilitySet,
  satisfiesCapabilities,
  type CapabilitySet,
} from './capability';

export {
  assertProviderModelNameUnique,
  createNormalizedModelIdentity,
  createProviderModelName,
  isNormalizedModelId,
  isNormalizedModelIdentity,
  isProviderKey,
  isProviderModelName,
  isProviderModelNameRecord,
  mapProviderModelToNormalizedIdentity,
  normalizeModelId,
  type NormalizedModelIdentity,
  type ProviderModelName,
} from './model-identity';

export {
  ENDPOINT_HEALTH_STATUS,
  addEndpointToPool,
  createEndpointPool,
  createUpstreamEndpoint,
  deriveEndpointPoolHealth,
  evaluateOfferEndpointHealth,
  isEndpointHealthStatus,
  isEndpointPool,
  isEndpointProtocol,
  isEndpointUrl,
  isEndpointWeight,
  isUpstreamEndpoint,
  recordEndpointHealth,
  removeEndpointFromPool,
  replaceEndpointInPool,
  type AddEndpointToPoolInput,
  type CreateEndpointPoolInput,
  type CreateUpstreamEndpointInput,
  type EndpointHealthStatus,
  type EndpointPool,
  type EndpointPoolHealth,
  type OfferEndpointHealth,
  type RecordEndpointHealthInput,
  type RemoveEndpointFromPoolInput,
  type ReplaceEndpointInPoolInput,
  type UpstreamEndpoint,
} from './endpoint';

export {
  createSellerFallbackConfig,
  isSellerFallbackConfig,
  orderEndpointCandidates,
  type CreateSellerFallbackConfigInput,
  type EndpointPreference,
  type OrderedEndpointCandidate,
  type OrderEndpointCandidatesInput,
  type SellerFallbackConfig,
  type SellerFallbackConfigContext,
} from './fallback';

export {
  PROVIDER_CREDENTIAL_INTERNAL_FIELDS,
  assertCredentialProvider,
  createProviderCredential,
  isCredentialHash,
  isCredentialLabel,
  isCredentialPlaintext,
  isProviderCredential,
  isProviderCredentialActive,
  isPublicProviderCredentialShape,
  revokeProviderCredential,
  toPublicProviderCredential,
  type CreateProviderCredentialInput,
  type CreatedProviderCredential,
  type ProviderCredential,
  type PublicProviderCredential,
  type RevokeProviderCredentialInput,
} from './provider-credential';

export {
  assertEligibilityForTenant,
  evaluateActivationEligibility,
  isSellerOperationalEligibility,
  type ActivationEligibilityAssessment,
  type SellerOperationalEligibility,
} from './eligibility';

export {
  MODEL_OFFER_ACTIVATABLE_STATUSES,
  MODEL_OFFER_STATUS,
  activateModelOffer,
  assertPublicAliasUnique,
  assignPublicAlias,
  createModelOffer,
  deactivateModelOffer,
  isModelOffer,
  isModelOfferServing,
  isModelOfferStatus,
  isPublicAlias,
  replaceCapabilities,
  retireModelOffer,
  type ActivateModelOfferInput,
  type AssignPublicAliasInput,
  type CreateModelOfferInput,
  type DeactivateModelOfferInput,
  type ModelOffer,
  type ModelOfferStatus,
  type ReplaceCapabilitiesInput,
  type RetireModelOfferInput,
} from './model-offer';
