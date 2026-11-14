-- 0011_permission_catalog_write_actions.sql — thêm ba permission ghi của bổ nhiệm
-- thường vào catalog canonical và cấp chúng cho role canonical `system-administrator`.
--
-- Source of truth:
-- - docs/domains/staff-access/adr/0034-write-permissions-role-assign-revoke-staff-create.md
--   Quyết định 1, 2 (supersede-in-part ADR-0023 Quyết định 2 vế "chưa chốt").
-- - docs/domains/staff-access/adr/0023-administrator-lifecycle-paths.md Quyết định 2.
-- - ADR-0010: permission mới đi qua **seed migration mới**, không sửa `0003`/`0007`/
--   `0010` đã apply.
-- - ADR-0033 Quyết định 2 + ADR-0021 Quyết định 4 + ADR-0024 Quyết định 5: định danh
--   canonical của role (`kind='system'`, `name='system-administrator'`, `id` cố định).
--
-- Ba việc, theo thứ tự:
--   1. Insert `role.assign`, `role.revoke`, `staff.create` vào `staff_access.permissions`,
--      status `active` — đúng hình `domain.action` của ADR-0010.
--   2. Gắn cả ba vào role canonical — người giữ canonical administrator role (bootstrap
--      administrator đầu tiên và mọi staff được bổ nhiệm vào role đó) được bổ nhiệm,
--      thu hồi role và tạo staff identity.
--
-- Idempotent: đúng hình `INSERT ... SELECT ... FROM (VALUES ...) WHERE NOT EXISTS ...
-- ON CONFLICT DO NOTHING` của `0003`/`0007`/`0010`. Runner không có ledger và chạy lại
-- toàn bộ file mỗi lần apply, nên lần thứ hai phải là no-op — kể cả grant.
--
-- Fail-loud thay vì im lặng chấp nhận một hàng không dùng được:
--   * hàng literal đã tồn tại nhưng `domain`/`action` khác — CHECK
--     `id = domain || '.' || action` khiến trạng thái này không biểu diễn được, nhưng
--     vẫn kiểm tường minh: đó là lỗi provisioning, không phải "đã có".
--   * hàng đã `retired` → dừng. Trigger `permissions_retired_immutable` chặn hồi sinh
--     bằng UPDATE; retired là terminal (ADR-0010), đường đúng là seed migration mới có
--     review.
--   * role canonical vắng, không `active`, hay `id` cố định đã bị hàng khác dùng → dừng.
--     File này **không** tạo role: định danh role canonical thuộc `0008` (ADR-0024), và
--     tạo lại nó ở đây là mở đường thứ hai cho cùng một định danh.
--
-- ⚠️ Nội dung role canonical được assertion "sealed set" ở `0008`; `0008` khai báo cả ba
-- literal này trong `later_seed_permissions` (ADR-0034 Quyết định 3). Mọi seed grant mới
-- cho role này sau 0011 phải thêm literal của nó vào mảng đó trong `0008` và ghi ADR
-- tương ứng — nếu không, lần apply kế tiếp sẽ dừng ở `0008`.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Ba permission ghi: role.assign, role.revoke, staff.create
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  existing_domain text;
  existing_action text;
  existing_status text;
  literal text;
  expected_domain text;
  expected_action text;
BEGIN
  -- Mỗi literal một vòng kiểm tường minh: thông báo nêu đúng literal nào lệch, thay
  -- vì một lỗi gộp khiến người vận hành không biết hàng nào provisioning sai.
  FOR literal, expected_domain, expected_action IN
    SELECT * FROM (VALUES
      ('role.assign', 'role', 'assign'),
      ('role.revoke', 'role', 'revoke'),
      ('staff.create', 'staff', 'create')
    ) AS v(id, domain, action)
  LOOP
    SELECT p.domain, p.action, p.status
      INTO existing_domain, existing_action, existing_status
      FROM staff_access.permissions p
     WHERE p.id = literal;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    IF existing_domain <> expected_domain OR existing_action <> expected_action THEN
      RAISE EXCEPTION
        'permissions: id % exists with a different domain/action (domain=%, action=%); the canonical catalog was modified outside a seed migration',
        literal, existing_domain, existing_action
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF existing_status <> 'active' THEN
      RAISE EXCEPTION
        'permissions: % is in status "%"; retired is terminal, so restoring it requires a new reviewed seed migration (ADR-0010), not skipping it',
        literal, existing_status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END LOOP;
END;
$$;

INSERT INTO staff_access.permissions (id, domain, action, status)
SELECT v.id, v.domain, v.action, 'active'
FROM (VALUES
  ('role.assign', 'role', 'assign'),
  ('role.revoke', 'role', 'revoke'),
  ('staff.create', 'staff', 'create')
) AS v(id, domain, action)
WHERE NOT EXISTS (
  SELECT 1 FROM staff_access.permissions p WHERE p.id = v.id
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Grant cả ba cho role canonical `system-administrator`
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  canonical_role_id constant uuid := 'eeb3abcb-31ef-479f-9dd1-198a9d520b1b';
  canonical_kind constant text := 'system';
  canonical_name constant text := 'system-administrator';
  conflicting_kind text;
  conflicting_name text;
  conflicting_status text;
BEGIN
  -- Cùng id nhưng khác danh tính: id cố định đã bị dùng cho hàng khác.
  SELECT r.kind, r.name, r.status
    INTO conflicting_kind, conflicting_name, conflicting_status
    FROM staff_access.roles r
   WHERE r.id = canonical_role_id
     AND (r.kind <> canonical_kind OR r.name <> canonical_name);

  IF FOUND THEN
    RAISE EXCEPTION
      'roles: id % is reserved for the canonical system administrator role but is already used by a different role (kind=%, name=%, status=%)',
      canonical_role_id, conflicting_kind, conflicting_name, conflicting_status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Role canonical phải tồn tại và active: file này không tạo role.
  SELECT r.status
    INTO conflicting_status
    FROM staff_access.roles r
   WHERE r.id = canonical_role_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'roles: canonical system administrator role (%) is missing; run 0008_role_identity_and_assignment_uniqueness.sql first',
      canonical_role_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF conflicting_status <> 'active' THEN
    RAISE EXCEPTION
      'roles: canonical system administrator role (%) is in status "%"; granting a new permission to a retired role is not a repair',
      canonical_role_id, conflicting_status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END;
$$;

INSERT INTO staff_access.role_permissions (role_id, permission_id)
SELECT 'eeb3abcb-31ef-479f-9dd1-198a9d520b1b', p.id
FROM staff_access.permissions p
WHERE p.id IN ('role.assign', 'role.revoke', 'staff.create')
  AND p.status = 'active'
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMIT;
