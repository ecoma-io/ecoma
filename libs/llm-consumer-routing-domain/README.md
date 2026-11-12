# LLM Consumer Routing Domain

Tầng domain thuần của bounded context `llm-consumer-routing` (`@ecoma-io/llm-consumer-routing-domain`): model alias, routing policy, candidate selection, eligibility, strategy (priority/round-robin/lowest-price), fallback hai cấp dựa trên execution evidence, và policy version/snapshot.

Thư viện **không** import Nx project khác, **không** SQL, **không** Node builtin, **không** I/O, **không** global mutable state; thời gian, cursor và randomness do caller truyền vào. Hàm thuần trả `DomainOk`/`DomainRejection` thay vì ném exception cho dữ liệu đầu vào hỏng.

Nx project `@ecoma-io/llm-consumer-routing-domain`, tags `type:domain`, `scope:llm-consumer`, `runtime:universal`.

## Purpose

- Tập trung luật routing phía Consumer — chọn candidate nào, thứ tự nào, khi nào được fallback — thành thư viện thuần không phụ thuộc persistence hay transport.
- Entry công khai duy nhất là `src/index.ts` (`main` của package); các module khác là internal.

## Responsibilities

Exports công khai (từ `src/index.ts`):

- **Shared guards**: `DomainOk`/`DomainRejection`, `isNonEmptyString`, `isEpochMillis`, `isFiniteNumber`, `isNonNegativeInteger`, `isPositiveInteger` (`shared.ts`).
- **Domain errors**: `RoutingDomainErrorCode` (`invalid_alias`, `alias_not_found`, `alias_retired`, `invalid_policy_version`, `invalid_candidate`, `no_eligible_candidate`, `fallback_not_allowed`, `fallback_exhausted`, `invalid_strategy_input`, `invalid_snapshot`), `ROUTING_DOMAIN_ERROR_MESSAGES` — message tiếng Anh, không mang identifier/token (`errors.ts`).
- **Alias**: `ModelAlias`, `AliasRecord`, `resolveAlias`, `retireAlias`, `ALIAS_STATUS` (`alias.ts`).
- **Policy và candidate**: `createPolicy`, `isRoutingPolicy` (`policy.ts`); `Candidate`, `CandidateCapability`, `CANDIDATE_STATUS` (`candidate.ts`).
- **Eligibility**: `evaluateEligibility`, `filterEligible` với `EligibilityFacts`/`EligibilityDenialReason` (`eligibility.ts`).
- **Strategy**: `selectByPriority`, `selectRoundRobin` (với `RoundRobinCursor` do caller giữ), `selectLowestPrice` (giá qua `PriceFact` do caller cấp), `selectCandidate` (`strategy.ts`).
- **Fallback**: `decideFallback`, `isFallbackAllowedEvidence` dựa trên `ExecutionEvidence` (`fallback.ts`).
- **Snapshot**: `buildSnapshot`, `freezeSnapshot`, `RoutingPolicyVersion`, `FallbackConfig`, `RoutingSnapshot` (`snapshot.ts`).

Consumer trong workspace: `tools/dx/src/architecture/llm-boundaries.spec.ts` ghim ranh giới scope của các lib LLM theo đúng tên project này.

## Boundaries

- Tính giá và pricing catalog thuộc `llm-seller-pricing`; reserve/settle quota thuộc runtime host (`llm-api`); dispatch/provider execution thuộc `llm-inference`; tenant/membership/workspace thuộc `llm-consumer-tenant` — domain này nhận facts làm input, không tự gọi sang context nào.
- Seller offer và upstream endpoint thuộc `llm-marketplace`.
- Không phụ thuộc `scope:llm-seller` — chiều phụ thuộc giữa ba nhóm scope Consumer/Seller/Shared ghim bởi ADR-0019 và `docs/architecture/05-code-architecture.md` §6.3.

## Development

```bash
pnpm nx run @ecoma-io/llm-consumer-routing-domain:lint
pnpm nx run @ecoma-io/llm-consumer-routing-domain:typecheck   # tsc --build --emitDeclarationOnly
```

Mã nguồn nằm dưới `src/`; thêm module mới = thêm file và spec colocated, rồi export qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/llm-consumer-routing-domain:test        # vitest — spec colocated trong src/
```

Spec colocated theo module: `alias.spec.ts`, `policy.spec.ts`, `candidate.spec.ts`, `eligibility.spec.ts`, `strategy.spec.ts`, `fallback.spec.ts`, `snapshot.spec.ts`, `errors.spec.ts`.

## Related Documentation

- [`docs/domains/llm-consumer-routing/README.md`](../../docs/domains/llm-consumer-routing/README.md) — bounded context; [`domain-model.md`](../../docs/domains/llm-consumer-routing/domain-model.md) — operation signature, fallback semantics, invariants.
- [`docs/domains/llm-consumer-tenant/adr/0019-llm-scope-ownership-and-dependency-matrix.md`](../../docs/domains/llm-consumer-tenant/adr/0019-llm-scope-ownership-and-dependency-matrix.md) — ma trận scope và chiều phụ thuộc LLM.
- [`docs/domains/llm-inference/README.md`](../../docs/domains/llm-inference/README.md) — lifecycle request suy luận mà fallback evidence đến từ đó.
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — §6.3 scope `llm-consumer`, §3 dependency direction.
