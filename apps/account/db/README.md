# `db-account` — schema, migration và test integration

Thư mục này là **nguồn sự thật duy nhất** cho schema của `db-account`. Không có ORM,
không có `drizzle-kit`, không có generate step: `db-account` là PostgreSQL thuần và
migration là file SQL thuần.

| Đường dẫn                | Vai trò                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| `migrations/*.sql`       | Migration, áp dụng **theo thứ tự tên file** (tên file có tiền tố số) |
| `migrate.ts`             | Hằng số và helper dùng chung cho runner và test harness              |
| `apply.ts`               | CLI runner, chạy trong CI                                            |
| `bootstrap.mts`          | CLI bootstrap first-administrator: A1 `provision` và A2 `verify`     |
| `../tests/integrations/` | Test integration trên PostgreSQL thật (testcontainers)               |

## Vì sao đây là greenfield provisioning

`db-account` là **greenfield provisioning**, không phải data migration. Trên `main`
không có schema, không có migration history, không có Hyperdrive binding. Không có
gì để chuyển từ đâu cả — thứ tự provisioning ở
[`03-operations.md` §3.2](../../../docs/applications/account/03-operations.md) bắt đầu từ
database rỗng.

Migration history **độc lập với `db-auth`**: hai deploy unit rollout độc lập, dùng
chung bảng migration là cách buộc hai service vào một release, đúng thứ tách deploy
unit sinh ra để tránh.

## Ba tầng role

| Tầng        | Role                     | Quyền                                                         |
| ----------- | ------------------------ | ------------------------------------------------------------- |
| Owner/admin | `ecoma_owner`            | Sở hữu database và object, **không** chạy trong Worker        |
| Migrator    | `ecoma_account_migrator` | DDL trên schema `account`; **chỉ** chạy ở CI runner           |
| Runtime     | `ecoma_account_runtime`  | Chỉ DML, **không** DDL; `users` không có `DELETE` (tombstone) |

`db-auth` có bộ ba role riêng theo cùng hình hình. `ecoma_account_runtime` **không**
được `CONNECT` tới `db-auth` — xem "Chặn chéo" bên dưới.

## Chạy migration

⚠️ **Chạy từ CI runner, không chạy từ trong Worker.** Hyperdrive không hỗ trợ advisory
lock ([`04-platform-facts.md`](../../../docs/architecture/04-platform-facts.md) HD6), nên
không thể giữ `pg_advisory_lock` qua đường đi của Worker. Worker chỉ dùng
`_runtime_` role, và `_runtime_` role không có quyền DDL.

```sh
DATABASE_URL='postgresql://…:…@host:5432/db-account' pnpm nx run @ecoma-io/account:db:migrate
```

| Biến                  | Bắt buộc | Mặc định  | Ý nghĩa                                                |
| --------------------- | -------- | --------- | ------------------------------------------------------ |
| `DATABASE_URL`        | Có       | —         | Kết nối tới `db-account`, bằng credential `_migrator_` |
| `ECOMA_AUTH_DATABASE` | Không    | `db-auth` | Tên database kia, truyền vào SQL qua GUC               |

`DATABASE_URL` không có thì exit code khác 0 và in hướng dẫn; coi im lặng là đã apply
là cách làm một lần migration biến mất.

⚠️ **Credential phải là `_migrator_` thật**, không phải owner hay superuser. Runner
cố ý **không** dùng `SET ROLE`, nên nó kiểm chứng được cả quyền **kết nối thật** lẫn
attribute của role. Chạy bằng superuser sẽ cho một kết quả xanh che mất đúng những lỗi
provisioning mà `0001`/`0002` **không** thể tự sửa.

Tên database không hardcode trong SQL: file migration dùng placeholder
`:"db_account_database"`, runner thay bằng tên database thật trước khi gửi. Nhờ vậy
staging và production chạy **cùng một file SQL**.

### Advisory lock và idempotent

Runner lấy `pg_advisory_lock(hashtext('db-account'))` rồi áp dụng lần lượt từng file
(mỗi file tự bọc `BEGIN`/`COMMIT`).

⚠️ **Không có bảng ledger riêng.** Runner **không** ghi tên file đã apply; nó chạy lại
mọi file mỗi lần chạy, và tính idempotent của DDL là thứ khiến lần chạy thứ hai là
no-op. Sau khi apply, catalog `pg_class` là nguồn sự thật — không có lịch sử apply để
lệch với schema thật.

Đổi lại, **mọi câu DDL phải idempotent**, và điều đó không tự động xảy ra:
`CREATE ROLE` không có dạng `IF NOT EXISTS`, nên `0002` phải guard bằng `pg_roles` trong
`DO $$ $$`. Thêm câu DDL mới thì bắt buộc nghĩ tới chạy lần hai — test
`../tests/integrations/migrations.spec.ts` chạy apply hai lần để giữ điều đó thật.

Lock là session-scoped nên tự nhả khi kết nối đóng, không để lại lock trôi nếu runner bị
kill giữa chừng.

Không có down-migration. Sai thì **forward-fix**
([`01-architecture.md`](../../../docs/applications/account/01-architecture.md) invariant 10).

## Provisioning step 1 — những gì migration **không** làm được

⚠️ **Bốn việc dưới đây phải do admin/owner chạy, không nằm trong `db/migrations/`.**
Cả bốn đều bị chặn bởi đúng một nguyên nhân: `ecoma_account_migrator` chỉ sở hữu
`db-account`, không sở hữu cluster, không có `CREATEROLE`, và không được có
(`NOCREATEROLE` là điều kiện để nó không leo thang). Đây là những giới hạn thật của
PostgreSQL, phát hiện bằng cách chạy bằng **credential migrator thật** — `SET ROLE`
từ superuser sẽ giấu hết chúng.

| Việc                                                              | Vì sao migration không tự làm                                   |
| ----------------------------------------------------------------- | --------------------------------------------------------------- |
| `CREATE ROLE … LOGIN` (cả hai role)                               | Cần `CREATEROLE`                                                |
| `GRANT CONNECT, CREATE, TEMPORARY` trên `db-account` cho migrator | `CREATE SCHEMA` cần `CREATE` ở tầng database, `PUBLIC` không có |
| `REVOKE CONNECT` trên `db-auth`                                   | Cần quyền sở hữu `db-auth`                                      |
| `COMMENT ON ROLE` / `COMMENT ON DATABASE`                         | Cần `CREATEROLE` / database owner                               |

```sql
-- Chạy bằng owner/admin, một lần, theo `03-operations.md` §3.2 bước 1
CREATE ROLE ecoma_account_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE ecoma_account_runtime  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE ecoma_account_nonce_pruner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE db-account TO ecoma_account_migrator;
REVOKE CONNECT ON DATABASE db-auth FROM PUBLIC;
REVOKE CONNECT ON DATABASE db-auth FROM ecoma_account_runtime;
```

⚠️ Dòng `REVOKE CONNECT` **báo thành công nhưng không làm gì cả** nếu chạy bằng
migrator: PostgreSQL in `WARNING: no privileges could be revoked for "db-auth"` và để
nguyên ACL. Đó chính là lý do nó nằm ở provisioning chứ không nằm trong `0002` — và
`AC-012` kiểm chứng **kết quả** của provisioning, không kiểm chứng file migration.

## Chặn chéo — lớp enforce thật của ranh giới database

⚠️ **Tag Nx không chặn được ranh giới database.** `apps/account` và `apps/auth` là hai
scope Nx riêng (`scope:account` và `scope:auth` từ khi tách bounded context) — nhưng dù
một scope chung hay hai scope riêng, tag chỉ mã hoá graph và **không** chặn được
`apps/account` khai báo binding trỏ `db-auth`. Ranh giới đó là **credential**, không phải tag.

**Phải REVOKE cả `PUBLIC`, không chỉ role.** PostgreSQL cấp `CONNECT` cho `PUBLIC`
theo mặc định, và quyền của `PUBLIC` là _quyền mặc định_. `REVOKE CONNECT …
FROM ecoma_account_runtime` một mình là **no-op**: `has_database_privilege` vẫn trả
`true` và connection thật vẫn thành công (đo trên PostgreSQL 17: ACL sau khi REVOKE
vẫn là `{=Tc/postgres,postgres=CTc/postgres}` — không có entry của
`ecoma_account_runtime`). Chỉ khi `PUBLIC` cũng bị rút mới còn `false`, và một
kết nối thật mới bị từ chối: `FATAL: permission denied for database "db-auth"`.

`tests/integrations/roles.spec.ts` có **ba** test riêng cho chỗ này: `has_database_privilege`
trả `false`, một kết nối thật bị từ chối, và item `PUBLIC` trong `datacl` không chứa `C`.

⚠️ **Hệ quả phối hợp:** rút `CONNECT` khỏi `PUBLIC` trên `db-auth` cũng chặn
`ecoma_auth_runtime`. Migration của chính `db-auth` **phải** `GRANT CONNECT` lại cho
nó. Nếu quên, `auth` hỏng chứ không phải `account` — grep `GRANT CONNECT` khi deploy
`db-auth`.

Nếu `db-auth` chưa tồn tại lúc apply `0002`, khối `DO $$ $$` bỏ qua; chạy lại migration
sau khi database có là sẵn sàng. `REVOKE CONNECT` không phụ thuộc bảng nào tồn tại.

## Ranh giới: không có truy vấn chéo database

⚠️ **Không foreign key, không `postgres_fdw`, không `dblink`, không
`FOREIGN DATA WRAPPER`** ở bất kỳ đâu trong schema này. `db-account` không đọc
`db-auth`; nó gọi HTTP contract. `AC-013`/`NFR-002b` quét `pg_constraint` và
`pg_extension` để giữ điều đó thật.

## Index

**Không có index "cho chắc".** Mỗi index trả lời cho một truy vấn hoặc một ràng buộc cụ
thể:

| Index                                                       | Trả lời cho                                                    |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| `users_pkey (sub)`                                          | Tra cứu theo `sub`; ràng buộc tombstone (AC-005)               |
| `account_sessions_pkey (id_hash)`                           | Tra cứu session theo hash; FR-004                              |
| `account_sessions_session_ref_key (session_ref)`            | UNIQUE — FR-004a, session_ref không tái sử dụng                |
| `account_sessions_user_sub_idx (user_sub, created_at DESC)` | Liệt kê session của một `sub`, mới nhất trước                  |
| `login_handoffs_pkey (handle_hash)`                         | **Chính là** cơ chế first-binding-wins (FR-006c2)              |
| `login_handoffs_expires_at_idx (expires_at)`                | `DELETE FROM account.login_handoffs WHERE expires_at < now()`  |
| `security_events_pkey (event_id)`                           | Idempotency của audit append-only                              |
| `security_events_subject_sub_idx` (partial)                 | Truy vấn audit theo `subject_sub`, bỏ qua dòng NULL            |
| `account_outbox_events_pkey (event_id)`                     | Idempotency key của outbox (FR-006n)                           |
| `account_outbox_events_unpublished_idx` (partial)           | Relay chỉ quét hàng chưa publish                               |
| `internal_nonces_pkey (nonce)`                              | Trọng tài của phep "kiểm tra **và** ghi" của `claimNonce`      |
| `internal_nonces_expires_at_idx`                            | `DELETE FROM account.internal_nonces WHERE expires_at < now()` |

`login_handoffs.handle_hash` là **PRIMARY KEY**, không phải UNIQUE tách riêng — một
UNIQUE trùng lặp sẽ là index thừa không trả lời cho gì. Test `every table in the schema
has exactly the indexes its constraints justify` liệt kê đúng danh sách này; thêm index
phải sửa cả danh sách trong test.

## Bootstrap first-administrator — A1 và A2

`bootstrap.mts` là bề mặt **offline** tạo-or-đọc-lại Account đầu tiên
([`03-operations.md` §3.4](../../../docs/applications/account/03-operations.md),
[ADR-0024](../../../docs/domains/staff-access/adr/0024-trusted-bootstrap-verified-address.md)).
Không route, không cron, không code path nào trong Worker — bước tuần tự hoá của nó là
`pg_advisory_xact_lock`, mà Hyperdrive không hỗ trợ (HD6).

```sh
echo '{"correlation_id":"…","operator_ref":"…"}' \
  | DATABASE_URL='postgresql://…/db-account' \
    npx tsx --tsconfig tsconfig.db.json db/bootstrap.mts provision
DATABASE_URL='postgresql://…/db-account' \
  npx tsx --tsconfig tsconfig.db.json db/bootstrap.mts verify
```

| Bước           | Hành vi                                                                                                                                                                                                                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 `provision` | Một transaction dưới advisory xact lock toàn cục. Không có hàng canonical + `users` rỗng → tạo `users` (`active`), `email_addresses` (`verified`, `is_sign_in`, `verified_at`), audit. Có hàng `verified` chứng minh được nguồn gốc bootstrap → hội tụ, chỉ ghi audit `converged`. Mọi trạng thái khác → từ chối. |
| A2 `verify`    | Chỉ đọc. Trả `sub` khi state đúng là trạng thái hội tụ; database trống → `no_bootstrap_account`; mọi trạng thái khác → từ chối.                                                                                                                                                                                   |

Địa chỉ canonical (`superadmin@ecoma.io`) là **hằng trong code**; `ECOMA_BOOTSTRAP_EMAIL`
chỉ được assert lại giá trị đó và procedure từ chối khi lệch. `DATABASE_URL` và input
A1 đi qua env/stdin, không bao giờ qua argv. Output là **một** dòng JSON trên stdout khi
thành công; khi từ chối là một object `{"stage":…,"status":"denied","reason":"<code>"}`
trên stderr với exit 1. Bootstrap **không** phát session — Superadmin vẫn đăng nhập bằng
luồng email-OTP hiện có.

## Test integration

Chạy trên **PostgreSQL thật** qua testcontainers (`postgres:17-alpine`), không mock:

```sh
pnpm nx run @ecoma-io/account:test-integration
```

| File (trong `../tests/integrations/`) | Phủ cách                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `migrations.spec.ts`                  | AC-001: áp từ rỗng, chạy lại là no-op, runtime không DDL                 |
| `roles.spec.ts`                       | AC-012, AC-013, AC-014, NFR-002a, NFR-002b, SR-008                       |
| `session.spec.ts`                     | FR-004, FR-004a, FR-004b, SR-002, AC-001, AC-002                         |
| `handoff.spec.ts`                     | AC-008b2 (concurrency), AC-008b3, AC-008b4, AC-008b5, FR-006c3, FR-006c4 |
| `tombstone.spec.ts`                   | AC-005, FR-012, FR-012e, NFR-001, invariant 6                            |
| `internal-nonces.spec.ts`             | Replay guard: nonce một lần, TTL lớn hơn skew, không `UPDATE`            |

Nếu **không có Docker**, toàn bộ suite **skip** chứ không fail — `probeDocker()` thử
khởi động một container thật trước, thất bại thì `describe.skipIf`. CI nào bắt buộc
kiểm chứng thì đừng để runner thiếu Docker.

⚠️ **Đây là fail-open có chủ đích, nên đừng đọc "xanh" là "đã kiểm chứng".** Một
runner **có** Docker nhưng không đủ tài nguyên cũng rơi vào cùng nhánh skip: sáu file
spec chạy song song, mỗi file tự `probeDocker()` **và** `startAccountDatabase()` nên
tạo tới **mười hai** container. Khi `beforeAll` chạm timeout `180_000`, Vitest bỏ
suite và lệnh vẫn exit 0.

Đo được trên máy dev: một lần chạy cho 31/53 test skip trong khi lần liền trước và
sau đều 53/53. Tái hiện lại 2026-10-14 ở kênh `test` (spec chạy song song với unit
test): `86 passed | 9 skipped`, rồi hai lần chạy liền kế `86 passed`. Nên **luôn đọc
dòng `Tests`** của Vitest, không chỉ exit code — `pnpm nx run
@ecoma-io/account:test-integration` phải báo `53 passed` chứ không phải `44 passed |
9 skipped`. Nếu thấy skip mà Docker có mặt, chạy lại sau khi `docker rm -f $(docker
ps -aq --filter ancestor=postgres:17-alpine)`; container tồn đọng từ lần chạy bị bỏ dở
chính là nguyên nhân.

Test `../tests/integrations/handoff.spec.ts` dùng **hai connection thật** với `pg_sleep` làm barrier cho case
first-binding-wins dưới tải đồng thời (AC-008b2): nếu chỉ chạy tuần tự thì race
condition của read-then-write sẽ không bao giờ lộ. `../tests/integrations/internal-nonces.spec.ts` dùng
đúng kỹ thuật đó cho `claimNonce`, vì nó cùng loại: đọc-rồi-ghi sẽ xanh mọi test tuần tự
rồi hỏng dưới tải đồng thời.

## Cấu trúc thư mục

```
apps/account/db/
├── README.md
├── migrate.mts           # hằng số + helper dùng chung
├── apply.mts             # CLI runner cho CI
├── bootstrap.mts         # CLI bootstrap first-administrator (A1 provision / A2 verify)
└── migrations/
    ├── 0001_identity_core.sql      # users, sessions, handoffs, audit, outbox
    ├── 0002_roles_and_grants.sql   # hai role + grant + chặn chéo
    ├── 0003_internal_nonces.sql    # kho nonce cho replay guard
    ├── 0004_rename_authn_level_to_acr.sql
    ├── 0005_email_addresses.sql
    ├── 0006_otp_challenges.sql
    └── 0007_nonce_pruner_role.sql  # role pruner của cron Worker auth-nonce-prune-job
```
