-- 0001_backoffice_domain.sql — schema lõi của RBAC domain `db-backoffice`.
--
-- Source of truth đã đọc trước khi viết:
-- - `docs/domains/staff-access/domain-model.md` §3–§5, §9 invariant 1–12,
--   §10 (đã chốt qua ADR — quyết định này là ADR-0001).
-- - `docs/applications/staff-access/02-requirements.md` SR-010..SR-015 + T-05 + AC-011.
-- - `docs/architecture/01-architecture.md` invariant 34/35: không dịch vụ khác ghi
--   staff/role/permission của `backoffice`; mọi thao tác đổi quyền có audit.
--
-- ⚠️ Tài liệu thiết kế §4 khai báo rõ "schema không được chốt ở đây, storage là
-- quyết định chưa chốt (§10)". Issue #85 (workstream A) **là** quyết định đó cho
-- phạm vi persistence nền tảng: PostgreSQL + database `db-backoffice` + schema
-- `backoffice`. Những gì **chủ động không** tạo ở file này, để không âm thầm
-- chốt một quyết định chưa chốt:
--
--   * `outbox_states` / bảng event distribution của mọi loại — cơ chế lan truyền
--     event sang resource-owning backend (event contract giữa `backoffice` và
--     backend) là quyết định chưa chốt (`01-architecture.md` §10 dòng cuối).
--     Khi decision đó chốt, migration sau tạo bảng riêng của nó — đúng hình thức
--     `account.account_outbox_events` được tạo khi invariant 6 đã chốt.
--
--   * `staff.email` — email **không** phải identity key (§3, §4.1): identity là
--     Account ID `sub` do `account` sở hữu. Hồ sơ định danh (email, profile)
--     sống ở `account`, không nhân bản vào đây.
--
--   * nội dung cụ thể của từng system-defined role `sys_*` — nó "phải xuất
--     phát từ permission catalog thực tế" (§4.4), catalog còn rỗng ở file này
--     nên không có role system nào được seed. Seed là việc của các migration
--     sau, cùng đường "insert-then-retire" của `permissions`.
--
-- Quy ước chung của file trong `db/migrations/` (giống `apps/account`):
--   * Áp theo thứ tự tên file; chạy lại phải là no-op (advisory lock trong
--     `apps/backoffice/db/apply.mts`, mọi DDL ở dạng idempotent).
--   * Mọi cột thời gian là `timestamptz`, tức đã lưu theo UTC.
--   * Schema ứng dụng tên `backoffice`; runtime role chỉ có DML trên schema này
--     (grant ở `0002_roles_and_grants.sql`).
--   * Không FK, không `postgres_fdw`, không `dblink`, không truy vấn xuyên
--     database. `sub` là tham chiếu opaque sang `db-account` — tham chiếu
--     không có ràng buộc ở tầng database (§3 "Database trust").

BEGIN;

-- ---------------------------------------------------------------------------
-- Role migrator TRƯỚC schema
-- ---------------------------------------------------------------------------
--
-- ⚠️ Thứ tự này bắt buộc vì cùng một lý do `0001_identity_core.sql` của
-- `account` phải giải thích: `CREATE SCHEMA` cần `CREATE` **trên database**, và
-- PostgreSQL không cấp quyền đó cho `PUBLIC`. Nên migration **không** tự cấp
-- được — `CREATE` ở tầng database là **provisioning step 1** (admin/owner),
-- xem README. Thiếu nó thì runner dừng ở `CREATE SCHEMA`.
--
-- Vì vậy file này giả định provisioning đã cấp `CREATE` cho
-- `ecoma_backoffice_migrator` trên database này. Tạo role thì vẫn ở đây vì role
-- là object của cluster, không cần quyền trên database nào — và `0002` cần nó
-- tồn tại (guard thứ hai nằm ở `0002`).
--
-- Runtime role được tạo và grant trong `0002`: `0001` không cần nó tồn tại
-- trước khi `0002` chạy, và giữ `0001` nhỏ bằng đúng những gì schema cần.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ecoma_backoffice_migrator') THEN
    CREATE ROLE ecoma_backoffice_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS backoffice;

COMMENT ON SCHEMA backoffice IS
  'Application schema of db-backoffice. Runtime role only has DML here; grants are issued in 0002_roles_and_grants.sql.';

-- ---------------------------------------------------------------------------
-- staff — sổ staff, trục trạng thái riêng khỏi account
-- ---------------------------------------------------------------------------
--
-- `sub` là PRIMARY KEY nên UNIQUE theo định nghĩa: một Account ID có thể không
-- có staff entry; khi có, mapping là 1:1 (§3, §4.1). `sub` là **reference**
-- opaque: không FK sang `db-account` (không có FK xuyên database), không tái
-- phát hành/không tái sử dụng thuộc sở hữu của `account`.
--
-- ⚠️ `status` theo trục của `libs/backoffice-domain` (`BackofficeStaffStatus`):
--   * Trục này **khác hẳn** account status (`active|suspended|deleted`) và hai
--     trục không suy ra nhau (§4.2, invariant 8). Suspend/delete account ở
--     `account` không tự viết lại hàng này.
--   * Cột CHECK chỉ chặn **tập nhãn** — nó không phải là policy luân chuyển.
--     Policy "terminated là terminal" là việc của trigger bên dưới vì CHECK
--     chỉ nhìn thấy NEW row, không nhìn OLD.
--
-- Không có `email`, không có profile: xem phần "chủ động không tạo" ở đầu
-- file. `created_at`/`updated_at` là dấu vết của sổ staff; `updated_at` do tầng
-- ứng dụng giữ (workstream B), schema không có trigger tự nhảy — một UPDATE
-- không đổi gì mà đổi `updated_at` là hành vi im lặng không ai gọi tên.

CREATE TABLE IF NOT EXISTS backoffice.staff (
  sub text PRIMARY KEY,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_status_check CHECK (status IN ('active', 'suspended', 'terminated'))
);

COMMENT ON TABLE backoffice.staff IS
  'Staff directory. sub is an opaque reference to the account Account ID, 1:1, no cross-database FK (01 3, 4.1). Email does not live in this table.';
COMMENT ON COLUMN backoffice.staff.sub IS
  'Account ID (sub form) of the staff member. PRIMARY KEY = unique; opaque reference, changing sub on an existing row is blocked (01 4.1).';
COMMENT ON COLUMN backoffice.staff.status IS
  'Independent axis that does not infer account status (01 4.2): active | suspended | terminated. Terminated is terminal; a trigger silently blocks restoration.';

-- ---------------------------------------------------------------------------
-- terminated là terminal: chặn hồi sinh im lặng
-- ---------------------------------------------------------------------------
--
-- §4.2: "`terminated` là trạng thái cuối cho membership; khôi phục membership là
-- thao tác mới có audit, không phải 'chuyển lại về active' im lặng."
--
-- Runtime role **có** UPDATE trên `staff` (suspend/terminate là thao tác tầng
-- app, workstream B), nên một CHECK không đủ — CHECK chỉ thấy NEW row, còn
-- "vừa đi qua trạng thái terminated" là thuộc tính của OLD row.
--
-- Cùng lúc đó `sub` là identity mapping 1:1: đổi `sub` trên một hàng đã tồn
-- tại là đổi danh tính của staff member đó.
--
-- Như `account.users_tombstone_immutable`, trigger này chỉ chặn **UPDATE**;
-- DELETE bị chặn ở **tầng grant** — runtime role không được cấp `DELETE` trên
-- `staff` (0002), vì "không giả định xoá vật lý" (§4.6): staff status là trạng
-- thái của record, record không bị xoá.
--
-- Tạo lại hàm bằng CREATE OR REPLACE và trigger bằng DROP-then-CREATE: apply
-- lại file phải là no-op, không phải lỗi.

CREATE OR REPLACE FUNCTION backoffice.staff_identity_and_terminal_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Đổi `sub` trên hàng đã tồn tại là đổi danh tính của một staff member —
  -- PK chỉ chặn trùng, không chặn UPDATE. Chặn o đây để sub cũ không được
  -- "tái dùng ngầm" cho người khác bằng một UPDATE (01 §4.1).
  IF NEW.sub IS DISTINCT FROM OLD.sub THEN
    RAISE EXCEPTION
      'staff: sub la tham chieu 1:1 sang account, khong duoc doi tren hang da ton tai (01 4.1)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- terminated là terminal: mọi UPDATE đưa status ra khỏi terminated bị từ
  -- chối. Khôi phục membership sau terminated là **thao tác mới có audit** —
  -- không phải là chuyển row này về 'active' im lặng (01 §4.2, T-05 của
  -- `02-requirements.md`).
  IF OLD.status = 'terminated'
     AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION
      'staff: terminated la trang thai terminal; phuc hoi membership la thao tac moi co audit, khong phai UPDATE im lang (01 4.2, T-05)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION backoffice.staff_identity_and_terminal_guard() IS
  'Blocks UPDATEs that change sub or move status away from terminated; restoring membership must be a new audited operation (01 4.1, 4.2).';

DROP TRIGGER IF EXISTS staff_identity_and_terminal_guard ON backoffice.staff;
CREATE TRIGGER staff_identity_and_terminal_guard
  BEFORE UPDATE ON backoffice.staff
  FOR EACH ROW
  EXECUTE FUNCTION backoffice.staff_identity_and_terminal_guard();

-- ---------------------------------------------------------------------------
-- permissions — sealed catalog, insert-then-retire
-- ---------------------------------------------------------------------------
--
-- **Permission catalog** là danh mục permission được phép gán (§4.3), thuộc sở
-- hữu của `backoffice`. Invariant 10 / SR-020: catalog là nguồn sự thật duy
-- nhất — resource-owning backend **không** tự phát minh permission ngoài
-- catalog. Cột UNIQUE (`domain`, `action`) là ràng buộc của Định danh: cùng một
-- resource domain + action chỉ có một permission entry.
--
-- Catalog không phải thứ runtime role tự quyết: grant ở `0002` chỉ cho runtime
-- SELECT trên bảng này (không INSERT/UPDATE). Ngoại lệ duy nhất cho ghi là seed
-- migration — file SQL trong repo chạy bằng migrator.
--
-- Không seed row nào ở file này: catalog tạo rỗng. Seed là việc của các file
-- seed riêng sau này, khi catalog thật sự có nội dung (việc cấm "phát minh
-- permission từ tài liệu" là yêu cầu §4.3 — tài liệu này không phát minh).

CREATE TABLE IF NOT EXISTS backoffice.permissions (
  id text PRIMARY KEY,
  domain text NOT NULL,
  action text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT permissions_status_check CHECK (status IN ('active', 'retired')),
  CONSTRAINT permissions_domain_action_unique UNIQUE (domain, action)
);

COMMENT ON TABLE backoffice.permissions IS
  'Permission catalog — sealed: INSERT only via the seed migration run by the migrator; the runtime role cannot INSERT/UPDATE (0002). Unique (domain, action).';
COMMENT ON COLUMN backoffice.permissions.domain IS
  'Resource domain of the permission (e.g. delivery). One half of the identifier; action is the other half.';
COMMENT ON COLUMN backoffice.permissions.action IS
  'Action name within the resource domain. Together they form identifiers like the delivery.redrive permission (example from 01 4.3).';

-- ---------------------------------------------------------------------------
-- Status retired là terminal: chặn hồi sinh catalog entry
-- ---------------------------------------------------------------------------
--
-- Đảo chiều ngược: một permission được retire **không** được quay lại active
-- bằng một UPDATE im lang (cùng tính chất membership terminated). Cách đúng để
-- đưa lại một permission rời catalogue là một seed migration mới, được review
-- như vậy có audit từ git.
--
-- UPDATE trên permissions vẫn có sẵn với migrator — trigger này giữ cho seed
-- migration không sửa ngược một entry đã retired (và trong trường hợp cứng,
-- chặn mọi role khác sử dụng cùng đường).

CREATE OR REPLACE FUNCTION backoffice.permissions_retired_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> OLD.status AND OLD.status = 'retired' THEN
    RAISE EXCEPTION
      'permissions: entry da retired la terminal, quay lai active phai la seed migration moi co review (01 4.3, invariant 10)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION backoffice.permissions_retired_immutable() IS
  'Insert-then-retire only: a retired entry is terminal, returning to active is silently blocked (01 4.3).';

DROP TRIGGER IF EXISTS permissions_retired_immutable ON backoffice.permissions;
CREATE TRIGGER permissions_retired_immutable
  BEFORE UPDATE ON backoffice.permissions
  FOR EACH ROW
  EXECUTE FUNCTION backoffice.permissions_retired_immutable();

-- ---------------------------------------------------------------------------
-- roles + role_permissions — role là tập permission có tên
-- ---------------------------------------------------------------------------
--
-- **Role** là một tập permission có tên (§4.4). Không có unrestricted
-- `isAdmin` bypass: mọi role đều là tập permission hữu hạn và mọi đường đều
-- chạy qua enforcement như nhau (SR-016). Schema không cột `is_admin` hay cờ
-- bypass nào — "role đặc biệt toàn quyền" chỉ có thể là role có nhiều
-- permission, và tất cả đều đi qua `role_permissions`.
--
-- system-defined role vs custom role được phân biệt bởi cột `is_system`, gắn
-- chặt với prefix của id bằng CHECK hai chiều (`is_system` ⇔ id có prefix
-- `sys_`): ràng buộc giữ hai nửa luôn phải là một — không INSERT role
-- system với id không có prefix (rồi code tra theo prefix lại bỏ sót nó),
-- không sửa `is_system` mà phá hỏng prefix. Gọi role bằng prefix `sys_` thì
-- không bao giờ nhầm một custom role.
--
-- ⚠️ Việc **bật custom role administration** là quyết định chưa chốt (§10).
-- Schema chỉ giữ khả năng phân biệt và ràng buộc; cho phép runtime role tạo
-- role hay không là quyết định của grant file (`0002`), không phải schema.

CREATE TABLE IF NOT EXISTS backoffice.roles (
  id text PRIMARY KEY,
  is_system boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_is_system_prefix_biconditional CHECK (
    (is_system = (id LIKE 'sys\_%' ESCAPE '\'))
  )
);

COMMENT ON TABLE backoffice.roles IS
  'Role = a named set of permissions. No bypass role: every role is a finite set via role_permissions (SR-016).';
COMMENT ON COLUMN backoffice.roles.is_system IS
  'System-defined roles have the id prefix sys_; the biconditional CHECK blocks changing one half while keeping the other. Custom role administration is not finalized (01 10).';

-- Bảng nối nhiều-to-nhiều: role chứa permission nào. Khoá (role_id,
-- permission_id): một role không trùng permission — đúng nghĩa "tập hữu hạn".
CREATE TABLE IF NOT EXISTS backoffice.role_permissions (
  role_id text NOT NULL REFERENCES backoffice.roles (id),
  permission_id text NOT NULL REFERENCES backoffice.permissions (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_permissions_role_permission_pk PRIMARY KEY (role_id, permission_id)
);

COMMENT ON TABLE backoffice.role_permissions IS
  'Permission set of each role. Changing a role''s permission set happens only through role_permissions, no other column.';
COMMENT ON COLUMN backoffice.role_permissions.role_id IS
  'FK into backoffice.roles. The runtime role may not create roles (0002 grant) but role_permissions has DML for custom roles (expand-friendly).';

-- ---------------------------------------------------------------------------
-- role_assignments — gán role cho staff, minimal scope, giữ lịch sử
-- ---------------------------------------------------------------------------
--
-- **Role assignment** gán một role cho một staff member (§4.5); một staff có
-- thể có **nhiều** role (không UNIQUE thêm trên `staff_sub`, khác vai trò với
-- mapping 1:1 staff↔sub). Tập quyền hiện hành của một staff là hợp của các
-- assignment còn hiệu lực; role cung cấp tập permission, assignment cung cấp
-- người + hạn hiệu lực.
--
-- ⚠️ **Scope schema giữ tối thiểu ở issue này.** §4.5 chỉ định nghĩa khái niệm
-- "phạm vi"; hình dạng dữ liệu nó (bảng con? jsonb?) là quyết định chưa chốt
-- (§10). Cột `scope_label text NOT NULL DEFAULT 'global'` là điểm neo đủ cho
-- v1; mở rộng là migration sau thêm cột hoặc bảng con, không phá dữ liệu —
-- expand đúng hình thức.
--
-- ⚠️ **valid_until không bị xoá bởi thời gian hết hạn.** Hết hạn là trạng thái
-- đọc ra tại **read-time** — ứng dụng lọc theo `valid_until >= now()` khi build
-- tập permission hiện hành (workstream B). Schema không có job dọn, không
-- DELETE vì thời gian: lịch sử assignment được giữ để audit còn truy vấn được
-- (§4.6). THU HỒI là `revoked_at` — một UPDATE có chủ đích, không phải DELETE.
--
-- `created_by_sub` là reference opaque (không FK): actor của việc gán role,
-- có thể NULL khi assignment được tạo trong seed/bootstrap bằng migrator —
-- đường bootstrap first-administrator đã được chốt ở ADR-0020 và thuộc
-- `db-staff-access`, không phải schema chuyển tiếp này.

CREATE TABLE IF NOT EXISTS backoffice.role_assignments (
  staff_sub text NOT NULL REFERENCES backoffice.staff (sub),
  role_id text NOT NULL REFERENCES backoffice.roles (id),
  scope_label text NOT NULL DEFAULT 'global',
  valid_until timestamptz,
  revoked_at timestamptz,
  created_by_sub text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Hai trục thời gian **độc lập** (cùng nguyên tắc "trục tách đôi" mà
  -- `staff status` và account status tuân theo):
  --   * `valid_until` — hạn hiệu lực **tự nhiên** của assignment.
  --   * `revoked_at`   — thời điểm **thu hồi có chủ đích**.
  -- Một assignment bị thu hồi sớm vẫn giữ `valid_until` (kế hoạch cũ) cùng
  -- `revoked_at` (thời điểm thực tế) — hai mốc khác nhau, và giữ cả hai là
  -- điều audit cần (§4.6: lịch sử assignment được giữ để truy vấn được).
  -- Vì vậy ràng buộc ở đây **không** cấm assignment có cả hai; nó chỉ chặn
  -- mốc thời gian vô nghĩa (hết hạn/thu hồi trước lúc assignment tồn tại).
  CONSTRAINT role_assignments_valid_until_after_created CHECK (
    valid_until IS NULL OR valid_until > created_at
  ),
  CONSTRAINT role_assignments_revoked_after_created CHECK (
    revoked_at IS NULL OR revoked_at > created_at
  )
);

COMMENT ON TABLE backoffice.role_assignments IS
  'Assigns roles to staff, N per staff. valid_until is a read-time filter in the app layer (workstream B); revocation is UPDATE revoked_at, not DELETE (01 4.6).';
COMMENT ON COLUMN backoffice.role_assignments.scope_label IS
  'Scope label — minimal for v1 (01 10). Shape may grow: more columns or tables can be added later, expand-friendly.';
COMMENT ON COLUMN backoffice.role_assignments.valid_until IS
  'Read-time validity horizon: the app layer does not query rows whose valid_until has passed. The row remains for audit (01 4.6).';
COMMENT ON COLUMN backoffice.role_assignments.revoked_at IS
  'Deliberate revocation timestamp — an audited UPDATE, not DELETE (SR-007/AC-006).';

CREATE INDEX IF NOT EXISTS role_assignments_staff_idx
  ON backoffice.role_assignments (staff_sub);
-- ⚠️ PK `(staff_sub, role_id)` có prefix `staff_sub` và index prefix của PK đã
-- đủ cho truy vấn "assignment của một staff". Index này là index phụ chỉ cần
-- khi query không cần gom role — giữ cho read-time filter ở workstream B; REMOVE
-- trước production nếu review không có EXPLAIN chứng minh nó cần.

-- ---------------------------------------------------------------------------
-- authorization_audit — append-only, SR-013 7 trường, không secret (SR-014)
-- ---------------------------------------------------------------------------
--
-- SR-013 (`02-requirements.md` §3.4): mỗi privileged operation ghi audit với
-- đủ **7 trường**: actor, target, action, time, result, reason,
-- request/correlation ID. Cột `context jsonb` là nơi ràng buộc của SR-014:
-- không chứa token/auth secret/password — CHECK chạy trên top-level key (bằng
-- operator `?|`) nhưng nó là **soft-check**: nó chỉ chặn đúng những tên key
-- liệt kê; payload lồng một tầng sâu hơn hay key khác tên vẫn đi qua được. Enforce
-- thật của SR-014 là scrubbing ở tầng ứng dụng + test (SR-014 kiểm chứng qua
-- grep audit, không phải qua CHECK DB).
--
-- ⚠️ `actor_sub`/`target_sub`/`created_by_sub` không FK — audit phải sống sót
-- qua bất kỳ thay đổi nào của sổ staff (cùng ý nghĩa với
-- `account.security_events` không FK tới `users`).

CREATE TABLE IF NOT EXISTS backoffice.authorization_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_sub text,
  target_sub text,
  action text NOT NULL,
  outcome text NOT NULL,
  reason_code text,
  request_id text,
  correlation_id text,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT authorization_audit_outcome_check CHECK (outcome IN ('success', 'failure', 'denied')),
  CONSTRAINT authorization_audit_no_secret_keys CHECK (
    NOT context ?| ARRAY['token', 'access_token', 'secret', 'password', 'authorization']
  )
);

COMMENT ON TABLE backoffice.authorization_audit IS
  'Append-only audit (SR-013, SR-015, invariant 12). UPDATE/DELETE are blocked in two layers: the runtime role has no grant (0002) and a trigger raises an exception.';
COMMENT ON COLUMN backoffice.authorization_audit.actor_sub IS
  'Actor sub, may be NULL for system operations. No FK so audit survives any change to the staff directory.';
COMMENT ON COLUMN backoffice.authorization_audit.context IS
  'Sanitized payload only (SR-014). The CHECK is a soft-check on top-level keys — not a substitute for app-layer scrubbing.';
COMMENT ON COLUMN backoffice.authorization_audit.outcome IS
  'Operation outcome: success | failure | denied. Denials must also be audited (SR-018) — a silent deny loses the investigation signal.';

-- Truy vấn phục vụ đường đọc audit thường nhất: theo actor, sắp theo thời
-- điểm, bỏ hàng NULL actor vì partial index chỉ phủ các hàng có actor.
CREATE INDEX IF NOT EXISTS authorization_audit_actor_idx
  ON backoffice.authorization_audit (actor_sub, occurred_at DESC)
  WHERE actor_sub IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Append-only enforcement 2 lớp cho authorization_audit (SR-015)
-- ---------------------------------------------------------------------------
--
-- SR-015: append-only + access-restricted. Lớp 1 là **grant** — runtime role
-- không có UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER trên bảng này (0002).
-- Lớp 2 là **trigger** raising exception trên mọi UPDATE/DELETE kể cả từ role
-- khác có quyền — cùng hình dạng `account.security_events_append_only`. Hai
-- lớp bổ sung cho nhau: grant thiếu mà trigger còn thì AC-015 vẫn đỏ, trigger
-- thiếu mà grant còn thì sweep `has_table_privilege` (AC-012) vẫn đỏ.
--
-- "Append-only" nghĩa là INSERT không bị chặn: đường deny (SR-018) cũng cần
-- ghi được audit. Chặn UPDATE/DELETE, không chặn INSERT.

CREATE OR REPLACE FUNCTION backoffice.authorization_audit_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'authorization_audit la bang audit append-only: % bi tu choi (SR-015, AC-015)',
    TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

COMMENT ON FUNCTION backoffice.authorization_audit_append_only() IS
  'Blocks UPDATE/DELETE on the audit with an absolute exception; INSERT stays open so every value gets recorded (SR-018). Layer 2; layer 1 is the grant in 0002.';

DROP TRIGGER IF EXISTS authorization_audit_append_only ON backoffice.authorization_audit;
CREATE TRIGGER authorization_audit_append_only
  BEFORE UPDATE OR DELETE ON backoffice.authorization_audit
  FOR EACH ROW
  EXECUTE FUNCTION backoffice.authorization_audit_append_only();

COMMIT;
