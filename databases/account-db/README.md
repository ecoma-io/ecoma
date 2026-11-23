# account-db

## Purpose

Migration authority của database `db-account` — cutover #375 từ runner cũ
`apps/account/db/apply.mts` sang hợp đồng migration
`docs/architecture/02-delivery.md` §3a (Modelling #373, delivery #374). Một
database một authority: sau cutover này, đường migrate duy nhất của
`db-account` là runner của project này.

## Responsibilities

- Sở hữu migration SQL + journal (`migrations/`) và history entry cho
  `db-account` — adopt toàn bộ history hiện có (6 file), không replay.
- `runner.mts`: wrapper giữ advisory lock
  `pg_advisory_lock(hashtext('db-account'))` trên kết nối thẳng (không
  Hyperdrive — HD6), guard `current_database()` fail closed trước khi lock, rồi
  spawn `drizzle-kit migrate` giữ connection lock sống suốt lần chạy (§3a.3).
- History table `account.__drizzle_migrations` thuộc Drizzle Kit — schema
  ghi tường minh trong `drizzle.config.ts` (`migrations.schema`), không bao giờ
  `public`/`drizzle` ngầm (§3a.3).
- Chế độ `stamp` (§3a.3 mục D): ghi history không thực thi SQL.
- Chế độ `adopt` (cutover #375): stack đã-migrate-cũ bởi runner cũ (runner cũ
  KHÔNG có bảng ledger — catalog `information_schema` là ledger, mọi DDL của
  13 file này idempotent) được nhận diện bằng "schema có bảng mà chưa có
  history Drizzle" và được stamp toàn bộ journal; stack trắng và stack đã
  cutover là no-op. Lane local chạy `adopt` rồi `migrate` trong cùng container.

## Boundaries

- **SQL-first (§3a.2):** canonical schema là SQL + journal. `drizzle-orm`
  **không** thuộc schema layer — runtime dependency của runner, pin ở root.
  Layout phẳng `migrations/<tag>.sql`; tag giữ nguyên tên file cũ.
- **Không bao giờ `drizzle-kit push`** trong pipeline (§3a.2); application
  truy PostgreSQL qua Hyperdrive + `pg` — layer này là tiến trình Node
  (`runtime:native`), không bundle vào Worker nào.
- Lock key GHIM giá trị `hashtext('db-account')` mà runner cũ tính
  server-side — không đổi khóa khi cutover.
- Bảng ledger cũ không tồn tại với runner này (runner cũ dùng catalog) — sau
  cutover không còn gì phải dọn.

## Development

| Target        | Lệnh                                                     | Cache | Ghi chú                                                        |
| ------------- | -------------------------------------------------------- | ----- | -------------------------------------------------------------- |
| `db-generate` | `drizzle-kit generate --custom`                          | ✓     | dev-time; `pnpm nx run account-db:db-generate -- --name=<tên>` |
| `db-check`    | `drizzle-kit check`                                      | ✓     | journal hợp lệ, không stale; không chạm database               |
| `db-migrate`  | `npx tsx --tsconfig tsconfig.db.json runner.mts migrate` | ✗     | cần `DATABASE_URL` role `_migrator`; mutate state thật         |

statement_timeout mặc định 300s (§3a.5), inject vào cả connection lock lẫn
`DATABASE_URL` của child kit.

## Testing

- `test` — spec colocated `runner.spec.ts` (hàm thuần + quyết định adopt,
  không Docker).
- `test-integration` — runner thật + `drizzle-kit migrate` thật trên
  PostgreSQL thật (testcontainers, `postgres:17-alpine`): apply/no-replay,
  rollback-when-failed + retry, advisory-lock mutual exclusion, stamp,
  adopt legacy/fresh/cutover, guard wrong-database. Docker bắt buộc — vắng
  Docker là suite ĐỎ (fail-loud, 06-testing.md §6).

## Related Documentation

- `docs/architecture/02-delivery.md` §3a — hợp đồng migration đầy đủ.
- `docs/architecture/06-testing.md` — tầng test và policy fail-loud.
- Issue #375 (cutover nhóm platform DBs), #374 (foundation), #373 (Modelling).
