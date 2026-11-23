# release-validation

Cơ chế baseline Release Validation cho PostgreSQL — thực thi Issue #379 theo
hợp đồng `docs/architecture/02-delivery.md` §3a.6 (mục G của #373) và
`03-operations.md` §3.1. **Slice này là cơ chế library + CLI; wire-up vào lane
Release Validation (#389), candidate slot (#381) và D1 (mục G+) là follow-up
của #379.**

## Purpose

Từ một release candidate, cho từng logical database PostgreSQL: resolve
previous-release baseline **đã verify restorable**, restore được vào target
dùng-đi, apply candidate migrations từ baseline đó, và emit evidence gắn đúng
danh tính candidate + baseline.

- **Baseline identity versioned per database** — một baseline cho một logical
  database cho một release candidate, không baseline dùng chung.
- **Verify restorable là bắt buộc** (§3a.6): "backup job thành công" hoặc
  "dump tồn tại" KHÔNG phải bằng chứng. Bằng chứng chấp nhận được là restore
  đã chạy + integrity check pass trên môi trường validation (fingerprint
  history `__drizzle_migrations` + inventory bảng khớp từng trường).
- **Candidate migration chạy TIẾN từ baseline-verified**, không từ database
  live staging — qua migration authority thật `databases/<slug>-db/runner.mts`
  (advisory lock + guard `current_database()` + `drizzle-kit migrate`), không
  runner thứ hai.
- **First-release**: khi chưa tồn tại previous release, validation rơi về
  fresh-install path — apply toàn bộ journal lên database trống, evidence
  vẫn gắn candidate identity (`firstRelease: true`, `baseline: null`).
- **Không down-migrate, không rollback database** (invariant 10/11) — baseline
  tồn tại để DR và validation, không phải đường rollback ứng dụng.
- **D1 nằm ngoài cơ chế này** — D1 baseline là Time Travel bookmark (mục G+),
  slice D1 là follow-up riêng của #379.

## CLI

Chạy từ repo root (Node ≥ 22.6, type-stripping):

```bash
# Capture baseline per-database từ instance chứa previous release
node tools/release-validation/src/cli.ts capture \
  --database db-remote-cache \
  --source-url postgresql://admin:***@source-host:5432/postgres \
  --out <dir>

# Validate: restore + integrity check + candidate migration từ baseline
node tools/release-validation/src/cli.ts validate \
  --database db-remote-cache \
  --target-url postgresql://admin:***@disposable-host:5432/postgres \
  --migrator-url postgresql://ecoma_remote_cache_migrator:***@disposable-host:5432/db-remote-cache \
  --migrator-role ecoma_remote_cache_migrator \
  --commit-sha <sha> --candidate-version <version> \
  --baseline <dir-capture> \
  --confirm-disposable-target

# First release: bỏ --baseline (fresh-install path)
# Danh tính candidate có thể đến từ manifest thay vì flags:
#   --manifest <release-manifest.json>   (JSON: {"sha": ..., "version": ...})
```

Exit codes: `0` = passed, `1` = run chạy thật và failed (evidence vẫn in ra),
`2` = refuse trước khi chạm database (usage sai, blocker, identity thiếu/mâu
thuẫn, database ngoài inventory, authority project thiếu trên cây).

## Responsibilities

- Restore **per-database** bằng `pg_dump --format=plain --no-owner
  --no-privileges` + `psql` với `ON_ERROR_STOP` — `pg_dumpall` là
  cluster-level (`04` PG1) nên mọi database đều đi đường dump per-database
  này; đây chính là lớp dump theo database mà `03` §3.1 yêu cầu cho
  `account`/`auth`.
- Target validate là **instance dùng-đi**: cơ chế DROP + CREATE lại database
  hợp đồng trên target, vì state trắng tuyệt đối là điều kiện của integrity
  check (restore đè lên database còn dư object sẽ để lại object lạ mà
  fingerprint không kỳ vọng). `--confirm-disposable-target` là consent bắt
  buộc cho hành vi phá này; thiếu là exit 2.
- Restore chạy bằng **role migrator** (`--migrator-url` — bắt buộc trỏ đúng
  database hợp đồng): dump `--no-owner` không mang ownership nên object sau
  restore thuộc role chạy restore, và migrator là chủ đúng như trên nguồn
  (runner luôn migrate bằng role đó) — candidate migration không cần vá ACL
  schema nào.
- DROP xóa ACL cấp database — cơ chế **re-grant** `CONNECT, CREATE, TEMPORARY`
  cho `--migrator-role` sau khi recreate. Role cấp cluster là việc của slot
  provisioning (#349); cơ chế không tạo/xóa role.
- Integrity check so fingerprint **ghi lúc capture** với state sau restore:
  số entry + `max(created_at)` của history và inventory bảng BASE TABLE.
  Lệch bất kỳ trường nào là corrupted restore → fail closed, candidate
  migration không chạy.
- Fail-closed suốt dòng: dump rỗng là refuse; dump file không khớp sha256 đã
  ghi là refuse; database ngoài inventory `02` §3a.1 là refuse; evidence
  thiếu một nửa danh tính candidate (SHA hoặc version) là refuse.
- Evidence JSON per-run in ra stdout cho workflow caller lưu lại theo mẫu
  §7.4.1, append-only theo danh tính candidate (provenance store §7.2,
  #346): `candidate {commitSha, version}` + `baseline` identity (sha256,
  fingerprint, mốc thời gian/LSN) + per-stage result + `historyAfter`.
  Evidence không chứa connection string; stderr nhúng đi qua mask password.
- `--docker <container>`: chạy psql/pg_dump bên trong container qua
  `docker exec` — cùng kỹ thuật docker-CLI của suite integration; URL kết
  nối phải đúng góc nhìn nơi binary chạy.

## Boundaries

- **Không sở hữu migration** — apply luôn qua runner của `databases/<slug>-db`
  được map trong inventory `02` §3a.1; không tạo runner, không parse journal,
  không tự suy schema history từ drizzle config (đọc qua catalog, refuse khi
  > 1 schema có `__drizzle_migrations`).
- **Không wire-up lane** — trigger, GitHub Environment, candidate slot TTL,
  gate đọc evidence thuộc #389/#381/#363; project này chỉ là cơ chế CLI.
- **Không D1** — mục G+ là follow-up riêng của #379.
- **Không production backup** — chính sách backup + PITR → R2 thuộc
  `03-operations.md` §3.1; baseline dump ở đây là artifact validation của
  lane Release Validation.
- `sourceLsn` là mốc provenance ghi vào release record (`02` §12), KHÔNG
  phải điều kiện restorable — điều kiện là integrity check.

## Testing

```bash
pnpm nx run @ecoma-io/release-validation:test                # unit, không Docker
pnpm nx run @ecoma-io/release-validation:test-integration    # Docker bắt buộc, fail-loud
```

Specs unit `src/*.spec.ts` (vitest, 23 test) phủ: resolve inventory `02`
§3a.1 và refuse database ngoài danh sách, resolve danh tính candidate
(manifest/flags/mâu thuẫn/thiếu), blocker pre-flight, stage machine
fail-closed (restore lỗi → skip, integrity lệch → migration không chạy,
first-release → integrity `not-applicable`), mask secret và hình dạng
evidence, parseArgs strict (flag lạ/trùng/thiếu value).

Specs integration `tests/integrations/pg-baseline-integration.spec.ts`
(6 test) chạy CLI thật trên hai container PostgreSQL thật qua docker-CLI
harness (`docker run` + `docker exec`, không @testcontainers; Docker
thiếu là suite ĐỎ — probe fail-loud từ globalSetup, không skip): capture
fingerprint đúng state; validate restore + candidate migration tiến
(history 1 → 2, data sống qua restore); integrity fail closed khi dump
bị biến đổi; truncated dump fail closed; interrupted migration (kill -9
giữa `pg_sleep`) để lại đúng baseline đã restore và retry hoàn tất;
first-release fresh-install.

## Related Documentation

- `docs/architecture/02-delivery.md` §3a.6 — mục G: baseline restorable
  per logical database, restore-verification bắt buộc (restore +
  integrity + migration apply), không down-migrate.
- `docs/architecture/02-delivery.md` §3a.1 — inventory logical database
  → migration authority `databases/<slug>-db`.
- `docs/architecture/03-operations.md` §3.1 — lớp dump per-database
  (pg_dumpall là cluster-level) và chính sách backup/PITR production.
- `docs/architecture/06-testing.md` — placement target `test` /
  `test-integration` và quy tắc Docker fail-loud.
- Issue #379 (previous-release baseline restore + candidate migration
  validation), #346 (provenance store), #349 (slot provisioning).

## Development

```bash
pnpm nx run release-validation:lint && pnpm nx run release-validation:typecheck
```
