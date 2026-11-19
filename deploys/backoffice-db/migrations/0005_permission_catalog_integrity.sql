-- 0005_permission_catalog_integrity.sql — enforce đặt tên id permission + integrity
-- của catalog seed.
--
-- Source of truth đã đọc trước khi viết:
--   * `docs/domains/staff-access/adr/0010-permission-naming-and-read-catalog.md`
--     (ADR-0010) — `id` của một permission = đúng chuỗi `<domain>.<action>`.
--   * `apps/backoffice/db/migrations/0001_backoffice_domain.sql` — schema
--     `backoffice.permissions` (PK `id`, UNIQUE (domain, action), status CHECK).
--   * `apps/backoffice/db/migrations/0003_permission_catalog_seed.sql` — seed 3
--     permission read `staff.read`, `role.read`, `permission.read`.
--   * `apps/backoffice/db/migrations/0004_self_elevation_guard.sql` — pattern
--     DO guard `pg_catalog.pg_constraint` + fail-closed.
--
-- ⚠️ Phạm vi ý định của file này:
--   * Thêm CHECK `permissions_id_matches_domain_action`: `id = domain || '.' || action`.
--   * Guard idempotent bằng `pg_catalog.pg_constraint`, như `0004`.
--   * Pre-flight fail-closed: nếu có row vi phạm, migration dừng với lỗi rõ ràng;
--     không dùng `NOT VALID`, không tự sửa dữ liệu.
--   * KHÔNG cấp/thu quyền runtime (invariant 11). KHÔNG INSERT/UPDATE catalog:
--     seed là việc của `0003`.
--   * Forward-only, không down-migration.

BEGIN;

-- ---------------------------------------------------------------------------
-- Pre-flight: fail-closed nếu có row vi phạm CHECK mới
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM backoffice.permissions
     WHERE id <> domain || '.' || action
  ) THEN
    RAISE EXCEPTION
      'permissions: co row vi pham CHECK permissions_id_matches_domain_action '
      '(id <> domain || ''.'' || action); khong tu sua du lieu, operator phai xu ly';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- CHECK: `id = domain || '.' || action`
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint
     WHERE conrelid = 'backoffice.permissions'::regclass
       AND conname = 'permissions_id_matches_domain_action'
  ) THEN
    ALTER TABLE backoffice.permissions
      ADD CONSTRAINT permissions_id_matches_domain_action
      CHECK (id = domain || '.' || action);
  END IF;
END;
$$;

COMMENT ON CONSTRAINT permissions_id_matches_domain_action ON backoffice.permissions IS
  'A permission''s id must equal exactly domain.action (ADR-0010); blocks catalog rows whose id disagrees with their own domain/action.';

COMMIT;
