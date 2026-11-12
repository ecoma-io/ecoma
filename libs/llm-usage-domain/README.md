# LLM Usage Domain

Thư viện domain thuần của bounded context `llm-usage` (`@ecoma-io/llm-usage-domain`): normalization của usage theo provider, token accounting, correction và reconciliation. Ngữ nghĩa và quy tắc đo lường là nội dung canonical của [`docs/domains/llm-usage/`](../../docs/domains/llm-usage/README.md) — thư viện hiện thực một phần tri thức đó bằng code.

Nx project `@ecoma-io/llm-usage-domain`, tags `type:domain`, `scope:llm-shared`, `runtime:universal`; `package.json` không có dependency nào.

## Purpose

- Cung cấp schema chuẩn (`NormalizedUsage`), phép tính token accounting và các operation thuần (normalize, classify, aggregate, correction, reconcile) cho đo lường usage của logical request và từng attempt.
- Giữ tách bạch đo lường và tài chính: usage là dữ liệu đo, charge là quyết định của context tài chính — thư viện không sở hữu quota/reservation/settlement/credit/balance/ledger.

## Responsibilities

- **Kiểu canonical** (`types.ts`): `NormalizedUsage`, `TokenCount`, `AttemptUsage`, `RequestUsage`, `Correction`, `ReconciliationResult`, `Provenance`, `USAGE_STATUS` — mọi giá trị readonly/immutable.
- **Lỗi** (`errors.ts`): `llmUsageDomainError`, `isLLMUsageDomainError`, catalog `LLM_USAGE_DOMAIN_ERROR_MESSAGES`.
- **Schema và invariant token** (`normalized-usage.ts`): `createNormalizedUsage`, `validateUsageInvariants`, `computeTotalTokens`, `isValidTokenCount` — cached là subset của input, reasoning là subset của output.
- **Provenance** (`provenance.ts`): `createProvenance`, `isProvenance`.
- **Normalize** (`normalize.ts`): `normalizeUsage` — input là `ParsedProviderUsage` đã parse ở lớp adapter; version do caller cấp, cùng input + cùng version cho cùng output.
- **Phân loại, tổng hợp, correction, reconciliation** (`classify.ts`, `aggregate.ts`, `correction.ts`, `reconcile.ts`): `classifyUsage`, `aggregateAttemptUsage`, `isCorrectionValid`, `correctionIdempotencyKey` cho cả request-level và attempt-level, `reconcile` so sánh exact.

## Boundaries

- Thuần TypeScript: không import Nx project khác, không SQL, không Node builtin, không I/O, không đọc đồng hồ; mọi tham số thời gian do caller truyền vào.
- Không provider SDK, không HTTP client, không DB driver, không ORM; domain không đọc raw HTTP payload — adapter/infrastructure mới parse provider usage.
- Không persistence, durable idempotency, alerting hay event dispatch; durable state của context nằm ở phía application (`llm-api` và `db-llm-gateway` theo [`docs/domains/llm-usage/README.md`](../../docs/domains/llm-usage/README.md)).
- Các quyết định còn mở của context — cách tổng hợp nhiều attempt, thứ tự replacement correction, quan hệ scope correction, tolerance của reconciliation — là nội dung canonical của [domain model](../../docs/domains/llm-usage/domain-model.md) §13; thư viện không tự chốt thay (hành vi hiện tại của từng operation được ghi trong header `src/index.ts`).

## Development

```bash
pnpm nx run @ecoma-io/llm-usage-domain:lint
pnpm nx run @ecoma-io/llm-usage-domain:typecheck   # tsc --build --emitDeclarationOnly
```

Entry công khai duy nhất là `src/index.ts` (`main` của package); thêm module mới đi kèm spec colocated và export tường minh qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/llm-usage-domain:test        # vitest — spec colocated trong src/
```

Spec colocated cạnh subject, ví dụ `normalize.spec.ts`, `correction.spec.ts`, `reconcile.spec.ts`.

## Related Documentation

- [`docs/domains/llm-usage/README.md`](../../docs/domains/llm-usage/README.md) — bounded context `llm-usage` và ranh giới measurement vs charge.
- [`docs/domains/llm-usage/domain-model.md`](../../docs/domains/llm-usage/domain-model.md) — domain model, normalization, token accounting, correction/reconciliation, quyết định còn mở (§13).
- [`docs/domains/llm-inference/README.md`](../../docs/domains/llm-inference/README.md) — logical request lifecycle mà usage gắn vào.
- [`docs/applications/llm-api/README.md`](../../docs/applications/llm-api/README.md) — application host context này theo catalog Applications.
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — ba scope ownership của LLM domain library (§6.3).
