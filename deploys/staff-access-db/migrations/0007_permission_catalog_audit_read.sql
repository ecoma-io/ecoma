-- 0007_permission_catalog_audit_read.sql — thêm permission `audit.read` vào catalog canonical.
--
-- Source of truth:
-- - docs/domains/staff-access/adr/0010-permission-naming-and-read-catalog.md
-- - docs/domains/staff-access/adr/0021-first-admin-bootstrap-path.md Quyết định 8.
-- - docs/domains/staff-access/adr/0024-trusted-bootstrap-verified-address.md Quyết định 5.
--
-- `audit.read` là permission của một route có thật (`apps/backoffice/server/api/audit.get.ts`)
-- nhưng trước file này chỉ tồn tại trong catalog di sản của `db-backoffice`. Đưa nó vào
-- catalog canonical bằng một seed migration mới, không sửa `0003` đã apply (ADR-0010).
--
-- Idempotent: đúng hình dạng `INSERT ... SELECT ... FROM (VALUES ...) WHERE NOT EXISTS
-- ... ON CONFLICT DO NOTHING` của `0003_permission_catalog_seed.sql`. Runner không có
-- ledger và chạy lại toàn bộ file mỗi lần apply, nên lần thứ hai phải là no-op.
--
-- Fail-loud thay vì im lặng chấp nhận một hàng đã tồn tại nhưng không dùng được:
--   * `id = 'audit.read'` đã `retired` → dừng. Trigger `permissions_retired_immutable`
--     chặn hồi sinh bằng UPDATE, nên "đã retired" là trạng thái không sửa tại chỗ;
--     đường đúng là một seed migration mới có review (ADR-0010), không phải bỏ qua.
--   * hàng `audit.read` mang `domain`/`action` khác — CHECK `id = domain || '.' || action`
--     khiến trạng thái này không biểu diễn được, nhưng vẫn kiểm tường minh: một hàng
--     lạ như vậy là lỗi provisioning, không phải "đã có".

BEGIN;

DO $$
DECLARE
  existing_domain text;
  existing_action text;
  existing_status text;
BEGIN
  SELECT p.domain, p.action, p.status
    INTO existing_domain, existing_action, existing_status
    FROM staff_access.permissions p
   WHERE p.id = 'audit.read';

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF existing_domain <> 'audit' OR existing_action <> 'read' THEN
    RAISE EXCEPTION
      'permissions: id audit.read exists with a different domain/action (domain=%, action=%); the canonical catalog was modified outside a seed migration',
      existing_domain, existing_action
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF existing_status <> 'active' THEN
    RAISE EXCEPTION
      'permissions: audit.read is in status "%"; retired is terminal, so restoring it requires a new reviewed seed migration (ADR-0010), not skipping it',
      existing_status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END;
$$;

INSERT INTO staff_access.permissions (id, domain, action, status)
SELECT v.id, v.domain, v.action, 'active'
FROM (VALUES
  ('audit.read', 'audit', 'read')
) AS v(id, domain, action)
WHERE NOT EXISTS (
  SELECT 1 FROM staff_access.permissions p WHERE p.id = v.id
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
