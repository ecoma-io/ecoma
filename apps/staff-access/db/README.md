# `db-staff-access` — schema, migration và test integration

Thư mục này là **nguồn sự thật duy nhất** cho schema của `db-staff-access`. Không có ORM,
không có `drizzle-kit`, không có generate step: `db-staff-access` là PostgreSQL thuần và
migration là file SQL thuần.

| Đường dẫn          | Vai trò                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `migrations/*.sql` | Migration, áp dụng **theo thứ tự tên file** (tên file có tiền tố số) |
| `migrate.mts`      | Hằng số và helper dùng chung cho runner và test harness              |
| `apply.mts`        | CLI runner, chạy trong CI                                            |
| `bootstrap.mts`    | CLI bootstrap S1/S2/S3 (staff + assignment + verify)                 |

## `db-staff-access` là greenfield provisioning

`db-staff-access` là **greenfield provisioning**, không phải data migration. Trên `main`
không có schema, không có migration history, không có Hyperdrive binding. Không có gì
để chuyển từ đâu cả — thứ tự provisioning ở
[`03-operations.md`](../../../docs/applications/account/03-operations.md) §3 (pattern tham chiếu) bắt đầu từ
database rỗng.

Storage được quyết ở [`docs/domains/staff-access/adr/0013-staff-access-ownership-transfer.md`]
(ADR-0013, đã Accepted): database `db-staff-access`, schema `staff_access`, pattern ba role
`ecoma_owner`/`ecoma_staff_access_migrator`/`ecoma_staff_access_runtime`, chặn chéo
`REVOKE CONNECT` (kể cả rút khỏi `PUBLIC`). `account` và `auth` **không** được ghi vào dữ
liệu staff/role/permission dù chung PostgreSQL instance — chung instance ≠ chung write
authority.

Migration history **độc lập** với `db-account`, `db-auth`, `db-backoffice`: hai deploy unit
rollout độc lập, dùng chung bảng migration là cách buộc hai service vào một release, đúng
thứ tách deploy unit sinh ra để tránh.

## Ba tầng role

| Tầng        | Role                          | Quyền                                                    |
| ----------- | ----------------------------- | -------------------------------------------------------- |
| Owner/admin | `ecoma_owner`                 | Sở hữu database và object, **không** chạy trong Worker   |
| Migrator    | `ecoma_staff_access_migrator` | DDL trên schema `staff_access`; **chỉ** chạy ở CI runner |
| Runtime     | `ecoma_staff_access_runtime`  | Chỉ DML, **không** DDL; minimal theo từng bảng (0002)    |

`ecoma_owner` không xuất hiện ở đây: credential đó không thuộc vòng đời migration.
Migrator không bao giờ là Worker secret (SR-010, invariant 11).

## Chạy migration

⚠️ **Chạy từ CI runner, không chạy từ trong Worker.** Hyperdrive không hỗ trợ advisory
lock ([`04-platform-facts.md`](../../../docs/architecture/04-platform-facts.md) HD6), nên
không thể giữ `pg_advisory_lock` qua đường đi của Worker. Worker chỉ dùng
`_runtime_` role, và `_runtime_` role không có quyền DDL.

```sh
DATABASE_URL='postgresql://…:…@host:5432/db-staff-access' pnpm nx run @ecoma-io/staff-access:db:migrate
```

| Biến           | Bắt buộc | Mặc định | Ý nghĩa                                                     |
| -------------- | -------- | -------- | ----------------------------------------------------------- |
| `DATABASE_URL` | Có       | —        | Kết nối tới `db-staff-access`, bằng credential `_migrator_` |

`DATABASE_URL` không có thì exit code khác 0 và in hướng dẫn; coi im lặng là đã apply
là cách làm một lần migration biến mất.

⚠️ **Credential phải là `_migrator_` thật**, không phải owner hay superuser. Runner
cố ý **không** dùng `SET ROLE`, nên nó kiểm chứng được cả quyền **kết nối thật** lẫn
attribute của role. Chạy bằng superuser sẽ cho một kết quả xanh che mất đúng những lỗi
provisioning mà `0001`/`0002` **không** thể tự sửa.

Tên database được pin `db-staff-access`: runner assert `current_database()` trước khi
lấy advisory lock và fail-loud khi `DATABASE_URL` trỏ sang database khác (guard #101
của backoffice). Chưa có biến override tên database — khi staging/production cần tên
khác, thêm runner option kèm assert tương ứng.

### Advisory lock và idempotent

Runner lấy `pg_advisory_lock(hashtext('db-staff-access'))` rồi áp dụng lần lượt từng file
(mỗi file tự bọc `BEGIN`/`COMMIT`).

⚠️ **Không có bảng ledger riêng.** Runner **không** ghi tên file đã apply; nó chạy lại
mọi file mỗi lần chạy, và tính idempotent của DDL là thứ khiến lần chạy thứ hai là
no-op. Sau khi apply, catalog `pg_class` là nguồn sự thật — không có lịch sử apply để
lệch với schema thật.

Không có down-migration. Sai thì **forward-fix**.

## Provisioning step 1 — những gì migration **không** làm được

⚠️ **Bốn việc dưới đây phải do admin/owner chạy, không nằm trong `db/migrations/`.**
Cả bốn đều bị chặn bởi đúng một nguyên nhân: `ecoma_staff_access_migrator` chỉ sở hữu
`db-staff-access`, không sở hữu cluster, không có `CREATEROLE`, và không được có
(`NOCREATEROLE` là điều kiện để nó không leo thang). Đây là những giới hạn thật của
PostgreSQL, phát hiện bằng cách chạy bằng **credential migrator thật** — `SET ROLE`
từ superuser sẽ giấu hết chúng.

| Việc                                                                   | Vì sao migration không tự làm                                   |
| ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| `CREATE ROLE … LOGIN` (cả hai role)                                    | Cần `CREATEROLE`                                                |
| `GRANT CONNECT, CREATE, TEMPORARY` trên `db-staff-access` cho migrator | `CREATE SCHEMA` cần `CREATE` ở tầng database, `PUBLIC` không có |
| `REVOKE CONNECT` trên `db-account`, `db-auth`, `db-backoffice`         | Cần quyền sở hữu database kia                                   |
| `COMMENT ON ROLE` / `COMMENT ON DATABASE`                              | Cần `CREATEROLE` / database owner                               |

```sql
-- Chạy bằng owner/admin, một lần, theo `03-operations.md` §3.2 bước 1
CREATE ROLE ecoma_staff_access_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE ecoma_staff_access_runtime  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE db-staff-access TO ecoma_staff_access_migrator;
```

## Chặn chéo — lớp enforce thật của ranh giới database

⚠️ **Tag Nx không chặn được ranh giới database.** `apps/staff-access` và `apps/account`/`apps/auth`/`apps/backoffice` là các scope Nx riêng (`scope:staff-access` vs các scope khác) — nhưng dù scope chung hay riêng, tag chỉ mã hoá graph và **không** chặn được `apps/staff-access` khai báo binding trỏ `db-account`. Ranh giới đó là **credential**, không phải tag.

**Phải REVOKE cả `PUBLIC`, không chỉ role.** PostgreSQL cấp `CONNECT` cho `PUBLIC`
theo mặc định, và quyền của `PUBLIC` là _quyền mặc định_. `REVOKE CONNECT … FROM
ecoma_staff_access_runtime` một mình là **no-op**: `has_database_privilege` vẫn trả
`true` và kết nối thật vẫn thành công (đo trên PostgreSQL 17: ACL sau khi REVOKE vẫn
là `{=Tc/postgres,postgres=CTc/postgres}` — không có entry của
`ecoma_staff_access_runtime`). Chỉ khi `PUBLIC` cũng bị rút mới còn `false`, và một
kết nối thật mới bị từ chối: `FATAL: permission denied for database "db-*"`.

`tests/integrations/roles.spec.ts` (Milestone B) có **ba** test riêng cho chỗ này:
`has_database_privilege` trả `false`, một kết nối thật bị từ chối, và item `PUBLIC` trong
`datacl` không chứa `C`.

Nếu `db-account`/`db-auth`/`db-backoffice` chưa tồn tại lúc apply `0002`, khối `DO $$ $$`
bỏ qua; chạy lại migration sau khi database có là sẵn sàng. `REVOKE CONNECT` không phụ
thuộc bảng nào tồn tại.

## Ranh giới: không có truy vấn chéo database

⚠️ **Không foreign key, không `postgres_fdw`, không `dblink`, không
`FOREIGN DATA WRAPPER`** ở bất kỳ đâu trong schema này. `db-staff-access` không đọc
`db-account`/`db-auth`/`db-backoffice`; nó gọi HTTP contract. Ký hiệu khác database được
ghi nhận qua `has_database_privilege` fail-closed trong `0002` — không đọc dữ liệu của
database kia.

## Index

**Không có index "cho chắc".** Mỗi index trả lời cho một truy vấn hoặc một ràng buộc cụ thể:

| Index                                                    | Trả lời cho                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| `staff_pkey (id)`                                        | Tra cứu theo định danh staff do directory sở hữu            |
| `staff_sub_key (sub)`                                    | UNIQUE `sub` — mapping 1:1 với Account ID opaque            |
| `staff_sub_idx (sub)`                                    | Tra cứu theo `sub` (đường token → staff, ADR-0012 §4)       |
| `permissions_pkey (id)`                                  | Tra cứu theo định danh `<domain>.<action>`                  |
| `permissions_domain_action_key (domain, action)`         | UNIQUE nửa catalog                                          |
| `roles_pkey (id)`                                        | Tra cứu theo định danh role                                 |
| `role_permissions_pkey (role_id, permission_id)`         | Tập permission của role — một role không trùng permission   |
| `role_permissions_role_id_idx (role_id)`                 | Liệt kê permission của một role                             |
| `role_assignments_pkey (id)`                             | Tra cứu assignment                                          |
| `role_assignments_staff_idx (staff_id)`                  | Assignment của một staff (đường read của audit và list API) |
| `authorization_audit_pkey (id)`                          | Idempotency của audit append-only                           |
| `authorization_audit_actor_idx (actor_sub, occurred_at)` | Truy vấn audit theo actor, bỏ hàng NULL actor               |
| `entitlements_pkey (staff_id, product)`                  | Tra cứu entitlement theo cặp (staff, product)               |

## Test integration

Chạy trên **PostgreSQL thật** qua testcontainers (`postgres:17-alpine`), không mock:

```sh
pnpm nx run @ecoma-io/staff-access:test-integration
```

Suite integration chạy bằng `vitest.integration.config.mts`; danh sách file hiện có:

| File (trong `tests/`)                       | Phủ cách                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `databases/migrations.spec.ts`              | Áp từ rỗng, chạy lại là no-op, advisory lock, guard `current_database` |
| `integrations/roles.spec.ts`                | Chặn chéo `REVOKE CONNECT`, grant sweep, catalog chỉ đọc               |
| `integrations/readiness.spec.ts`            | Readiness 200/503 theo schema và grant                                 |
| `integrations/bootstrap-superadmin.spec.ts` | S1/S2/S3, guard đo được, audit `denied`, race, CLI wire shape          |

Nếu **không có Docker**, `tests/integrations/docker-probe.global-setup.ts` ném và toàn bộ
lần chạy **đỏ** — không có nhánh skip với exit 0 (06-testing.md §6). Một suite bắt buộc
chưa chạy được thì phải thấy được, không phải xanh giả.

## Bootstrap S1/S2/S3

`bootstrap.mts` là bề mặt offline của ADR-0021/0022/0023/0024, chạy bằng credential
migrator, **không** nằm trong Worker bundle (`pg_advisory_xact_lock` không chạy qua
Hyperdrive — HD6):

```sh
echo '{"correlation_id":"…","operator_ref":"…","sub":"sub_…"}' \
  | DATABASE_URL='postgresql://…' npx tsx --tsconfig tsconfig.db.json db/bootstrap.mts staff-provision
echo '{"correlation_id":"…","operator_ref":"…","sub":"sub_…"}' \
  | DATABASE_URL='postgresql://…' npx tsx --tsconfig tsconfig.db.json db/bootstrap.mts staff-assign
echo '{"correlation_id":"…","sub":"sub_…"}' \
  | DATABASE_URL='postgresql://…' npx tsx --tsconfig tsconfig.db.json db/bootstrap.mts staff-verify
```

- Mỗi bước một transaction; S1 và S2 **tự** lấy advisory lock và **tự** đo lại
  `admins_before`/`admins_ever` — không chia sẻ phép đo.
- Từ chối: exit 1 và một dòng JSON `{"stage":…,"status":"denied","reason":…}` trên
  stderr; audit `denied` được commit trong transaction riêng sau khi transaction guard
  đã rollback, mang số đo nếu phép đo đã chạy.
- `operator_ref` bắt buộc với S1/S2 (`operator_ref_missing` khi thiếu) — audit phải có
  tham chiếu người thực thi, và procedure không được tạo assignment không attribution.
- `staff-verify` chỉ đọc và **bắt buộc `sub`** (`sub_missing` / `invalid_sub`): staff
  được kiểm là staff của đúng Account, không phải "hàng staff duy nhất trong database".
  `correlation_id` tuỳ chọn ở tầng hàm; khi có, nó kiểm thêm audit row của S1/S2 cho
  đúng lần chạy đó.

## Cấu trúc thư mục

```
apps/staff-access/db/
├── README.md
├── migrate.mts           # hằng số + helper dùng chung
├── apply.mts             # CLI runner cho CI
├── bootstrap.mts         # CLI bootstrap S1/S2/S3
└── migrations/
    ├── 0001_staff_access_domain.sql   # schema + tables + triggers
    ├── 0002_roles_and_grants.sql      # ba role + grant + chặn chéo
    ├── 0003_permission_catalog_seed.sql  # 3 permission read (staff.read, role.read, permission.read)
    ├── 0004_staff_access_entitlement_outbox.sql
    ├── 0005_internal_nonces.sql
    ├── 0006_outbox_settle.sql
    ├── 0007_permission_catalog_audit_read.sql  # audit.read (permission thứ tư)
    └── 0008_role_identity_and_assignment_uniqueness.sql  # UNIQUE (kind,name), partial unique assignment, seed role canonical
```
