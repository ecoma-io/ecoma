# LLM Inference

Bounded context `llm-inference` — lifecycle request suy luận. `llm-api` là runtime host và storage owner của `db-llm-gateway` (PostgreSQL); business ownership thuộc `llm-inference`. Tài liệu này mô tả **target architecture** cho lifecycle request suy luận. Quota policy → `llm-consumer-tenant`; usage measurement → `llm-usage`; financial monetary state → `llm-financial`. Hợp đồng crediting với `payment` → [`open-boundaries.md`](../open-boundaries.md) OB-1 (OPEN).

## Documents

| Document                               | Nội dung                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [`domain-model.md`](./domain-model.md) | Domain model, evidence matrix, retry admissibility, delivery facts, completion, error model, unresolved decisions |

## Cross-reference

- Usage measurement/normalization → [`domains/llm-usage/`](../llm-usage/README.md) (request-level và attempt-level usage, correction/reconciliation, provenance, idempotency).
- Quota/reservation/settlement → [`architecture/01-architecture.md`](../../architecture/01-architecture.md) A7, invariant 16.
- Provider usage formats → [`domains/llm-usage/`](../llm-usage/README.md).

## Boundary

- `llm-api` là owner duy nhất của `db-llm-gateway`: API key, quota, usage, reservation, settlement.
- Các app `llm-*` không chạm DB gateway; chỉ qua contract/API.
- Một logical request được tính tiền/tính quota **một lần** (`charged once`), dù có nhiều provider attempt.
- Không transparent provider switch sau khi đã stream bytes; không blind retry sau khi có khả năng provider đã thực thi.
