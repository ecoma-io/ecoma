-- 0004_self_elevation_guard.sql — guard chống self-elevation ở tầng database.
--
-- Source of truth đã đọc trước khi viết:
--   * `docs/domains/staff-access/domain-model.md` §7 ("Cấm: tự gán role
--     (self-assignment), tự nâng quyền (self-elevation), cấp quyền vượt quá
--     quyền của chính mình"), §9 invariant 10 (catalog sealed), 11 (least
--     privilege), 12 (audit append-only).
--   * `docs/applications/staff-access/02-requirements.md` SR-005 (cấm
--     self-assignment/self-elevation), SR-010 (least-privilege credential),
--     SR-013 (audit đủ 7 trường), SR-015 (audit append-only), SR-020 (catalog
--     là nguồn sự thật duy nhất), T-01 (self-grant), AC-006.
--   * `docs/domains/staff-access/adr/0003-bootstrap-first-admin-recovery.md` —
--     bootstrap/recovery là procedure IaC/manual SQL bằng credential
--     `ecoma_owner` (ADR-0001), **không** phải code path nào của `backoffice`.
--   * `docs/domains/staff-access/adr/0004-custom-role-administration.md` — giai
--     đoạn này **chỉ có system-defined role**; nội dung của role là governance
--     action có audit, **không** phải thao tác runtime của admin.
--   * `apps/backoffice/db/migrations/0002_roles_and_grants.sql` — grant runtime
--     role: INSERT/UPDATE `staff`, INSERT/DELETE `role_permissions`,
--     INSERT/UPDATE `role_assignments`, SELECT `permissions`/`roles`.
--   * `libs/backoffice-domain/src/account-id.ts` — định dạng Account ID:
--     prefix `sub_` + **32** ký tự base32 viết thường (`a`–`z`, `2`–`7`).
--     `BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS = 32`, ngưỡng 160 bit lấy từ
--     producer `libs/account-domain/src/subject.ts`.
--
-- ⚠️ **Đây là lớp phòng thủ thứ hai, không thay thế enforcement ở tầng
-- application.** `requirePermission` (workstream B) vẫn là checkpoint chính;
-- cùng hình thức 2 lớp của `authorization_audit` append-only (grant + trigger).
-- SR-005 — "không cấp cho người khác permission mình không có" — **không**
-- kiểm chứng được ở tầng DB (xem "Giới hạn của guard này" ở cuối file).
--
-- ⚠️ **Không cấp thêm quyền nào cho runtime role, và không thu quyền nào.**
-- File này chỉ thêm CHECK và trigger; grant của `0002` giữ nguyên. Trigger đọc
-- catalog bằng **quyền của chính caller** (runtime đã có SELECT trên
-- `backoffice.permissions` và `backoffice.roles`), **không** dùng
-- `SECURITY DEFINER` — xem giải thích ở trigger `role_permissions`.
--
-- ⚠️ **Forward-only.** `0001`/`0002`/`0003` không bị sửa; không có
-- down-migration. Sai thì **forward-fix**.

BEGIN;

-- ---------------------------------------------------------------------------
-- CHECK: `staff.sub` là Account ID đúng định dạng
-- ---------------------------------------------------------------------------
--
-- `sub` là **reference opaque** sang Account ID mà `account` cấp (§4.1) — không
-- FK xuyên database nên không có gì ở tầng DB bảo đảm nó là Account ID thật.
-- Trước migration này, `staff.sub` là `text` tự do: bất kỳ chuỗi nào cũng
-- qua được, kể cả chuỗi mang PII (`email@example.com`) — tức bảng staff thành
-- chỗ chứa dữ liệu không kiểm soát được, vi phạm tinh thần SR-014 (audit
-- không chứa PII) ở chính bảng định danh.
--
-- CHECK này khớp **đúng** định dạng mà `libs/backoffice-domain` chấp nhận
-- (`isBackofficeAccountId`): prefix `sub_` + 32 ký tự base32 viết thường
-- (`a`–`z`, `2`–`7`). Cùng một quy tắc ở hai tầng là điều kiện để tầng app
-- và tầng DB không lệch nhau — lệch là mọi `sub` thật bị từ chối ở một bên.
--
-- ⚠️ Biểu thức `~` của PostgreSQL là POSIX: `^` khớp đầu chuỗi, `$` khớp
-- cuối chuỗi — **không** khớp trước ký tự xuống dòng, nên một `sub` có
-- `\n` cuối vẫn bị từ chối (đã đo trên PostgreSQL 17, không suy đoán).
--
-- ⚠️ **Hành vi apply: FAIL-CLOSED, có chủ ý.** `ALTER TABLE … ADD CONSTRAINT …
-- CHECK` kiểm tra **các dòng đang tồn tại**: nếu môi trường đang có dữ liệu
-- vi phạm, migration **dừng** với lỗi `violates check constraint` thay vì
-- âm thầm bỏ qua hay tự sửa dữ liệu. Đây là lựa chọn có chủ ý: `db-backoffice`
-- chưa có dữ liệu production, và một guard chỉ áp cho dòng mới mà bỏ qua dòng
-- cũ sẽ để lại lỗ hổng đúng lúc dữ liệu bị đưa vào. Cố ý **không** dùng
-- `NOT VALID` (nó bỏ qua dòng cũ) và **không** tự UPDATE dữ liệu để "làm cho
-- apply pass" — dữ liệu vi phạm là sự cố operator phải xử lý, không phải thứ
-- migration tự quyết.
--
-- Pre-flight (chạy trước khi apply, bằng credential chỉ đọc):
--   SELECT count(*) FROM backoffice.staff
--    WHERE sub !~ '^sub_[a-z2-7]{32}$';
--
-- PostgreSQL không có `ADD CONSTRAINT IF NOT EXISTS` → guard bằng
-- `pg_catalog.pg_constraint`, cùng pattern như `0002_roles_and_grants.sql`.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint
     WHERE conrelid = 'backoffice.staff'::regclass
       AND conname = 'staff_sub_account_id_format_check'
  ) THEN
    ALTER TABLE backoffice.staff
      ADD CONSTRAINT staff_sub_account_id_format_check
      CHECK (sub ~ '^sub_[a-z2-7]{32}$');
  END IF;
END;
$$;

COMMENT ON CONSTRAINT staff_sub_account_id_format_check ON backoffice.staff IS
  'sub must be a well-formed Account ID: sub_ prefix + 32 lowercase base32 characters (a-z, 2-7) — matches isBackofficeAccountId in libs/backoffice-domain.';

-- ---------------------------------------------------------------------------
-- CHECK: độ dài `request_id`/`correlation_id` + định dạng `target_sub` của audit
-- ---------------------------------------------------------------------------
--
-- ⚠️ Ngưỡng **128** ở đây là CÙNG một con số với
-- `AUTHORIZATION_AUDIT_ID_MAX_LENGTH` ở `apps/backoffice/server/authorization-audit.ts`
-- (tầng app). Tầng app chặn trước khi ghi; CHECK này là lớp thứ hai chặn ở
-- tầng DB — một client khác (tool vận hành, script, hoặc code path khác ghi
-- audit) không đi qua tầng app vẫn bị chặn. Hai bên lệch con số là một bên
-- trở thành trang trí.
--
-- `char_length` đếm **ký tự**, khớp với `.length` của JS trên chuỗi ASCII
-- (mọi correlation id thật là ASCII). Với chuỗi đa byte, `char_length` đếm
-- ít hơn `String.length` của JS (một code point ngoài BMP = 2 đơn vị JS) —
-- CHECK ở đây là chặn trên ngoài, tầng app vẫn là chặn trong.
--
-- `target_sub` là Account ID mà operation tác động (`01` §4.6) — không phải
-- chuỗi tự do. Tầng app đã validate nó bằng `isBackofficeAccountId` ở
-- `writeAuditRow`, nhưng `recordPrivilegedSuccess` ghi thẳng giá trị đó xuống
-- DB: CHECK này là lớp chặn cuối cho đường đó. NULL vẫn được phép — audit của
-- một operation không tác động ai có `target_sub IS NULL` bình thường.
--
-- ⚠️ `actor_sub` **không** có CHECK ở đây: mọi đường ghi audit của tầng app
-- đều đã validate actor (`recordDecision`/`recordPrivilegedSuccess` ném
-- `TypeError` khi actor sai định dạng; `recordAuthorizationFailure` ghi NULL).
-- Thêm CHECK cho `actor_sub` là việc của migration sau, không gộp vào đây.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint
     WHERE conrelid = 'backoffice.authorization_audit'::regclass
       AND conname = 'authorization_audit_request_id_length_check'
  ) THEN
    ALTER TABLE backoffice.authorization_audit
      ADD CONSTRAINT authorization_audit_request_id_length_check
      CHECK (request_id IS NULL OR char_length(request_id) <= 128);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint
     WHERE conrelid = 'backoffice.authorization_audit'::regclass
       AND conname = 'authorization_audit_correlation_id_length_check'
  ) THEN
    ALTER TABLE backoffice.authorization_audit
      ADD CONSTRAINT authorization_audit_correlation_id_length_check
      CHECK (correlation_id IS NULL OR char_length(correlation_id) <= 128);
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint
     WHERE conrelid = 'backoffice.authorization_audit'::regclass
       AND conname = 'authorization_audit_target_sub_format_check'
  ) THEN
    ALTER TABLE backoffice.authorization_audit
      ADD CONSTRAINT authorization_audit_target_sub_format_check
      CHECK (target_sub IS NULL OR target_sub ~ '^sub_[a-z2-7]{32}$');
  END IF;
END;
$$;

COMMENT ON CONSTRAINT authorization_audit_request_id_length_check ON backoffice.authorization_audit IS
  'request_id is at most 128 characters — same threshold as AUTHORIZATION_AUDIT_ID_MAX_LENGTH at the app layer (apps/backoffice/server/authorization-audit.ts).';
COMMENT ON CONSTRAINT authorization_audit_correlation_id_length_check ON backoffice.authorization_audit IS
  'correlation_id is at most 128 characters — same threshold as AUTHORIZATION_AUDIT_ID_MAX_LENGTH at the app layer (apps/backoffice/server/authorization-audit.ts).';
COMMENT ON CONSTRAINT authorization_audit_target_sub_format_check ON backoffice.authorization_audit IS
  'target_sub is an Account ID (sub_ + 32 base32 characters) or NULL; blocks the audit from becoming a data-exfiltration channel (S2, SR-014).';

-- ---------------------------------------------------------------------------
-- Trigger: runtime role không được tự nâng quyền qua `role_assignments`
-- ---------------------------------------------------------------------------
--
-- Vấn đề gốc (finding S5 của security/RBAC adversarial review, issue #102):
-- `0002` cấp cho `ecoma_backoffice_runtime` `INSERT`/`UPDATE` trên
-- `role_assignments`, `INSERT`/`DELETE` trên `role_permissions` và
-- `INSERT` trên `staff`. Không có trigger/CHECK nào chặn, nên credential của
-- đường serving có đủ đường để tự cấp quyền cho chính nó — vi phạm trực tiếp
-- §7 ("Cấm: tự gán role, tự nâng quyền") và SR-005.
--
-- ⚠️ **Phân biệt migrator với runtime bằng `current_user`.** `current_user` là
-- role **đang có hiệu lực**, nên nó là đúng thứ cần so:
--   * Worker kết nối bằng credential thật của runtime → `current_user` =
--     `ecoma_backoffice_runtime`.
--   * `SET ROLE ecoma_backoffice_runtime` (đường `asRuntime()` của test
--     harness) → `current_user` = `ecoma_backoffice_runtime`, `session_user`
--     = superuser. Đã đo trên PostgreSQL 17.
--   * Migrator (bootstrap/seed) → `current_user` = `ecoma_backoffice_migrator`.
--   * Owner/admin (`ecoma_owner`, ADR-0001) — đường bootstrap/recovery của
--     ADR-0003 → `current_user` = `ecoma_owner`, **không** phải runtime.
--
-- Vì vậy guard ở đây **bỏ qua** mọi role ngoài runtime: đường bootstrap của
-- ADR-0003 (SQL/IaC bằng `ecoma_owner`) và đường seed của migrator vẫn chạy
-- được. Đây là điều kiện để file này không làm hỏng bootstrap — và nó được
-- kiểm chứng bằng test, không bằng lời bình luận.
--
-- ⚠️ Trigger function **không** phải `SECURITY DEFINER`: `SECURITY DEFINER` đổi
-- `current_user` thành chủ sở hữu function, tức guard sẽ tự tắt mình (role
-- sở hữu không phải runtime) — một cách tự lách rất dễ xảy ra khi ai đó thêm
-- `SECURITY DEFINER` để "đọc catalog với quyền cao hơn". `SECURITY INVOKER`
-- (mặc định) là thứ **phải** có ở đây.

CREATE OR REPLACE FUNCTION backoffice.role_assignments_no_self_elevation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Không phải runtime → không phải việc của guard này (migrator/owner).
  IF current_user::text <> 'ecoma_backoffice_runtime' THEN
    RETURN NEW;
  END IF;

  -- Runtime không được thay đổi `revoked_at`/`valid_until` trên một assignment
  -- đã tồn tại: un-revoke (SET revoked_at = NULL) và kéo dài hạn (SET
  -- valid_until = ...) là đường leo thang không có audit. Không có code path
  -- sản phẩm nào ghi `role_assignments` ở hiện tại, nên block toàn phần.
  IF TG_OP = 'UPDATE' AND (
        NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
     OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
  ) THEN
    RAISE EXCEPTION
      'role_assignments: runtime role khong duoc thay doi revoked_at/valid_until (un-revoke hoac keo dai han) — thao tac nay la governance action'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- (1) Không gán system-defined role.
  --
  -- `roles.is_system` là khai báo **domain** của "role này là system-defined"
  -- (ADR-0004), nên guard đọc cột đó chứ không đoán lại từ prefix `sys_`:
  -- nếu biconditional CHECK ở `0001` sau này được nới lỏng, guard vẫn giữ
  -- đúng nghĩa. Runtime có SELECT trên `backoffice.roles` (`0002`) nên đọc
  -- được mà không cần quyền nào thêm.
  --
  -- ⚠️ Đây là điều kiện **nặng nhất** của guard: vì ADR-0004 chốt giai đoạn
  -- này **chỉ có system-defined role**, chặn việc gán role system nghĩa là
  -- credential của đường serving **không gán được role nào cả**. Đó mới là
  -- điều kiện đóng được đường leo thang ở tầng credential. Khi ADR-0004 được
  -- kích hoạt lại (custom role), guard này **phải được xem lại** — xem mục
  -- "Giới hạn của guard này" ở cuối file.
  IF EXISTS (
    SELECT 1
      FROM backoffice.roles r
     WHERE r.id = NEW.role_id
       AND r.is_system
  ) THEN
    RAISE EXCEPTION
      'role_assignments: runtime role khong duoc gan system-defined role (is_system) — noi dung va viec gan role system la governance action (ADR-0004)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- (2) Actor phải được khai báo.
  --
  -- `created_by_sub` là actor của việc gán role (`0001`). Bắt buộc nó phải
  -- có mặt là điều kiện để điều kiện (4) **không bị lách**: nếu actor có thể
  -- bị bỏ trống thì "tự gán role cho chính mình" cũng bị bỏ qua theo.
  --
  -- Đây cũng là điều kiện của audit: SR-013 đòi mọi privileged operation có
  -- actor trong bản ghi; một assignment không có actor thì không truy vết
  -- được ai đã cấp quyền.
  IF NEW.created_by_sub IS NULL THEN
    RAISE EXCEPTION
      'role_assignments: runtime role phai khai bao actor (created_by_sub) de gan role duoc truy vet (SR-013)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- (3) Actor phải là Account ID đúng định dạng.
  IF NEW.created_by_sub !~ '^sub_[a-z2-7]{32}$' THEN
    RAISE EXCEPTION
      'role_assignments: created_by_sub phai la Account ID dung dinh dang (sub_ + 32 ky tu base32 viet thuong)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- (4) Cấm tự gán role cho chính mình — SR-005, T-01, AC-006.
  --
  -- Actor trong hàng là `created_by_sub`; "chính mình" là `staff_sub` trùng
  -- actor đó. Đây là biểu hiện ở tầng DB của lỗi ở tầng app "gán role cho
  -- chính mình": tầng app đi qua `requirePermission` thì đã chặn (SR-005),
  -- nhưng nếu một code path ghi thẳng xuống DB mà quên check, tầng DB là
  -- lớp chặn cuối.
  IF NEW.staff_sub = NEW.created_by_sub THEN
    RAISE EXCEPTION
      'role_assignments: runtime role khong duoc tu gan role cho chinh minh (SR-005, T-01)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION backoffice.role_assignments_no_self_elevation() IS
  'Blocks the runtime role from assigning roles to itself and from assigning system-defined roles; the actor (created_by_sub) must be declared and well-formed. Migrator/owner are not blocked (the ADR-0003 bootstrap path).';

-- Trigger bắt **cả** INSERT lẫn UPDATE của các cột mang ý nghĩa cấp quyền, và
-- cả UPDATE `revoked_at`/`valid_until` để runtime không tự un-revoke hay kéo
-- dài hạn assignment (F1). Migrator/owner đi qua được (current_user khác runtime).
--
-- ⚠️ `UPDATE OF staff_sub, role_id, created_by_sub, revoked_at, valid_until`
-- — danh sách cột này khiến trigger **không** chạy khi UPDATE chỉ đụng
-- `scope_label`/`created_at` (các cột không mang ý nghĩa cấp quyền). `scope_label`
-- là nhãn phạm vi v1 (§4.5) — thay đổi nhãn không đổi quyền, nên không cần guard.
-- Còn `revoked_at`/`valid_until` là hai trục thời gian hiệu lực (§4.6): runtime
-- không được tự un-revoke hay kéo dài hạn, nên phải qua guard.
DROP TRIGGER IF EXISTS role_assignments_no_self_elevation ON backoffice.role_assignments;
CREATE TRIGGER role_assignments_no_self_elevation
  BEFORE INSERT OR UPDATE OF staff_sub, role_id, created_by_sub, revoked_at, valid_until
  ON backoffice.role_assignments
  FOR EACH ROW
  EXECUTE FUNCTION backoffice.role_assignments_no_self_elevation();

-- ---------------------------------------------------------------------------
-- Expand: thêm cột actor cho `role_permissions`
-- ---------------------------------------------------------------------------
--
-- ⚠️ **Đây là một bước expand, không phải contract**: cột mới **NULLABLE** ở
-- tầng schema, và ràng buộc "runtime phải khai báo actor" được trigger bên
-- dưới thực thi — **không** phải `NOT NULL`. Lý do: `role_assignments` cũng
-- vậy (`created_by_sub text` nullable, `0001`), và đường governance (migrator /
-- owner compose role) không có actor từ hệ thống account để ghi vào — bắt
-- buộc `NOT NULL` ở tầng schema sẽ chặn nhầm chính bootstrap path.
--
-- ⚠️ `ADD COLUMN IF NOT EXISTS` **có** sẵn trong PostgreSQL (khác với
-- `ADD CONSTRAINT`, vốn không có) — nên bước expand này idempotent theo đúng
-- cách, không cần vòng `pg_catalog.pg_attribute`.
--
-- Vì sao cột này cần: một lần gắn permission mà không có actor thì **không
-- truy vết được ai đã cấp quyền** — đúng điều SR-013 đòi (mọi privileged
-- operation ghi audit đủ các trường, trong đó có actor). `role_permissions`
-- là một privileged operation, nên nó cũng cần actor. Cột này là nơi lưu actor
-- **cùng transaction** với việc gắn permission — audit ở tầng app ghi *sau*
-- write thành công, nên nó không thay được cột này.

ALTER TABLE backoffice.role_permissions
  ADD COLUMN IF NOT EXISTS created_by_sub text;

COMMENT ON COLUMN backoffice.role_permissions.created_by_sub IS
  'Actor that granted this permission (Account ID). Nullable at the schema layer so the governance path (migrator/owner) is not blocked; the trigger blocks the runtime when NULL.';

-- ---------------------------------------------------------------------------
-- Trigger: runtime role không được đổi nội dung role / gắn permission ngoài
-- catalog đang active
-- ---------------------------------------------------------------------------
--
-- Catalog là **sealed** (invariant 10, SR-020): `permissions` chỉ có SELECT cho
-- runtime (grant ở `0002`), INSERT/UPDATE là việc của seed migration chạy bằng
-- migrator. `0001` đã chặn việc **hồi sinh** một entry `retired` (UPDATE
-- status) — nhưng chưa chặn việc **gắn lại** một permission đã retired vào
-- một role. Đó là lỗ hổng của đường `role_permissions`.
--
-- Ba điều kiện, tất cả chỉ áp cho runtime:
--
--   (a) Permission phải `active` trong sealed catalog — permission `retired`
--       không được gắn lại (inventory 10 đã retire thì không quay lại).
--   (b) Role đích không phải system-defined role — ADR-0004: "thay đổi nội
--       dung role là một governance action có audit, **không** phải thao tác
--       runtime của admin". Runtime không compose role.
--   (c) Actor phải được khai báo và đúng định dạng — cùng lý do (SR-013)
--       như ở `role_assignments`; `role_permissions` không có cột actor nên
--       dùng `created_by_sub` của chính nó.
--
-- ⚠️ Trigger đọc catalog bằng **quyền của chính caller** (`SECURITY INVOKER`
-- — mặc định), không phải bằng `SECURITY DEFINER`: runtime đã có SELECT trên
-- `backoffice.permissions` và `backoffice.roles`, nên đọc được mà **không cần**
-- và không được cấp thêm quyền nào. `SECURITY DEFINER` ở đây vừa là nới quyền
-- không cần thiết vừa **làm hỏng** guard `role_assignments` bên trên (xem giải
-- thích ở đó: `current_user` trong một `SECURITY DEFINER` function là chủ sở
-- hữu function, không phải caller).
--
-- ⚠️ Guard này áp cho **runtime role**. Migrator/owner vẫn gắn được bất kỳ
-- permission nào trong catalog — đó là đường governance (compose role của
-- procedure quản trị), và việc chặn nó ở đây sẽ chặn nhầm bootstrap. Sự bất
-- đối xứng này là **có chủ ý**: `0001` đã chặn hồi sinh entry `retired` cho
-- **mọi** role, còn quy tắc ở đây bảo vệ đường serving.

CREATE OR REPLACE FUNCTION backoffice.role_permissions_governed_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  permission_status text;
BEGIN
  -- Không phải runtime → không phải việc của guard này (migrator/owner).
  IF current_user::text <> 'ecoma_backoffice_runtime' THEN
    RETURN NEW;
  END IF;

  -- (b) Không đổi nội dung của system-defined role (ADR-0004).
  --
  -- Runtime có SELECT trên `backoffice.roles` (`0002`) nên đọc được cột
  -- `is_system` bằng quyền của chính caller.
  IF EXISTS (
    SELECT 1
      FROM backoffice.roles r
     WHERE r.id = NEW.role_id
       AND r.is_system
  ) THEN
    RAISE EXCEPTION
      'role_permissions: runtime role khong duoc gan permission vao system-defined role — doi noi dung role la governance action (ADR-0004)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- (a) Permission phải `active` trong sealed catalog.
  --
  -- Đọc catalog bằng quyền của caller (runtime có SELECT trên
  -- `backoffice.permissions` — `0002`).
  SELECT p.status
    INTO permission_status
    FROM backoffice.permissions p
   WHERE p.id = NEW.permission_id;

  -- `IS DISTINCT FROM` để fail-closed: permission không tồn tại cũng là
  -- "không phải active" (FK sẽ chặn sau, nhưng guard không dựa vào thứ tự
  -- lỗi của FK).
  IF permission_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION
      'role_permissions: runtime role chi duoc gan permission dang active trong catalog; permission % khong active (status=%)',
      NEW.permission_id,
      coalesce(permission_status, 'khong ton tai')
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- (c) Actor phải được khai báo và đúng định dạng (SR-013).
  IF NEW.created_by_sub IS NULL THEN
    RAISE EXCEPTION
      'role_permissions: runtime role phai khai bao actor (created_by_sub) de gan permission duoc truy vet (SR-013)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.created_by_sub !~ '^sub_[a-z2-7]{32}$' THEN
    RAISE EXCEPTION
      'role_permissions: created_by_sub phai la Account ID dung dinh dang (sub_ + 32 ky tu base32 viet thuong)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION backoffice.role_permissions_governed_write() IS
  'The runtime role may grant only permissions with status active in the sealed catalog and never onto a system-defined role (ADR-0004); the actor must be declared. Reads with the caller''s privileges (the runtime has SELECT), not SECURITY DEFINER.';

-- `role_permissions` không có UPDATE cho runtime (đổi membership làm bằng
-- INSERT/DELETE — `0002`), nên guard INSERT chỉ cần BEFORE INSERT. DELETE đi
-- qua guard riêng bên dưới (BEFORE DELETE) — runtime không được gỡ permission
-- khỏi system-defined role, vì xoá permission là thay đổi nội dung role (F2).
DROP TRIGGER IF EXISTS role_permissions_governed_write ON backoffice.role_permissions;
CREATE TRIGGER role_permissions_governed_write
  BEFORE INSERT ON backoffice.role_permissions
  FOR EACH ROW
  EXECUTE FUNCTION backoffice.role_permissions_governed_write();

-- ---------------------------------------------------------------------------
-- Trigger: runtime role không được xoá permission khỏi system-defined role
-- ---------------------------------------------------------------------------
--
-- F2 (finding HIGH của adversarial review): runtime có `DELETE` trên
-- `role_permissions` (`0002:119`) và trigger trước đây chỉ bắt BEFORE INSERT,
-- nên runtime xoá được permission khỏi system-defined role — thay đổi nội dung
-- role là governance action có audit (ADR-0004). Đối xứng không cân bằng: guard
-- chặn thêm nhưng không chặn bớt.
--
-- Lựa chọn: block toàn phần DELETE trên system-defined role cho runtime. Với
-- role **không** system (custom role) thì runtime cũng không được DELETE — đồng
-- nhất với nguyên tắc "nội dung role là governance action", và không có code path
-- sản phẩm nào DELETE `role_permissions` ở hiện tại nên không có đường hợp lệ
-- bị chặn nhầm. Migrator/owner đi qua được (current_user khác runtime).
CREATE OR REPLACE FUNCTION backoffice.role_permissions_no_system_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Không phải runtime → không phải việc của guard này (migrator/owner).
  IF current_user::text <> 'ecoma_backoffice_runtime' THEN
    RETURN OLD;
  END IF;

  -- Runtime không được xoá permission khỏi system-defined role; và đồng nhất
  -- cho mọi role (nội dung role là governance action — ADR-0004).
  IF EXISTS (
    SELECT 1
      FROM backoffice.roles r
     WHERE r.id = OLD.role_id
       AND r.is_system
  ) THEN
    RAISE EXCEPTION
      'role_permissions: runtime role khong duoc xoa permission khoi system-defined role — doi noi dung role la governance action (ADR-0004)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Block toàn phần cho runtime trên mọi role (custom lẫn system): nội dung role
  -- là governance action, runtime không compose role.
  RAISE EXCEPTION
    'role_permissions: runtime role khong duoc xoa permission khoi role — doi noi dung role la governance action (ADR-0004)'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

COMMENT ON FUNCTION backoffice.role_permissions_no_system_delete() IS
  'Blocks the runtime role from removing permissions from a role (system-defined and custom) — changing role contents is a governance action (ADR-0004). Migrator/owner are not blocked.';

DROP TRIGGER IF EXISTS role_permissions_no_system_delete ON backoffice.role_permissions;
CREATE TRIGGER role_permissions_no_system_delete
  BEFORE DELETE ON backoffice.role_permissions
  FOR EACH ROW
  EXECUTE FUNCTION backoffice.role_permissions_no_system_delete();

-- ---------------------------------------------------------------------------
-- Giới hạn của guard này — đọc trước khi tưởng nó thay thế tầng app
-- ---------------------------------------------------------------------------
--
-- 1. **"Chính mình" ở tầng DB là `staff_sub = created_by_sub`** — tức danh
--    tính actor mà chính câu lệnh ghi xuống. Đây là **danh tính được khai
--    báo**, không phải danh tính được xác thực: credential runtime tạo được
--    staff row cho một `sub` bất kỳ (`staff` có INSERT cho runtime), nên một
--    actor giả vẫn lách được điều kiện (4). Vì vậy điều kiện (4) là **lớp
--    phòng thủ thứ hai cho lỗi ở tầng app**, còn việc xác thực actor là
--    việc của tầng app (token đã verify → `requirePermission` → SR-005).
--    Không có cách nào xác thực actor ở tầng DB: `db-backoffice` không có
--    quyền đọc `db-account` (không FK, không FDW, không truy vấn xuyên
--    database — §3 "Database trust").
--
-- 2. **"Không cấp vượt quá quyền mình có" (SR-005, câu còn lại) không kiểm
--    chứng được ở tầng DB**: tầng DB không biết credential nào đang chạy
--    ứng với staff nào (`current_user` là *role database*, không phải *staff
--    member*), nên không có cách nào biết "staff X có quyền Y" để so với
--    "role Z chứa Y". Việc này là của tầng app, và **không** được giả vờ là
--    đã làm ở đây.
--
-- 3. **Chặn system-defined role là điều kiện gắn với ADR-0004** ("giai đoạn
--    này chỉ có system-defined role"; custom role administration **không** bật).
--    Nếu/ khi custom role administration được bật lại, điều kiện (1) ở
--    `role_assignments` và (b) ở `role_permissions` **phải được xem lại** —
--    chúng sẽ chặn nhầm việc dùng custom role. Việc bật lại cần một ADR mới
--    theo `01` §10, không phải sửa file migration này.
--
-- 4. **Guard này không thay thế `requirePermission`** (workstream B) và không
--    thay thế audit ở tầng app: một denial ở tầng app vẫn phải được ghi
--    audit (SR-018). Guard DB chỉ đảm bảo rằng kể cả khi tầng app bị lỗi,
--    credential không đi được đến trạng thái leo thang.
--
-- 5. **Yêu cầu "assignment phải có audit row tương ứng" (gợi ý trong finding
--    S5 của issue #102) KHÔNG được hiện thực ở đây, và đây là quyết định có
--    chủ ý**: chưa có contract nào định nghĩa "audit row tương ứng" với một
--    assignment — không có operation id chung giữa `role_assignments` và
--    `authorization_audit`, và tầng app hiện ghi audit **sau** khi write thành
--    công (`recordPrivilegedSuccess`), nên một trigger BEFORE INSERT buộc phải
--    tìm thấy audit row trước khi write xảy ra là bất khả thi theo thứ tự
--    hiện tại. Bắt buộc nó ở đây sẽ **chặn nhầm** đường hợp lệ. Nếu muốn có
--    ràng buộc như vậy thì nó là một **contract** (operation id + thứ tự
--    ghi + transaction), thuộc phạm vi tầng app, không phải một CHECK của DB.

COMMIT;
