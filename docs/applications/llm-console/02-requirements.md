# llm-console — 02 Requirements

> Yêu cầu của deploy unit `llm-console`. Bounded context requirements → canonical ở [`docs/domains/llm-marketplace/`](../../domains/llm-marketplace/), [`docs/domains/llm-consumer-tenant/`](../../domains/llm-consumer-tenant/), [`docs/domains/llm-consumer-routing/`](../../domains/llm-consumer-routing/), [`docs/domains/llm-seller-pricing/`](../../domains/llm-seller-pricing/), [`docs/domains/llm-financial/`](../../domains/llm-financial/), [`docs/domains/llm-usage/`](../../domains/llm-usage/). File này chỉ tóm tắt deploy-unit-specific.

## Functional (deploy-unit)

- FR-LC-01: API key lifecycle management (create show-once / rotate / revoke) qua BFF.
- FR-LC-02: Alias/routing configuration UI (model alias, routing policy, candidate/fallback) qua contract.
- FR-LC-03: Balance view (available balance, ledger entries).
- FR-LC-04: Top-up initiation và trạng thái theo dõi qua payment/financial contract.
- FR-LC-05: Usage views (request-level, attempt-level, token categories).
- FR-LC-06: Workspace/tenant scope resolution từ principal.
- FR-LC-07: Web push subscription management (consumer app).
- FR-LC-08: BFF server routes read-only-or-mutating theo contract downstream; không có DB access.

## Non-functional (deploy-unit)

- NFR-LC-01: Non-SSR SPA; hydration không lệch (shell preferences từ cookie).
- NFR-LC-02: BFF fail-closed 503 khi thiếu config; error body không lộ driver message.
- NFR-LC-03: Bootstrap/build/test không cần downstream service đang sống (mock contract).
- NFR-LC-04: Strict CSP + nonce; cấm inline script.
- NFR-LC-05: Idempotent write retry với idempotency key.
- NFR-LC-06: Observability không log prompt/response body hoặc sensitive payload.
- NFR-LC-07: Shared shell styling consistent với backoffice/llm-seller.

## Security requirements

- SR-LC-01: Session cookie `__Host-*`, `HttpOnly`, `Secure`, `SameSite=Lax`.
- SR-LC-02: BFF giữ token server-side; browser không thấy token.
- SR-LC-03: Tenant ID từ principal, không từ client input.
- SR-LC-04: Authorization enforce ở resource-owning backend, không chỉ UI.
- SR-LC-05: API key plaintext show-once; storage hash-only.

## Non-goals (deploy-unit)

- Không sở hữu DB nghiệp vụ.
- Không chứa business rules thay thế bounded context.
- Không implement IdP/credential store (dùng account/auth).
- Không direct cross-database query.
- Hostname riêng cho llm-console hoãn tới threat-model decision (architecture §10).

## Acceptance (deploy-unit)

- `nx typecheck lint test` của app xanh.
- BFF fail-closed 503 khi thiếu config.
- Contract test với downstream mock xanh.
- Không write route bypass contract.
