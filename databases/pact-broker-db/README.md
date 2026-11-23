# pact-broker-db

## Purpose

Migration authority của database `db-pact-broker` — cutover thứ hai theo hợp
đồng migration `docs/architecture/02-delivery.md` §3a (Modelling #373;
foundation #374, cutover #378). Project nhân pattern exemplar
`databases/pact-broker-app-db`; 6 file migration của `pact-broker-api` đã move-in
vào journal trong PR cutover này.

## Responsibilities

- Sở hữu migration SQL + journal (`migrations/`) và history entry cho
  `db-pact-broker` — một database một authority (§3a.1).
- `runner.mts`: wrapper giữ advisory lock
  `pg_advisory_lock(hashtext('db-pact-broker'))` trên kết nối thẳng (không
  Hyperdrive — HD6), guard `current_database()` fail closed trước khi lock, rồi
  spawn `drizzle-kit migrate` giữ connection lock sống suốt lần chạy (§3a.3).
  Khóa pin `244941704` = `hashtext('db-pact-broker')` đo thật trên PostgreSQL
  17 — cùng giá trị runner cũ tính lúc chạy, lock identity không đổi qua
  cutover.
- History table `pact_broker.__drizzle_migrations` thuộc Drizzle Kit — schema
  ghi tường minh trong `drizzle.config.ts` (`migrations.schema`), không bao giờ
  `public`/`drizzle` ngầm (§3a.3).
- Chế độ `stamp` cho cutover 2 bước (§3a.3 mục D): ghi history **không thực
  thi SQL** — dùng khi một environment đã có schema từ runner cũ nhưng chưa có
  ledger.

## Boundaries

- **SQL-first (§3a.2):** canonical schema là SQL + journal. `drizzle-orm`
  **không** thuộc schema layer — nó là runtime dependency của runner, pin ở
  root `package.json`. Layout phẳng `migrations/<idx>_<name>.sql` (đúng layout
  kit 0.31.11).
- **Move-in #378:** 6 file `apps/pact-broker-api/db/migrations/*.sql` vào
  journal **giữ nguyên nội dung từng byte** (tag đổi theo idx journal, nội dung
  không); runner cũ `apply.mts` + `migrate.mts` retired trong cùng PR — một
  database không bao giờ có hai runner sống.
- **Không bao giờ `drizzle-kit push`** trong pipeline (§3a.2); application vẫn
  truy PostgreSQL qua Hyperdrive + `pg` — layer này chạy như tiến trình Node
  (`runtime:native`), không bundle vào Worker nào.
- Semantics thật của kit migrate (verified thực nghiệm #374): toàn bộ pending
  set chạy trong **một transaction của lần chạy** — fail giữa chừng rollback
  toàn bộ, không per-file; retry chỉ apply phần chưa ghi history.
- Bootstrap tenant + provision machine token **không** thuộc project này —
  ranh giới §3.2/#352 (`apps/pact-broker-api/db/bootstrap-tenant.mts` giữ
  nguyên).

## Development

| Target        | Lệnh                                                     | Cache | Ghi chú                                                                        |
| ------------- | -------------------------------------------------------- | ----- | ------------------------------------------------------------------------------ |
| `db-generate` | `drizzle-kit generate --custom`                          | ✓     | dev-time; truyền tên: `pnpm nx run pact-broker-db:db-generate -- --name=<tên>` |
| `db-check`    | `drizzle-kit check`                                      | ✓     | journal hợp lệ, không stale; không chạm database                               |
| `db-migrate`  | `npx tsx --tsconfig tsconfig.db.json runner.mts migrate` | ✗     | cần `DATABASE_URL` role `_migrator`; mutate state thật                         |

Chế độ **stamp** (cutover 2 bước §3a.3 mục D, không phải target riêng):

```
npx tsx --tsconfig tsconfig.db.json runner.mts stamp
```

statement_timeout mặc định 300s (§3a.5), inject vào cả connection lock lẫn
`DATABASE_URL` của child kit.

**Đăng ký arch-check:** cùng exemption với exemplar — `databases/*-db` là
lifecycle project (coordinator invoke qua nx target), miễn qua marker
`scaffold` trên đĩa; `pnpm dx arch-check` xanh.

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
- Issue #378 (cutover `db-pact-broker` + `db-pact-broker-app`), #374
  (foundation exemplar), #373 (Modelling — nguồn hợp đồng).
