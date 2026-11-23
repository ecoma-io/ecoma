-- 0011_bootstrap_write_guards.sql — guard ghi bootstrap của `db-account`.
--
-- Hai lỗ hổng quyền ghi mà A1/A2 dựa vào, và migration này chốt lại:
--
--  1. `ecoma_account_runtime` có INSERT trên `account.users` (`0002` dòng 118) —
--     runtime có thể tự tạo user, phá giả thiết "chỉ migrator/owner tạo user"
--     của A1 (một user được tạo bởi runtime khiến nhánh hội tụ của A1 có thể
--     mạo danh chủ sở hữu địa chỉ canonical).
--  2. `ecoma_account_runtime` có INSERT trên `account.security_events` (`0002`
--     dòng 122) — runtime có thể nói ra một sự kiện provenance
--     `bootstrap_account_provisioned` giả mạo, và A1 đếm sự kiện này để chứng
--     minh nguồn gốc nên có thể hội tụ lên một sub bị gian lận.
--
-- Hậu quả: sau migration này runtime giữ `SELECT`/`UPDATE` trên `account.users`
-- (đọc trạng thái account), **không** có `INSERT` (không tạo user), và runtime
-- không thể chèn sự kiện loại `bootstrap_account_provisioned` (chỉ migrator/
-- owner được ghi provenance bootstrap). Migrator/owner vẫn giữ quyền ghi cả hai
-- — đường CLI `db/bootstrap.mts` chạy bằng credential migrator.

BEGIN;

-- ---------------------------------------------------------------------------
-- A1-invariant: runtime KHÔNG được ghi `account.users`
-- ---------------------------------------------------------------------------

-- `0002` cấp SELECT, INSERT, UPDATE trên `account.users` cho runtime. SELECT và
-- UPDATE phải giữ (runtime đọc trạng thái account, cập nhật status...), nhưng
-- INSERT phải thu hồi: chỉ migrator/owner mới được tạo user, và A1 là đường ghi
-- duy nhất cho user đầu tiên. Không cấp DELETE (tombstone nhóm 1 giữ vĩnh viễn
-- sub, FR-001 / FR-012d).
REVOKE INSERT ON TABLE account.users FROM ecoma_account_runtime;

-- Khối assert fail-closed: chạy lại migration phải không làm gì nếu grant đã
-- bị thu hồi, và NÉM nếu vẫn còn. `REVOKE` trên bảng không xoá grant cấp theo
-- cột, nên kiểm cả cấp bảng và cấp cột — một cột còn INSERT là lỗ hổng còn lại.
DO $$
DECLARE
  table_insert boolean;
  col_insert boolean;
BEGIN
  table_insert := has_table_privilege('ecoma_account_runtime', 'account.users', 'INSERT');

  -- Kiểm grant INSERT theo từng cột của `account.users`: REVOKE bảng không tác
  -- động tới grant cấp cột, nên một cột còn INSERT là lỗ hổng còn lại.
  SELECT EXISTS (
    SELECT 1 FROM information_schema.column_privileges
    WHERE grantee = 'ecoma_account_runtime'
      AND table_catalog = current_database()
      AND table_schema = 'account'
      AND table_name = 'users'
      AND privilege_type = 'INSERT'
  ) INTO col_insert;

  IF table_insert OR col_insert THEN
    RAISE EXCEPTION
      'ecoma_account_runtime still holds INSERT on account.users (table=% or column=%); revoke failed — bootstrap write guard broken',
      table_insert, col_insert
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- A2-provenance: runtime KHÔNG được ghi sự kiện bootstrap_account_provisioned
-- ---------------------------------------------------------------------------

-- Hàm trigger chặn runtime chèn sự kiện loại được dành cho provenance bootstrap.
-- `current_user` trong trigger SECURITY INVOKER là principal thực thi — chính
-- credential runtime khi Worker gọi — không phải metadata do caller kiểm soát.
-- Không dùng SECURITY DEFINER (migrator không muốn bị bỏ qua kiểm tra), và không
-- đọc `metadata` do client cung cấp (dễ bị giả mạo). Migrator/owner (không phải
-- `ecoma_account_runtime`) vẫn được ghi sự kiện này — trigger chỉ từ chối khi
-- principal thực thi là runtime.
CREATE OR REPLACE FUNCTION account.security_events_reserve_bootstrap_type()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  IF NEW.type = 'bootstrap_account_provisioned' AND current_user = 'ecoma_account_runtime' THEN
    RAISE EXCEPTION
      'ecoma_account_runtime is not allowed to insert bootstrap_account_provisioned security events; bootstrap provenance is reserved to the migrator/owner principal'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS security_events_reserve_bootstrap_type ON account.security_events;
CREATE TRIGGER security_events_reserve_bootstrap_type
  BEFORE INSERT ON account.security_events
  FOR EACH ROW
  EXECUTE FUNCTION account.security_events_reserve_bootstrap_type();

COMMIT;
