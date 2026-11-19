-- 0010_permission_catalog_invitation_create.sql — thêm permission `invitation.create` vào
-- catalog canonical và cấp nó cho role canonical `system-administrator`.
--
-- Source of truth:
-- - docs/domains/staff-access/adr/0033-permission-verdict-contract.md Quyết định 1, 2.
-- - docs/domains/account/adr/0030-account-creation-channel-invitation.md Quyết định 3.
-- - ADR-0010: permission mới đi qua **seed migration mới**, không sửa `0003`/`0007` đã apply.
-- - ADR-0021 Quyết định 4 + ADR-0024 Quyết định 5: định danh canonical của role
--   (`kind='system'`, `name='system-administrator'`, `id` cố định).
--
-- Hai việc, theo thứ tự:
--   1. Insert `invitation.create` (`domain='invitation'`, `action='create'`) vào
--      `staff_access.permissions`, status `active`.
--   2. Gắn nó vào role canonical — administrator đầu tiên (bootstrap) và mọi staff được
--      bổ nhiệm vào role đó giữ được quyền phát lời mời.
--
-- Idempotent: đúng hình `INSERT ... SELECT ... FROM (VALUES ...) WHERE NOT EXISTS ...
-- ON CONFLICT DO NOTHING` của `0003`/`0007`. Runner không có ledger và chạy lại toàn bộ
-- file mỗi lần apply, nên lần thứ hai phải là no-op — kể cả grant.
--
-- Fail-loud thay vì im lặng chấp nhận một hàng không dùng được:
--   * hàng `invitation.create` đã tồn tại nhưng `domain`/`action` khác — CHECK
--     `id = domain || '.' || action` khiến trạng thái này không biểu diễn được, nhưng
--     vẫn kiểm tường minh: đó là lỗi provisioning, không phải "đã có".
--   * hàng đã `retired` → dừng. Trigger `permissions_retired_immutable` chặn hồi sinh
--     bằng UPDATE; retired là terminal (ADR-0010), đường đúng là seed migration mới có
--     review.
--   * role canonical vắng, không `active`, hay `id` cố định đã bị hàng khác dùng → dừng.
--     File này **không** tạo role: định danh role canonical thuộc `0008` (ADR-0024), và
--     tạo lại nó ở đây là mở đường thứ hai cho cùng một định danh.
--
-- ⚠️ Nội dung role canonical được assertion "sealed set" ở `0008`; `0008` khai báo
-- `invitation.create` trong `later_seed_permissions`. Mọi seed grant mới cho role này
-- (ví dụ ba quyền ghi của #44) phải thêm literal của nó vào mảng đó trong `0008` và ghi
-- ADR tương ứng — nếu không, lần apply kế tiếp sẽ dừng ở `0008`.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Permission `invitation.create`
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  existing_domain text;
  existing_action text;
  existing_status text;
BEGIN
  SELECT p.domain, p.action, p.status
    INTO existing_domain, existing_action, existing_status
    FROM staff_access.permissions p
   WHERE p.id = 'invitation.create';

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF existing_domain <> 'invitation' OR existing_action <> 'create' THEN
    RAISE EXCEPTION
      'permissions: id invitation.create exists with a different domain/action (domain=%, action=%); the canonical catalog was modified outside a seed migration',
      existing_domain, existing_action
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF existing_status <> 'active' THEN
    RAISE EXCEPTION
      'permissions: invitation.create is in status "%"; retired is terminal, so restoring it requires a new reviewed seed migration (ADR-0010), not skipping it',
      existing_status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END;
$$;

INSERT INTO staff_access.permissions (id, domain, action, status)
SELECT v.id, v.domain, v.action, 'active'
FROM (VALUES
  ('invitation.create', 'invitation', 'create')
) AS v(id, domain, action)
WHERE NOT EXISTS (
  SELECT 1 FROM staff_access.permissions p WHERE p.id = v.id
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Grant cho role canonical `system-administrator`
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
WHERE p.id = 'invitation.create'
  AND p.status = 'active'
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMIT;
