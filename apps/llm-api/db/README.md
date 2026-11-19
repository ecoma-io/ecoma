# `db/` của `llm-api` — bootstrap/seed runner

Sau cutover #376 (hợp đồng `02-delivery.md` §3a), thư mục này **không còn** là
nguồn sự thật migration nữa: schema migration của ba database mà deploy unit
sở hữu đã chuyển về ba migration authority riêng — một database một authority
(§3a.1):

| Database             | Migration authority          | Lệnh migrate                                |
| -------------------- | ---------------------------- | ------------------------------------------- |
| `db-llm-gateway`     | `deploys/llm-gateway-db`     | `pnpm nx run llm-gateway-db:db-migrate`     |
| `db-llm-tenant`      | `deploys/llm-tenant-db`      | `pnpm nx run llm-tenant-db:db-migrate`      |
| `db-llm-marketplace` | `deploys/llm-marketplace-db` | `pnpm nx run llm-marketplace-db:db-migrate` |

Mỗi project `deploys/llm-*-db` sở hữu SQL + journal + runner wrapper
(`runner.mts migrate`, advisory lock `hashtext('<database>')`, engine
`drizzle-kit migrate` với history `__drizzle_migrations`). Một database không
bao giờ có hai runner sống — `db/apply.mts` cũ đã retire trong PR cutover
#376.

Còn lại trong thư mục này, đúng ranh giới bootstrap/seed §3.2 (chi tiết ranh
giới: #352):

- `bootstrap-seller-governance.mts` — bước 8a (seed seller governance, Issue #23).
- `bootstrap-marketplace.mts` — bước 8b (seed marketplace offering + upstream
  credential hash, Issue #23).
- `bootstrap-consumer-tenant.mts` — bước 9 (seed tenant `ecoma` + owner
  membership + API key đầu tiên; ghi hai database trong một lần chạy, #24).
- `bootstrap-financial.mts` — bước 10 (seed sponsor funding ADR-0028 trên
  `db-llm-gateway`, #24).
- `bootstrap-shared.mts` — helper dùng chung của bốn runner.

Đây là **seed biến thiên theo environment hoặc phụ thuộc dữ liệu runtime**
(superadmin, tenant `ecoma`, upstream credential) — không bao giờ chuyển vào
migration projects; seed catalog sealed là trường hợp duy nhất được phép nằm
trong migration (§3a.5).

Lane local (`deploys/llm-api-deploy`) gọi migration qua container ephemeral
chạy `runner.mts migrate` của từng project db, và bootstrap qua container
ephemeral chạy đúng các script này — thứ tự provision → migrate → bootstrap
không đổi.
