# LLM Consumer Routing

Bounded context `llm-consumer-routing` — phân hệ routing phía Consumer: model alias, routing policy, candidate selection (provider/endpoint), fallback config hai cấp (offer-level và endpoint-level). Target architecture. Quota/usage/settlement authority → [`architecture/01-architecture.md`](../../architecture/01-architecture.md) A7, invariant 16. Logical request lifecycle → [`domains/llm-inference/`](../llm-inference/README.md). Pricing → [`domains/llm-seller-pricing/`](../llm-seller-pricing/README.md). Library `libs/llm-consumer-routing-domain`.

> **Phạm vi Nx:** project thuộc `scope:llm-consumer`; được dùng `scope:shared`, `scope:platform`, `type:contracts`; **không** phụ thuộc `scope:llm-seller` ([ADR-0019](../llm-consumer-tenant/adr/0019-llm-scope-ownership-and-dependency-matrix.md)).

## Documents

| Document                               | Nội dung                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [`domain-model.md`](./domain-model.md) | Domain model, operation signature, fallback semantics, business invariants, cross-context boundaries |

## Boundary

- Routing **chỉ** quyết định candidate nào được chọn và thứ tự fallback; không reserve quota, không dispatch, không settle.
- Routing config là **versioned snapshot**: một logical request bind với một routing snapshot tại admission; pricing change hay routing change sau đó không làm thay đổi request đã admit.
- Alias lifecycle và candidate eligibility được resolve **trước** strategy selection (eligibility gate trước strategy).
- `llm-api` là owner duy nhất của routing config durable state trong `db-llm-gateway`; app `llm-*` không chạm DB.
