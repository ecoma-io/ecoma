# llm-seller — Solution Architecture

> Phạm vi: thiết kế deploy unit `llm-seller` — composition UI seller + BFF. Ranh giới bounded context `llm-*` (seller-tenant, seller-governance, seller-pricing, marketplace, consumer-tenant, financial) và `payout` → canonical ở [`docs/domains/`](../../domains/). System-level boundary → [`docs/architecture/01-architecture.md`](../../architecture/01-architecture.md).

## 1. Deploy unit

- `llm-seller`: Cloudflare Worker (Nuxt 4 + Nitro `cloudflare_module`), **non-SSR SPA** + BFF server routes. Mount theo `project.json` (shared origin `ecoma.io` hoặc hostname riêng theo threat model — [`01-architecture.md`](../../architecture/01-architecture.md) §10).
- Không sở hữu database. Không có Hyperdrive binding. Mọi dữ liệu nghiệp vụ đi qua API của context owning.
- **Phạm vi composition:** phía Seller của composition là `llm-seller-tenant`, `llm-seller-governance`, `llm-seller-pricing` và `llm-marketplace`; `llm-financial`, `payout`, `payment` và `llm-consumer-tenant` được tiêu thụ qua contract/API, không phải composition nội bộ.

## 2. Runtime

```text
apps/llm-seller  (Cloudflare Worker, Nuxt 4 + Nitro preset cloudflare_module)
├── SPA (client-only render; SSR tắt) → shell @ecoma-io/ui-app-shell
├── BFF server routes → gọi llm-api (bao gồm module llm-seller-tenant, llm-seller-governance, llm-seller-pricing, llm-consumer-tenant) / llm-marketplace / llm-financial / payout qua Service Binding hoặc fetch nội bộ
├── Browser session: OIDC qua auth.ecoma.io; BFF giữ token server-side
└── Shared shell styling/layout từ libs/ui-app-shell
```

- **Non-SSR**: rendering xảy ra ở client; server chỉ phục vụ static asset + BFF routes. Lý do: stateful dashboard, shell preferences cookie hydration, giảm serving-path dependency.
- BFF không chạm DB; mọi write đi qua contract/API của context owning.

## 3. UI / application boundaries

- **UI layer**: pages/components của seller (profile, offers, endpoints, provider credentials, seller pricing, earnings, settlement views). Dùng `@ecoma-io/ui-app-shell` cho layout shell; domain UI không gọi DB trực tiếp.
- **Application layer (BFF)**: server routes translate request/response, attach auth context, gọi API downstream, xử lý error và retry policy. Không chứa business rules thay thế bounded context.
- **Domain layer**: không tồn tại trong composition; domain rules thuộc `llm-seller-tenant`, `llm-seller-governance`, `llm-seller-pricing`, `llm-marketplace`, `llm-consumer-tenant`, `llm-financial`, `payout` và `payment`.
- Boundary enforce bằng Nx module-boundary + contract test; UI không import implementation nội bộ của downstream service.

## 4. AuthN / AuthZ

- **AuthN**: qua `account`/`auth` (OIDC). Browser session cookie `__Host-llm-seller-session` (hoặc tương đương), BFF giữ access token server-side; browser không thấy token. Token validity ≠ privilege currency (A24).
- **AuthZ**: deny-by-default, enforce ở resource-owning backend (A23). Composition chỉ làm UI visibility; permission catalog cấp sản phẩm từ `staff-access` (nếu seller là staff), còn quyền trong Seller tenant do `llm-seller-tenant` quyết định (owner authority hoặc permission grant). Composition không tự cấp permission.
- Seller tenant resolution lấy từ authenticated principal + selector đã verify, không từ client input (llm-seller-tenant §1).
- Seller identity liên kết bằng `sub` opaque; không FK xuyên database.

## 5. API integrations

| Downstream              | Mục đích trong seller UI                                                                         | Đường đi                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `llm-api`               | Offer/endpoint/credential submission, seller pricing, earnings/settlement view                   | BFF → Service Binding/fetch (auth context) |
| `llm-seller-tenant`     | Seller tenant, ownership, membership/grant                                                       | BFF → API (qua contract)                   |
| `llm-seller-governance` | Restriction/appeal, verification, legal/tax profile, onboarding, operational eligibility verdict | BFF → API (qua contract)                   |
| `llm-consumer-tenant`   | Console tenant/workspace, membership, grant                                                      | BFF → API                                  |
| `llm-marketplace`       | Offer lifecycle, capability, endpoint, provider credential, normalized identity                  | BFF → API (qua contract)                   |
| `llm-seller-pricing`    | Seller pricing cho offer                                                                         | BFF → API (qua contract)                   |
| `llm-financial`         | Seller payable, settlement, refund/adjustment view                                               | BFF → API                                  |
| `payout`                | Payout request, quote, beneficiary, disbursement status, payout reconciliation                   | BFF → API                                  |
| `payment`               | Payment transaction / gateway execution adapter (không sở hữu payout workflow)                   | BFF → API                                  |
| `staff-access`          | Entitlement cross-context (nếu seller là staff)                                                  | BFF → API                                  |
| `push-notification`     | Web push subscription cho seller app                                                             | BFF → Service Binding                      |
| `pact-broker`           | Publish/verify pact (dogfooding)                                                                 | CI/CD, không runtime serving path          |

- Mọi call đi qua BFF; browser không gọi downstream trực tiếp.
- Idempotency key + correlation ID truyền xuyên mọi hop (invariant 20).
- Không cross-database query; dữ liệu cần projection thì đồng bộ có chủ intent.

## 6. Seller workflows

1. **Seller profile**: thông tin Seller tenant, ownership/membership (llm-seller-tenant); trạng thái restriction và verification, legal/tax profile (llm-seller-governance).
2. **Offers**: tạo/cập nhật offer model, capability, activation (llm-marketplace).
3. **Endpoints**: upstream endpoint URL/protocol/health, endpoint pool load balancing/failover (llm-marketplace).
4. **Provider credentials**: tạo credential hash-only show-once, revoke (llm-marketplace).
5. **Seller pricing**: seller pricing cho offer (llm-seller-pricing).
6. **Earnings**: seller payable view (llm-financial).
7. **Settlement views**: settlement/earnings status (llm-financial) và payout status (payout); không mutate settlement từ UI ngoài contract.

Composition chỉ orchestrate UI + gọi API; business rule và state machine thuộc context owning.

## 7. Session / security boundary

- Session cookie `__Host-*`, `HttpOnly`, `Secure`, `SameSite=Lax`, isolate theo hostname (architecture §6).
- BFF giữ token server-side; browser chỉ giữ session ID. Pattern hash-only storage (`id_hash = SHA-256(id)`) như pact-broker-app/backoffice.
- XSS ở shared origin `ecoma.io/*` ảnh hưởng app cùng origin → strict CSP + nonce, cấm inline script, sanitize server-side (architecture §6).
- Thao tác nhạy cảm (credential create/revoke, pricing change) cần step-up auth khi được chốt.
- Observability không log prompt/response body hoặc sensitive payload.

## 8. Error handling và application lifecycle

- Downstream unavailable → BFF trả error chuẩn, không lộ driver message; fail-closed cho route cần downstream.
- Idempotent retry ở BFF cho write có idempotency key; không retry không idempotent.
- Health: `GET /health` (liveness, không chạm downstream), `GET /ready` (config + downstream readiness) — fail-closed 503 khi thiếu config.
- Graceful degradation: UI hiển thị trạng thái unavailable; không cache stale như authority.

## 9. Invariants (deploy-unit)

1. `llm-seller` không sở hữu DB và không chạm DB của context khác.
2. Mọi dữ liệu nghiệp vụ đi qua contract/API của context owning.
3. Authenticated actor (`sub`) lấy từ verified authentication context; tenant selector có thể do client cung cấp nhưng backend phải xác minh membership/permission/tenant active/resource ownership tại write boundary; fail closed nếu không xác minh được.
4. BFF không tin claim do client gửi.
5. Authorization enforce ở resource-owning backend, không chỉ ở UI.
6. Không log prompt/response body hoặc sensitive payload.
