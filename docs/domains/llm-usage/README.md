# LLM Usage

Bounded context `llm-usage` — phân hệ đo lường usage: provider-specific usage formats, normalization, token accounting (input/output/cached/reasoning), request-level và attempt-level usage, correction/reconciliation, missing/malformed provider usage, provenance và idempotency. Target architecture. Quota authority → [`architecture/01-architecture.md`](../../architecture/01-architecture.md) A7. Logical request lifecycle → [`domains/llm-inference/`](../llm-inference/README.md).

## Documents

| Document                               | Nội dung                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`domain-model.md`](./domain-model.md) | Domain model, value objects, normalization, token accounting, correction/reconciliation, provenance |

## Boundary

- Usage **measurement** (đo lường tiêu thụ) khác **financial charge** (tính tiền). Usage là dữ liệu đo lường; charge là quyết định tài chính do authority/quota/settlement xử lý. Hai khái niệm không đồng nhất.
- Usage ghi durable cho logical request (request-level) và từng attempt (attempt-level); charge chỉ tính một lần per logical request (`charged once` ở llm-inference).
- `llm-api` sở hữu usage durable state trong `db-llm-gateway`.
