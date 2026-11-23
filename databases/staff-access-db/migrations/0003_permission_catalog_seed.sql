-- 0003_permission_catalog_seed.sql — seed catalog permission read của Staff Access.
--
-- Source of truth: docs/domains/staff-access/adr/0010-permission-naming-and-read-catalog.md
-- (permission naming `<domain>.<action>`, read catalog exactly 3 permission).
--
-- Seed đúng 3 permission read:
--   * staff.read
--   * role.read
--   * permission.read
--
-- Idempotent: VALUES + WHERE NOT EXISTS + ON CONFLICT DO NOTHING.
-- Không seed role, không seed staff, không seed assignment.
-- ASCII-only; COMMENT ON tiếng Anh.

BEGIN;

INSERT INTO staff_access.permissions (id, domain, action, status)
SELECT v.id, v.domain, v.action, 'active'
FROM (VALUES
  ('staff.read', 'staff', 'read'),
  ('role.read', 'role', 'read'),
  ('permission.read', 'permission', 'read')
) AS v(id, domain, action)
WHERE NOT EXISTS (
  SELECT 1 FROM staff_access.permissions p WHERE p.id = v.id
)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE staff_access.permissions IS
  'Permission catalog — sealed: INSERT only via this seed migration run by the migrator; the runtime role cannot INSERT/UPDATE (0002). Unique (domain, action). id = domain.action.';

COMMIT;
