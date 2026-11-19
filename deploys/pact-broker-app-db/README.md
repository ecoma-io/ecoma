# pact-broker-app-db

## Purpose

Migration authority của database `db-pact-broker-app` — project đầu tiên áp
dụng hợp đồng migration `docs/architecture/02-delivery.md` §3a (Modelling
#373, delivery #374). Đây là **exemplar** của convention `deploys/<name>-db`:
pattern tái dụng được cho 11 database PostgreSQL còn lại qua các cutover issue
(#375–#378).

## Responsibilities

- Sở hữu migration SQL + journal (`migrations/`) và history entry cho
  `db-pact-broker-app` — một database một authority (§3a.1).
- `runner.mts`: wrapper giữ advisory lock
  `pg_advisory_lock(hashtext('db-pact-broker-app'))` trên kết nối thẳng (không
  Hyperdrive — HD6), guard `current_database()` fail closed trước khi lock, rồi
  spawn `drizzle-kit migrate` giữ connection lock sống suốt lần chạy (§3a.3).
- History table `pact_broker_app.__drizzle_migrations` thuộc Drizzle Kit —
  schema ghi tường minh trong `drizzle.config.ts` (`migrations.schema`), không
  bao giờ `public`/`drizzle` ngầm (§3a.3).
- Chế độ `stamp` cho cutover 2 bước (§3a.3 mục D): ghi history **không thực
  thi SQL**.

## Boundaries

- **SQL-first (§3a.2):** canonical schema là SQL + journal. `drizzle-orm`
  **không** thuộc schema layer — nó là runtime dependency của runner, pin ở
  root `package.json` (`drizzle-orm@0.45.4`, blocking dependency của #374 vì
  kit gọi `assertPackages("drizzle-orm")` trước khi migrate). Layout phẳng
  `migrations/<idx>_<name>.sql` — không phải thư mục con `<tag>/migration.sql`
  (văn bản §3a.2 sai chi tiết này; đã báo #373).
- **Không bao giờ `drizzle-kit push`** trong pipeline (§3a.2); application vẫn
  truy PostgreSQL qua Hyperdrive + `pg` — layer này chạy như tiến trình Node
  (`runtime:native`), không bundle vào Worker nào.
- **Không đụng lane cũ:** migration `0001_pact_broker_app_bff_sessions.sql`
  vẫn thuộc `apps/pact-broker-app/db/` (runner cũ). Move-in + baseline stamp +
  retire runner cũ là **cutover #378** — một database không bao giờ có hai
  runner sống; foundation không đụng lane cũ (local lane M1 giữ nguyên behavior).
- Semantics thật của kit migrate (divergence đã báo #373): toàn bộ pending set
  chạy trong **một transaction của lần chạy** — fail giữa chừng rollback toàn
  bộ, không per-file; retry chỉ apply phần chưa ghi history.

## Development

| Target        | Lệnh                                                     | Cache | Ghi chú                                                                            |
| ------------- | -------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------- |
| `db-generate` | `drizzle-kit generate --custom`                          | ✓     | dev-time; truyền tên: `pnpm nx run pact-broker-app-db:db-generate -- --name=<tên>` |
| `db-check`    | `drizzle-kit check`                                      | ✓     | journal hợp lệ, không stale; không chạm database                                   |
| `db-migrate`  | `npx tsx --tsconfig tsconfig.db.json runner.mts migrate` | ✗     | cần `DATABASE_URL` role `_migrator`; mutate state thật                             |

Chế độ **stamp** (chỉ chạy khi cutover #378, không phải target riêng):

```
npx tsx --tsconfig tsconfig.db.json runner.mts stamp
```

statement_timeout mặc định 300s (§3a.5), inject vào cả connection lock lẫn
`DATABASE_URL` của child kit. Journal hiện **rỗng** — chưa move-in migration
nào (cutover #378 làm).

**Đăng ký arch-check:** `deployment-map-check` đòi mọi `type:deployment`
project sở hữu một app entry trong `DEPLOYMENT_MAP`, nhưng lifecycle project
database không sở hữu app nào. Quyết định #373/#374: `deploys/*-db` là
lifecycle project (coordinator invoke qua nx target), được miễn qua marker
`scaffold` trên đĩa — gap hợp đồng đã đóng, `pnpm dx arch-check` xanh trên
HEAD này.

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
- Issue #374 (delivery foundation), #373 (Modelling — nguồn hợp đồng),
  #378 (cutover `db-pact-broker-app`).
