-- 0003_permission_catalog_seed.sql — seed catalog permission read cho backoffice.
--
-- Source of truth đã đọc trước khi viết:
--   * `docs/domains/staff-access/adr/0010-permission-naming-and-read-catalog.md`
--     (ADR-0010) — quy ước đặt tên `domain.action` dot-style và 3 permission read.
--   * `docs/domains/staff-access/domain-model.md` §4.3, §9 invariant 10:
--     catalog là nguồn sự thật duy nhất; thêm/đổi/bỏ permission là governance action
--     có audit (ADR từ git).
--   * `apps/backoffice/db/migrations/0001_backoffice_domain.sql` — schema
--     `backoffice.permissions` (PK `id`, UNIQUE (domain, action), status CHECK).
--   * `apps/backoffice/db/migrations/0002_roles_and_grants.sql` — runtime role chỉ
--     SELECT trên `permissions`; INSERT/UPDATE thuộc migrator.
--
-- ⚠️ Phạm vi ý định của file này — **chỉ seed permission**:
--   * INSERT 4 permission read: `staff.read`, `role.read`, `permission.read`,
--     `audit.read`, status `active`.
--   * KHÔNG INSERT role, role_permissions, role_assignments, staff. System-defined
--     role là quyết định riêng (ADR-0004), phải xuất phát từ catalog thực tế —
--     không phát minh ở đây.
--   * `audit.read` được thêm bởi P5.4 (issue #478): route `GET /api/audit/entries`
--     enforce `audit.read` qua `requirePermission`, cần row `active` trong catalog
--     để không bị deny lặng. Đây là permission route mới dùng, không phải surplus.
--   * KHÔNG thêm permission chưa được route nào dùng.
--
-- Idempotent + drift-proof:
--   * `WHERE NOT EXISTS (domain, action)` tự tài liệu hoá ý định: nếu slot
--     `(domain, action)` đã bị một row drift chiếm thì bỏ qua seed row đó,
--     không nhân bản và không overwrite drift row (không tự sửa dữ liệu).
--   * `ON CONFLICT DO NOTHING` (không target) bắt **mọi** unique violation
--     (PK `id` lẫn `UNIQUE (domain, action)`), nên re-apply không bao giờ ném
--     lỗi dù drift row cùng id hay cùng `(domain, action)`.
--   * Áp cho cả hai unique constraint của `backoffice.permissions` — xem
--     `0005_permission_catalog_integrity.sql` (CHECK `id = domain.action`).
-- Chạy bằng migrator (role khác runtime); runtime role vẫn chỉ SELECT được.

BEGIN;

INSERT INTO backoffice.permissions (id, domain, action, status)
SELECT v.id, v.domain, v.action, v.status
FROM (VALUES
  ('staff.read', 'staff', 'read', 'active'),
  ('role.read', 'role', 'read', 'active'),
  ('permission.read', 'permission', 'read', 'active'),
  ('audit.read', 'audit', 'read', 'active')
) AS v(id, domain, action, status)
WHERE NOT EXISTS (
  SELECT 1 FROM backoffice.permissions p
   WHERE p.domain = v.domain AND p.action = v.action
)
ON CONFLICT DO NOTHING;

COMMIT;
