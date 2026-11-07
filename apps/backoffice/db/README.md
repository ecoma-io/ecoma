# `db-backoffice` — schema, migration và test integration

Thư mục này là **nguồn sự thật duy nhất** cho schema của `db-backoffice`. Không có
ORM, không có `drizzle-kit`, không có generate step: `db-backoffice` là PostgreSQL
thuần và migration là file SQL thuần. Cấu trúc và quy ước mirror
[`apps/account/db/`](../../account/db/README.md) — pattern tham chiếu, không sao
chép mù.

| Đường dẫn                | Vai trò                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| `migrations/*.sql`       | Migration, áp dụng **theo thứ tự tên file** (tên file có tiền tố số) |
| `migrate.mts`            | Hằng số và helper dùng chung cho runner và test harness              |
| `apply.mts`              | CLI runner, chạy trong CI                                            |
| `../tests/integrations/` | Test integration trên PostgreSQL thật (testcontainers)               |

## Thứ tự migration hiện tại

| File                                    | Nội dung                                                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0001_backoffice_domain.sql`            | `backoffice.staff`, `permissions`, `roles`, `role_permissions`, `role_assignments`, `authorization_audit`                                                                                                                                        |
| `0002_roles_and_grants.sql`             | hai role + grant từng bảng + guard CONNECT + REVOKE `public`                                                                                                                                                                                     |
| `0003_permission_catalog_seed.sql`      | seed 3 permission read `staff.read`, `role.read`, `permission.read` (status `active`), idempotent + drift-proof (no-target + guard `WHERE NOT EXISTS`)                                                                                           |
| `0004_self_elevation_guard.sql`         | guard tầng DB chống tự nâng quyền của runtime: CHECK định dạng Account ID + độ dài id audit, trigger chặn runtime tự gán role / gán system role / gán permission không active / un-revoke hoặc kéo dài hạn assignment / xoá permission khỏi role |
| `0005_permission_catalog_integrity.sql` | CHECK `permissions_id_matches_domain_action`: `id = domain                                                                                                                                                                                       |     | '.' |     | action`, guard bằng `pg_catalog.pg_constraint`, pre-flight fail-closed; không cấp/thu quyền runtime (invariant 11) |

## Vì sao issue này tạo schema cho staff/RBAC

Tài liệu thiết kế
[`docs/domains/staff-access/domain-model.md`](../../../docs/domains/staff-access/domain-model.md)
§9 để "storage/schema cho staff/RBAC" ở bảng _Đã chốt qua ADR_ (ADR-0001), với điều kiện kích
hoạt "trước khi implement persistence đầu tiên cho staff/RBAC". Workstream này
**là** persistence đầu tiên đó, nên nó chốt: engine PostgreSQL (business data,
bounded context rule), tên database `db-backoffice`, schema `backoffice`.

Những gì file migration **chủ động không** tạo (và comment ở đầu
`0001` giải thích):

- `authorization_audit` retention — theo policy retention hệ thống, chưa chốt.
- bảng outbox / event distribution — cơ chế lan truyền trạng thái sang
  resource-owning backend chưa chốt (§10 dòng cuối).
- seed của system role `sys_*` — nội dung role phải xuất phát từ permission
  catalog thực tế (§4.4); catalog rỗng ở issue này.
- custom role administration — chưa chốt (§10), schema chỉ giữ áp phân biệt
  `is_system`.

## Ba tầng role

| Tầng        | Role                        | Quyền                                                           |
| ----------- | --------------------------- | --------------------------------------------------------------- |
| Owner/admin | `ecoma_owner`               | Sở hữu database và object, **không** chạy trong Worker          |
| Migrator    | `ecoma_backoffice_migrator` | DDL trên schema `backoffice`; chỉ chạy ở CI runner              |
| Runtime     | `ecoma_backoffice_runtime`  | Chỉ DML hạn chế theo bảng; không DDL, không DELETE trên `staff` |

Grant hạn chế theo từng bảng (không "cấp chung rồi thu", cùng lý do mà
`account` chọn): runtime có `DELETE` trên `role_permissions` (gỡ permission khỏi
role) nhưng **không** `DELETE` trên `staff`/`role_assignments` (lịch sử giữ để
audit), `SELECT`-only trên `permissions` (sealed catalog, invariant 10) và trên
`roles`, `SELECT`+`INSERT`-only trên `authorization_audit` (SR-015).

## Guard tự nâng quyền (`0004`)

`0004` là **lớp phòng thủ thứ hai**, không thay thế `requirePermission` ở tầng
app. Nó chỉ ràng buộc **runtime role**; `ecoma_backoffice_migrator` và
`ecoma_owner` đi qua được (bootstrap/seed path), vì trigger phân biệt bằng
`current_user`.

| Guard                                                   | Chặn cái gì                                                                                                                                                                                                                         |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CHECK `staff_sub_account_id_format_check`               | `staff.sub` không phải Account ID (`sub_` + 32 ký tự base32 `a`–`z`,`2`–`7`)                                                                                                                                                        |
| Trigger `role_assignments_no_self_elevation`            | runtime tự gán role cho chính mình; runtime gán system-defined role (`roles.is_system`); runtime không khai báo actor; runtime không đúng định dạng actor; runtime thay đổi `revoked_at`/`valid_until` (un-revoke hoặc kéo dài hạn) |
| Trigger `role_permissions_governed_write`               | runtime gán permission không `status = 'active'`; runtime gán vào system-defined role; runtime không khai báo actor; runtime không đúng định dạng actor                                                                             |
| Trigger `role_permissions_no_system_delete`             | runtime xoá permission khỏi role (system-defined lẫn custom) — nội dung role là governance action (ADR-0004)                                                                                                                        |
| CHECK `authorization_audit_request_id_length_check`     | `request_id` dài quá 128 ký tự (`AUTHORIZATION_AUDIT_ID_MAX_LENGTH`)                                                                                                                                                                |
| CHECK `authorization_audit_correlation_id_length_check` | `correlation_id` dài quá 128 ký tự                                                                                                                                                                                                  |
| CHECK `authorization_audit_target_sub_format_check`     | `target_sub` không phải Account ID                                                                                                                                                                                                  |

⚠️ `0004` **không cấp thêm quyền nào cho runtime**. Trigger đọc catalog bằng
chính quyền của caller (`SECURITY INVOKER`, runtime đã có `SELECT` trên
`permissions`/`roles`) — `SECURITY DEFINER` sẽ đổi `current_user` thành owner
của function và vô hiệu hóa guard.

⚠️ **Apply theo hướng fail-closed**: nếu môi trường thật đang có dữ liệu vi
phạm CHECK mới thì migration **dừng** với `violates check constraint`, không
dùng `NOT VALID` và không tự sửa dữ liệu. Truy vấn kiểm tra trước khi apply:

```sql
SELECT count(*) FROM backoffice.staff WHERE sub !~ '^sub_[a-z2-7]{32}$';
```

⚠️ Cột `role_permissions.created_by_sub` được thêm ở `0004` là **expand**
(nullable, không contract): đường governance (migrator/owner) không bị chặn,
chỉ runtime bị chặn bởi trigger — cùng cách `role_assignments.created_by_sub`
đã nullable sẵn từ `0001`.

## Chạy migration

⚠️ **Chạy từ CI runner, không chạy từ trong Worker.** Hyperdrive không hỗ trợ
advisory lock ([`04-platform-facts.md`](../../../docs/architecture/04-platform-facts.md)
HD6), nên không thể giữ `pg_advisory_lock` qua đường đi của Worker. Worker chỉ
dùng `_runtime_` role, và `_runtime_` role không có quyền DDL.

```sh
DATABASE_URL='postgresql://…:…@host:5432/db-backoffice' pnpm nx run @ecoma-io/backoffice:db:migrate
```

| Biến           | Bắt buộc | Ý nghĩa                                                   |
| -------------- | -------- | --------------------------------------------------------- |
| `DATABASE_URL` | Có       | Kết nối tới `db-backoffice`, bằng credential `_migrator_` |

`DATABASE_URL` không có thì exit code khác 0 và in hướng dẫn; coi im lặng là đã
apply là cách làm một lần migration biến mất.

⚠️ **Credential phải là `_migrator_` thật**, không phải owner hay superuser.
Runner cố ý **không** dùng `SET ROLE`, nên nó kiểm chứng được cả quyền **kết
nối thật** lẫn attribute của role. Chạy bằng superuser sẽ cho một kết quả xanh
che mất đúng những lỗi provisioning mà `0001`/`0002` **không** thể tự sửa.

⚠️ Backoffice không có placeholder tên database trong SQL:
`db-backoffice` không có database nào khác cần mention (guard CONNECT chỉ nhìn
chính database hiện hành; REVOKE CONNECT chéo là việc của provisioning step 1).
`renderMigration` được giữ lại để runner và harness đi chung một đường code.

### Advisory lock và idempotent

Runner lấy `pg_advisory_lock(hashtext('db-backoffice'))` rồi áp dụng lần lượt
từng file (mỗi file tự bọc `BEGIN`/`COMMIT`). Lock là session-scoped nên tự nhả
khi kết nối đóng.

⚠️ **Không có bảng ledger riêng.** Runner chạy lại mọi file mỗi lần, và tính
idempotent của DDL là thứ khiến lần chạy thứ hai là no-op. Sau khi apply, catalog
`pg_class` là nguồn sự thật. Thêm câu DDL mới thì bắt buộc nghĩ tới chạy lần hai
— test `migrations.spec.ts` chạy apply hai lần để giữ điều đó thật.

Không có down-migration. Sai thì **forward-fix**.

## Provisioning step 1 — những gì migration **không** làm được

⚠️ Các việc dưới đây phải do admin/owner chạy, không nằm trong `db/migrations/`:
`ecoma_backoffice_migrator` chỉ sở hữu `db-backoffice`, không có `CREATEROLE`
và không được có.

| Việc                                                                 | Vì sao migration không tự làm                                   |
| -------------------------------------------------------------------- | --------------------------------------------------------------- |
| `CREATE ROLE … LOGIN` (cả hai role)                                  | Cần `CREATEROLE`                                                |
| `GRANT CONNECT, CREATE, TEMPORARY` trên `db-backoffice` cho migrator | `CREATE SCHEMA` cần `CREATE` ở tầng database, `PUBLIC` không có |
| `REVOKE CONNECT` chéo trên database của service khác                 | Cần quyền sở hữu database kia                                   |
| `COMMENT ON ROLE` / `COMMENT ON DATABASE`                            | Cần `CREATEROLE` / database owner                               |

```sql
-- Chạy bằng owner/admin, một lần
CREATE ROLE ecoma_backoffice_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE ecoma_backoffice_runtime  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE db-backoffice TO ecoma_backoffice_migrator;
-- REVOKE CONNECT chéo sang database của service khác làm bằng owner của database đó,
-- theo đúng runbook của service sở hữu nó.
```

⚠️ `REVOKE CONNECT` **báo thành công nhưng không làm gì cả** nếu chạy bằng
migrator. Đó chính là lý do nó nằm ở provisioning chứ không nằm trong
migration — assertion `has_database_privilege('ecoma_backoffice_runtime', …)`
trong `0002` là **lưới bắt provisioning quên GRANT lại CONNECT cho runtime của
chính db-backoffice**, không phải một đèn xanh tự động.

## Ranh giới: không có truy vấn chéo database

⚠️ **Không foreign key, không `postgres_fdw`, không `dblink`, không
`FOREIGN DATA WRAPPER`** ở bất kỳ đâu trong schema này. `sub` là tham chiếu
opaque sang `db-account` — tham chiếu, không FK (A21, §3). `account`/`auth`
không được ghi vào dữ liệu staff/RBAC của `backoffice` dù chung instance
(invariant 34/35; `01-architecture.md` §3 và §8).

## Index

**Không có index "cho chắc".** Mỗi index trả lời cho một truy vấn hoặc một
ràng buộc cụ thể:

| Index                                                        | Trả lời cho                                                                                                                                                                                                           |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `staff_pkey (sub)`                                           | Tra cứu theo `sub`; mapping 1:1 (§4.1)                                                                                                                                                                                |
| `permissions_pkey (id)` + `permissions_domain_action_unique` | Tra cứu định danh permission; UNIQUE là ràng buộc catalog (§4.3)                                                                                                                                                      |
| `roles_pkey (id)`                                            | Tra cứu theo id; `sys_` prefix là cơ chế phân loại system role                                                                                                                                                        |
| `role_permissions_pkey (role_id, permission_id)`             | Liệt kê permission của một role; tập hữu hạn (SR-016)                                                                                                                                                                 |
| `role_assignments_pkey (staff_sub, role_id)`                 | Liệt kê role của một staff; hợp các assignment còn hiệu lực (§4.5)                                                                                                                                                    |
| `role_assignments_staff_idx (staff_sub)`                     | Truy vấn assignment theo `staff_sub` không cần gom role — read-time filter của workstream B. ⚠️ PK prefix `(staff_sub)` đã phủ truy vấn này; REMOVE index này trước production nếu không có EXPLAIN chứng minh nó cần |
| `authorization_audit_pkey (id)`                              | Idempotency của audit append-only                                                                                                                                                                                     |
| `authorization_audit_actor_idx` (partial)                    | Truy vấn audit theo `actor_sub`, sắp theo `occurred_at DESC`                                                                                                                                                          |

## Test integration

Chạy trên **PostgreSQL thật** qua testcontainers (`postgres:17-alpine`), không
mock:

```sh
pnpm nx run @ecoma-io/backoffice:test-integration
```

| File                           | Phủ cách                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `migrations.spec.ts`           | apply từ rỗng, chạy lại là no-op, advisory lock, runtime-role DML smoke                                                                                                  |
| `grants.spec.ts`               | AC-012 (`has_table_privilege` sweep tuỳ bảng), SR-015 audit append-only, runtime không DDL / không `public`                                                              |
| `self-elevation-guard.spec.ts` | guard của `0004`: runtime không tự gán role / không gán system role / không gán permission không active, định dạng `sub` và độ dài id audit, và migrator vẫn đi qua được |

Nếu **không có Docker**, toàn bộ suite **skip** chứ không fail — `probeDocker()`
thử khởi động một container thật trước, thất bại thì `describe.skipIf`. Đọc
[`apps/account/db/README.md`](../../account/db/README.md) về fail-open này:
**luôn đọc dòng `Tests`** của Vitest, không chỉ exit code.

⚠️ Payload của `authorization_audit` mang kiểu dữ liệu có CHECK top-level-key
chặn `token|access_token|secret|password|authorization`, nhưng CHECK đó là lớp
mềm: enforce thật của SR-014 nằm ở scrubbing tầng app + test (workstream B).

## Cấu trúc thư mục

```
apps/backoffice/db/
├── README.md
├── migrate.mts           # hằng số + helper dùng chung
├── apply.mts             # CLI runner cho CI
└── migrations/
    ├── 0001_backoffice_domain.sql        # staff, permissions, roles, assignments, audit
    ├── 0002_roles_and_grants.sql         # hai role + grant từng bảng + guard CONNECT
    ├── 0003_permission_catalog_seed.sql  # seed permission catalog read (drift-proof)
    ├── 0004_self_elevation_guard.sql     # guard tầng DB chống tự nâng quyền của runtime
    └── 0005_permission_catalog_integrity.sql  # CHECK id = domain.action (drift-proof naming)
```
