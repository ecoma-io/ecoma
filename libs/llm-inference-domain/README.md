# LLM Inference Domain

Tầng domain thuần của bounded context `llm-inference` (`@ecoma-io/llm-inference-domain`): lifecycle request suy luận logic, lifecycle provider attempt, execution evidence, retry admissibility, streaming/delivery facts và completion của logical request.

Thư viện **không** import Nx project nào, **không** SQL, **không** Node builtin, **không** I/O, không HTTP client hay provider SDK; thời gian, identifier, dữ kiện thực thi, snapshot và policy limit do caller truyền vào — domain không đọc đồng hồ, không sinh identifier. Không persistence, durable idempotency, transaction, optimistic concurrency, recovery worker hay event dispatch.

Nx project `@ecoma-io/llm-inference-domain`, tags `type:domain`, `scope:llm-shared`, `runtime:universal`.

## Purpose

- Tập trung lifecycle request suy luận — attempt nào mở, evidence nào authoritative, retry nào được phép, client disconnect ảnh hưởng ra sao — thành thư viện thuần không phụ thuộc persistence hay transport.
- Entry công khai duy nhất là `src/index.ts` (`main` của package).

## Responsibilities

Exports công khai (từ `src/index.ts`):

- **Domain errors** (`errors.ts`): `InferenceDomainErrorCode`, `INFERENCE_DOMAIN_ERROR_MESSAGES`.
- **Identifiers** (`shared.ts`): `RequestId`, `AttemptId` với `createRequestId`/`createAttemptId`, `isRequestId`/`isAttemptId`, `MAX_OPAQUE_ID_LENGTH`, `InferenceOk`/`InferenceFailure`/`InferenceResult`.
- **Execution evidence** (`evidence.ts`): `EXECUTION_EVIDENCE`/`EXECUTION_EVIDENCE_VALUES`, `classifyEvidence`, `canTransitionEvidence`, `allowedEvidenceTargets`, `isAuthoritativeEvidence`, `isRetrySafeEvidence`.
- **Provider attempt** (`attempt.ts`): `ProviderAttempt`, `classifyAttemptOutcome`, `isAttemptOpen`, `isAttemptUncertain`.
- **Client delivery** (`delivery.ts`): `ClientDelivery`/`ClientDeliveryState`, `INITIAL_CLIENT_DELIVERY`, `commitClientResponse`, `recordClientDisconnect`, `hasClientOutputCommitted`, `isClientDisconnected`.
- **Execution policy** (`policy.ts`): `ExecutionPolicy`, `validateExecutionPolicy`, `isExecutionPolicy`.
- **Logical request** (`request.ts`): `createLogicalRequest`, `recordDispatchIntent`, `recordAttemptEvidence`, `closeAttempt`, `reconcileUncertainAttempt`, `awaitReconciliation`, `evaluateRetryAdmissibility` (trả `RetryDecision`/`RetryRejectionReason`), `completeRequest`/`failRequest`/`cancelRequest`, `describeRequestProgress`, `findAttempt`/`findOpenAttempt`/`latestAttempt`, `hasUnresolvedUncertainty`, `isRequestTerminal`, `isTerminalStatus`.

## Boundaries

- Chọn candidate và thứ tự fallback thuộc `llm-consumer-routing` — domain này nhận `candidateRef`/`endpointRef` làm input; `fallback.ts` của routing chỉ đọc vocabulary evidence tại biên.
- Model offer, upstream endpoint, endpoint pool, credential metadata thuộc `llm-marketplace`; usage measurement thuộc `llm-usage`; customer price thuộc `llm-seller-pricing`; monetary state và settlement thuộc `llm-financial`.
- Quota authority (reserve/settle), persistence, provider adapter, HTTP/SSE và orchestration thuộc runtime host `llm-api`.
- Các quyết định để mở của context (default `maxAttempts`/deadline, huỷ request khi client disconnect, escalation khi bất định không thể reconcile) nằm ở `docs/domains/llm-inference/domain-model.md` §10 — lib không có API nào chốt giúp.

## Development

```bash
pnpm nx run @ecoma-io/llm-inference-domain:lint
pnpm nx run @ecoma-io/llm-inference-domain:typecheck          # tsc --build --emitDeclarationOnly
```

Mã nguồn nằm dưới `src/`; thêm module mới = thêm file và spec colocated, rồi export qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/llm-inference-domain:test               # vitest — spec colocated trong src/
```

Spec colocated: `request.spec.ts`, `evidence.spec.ts`, `delivery.spec.ts`, `errors.spec.ts`, `guards.spec.ts`, `index.spec.ts`.

## Related Documentation

- [`docs/domains/llm-inference/README.md`](../../docs/domains/llm-inference/README.md) — bounded context; [`domain-model.md`](../../docs/domains/llm-inference/domain-model.md) — evidence matrix, retry admissibility, delivery facts, unresolved decisions.
- [`docs/domains/llm-consumer-routing/README.md`](../../docs/domains/llm-consumer-routing/README.md) — context quyết định candidate mà attempt này thực thi.
- [`docs/applications/llm-api/README.md`](../../docs/applications/llm-api/README.md) — runtime host compose các context LLM.
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — §6.3 scope `llm-shared`, §3 dependency direction.
