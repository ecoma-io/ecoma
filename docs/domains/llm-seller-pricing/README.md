# LLM Seller Pricing

Bounded context `llm-seller-pricing`: seller-configured customer price, pricing schedule theo offer, per-request và per-token pricing, peak/off-peak theo IANA timezone, versioned schedule và pricing snapshot bất biến. Composed inside `llm-api`. Library `libs/llm-seller-pricing-domain`. Target architecture.

> **Phạm vi Nx:** project thuộc `scope:llm-seller`; được dùng `scope:shared`, `scope:platform`, `type:contracts`; **không** phụ thuộc `scope:llm-consumer` ([ADR-0019](../llm-consumer-tenant/adr/0019-llm-scope-ownership-and-dependency-matrix.md)).

> **Cross-reference:** catalog → [`docs/domains/README.md`](../README.md) §2 (`llm-seller-pricing`) · system-level → [`docs/architecture/01-architecture.md`](../../architecture/01-architecture.md) §2, §4, A7, invariant 16 · usage measurement (token category, subset invariant) → [`domains/llm-usage/`](../llm-usage/README.md) · routing (lowest customer price) → [`domains/llm-consumer-routing/`](../llm-consumer-routing/README.md) · financial charge/settlement → [`domains/llm-financial/`](../llm-financial/README.md); payout → [`domains/payout/`](../payout/README.md) · offer/model identity → [`domains/llm-marketplace/`](../llm-marketplace/README.md) · composed in → [`applications/llm-api/`](../../applications/llm-api/README.md).

## Documents

| Document                               | Nội dung                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`domain-model.md`](./domain-model.md) | Business model, rules, invariants, business operations, error taxonomy, quyết định chưa chốt |

## Boundary

- Pricing **chỉ** sở hữu pricing schedule, version, price resolution và pricing snapshot; không reserve quota, không dispatch, không settle usage, không charge wallet, không giữ balance.
- Seller-configured price **là** customer price. Provider cost là đại lượng độc lập, không được dùng để suy ra customer price; ownership/source của nó còn chưa chốt ([`open-boundaries.md`](../open-boundaries.md) OB-7).
- Per-request và per-token (input/output) là dimension **bắt buộc**; cached tokens là subset của input, reasoning tokens là subset của output — không double-count.
- Pricing là **versioned snapshot**: một logical request bind với một pricing snapshot tại admission; pricing change sau đó **không** alter giá đã admit.
- Tính tiền dùng **fixed-point** (số nguyên), **không** dùng floating point ở bất kỳ bước nào.
- Pricing snapshot persist cùng logical request record để audit/replay.
