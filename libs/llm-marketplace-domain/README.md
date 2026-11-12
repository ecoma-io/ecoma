# LLM Marketplace Domain

Tầng domain thuần của bounded context `llm-marketplace` (`@ecoma-io/llm-marketplace-domain`): model offer, normalized model identity và provider model name, capability, upstream endpoint, endpoint pool, Seller endpoint fallback trong một offer, provider credential (hash-only, show-once) và offer activation.

Thư viện **không** import Nx project nào (kể cả các lib `llm-seller-*` hay `llm-financial-domain`), **không** SQL, **không** Node builtin, **không** I/O; thời gian do caller truyền vào. Không provider SDK, không HTTP client, không DB driver, không ORM, không crypto.

Nx project `@ecoma-io/llm-marketplace-domain`, tags `type:domain`, `scope:llm-seller`, `runtime:universal`.

## Purpose

- Tập trung catalog phía Seller — offer, capability, endpoint pool và credential — thành thư viện thuần, giữ `sellerTenantId` như tham chiếu opaque và tiêu thụ eligibility verdict thay vì tự quyết.
- Entry công khai duy nhất là `src/index.ts` (`main` của package).

## Responsibilities

Exports công khai (từ `src/index.ts`, nhóm chính):

- **Domain errors** (`errors.ts`): `LlmMarketplaceDomainErrorCode`, `LLM_MARKETPLACE_DOMAIN_ERROR_MESSAGES`.
- **Identifiers** (`shared.ts`): `SellerTenantId`, `SellerActorId`, `ModelOfferId`, `UpstreamEndpointId`, `EndpointPoolId`, `ProviderCredentialId` với bộ `create*`/`is*`, giới hạn độ dài (`MAX_MODEL_NAME_LENGTH`, `MAX_PUBLIC_ALIAS_LENGTH`, `MAX_ENDPOINT_URL_LENGTH`, `MAX_ENDPOINT_WEIGHT`, `MAX_CREDENTIAL_HASH_LENGTH`, `MAX_CREDENTIAL_PLAINTEXT_LENGTH`, `MAX_PROVIDER_KEY_LENGTH`, `MAX_OPAQUE_ID_LENGTH`), `llmMarketplaceOk`/`llmMarketplaceFailure`.
- **Capability** (`capability.ts`): `CapabilitySet`, `createCapabilitySet`, `hasCapability`, `satisfiesCapabilities`.
- **Model identity** (`model-identity.ts`): `createNormalizedModelIdentity`, `createProviderModelName`, `mapProviderModelToNormalizedIdentity`, `normalizeModelId`, `assertProviderModelNameUnique`.
- **Endpoint và pool** (`endpoint.ts`): `createUpstreamEndpoint`, `createEndpointPool`, `addEndpointToPool`/`replaceEndpointInPool`/`removeEndpointFromPool`, `recordEndpointHealth`, `deriveEndpointPoolHealth`, `evaluateOfferEndpointHealth`, `ENDPOINT_HEALTH_STATUS`.
- **Seller endpoint fallback** (`fallback.ts`): `createSellerFallbackConfig`, `orderEndpointCandidates` — fallback trong phạm vi một offer; fallback giữa các offer thuộc routing.
- **Provider credential** (`provider-credential.ts`): `createProviderCredential` (plaintext chỉ trả một lần qua `CreatedProviderCredential`), `toPublicProviderCredential`, `isPublicProviderCredentialShape`, `revokeProviderCredential`, `PROVIDER_CREDENTIAL_INTERNAL_FIELDS` — domain không hash và không verify plaintext, hashing là trách nhiệm caller.
- **Eligibility tại biên** (`eligibility.ts`): `SellerOperationalEligibility`, `isSellerOperationalEligibility`, `evaluateActivationEligibility`, `assertEligibilityForTenant`.
- **Model offer** (`model-offer.ts`): `createModelOffer`, `activateModelOffer`/`deactivateModelOffer`/`retireModelOffer`, `assignPublicAlias`/`assertPublicAliasUnique`, `replaceCapabilities`, `MODEL_OFFER_STATUS`/`MODEL_OFFER_ACTIVATABLE_STATUSES`, `isModelOfferServing`.

Consumer trong workspace: `tools/dx/src/architecture/llm-boundaries.spec.ts` ghim ranh giới scope của các lib LLM theo đúng tên project này.

## Boundaries

- Seller tenant, membership và ownership thuộc `llm-seller-tenant`; restriction/verification/legal-tax và operational eligibility **verdict** thuộc `llm-seller-governance` — lib chỉ khai báo `SellerOperationalEligibility` tại biên và tiêu thụ verdict.
- Consumer routing (alias, priority/round-robin/lowest-price, fallback giữa các offer) thuộc `llm-consumer-routing-domain`.
- Provider cost, customer price, quota và settlement không thuộc lib này.
- Các quyết định để mở của context (public seller prefix, quy tắc unique public alias xuyên seller, retention credential, chiến lược chọn endpoint trong pool) nằm ở `docs/domains/llm-marketplace/domain-model.md` §11 — lib không có API nào chốt giúp.

## Development

```bash
pnpm nx run @ecoma-io/llm-marketplace-domain:lint
pnpm nx run @ecoma-io/llm-marketplace-domain:typecheck        # tsc --build --emitDeclarationOnly
```

Mã nguồn nằm dưới `src/`; thêm module mới = thêm file và spec colocated, rồi export qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/llm-marketplace-domain:test             # vitest — spec colocated trong src/
```

Spec colocated theo module: `model-offer.spec.ts`, `capability.spec.ts`, `endpoint.spec.ts`, `fallback.spec.ts`, `provider-credential.spec.ts`, `eligibility.spec.ts`, `model-identity.spec.ts`, `errors.spec.ts`, `shared.spec.ts`, `index.spec.ts`.

## Related Documentation

- [`docs/domains/llm-marketplace/README.md`](../../docs/domains/llm-marketplace/README.md) — bounded context; [`domain-model.md`](../../docs/domains/llm-marketplace/domain-model.md) — offer, endpoint pool, credential, undecided points (§11).
- [`docs/domains/llm-seller-governance/README.md`](../../docs/domains/llm-seller-governance/README.md) — nguồn của operational eligibility verdict mà lib này tiêu thụ.
- [`docs/applications/llm-health-check/README.md`](../../docs/applications/llm-health-check/README.md) — job đo health evidence của upstream endpoint; ý nghĩa nghiệp vụ của `health_status` thuộc context.
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — §6.3 scope `llm-seller`, §3 dependency direction.
