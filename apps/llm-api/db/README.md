# Migration `db-llm-gateway`, `db-llm-tenant`, `db-llm-marketplace` — `llm-api`

Thư mục này là **nguồn sự thật duy nhất** cho migration của ba database LLM mà deploy unit
`llm-api` sở hữu (A2). Không có ORM, không có `drizzle-kit`, không có generate step:
migration là file SQL thuần, áp dụng bằng runner tự sở hữu của unit.

| Đường dẫn                      | Vai trò                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `apply.mts`                    | CLI runner — chọn target `gateway` \| `tenant` \| `marketplace`, chạy trong CI         |
| `migrate.mts`                  | Hằng số target → database + thư mục migration, helper dùng chung                       |
| `migrations/gateway/*.sql`     | Migration của `db-llm-gateway` (schema `llm_financial`, `llm_seller`)                  |
| `migrations/tenant/*.sql`      | Migration của `db-llm-tenant` (schema `llm_tenant`)                                    |
| `migrations/marketplace/*.sql` | Migration của `db-llm-marketplace` (schema `llm_marketplace` + quyền — bảng thuộc #24) |

## Hợp đồng runner (`02-delivery.md` §3)

- **Mỗi database một lần gọi riêng** — target chọn DB đích và thư mục migration tương ứng;
  `DATABASE_URL` là credential **migrator** của đúng DB đó. Không có đường chạy "cả ba DB
  một lượt": rollout độc lập từng database.
- **Verify `current_database()` trước khi DDL** — URL trỏ nhầm database là fail-loud, không
  chạy nửa chừng trên nhầm đích.
- **Advisory lock per-DB**: `pg_advisory_lock(hashtext('<db-name>'))` — hash tính phía server
  theo tên database, serialize nhiều runner trên cùng DB; hai DB khác nhau không tranh khóa.
- **Idempotent, không ledger, không down-migration** — DDL `IF NOT EXISTS`; apply lại thành
  công mà không đổi gì; catalog PostgreSQL sau apply là nguồn sự thật (ADR-0025 §6:
  môi trường chưa phát hành, forward-fix).
- **Chỉ credential migrator** — role runtime chỉ có DML; migration **không bao giờ** qua
  Hyperdrive (HD6: Hyperdrive không hỗ trợ advisory lock — runner chạy ở CI runner, không
  thuộc bundle Worker; `docs/applications/llm-api/README.md` §Persistence implementation).

## Gọi từng database

Từ thư mục `apps/llm-api` (hoặc qua Nx, đối số đi qua sau `--`):

```sh
# db-llm-gateway (schema llm_financial + llm_seller)
DATABASE_URL=<gateway-migrator-url> pnpm nx run @ecoma-io/llm-api:db:migrate -- gateway

# db-llm-tenant (schema llm_tenant)
DATABASE_URL=<tenant-migrator-url> pnpm nx run @ecoma-io/llm-api:db:migrate -- tenant

# db-llm-marketplace (schema llm_marketplace; bảng nghiệp vụ thuộc #24)
DATABASE_URL=<marketplace-migrator-url> pnpm nx run @ecoma-io/llm-api:db:migrate -- marketplace
```

Thiếu target, target lạ hoặc thiếu `DATABASE_URL` là exit khác 0 kèm hướng dẫn — coi im
lặng là đã apply là cách làm một lần migration biến mất.

## Slice này không có bảng nghiệp vụ

`0001` của cả ba DB chỉ tạo **schema namespace đã đặt tên** trong
[`docs/applications/llm-api/README.md`](../../../docs/applications/llm-api/README.md)
§Persistence implementation + default privileges `migrator → runtime`
(`ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES`).
Riêng `db-llm-marketplace`: schema `llm_marketplace` được tạo ở `0002` (forward-fix
sau `0001_privileges`), và `0003` thu hồi default privilege db-wide của `0001` —
quyền DML `migrator → runtime` chỉ còn theo schema `llm_marketplace` (scope chặt
đúng schema sở hữu). Các DB này chưa có bảng nghiệp vụ nào — bảng marketplace
thuộc Issue #24; bảng nghiệp vụ của gateway/tenant thuộc slice sau của #22 (#23/#24).
