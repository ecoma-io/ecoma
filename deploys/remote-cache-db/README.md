# remote-cache-db

## Purpose

Migration authority của database `db-remote-cache` — database control plane
của bounded context `remote-cache`, do cạnh API sở hữu (ADR-0035: BFF sở hữu
database `db-remote-cache-app` riêng, authority của nó là
`deploys/remote-cache-app-db`). Cutover theo hợp đồng
`docs/architecture/02-delivery.md` §3a (Modelling #373, foundation #374,
delivery #377), mirror exemplar `deploys/pact-broker-app-db`.

## Responsibilities

- Sở hữu migration SQL + journal (`migrations/`) và history entry cho
  `db-remote-cache` — một database một authority (§3a.1).
- `runner.mts`: wrapper giữ advisory lock
  `pg_advisory_lock(hashtext('db-remote-cache'))` trên kết nối thẳng (không
  Hyperdrive — HD6), guard `current_database()` fail closed trước khi lock, rồi
  spawn `drizzle-kit migrate` giữ connection lock sống suốt lần chạy (§3a.3).
- History table `remote_cache.__drizzle_migrations` thuộc Drizzle Kit — schema
  ghi tường minh trong `drizzle.config.ts` (`migrations.schema`), không bao giờ
  `public`/`drizzle` ngầm (§3a.3).
- Chế độ `stamp` cho cutover 2 bước (§3a.3 mục D): ghi history **không thực
  thi SQL**.

## Adoption (cutover #377)

- 8 file SQL của `db-remote-cache` (`0001_control_plane` …
  `0008_portal_authorization`) được move-in từ
  `apps/remote-cache-api/db/migrations/` **giữ nguyên nội dung**, mỗi file một
  entry journal. `when` là giá trị cố định tăng đơn điệu
  (1700000000xxx) — thấp hơn mọi timestamp mà `generate --custom` tương lai
  sinh, nên kit không bao giờ xếp một migration mới về trước adopted set.
- Runner cũ tính khóa advisory server-side bằng `hashtext('db-remote-cache')`;
  wrapper hard-code cùng giá trị (đo thật trên PostgreSQL 17:
  `-2037959451`) — lock identity không đổi qua cutover.
- Trên environment có schema sẵn (local stack cũ): runner migrate đầu tiên sẽ
  apply lại toàn bộ adopted set — DDL idempotent nên catalog không đổi (đúng
  behavior runner cũ, vốn re-apply mọi lần chạy), và history được ghi đầy đủ
  từ lần chạy đó. Trên environment đã có schema và KHÔNG muốn chạm DDL: chạy
  `stamp` trước (mục D). Trên environment trắng: apply toàn bộ từ đầu.

## Boundaries

- **SQL-first (§3a.2):** canonical schema là SQL + journal. `drizzle-orm`
  **không** thuộc schema layer — nó là runtime dependency của runner, pin ở
  root `package.json` (`drizzle-orm@0.45.4`). Layout phẳng
  `migrations/<idx>_<name>.sql` (văn bản §3a.2 mô tả layout thư mục con là
  sai chi tiết — đã báo #373; exemplar #374 dùng layout phẳng).
- **Không bao giờ `drizzle-kit push`** trong pipeline (§3a.2); application vẫn
  truy PostgreSQL qua Hyperdrive + `pg` — layer này chạy như tiến trình Node
  (`runtime:native`), không bundle vào Worker nào.
- **Bootstrap/seed KHÔNG thuộc project này** (ranh giới §3.2): bootstrap CLI
  vận hành vẫn ở `apps/remote-cache-api/db/bootstrap-tenant.mts`; catalog
  sealed trong migration của adopted set giữ nguyên theo §3a.5.
- Semantics thật của kit migrate: toàn bộ pending set chạy trong **một
  transaction của lần chạy** — fail giữa chừng rollback toàn bộ, không
  per-file; retry chỉ apply phần chưa ghi history.

## Development

| Target        | Lệnh                                                     | Cache | Ghi chú                                                                         |
| ------------- | -------------------------------------------------------- | ----- | ------------------------------------------------------------------------------- |
| `db-generate` | `drizzle-kit generate --custom`                          | ✓     | dev-time; truyền tên: `pnpm nx run remote-cache-db:db-generate -- --name=<tên>` |
| `db-check`    | `drizzle-kit check`                                      | ✓     | journal hợp lệ, không stale; không chạm database                                |
| `db-migrate`  | `npx tsx --tsconfig tsconfig.db.json runner.mts migrate` | ✗     | cần `DATABASE_URL` role `ecoma_remote_cache_migrator`; mutate state thật        |

Chế độ **stamp** (chỉ chạy khi cần adopt một environment đã có schema):

```
npx tsx --tsconfig tsconfig.db.json runner.mts stamp
```

statement_timeout mặc định 300s (§3a.5), inject vào cả connection lock lẫn
`DATABASE_URL` của child kit.

**Đăng ký arch-check:** cùng marker `scaffold` với exemplar — lifecycle
project database không sở hữu app entry trong `DEPLOYMENT_MAP` (gap hợp đồng
đã đóng tại #374).

## Testing

- `test` — spec colocated `runner.spec.ts` (hàm thuần, không Docker).
- `test-integration` — runner thật + `drizzle-kit migrate` thật trên
  PostgreSQL thật (testcontainers, `postgres:17-alpine`): apply/no-replay,
  rollback-when-failed + retry, advisory-lock mutual exclusion, stamp
  semantics, guard wrong-database. Docker bắt buộc — vắng Docker là suite ĐỎ
  (fail-loud, 06-testing.md §6).

## Related Documentation

- `docs/architecture/02-delivery.md` §3a — hợp đồng migration đầy đủ
  (§3a.1–§3a.7, decisions A–H).
- `docs/architecture/06-testing.md` — tầng test và policy fail-loud.
- Issue #377 (delivery cutover), #374 (foundation exemplar), #373 (Modelling
  — nguồn hợp đồng).
