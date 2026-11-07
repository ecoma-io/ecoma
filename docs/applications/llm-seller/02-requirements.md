# llm-seller — Requirements

> Yêu cầu của deploy unit `llm-seller`. Bounded context requirements → canonical ở [`docs/domains/llm-seller-tenant/`](../../domains/llm-seller-tenant/), [`docs/domains/llm-seller-governance/`](../../domains/llm-seller-governance/), [`docs/domains/llm-seller-pricing/`](../../domains/llm-seller-pricing/), [`docs/domains/llm-marketplace/`](../../domains/llm-marketplace/), [`docs/domains/llm-consumer-tenant/`](../../domains/llm-consumer-tenant/), [`docs/domains/llm-financial/`](../../domains/llm-financial/). File này chỉ tóm tắt deploy-unit-specific.

## 1. Functional (deploy-unit)

- FR-LS-01: Seller profile view và edit theo contract của `llm-seller-tenant` và `llm-seller-governance` (ownership/membership, legal/tax profile version, verification status); không tự suy ra trạng thái Seller.
- FR-LS-02: Offer CRUD + capability + activation toggle.
- FR-LS-03: Upstream endpoint CRUD + endpoint pool management.
- FR-LS-04: Provider credential create (show-once) / revoke.
- FR-LS-05: Seller pricing edit theo contract của `llm-seller-pricing`.
- FR-LS-06: Earnings view (seller payable).
- FR-LS-07: Settlement views (status, history).
- FR-LS-08: Workspace/tenant scope resolution từ principal.
- FR-LS-09: Web push subscription management (seller app).
- FR-LS-10: BFF server routes read-only-or-mutating theo contract downstream; không có DB access.

## 2. Non-functional (deploy-unit)

- NFR-LS-01: Non-SSR SPA; hydration không lệch (shell preferences từ cookie).
- NFR-LS-02: BFF fail-closed 503 khi thiếu config; error body không lộ driver message.
- NFR-LS-03: Bootstrap/build/test không cần downstream service đang sống (mock contract).
- NFR-LS-04: Strict CSP + nonce; cấm inline script.
- NFR-LS-05: Idempotent write retry với idempotency key.
- NFR-LS-06: Observability không log prompt/response body hoặc sensitive payload.
- NFR-LS-07: Shared shell styling consistent với backoffice/llm-console.

## 3. Security requirements

- SR-LS-01: Session cookie `__Host-*`, `HttpOnly`, `Secure`, `SameSite=Lax`.
- SR-LS-02: BFF giữ token server-side; browser không thấy token.
- SR-LS-03: Tenant ID từ principal, không từ client input.
- SR-LS-04: Authorization enforce ở resource-owning backend, không chỉ UI.
- SR-LS-05: Credential plaintext show-once; storage hash-only.

## 4. Non-goals (deploy-unit)

- Không sở hữu DB nghiệp vụ.
- Không chứa business rules thay thế bounded context.
- Không implement IdP/credential store (dùng account/auth).
- Không direct cross-database query.
- Hostname riêng cho llm-seller hoãn tới threat-model decision (architecture §10).

## 5. Acceptance (deploy-unit)

- `nx typecheck lint test` của app xanh.
- BFF fail-closed 503 khi thiếu config.
- Contract test với downstream mock xanh.
- Không write route bypass contract.
