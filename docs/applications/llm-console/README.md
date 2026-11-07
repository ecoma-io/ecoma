# llm-console — Application

`llm-console` là **composition: UI consumer + BFF** thuộc các bounded context `llm-*` (catalog → [`docs/domains/README.md`](../../domains/README.md) §2). Deploy unit chạy trên Edge (Cloudflare Worker), không sở hữu database nghiệp vụ — ghi qua contract/API của các context owning (`llm-api` cho `llm-consumer-tenant`, `llm-consumer-routing`, `llm-financial`, `payment`). Chi tiết bounded context, domain rules → canonical ở [`docs/domains/`](../../domains/).

> `llm-console` là Nuxt SPA + BFF composing `llm-consumer-tenant` và `llm-consumer-routing`; document composition và contract consumption, không domain ownership. Domain ownership luôn thuộc `docs/domains/*/domain-model.md`.

## Vai trò composition

- **UI consumer** cho khách hàng dùng LLM gateway: API key management, alias/routing configuration, balance/top-up, usage views.
- **BFF** giữ token server-side; trình browser chỉ thấy session cookie; mọi dữ liệu nghiệp vụ đi qua API của context owning.
- **Không sở hữu DB nghiệp vụ**, không chứa business rules thay thế bounded context.

## Documents

| Document                                     | Nội dung                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [`01-architecture.md`](./01-architecture.md) | Ranh giới composition, runtime Nuxt SPA + BFF non-SSR, UI/application boundary, authN/authZ, API integration, session/security |
| [`02-requirements.md`](./02-requirements.md) | FR/NFR/SR deploy-unit-specific, non-goals, acceptance                                                                          |
| [`03-operations.md`](./03-operations.md)     | Deployment, config, monitoring, failure, recovery, runbook                                                                     |

## Cross-reference

- Composition nội bộ: [`llm-consumer-tenant`](../../domains/llm-consumer-tenant/README.md), [`llm-consumer-routing`](../../domains/llm-consumer-routing/README.md).
- Bounded contexts consumed qua contract/API: [`llm-seller-pricing`](../../domains/llm-seller-pricing/README.md), [`llm-financial`](../../domains/llm-financial/README.md), [`llm-usage`](../../domains/llm-usage/README.md).
- Tenant/workspace/membership/permission grant → [`docs/domains/llm-consumer-tenant/`](../../domains/llm-consumer-tenant/README.md).
- Routing/alias → [`docs/domains/llm-consumer-routing/`](../../domains/llm-consumer-routing/README.md).
- Pricing → [`docs/domains/llm-seller-pricing/`](../../domains/llm-seller-pricing/README.md) (nếu có).
- Financial correctness (balance, top-up, usage) → [`docs/domains/llm-financial/`](../../domains/llm-financial/README.md).
- Payment/payout canonical → [`docs/domains/payment/`](../../domains/payment/README.md) (nếu có).
- Usage measurement → [`docs/domains/llm-usage/`](../../domains/llm-usage/README.md).
- Staff Access entitlement → [`docs/domains/staff-access/`](../../domains/staff-access/README.md).
- System-level boundary/data ownership → [`docs/architecture/01-architecture.md`](../../architecture/01-architecture.md) §2, §4.
- Shared shell → [`libs/ui-app-shell/`](../../../libs/ui-app-shell/README.md).
