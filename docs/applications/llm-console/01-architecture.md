# llm-console — 01 Architecture

> Phạm vi: thiết kế deploy unit `llm-console` — composition UI consumer + BFF. Ranh giới bounded context `llm-*` (consumer-tenant, consumer-routing, seller-pricing, financial, usage) → canonical ở [`docs/domains/`](../../domains/). System-level boundary → [`docs/architecture/01-architecture.md`](../../architecture/01-architecture.md).

## 1. Deploy unit

- `llm-console`: Cloudflare Worker (Nuxt 4 + Nitro `cloudflare_module`), **non-SSR SPA** + BFF server routes. Mount theo `project.json` (shared origin `ecoma.io` hoặc hostname riêng theo threat model — [`01-architecture.md`](../../architecture/01-architecture.md) §10).
- Không sở hữu database. Không có Hyperdrive binding. Mọi dữ liệu nghiệp vụ đi qua API của context owning.
- **Phạm vi composition:** phía Consumer của composition là `llm-consumer-tenant` và `llm-consumer-routing`; các context còn lại (`llm-seller-pricing`, `llm-financial`, `llm-usage`, `payment`) được tiêu thụ qua contract/API. Domain rules vẫn thuộc context owning — composition chỉ orchestrate UI + BFF.

## 2. Runtime

```text
apps/llm-console  (Cloudflare Worker, Nuxt 4 + Nitro preset cloudflare_module)
├── SPA (client-only render; SSR tắt) → shell @ecoma-io/ui-app-shell
├── BFF server routes → gọi llm-api (gồm module llm-consumer-tenant, llm-consumer-routing) / llm-financial / payment / llm-usage qua Service Binding hoặc fetch nội bộ
├── Browser session: OIDC qua auth.ecoma.io; BFF giữ token server-side
└── Shared shell styling/layout từ libs/ui-app-shell
```

- **Non-SSR**: rendering xảy ra ở client; server chỉ phục vụ static asset + BFF routes.
- BFF không chạm DB; mọi write đi qua contract/API của context owning.

## 3. UI / application boundaries

- **UI layer**: pages/components của consumer (API key management, alias/routing configuration, balance/top-up, usage views). Dùng `@ecoma-io/ui-app-shell` cho layout shell; domain UI không gọi DB trực tiếp.
- **Application layer (BFF)**: server routes translate request/response, attach auth context, gọi API downstream, xử lý error và retry policy. Không chứa business rules thay thế bounded context.
- **Domain layer**: không tồn tại trong composition; domain rules thuộc `llm-api`/`llm-consumer-tenant`/`llm-consumer-routing`/`llm-financial`/`llm-usage`/`payment`.
- Boundary enforce bằng Nx module-boundary + contract test; UI không import implementation nội bộ của downstream service.

## 4. AuthN / AuthZ

- **AuthN**: qua `account`/`auth` (OIDC). Browser session cookie `__Host-llm-console-session` (hoặc tương đương), BFF giữ access token server-side; browser không thấy token. Token validity ≠ privilege currency (A24).
- **AuthZ**: deny-by-default, enforce ở resource-owning backend (A23). Composition chỉ làm UI visibility; permission catalog cấp sản phẩm từ `staff-access` (nếu consumer là staff) hoặc permission grant của `llm-consumer-tenant`. Composition không tự cấp permission.
- Tenant/workspace resolution lấy từ authenticated principal, không từ client input (llm-consumer-tenant §1).
- Consumer identity liên kết bằng `sub` opaque; không FK xuyên database.

## 5. API integrations

| Downstream             | Mục đích trong consumer UI                                                    | Đường đi                                   |
| ---------------------- | ----------------------------------------------------------------------------- | ------------------------------------------ |
| `llm-api`              | API key lifecycle, alias/routing config submission, usage view                | BFF → Service Binding/fetch (auth context) |
| `llm-consumer-tenant`  | Workspace/tenant scope, membership, permission grant (module trong `llm-api`) | BFF → API của `llm-api`                    |
| `llm-consumer-routing` | Alias/model configuration, routing policy, fallback config                    | BFF → API (qua contract)                   |
| `llm-financial`        | Balance, top-up, billing account, charge/settlement view                      | BFF → API                                  |
| `payment`              | Top-up/payment initiation, payout status (canonical ở payment)                | BFF → API                                  |
| `llm-usage`            | Usage measurement views (request/attempt-level)                               | BFF → API                                  |
| `staff-access`         | Entitlement cross-context (nếu consumer là staff)                             | BFF → API                                  |
| `push-notification`    | Web push subscription cho consumer app                                        | BFF → Service Binding                      |
| `pact-broker`          | Publish/verify pact (dogfooding)                                              | CI/CD, không runtime serving path          |

- Mọi call đi qua BFF; browser không gọi downstream trực tiếp.
- Idempotency key + correlation ID truyền xuyên mọi hop (invariant 20).
- Không cross-database query; dữ liệu cần projection thì đồng bộ có chủ đích.

## 6. Consumer workflows

1. **API keys**: tạo/rotate/revoke API key cho consumer (llm-api contract).
2. **Alias/routing configuration**: khai báo model alias, routing policy, candidate/fallback config (llm-consumer-routing).
3. **Balance**: xem available balance, ledger entries (llm-financial).
4. **Top-up**: khởi tạo top-up qua payment; theo dõi trạng thái (payment/llm-financial).
5. **Usage**: xem usage theo request/attempt, token categories (llm-usage).
6. **Workspace/tenant scope**: resolve scope từ principal (llm-consumer-tenant).

Composition chỉ orchestrate UI + gọi API; business rule và state machine thuộc context owning.

## 7. Session / security boundary

- Session cookie `__Host-*`, `HttpOnly`, `Secure`, `SameSite=Lax`, isolate theo hostname (architecture §6).
- BFF giữ token server-side; browser chỉ giữ session ID. Durable session store owner = `account` (browser session thuộc `db-account`, A9); `llm-console` không sở hữu session state và không dùng Worker memory/KV. Pattern hash-only storage (`id_hash = SHA-256(id)`) như pact-broker-app/backoffice. TTL idle/absolute và pruning theo `account`; fail-closed nếu store unavailable.
- XSS ở shared origin `ecoma.io/*` ảnh hưởng app cùng origin → strict CSP + nonce, cấm inline script, sanitize server-side (architecture §6).
- Thao tác nhạy cảm (API key create/revoke, top-up initiation) cần step-up auth khi được chốt.
- Observability không log prompt/response body hoặc sensitive payload.

## 8. Error handling và application lifecycle

- Downstream unavailable → BFF trả error chuẩn, không lộ driver message; fail-closed cho route cần downstream.
- Idempotent retry ở BFF cho write có idempotency key; không retry không idempotent.
- Health: `GET /health` (liveness, không chạm downstream), `GET /ready` (config + downstream readiness) — fail-closed 503 khi thiếu config.
- Graceful degradation: UI hiển thị trạng thái unavailable; không cache stale như authority.

## 9. Invariants (deploy-unit)

1. `llm-console` không sở hữu DB và không chạm DB của context khác.
2. Mọi dữ liệu nghiệp vụ đi qua contract/API của context owning.
3. Authenticated actor (`sub`) lấy từ verified authentication context; tenant selector có thể do client cung cấp nhưng backend phải xác minh membership/permission/tenant active/resource ownership tại write boundary; fail closed nếu không xác minh được.
4. BFF không tin claim do client gửi.
5. Authorization enforce ở resource-owning backend, không chỉ ở UI.
6. Không log prompt/response body hoặc sensitive payload.
