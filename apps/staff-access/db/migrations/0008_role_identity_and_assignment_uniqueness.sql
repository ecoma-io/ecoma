-- 0008_role_identity_and_assignment_uniqueness.sql — định danh canonical của system
-- administrator role, ràng buộc uniqueness của assignment, và seed role canonical.
--
-- Source of truth:
-- - docs/domains/staff-access/adr/0021-first-admin-bootstrap-path.md Quyết định 4, 5.
-- - docs/domains/staff-access/adr/0022-measured-first-admin-guard.md Quyết định 4, 5.
-- - docs/domains/staff-access/adr/0024-trusted-bootstrap-verified-address.md Quyết định 5.
--
-- File này làm đúng bốn việc, theo thứ tự:
--   1. UNIQUE `(kind, name)` trên `staff_access.roles` — để định danh canonical phân giải
--      được thành đúng một hàng (ADR-0022 Quyết định 4).
--   2. Partial unique index `(staff_id, role_id) WHERE revoked_at IS NULL` trên
--      `staff_access.role_assignments` — chống nhân bản assignment còn sống
--      (ADR-0021 Quyết định 5).
--   3. Seed đúng một role canonical `kind='system'`, `name='system-administrator'`,
--      `status='active'` với `id` cố định, cùng `role_permissions` của nó là đúng bốn
--      permission read (ADR-0024 Quyết định 5), và assertion rằng nội dung role không có
--      permission nào ngoài tập khai báo — bốn read ở đây cộng các literal mà seed
--      migration sau thêm vào `later_seed_permissions` (hiện tại: `invitation.create`
--      của `0010`, ADR-0033).
--   4. Assertion rằng catalog vẫn sealed: runtime role không có quyền ghi trên
--      `permissions` / `roles` / `role_permissions`.
--
-- ⚠️ Fail-loud, không tự sửa dữ liệu: file này **không** xoá, merge hay đổi id hàng nào.
-- Gặp dữ liệu vi phạm, nó dừng với thông báo nêu rõ hàng xung đột; người vận hành quyết
-- định, vì mỗi lựa chọn thay thế (xoá role, đổi id, gộp assignment) đều là thay đổi quyền
-- không có audit.
--
-- Idempotent: runner không có ledger và chạy lại mọi file mỗi lần apply. Constraint và
-- index được bảo vệ bằng catalog guard; seed dùng `ON CONFLICT DO NOTHING` trên `id` cố
-- định; các kiểm tra trước khi ghi là read-only nên lần chạy thứ hai đi qua sạch.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. UNIQUE (kind, name) trên roles
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  duplicate_list text;
  has_unique boolean;
BEGIN
  -- Đã có unique index/constraint không partial, không expression, đúng hai cột
  -- (kind, name)? Tên khác cũng chấp nhận: mục tiêu là ràng buộc, không phải tên.
  SELECT EXISTS (
    SELECT 1
      FROM (
        SELECT i.indexrelid,
               array_agg(a.attname::text ORDER BY a.attname::text) AS cols
          FROM pg_catalog.pg_index i
          JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_catalog.pg_attribute a
            ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey::int2[])
         WHERE n.nspname = 'staff_access'
           AND c.relname = 'roles'
           AND i.indisunique
           AND i.indpred IS NULL
           AND i.indexprs IS NULL
         GROUP BY i.indexrelid
      ) idx
     WHERE idx.cols = ARRAY['kind', 'name']
  ) INTO has_unique;

  IF has_unique THEN
    RETURN;
  END IF;

  -- Dữ liệu hiện có vi phạm? Nêu rõ cặp xung đột thay vì để ALTER TABLE ném lỗi chung.
  SELECT string_agg(format('(kind=%L, name=%L, rows=%s)', d.kind, d.name, d.rows), ', ')
    INTO duplicate_list
    FROM (
      SELECT kind, name, count(*) AS rows
        FROM staff_access.roles
       GROUP BY kind, name
      HAVING count(*) > 1
    ) d;

  IF duplicate_list IS NOT NULL THEN
    RAISE EXCEPTION
      'roles: cannot add UNIQUE (kind, name); duplicate identities already exist: %. Resolve them explicitly, this migration never deletes or merges roles.',
      duplicate_list
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  ALTER TABLE staff_access.roles
    ADD CONSTRAINT roles_kind_name_unique UNIQUE (kind, name);
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Partial unique index trên role_assignments còn sống — xác thực từ catalog
--
-- Chỉ kiểm "index theo tên tồn tại" là chưa đủ: một index trùng tên nhưng sai
-- bảng, không unique, sai cột, sai predicate hay có expression sẽ đi qua mà vẫn
-- không bảo vệ được S2. Index đã có thì mọi thuộc tính phải khớp yêu cầu, lấy từ
-- pg_index/pg_class/pg_namespace/pg_attribute/pg_am/pg_get_expr; lệch thuộc tính
-- nào → dừng với thông báo nêu rõ thuộc tính và giá trị thật. Không bao giờ DROP
-- hay thay thế index — thay index là thay đổi quyền, phải qua review.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_table_oid oid;
  v_index_oid oid;
  v_conflict_list text;
  v_is_unique boolean;
  v_is_valid boolean;
  v_is_ready boolean;
  v_indnkeyatts int;
  v_indnatts int;
  v_am_name text;
  v_predicate text;
  v_indexprs_is_null boolean;
  v_key_columns text;
  v_actual_table text;
  v_errors text[] := '{}';
BEGIN
  SELECT c.oid INTO v_table_oid
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'staff_access' AND c.relname = 'role_assignments';

  IF v_table_oid IS NULL THEN
    RAISE EXCEPTION
      'role_assignments: table staff_access.role_assignments does not exist; run 0001_staff_access_domain.sql first'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT i.indexrelid INTO v_index_oid
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'staff_access'
     AND c.relname = 'role_assignments_active_unique_idx';

  IF v_index_oid IS NULL THEN
    -- `WHERE revoked_at IS NULL` không biểu đạt "còn hiệu lực" (effective_until là
    -- read-time filter, và now() không dùng được trong index predicate) — đó là lý do
    -- procedure phải coi assignment hết hạn nhưng chưa revoked_at là fail-closed.
    SELECT string_agg(
             format('(staff_id=%s, role_id=%s, rows=%s)', d.staff_id, d.role_id, d.rows),
             ', '
           )
      INTO v_conflict_list
      FROM (
        SELECT staff_id, role_id, count(*) AS rows
          FROM staff_access.role_assignments
         WHERE revoked_at IS NULL
         GROUP BY staff_id, role_id
        HAVING count(*) > 1
      ) d;

    IF v_conflict_list IS NOT NULL THEN
      RAISE EXCEPTION
        'role_assignments: cannot add partial unique index (staff_id, role_id) WHERE revoked_at IS NULL; conflicting live rows already exist: %. Resolve them explicitly, this migration never deletes or merges assignments.',
        v_conflict_list
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    CREATE UNIQUE INDEX role_assignments_active_unique_idx
      ON staff_access.role_assignments (staff_id, role_id)
      WHERE revoked_at IS NULL;

    RETURN;
  END IF;

  -- Index đã tồn tại: xác thực từng thuộc tính từ catalog, không bao giờ DROP.
  SELECT i.indisunique, i.indisvalid, i.indisready, i.indnkeyatts, i.indnatts
    INTO v_is_unique, v_is_valid, v_is_ready, v_indnkeyatts, v_indnatts
    FROM pg_catalog.pg_index i
   WHERE i.indexrelid = v_index_oid;

  SELECT am.amname INTO v_am_name
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_catalog.pg_am am ON am.oid = ic.relam
   WHERE i.indexrelid = v_index_oid;

  -- Predicate: chuẩn hoá (lowercase + gọn khoảng trắng + bỏ ngoặc bọc) rồi so với
  -- chuỗi canonical. Dùng [[:space:]] vì ERE của PostgreSQL không hỗ trợ \s.
  SELECT replace(
           replace(
             regexp_replace(
               lower(coalesce(pg_get_expr(i.indpred, i.indrelid), '')),
               '[[:space:]]+', ' ', 'g'
             ),
             '(', ''
           ),
           ')', ''
         )
    INTO v_predicate
    FROM pg_catalog.pg_index i
   WHERE i.indexrelid = v_index_oid;

  SELECT pg_get_expr(i.indexprs, i.indrelid) IS NULL INTO v_indexprs_is_null
    FROM pg_catalog.pg_index i
   WHERE i.indexrelid = v_index_oid;

  -- Tên cột khoá theo đúng thứ tự indkey (không suy từ tên index).
  SELECT array_agg(a.attname::text ORDER BY k.ord)::text INTO v_key_columns
    FROM unnest((SELECT i.indkey FROM pg_catalog.pg_index i WHERE i.indexrelid = v_index_oid))
      WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid = (SELECT i.indrelid FROM pg_catalog.pg_index i WHERE i.indexrelid = v_index_oid)
     AND a.attnum = k.attnum;

  SELECT c.relname INTO v_actual_table
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
   WHERE i.indexrelid = v_index_oid;

  IF v_actual_table <> 'role_assignments' THEN
    v_errors := array_append(v_errors, format('table = %s, expected role_assignments', v_actual_table));
  END IF;
  IF v_am_name <> 'btree' THEN
    v_errors := array_append(v_errors, format('access method = %s, expected btree', v_am_name));
  END IF;
  IF NOT v_is_unique THEN
    v_errors := array_append(v_errors, 'indisunique = false, expected true');
  END IF;
  IF NOT v_is_valid THEN
    v_errors := array_append(v_errors, 'indisvalid = false, expected true');
  END IF;
  IF NOT v_is_ready THEN
    v_errors := array_append(v_errors, 'indisready = false, expected true');
  END IF;
  IF v_indnkeyatts <> 2 THEN
    v_errors := array_append(v_errors, format('indnkeyatts = %s, expected 2', v_indnkeyatts));
  END IF;
  IF v_indnatts <> 2 THEN
    v_errors := array_append(v_errors, format('indnatts = %s, expected 2', v_indnatts));
  END IF;
  IF v_key_columns <> '{staff_id,role_id}' THEN
    v_errors := array_append(v_errors, format('key columns = %s, expected {staff_id,role_id}', v_key_columns));
  END IF;
  IF NOT v_indexprs_is_null THEN
    v_errors := array_append(v_errors, 'indexprs is not null, expected null (no expressions)');
  END IF;
  IF v_predicate <> 'revoked_at is null' THEN
    v_errors := array_append(v_errors, format('predicate = %s, expected revoked_at is null', v_predicate));
  END IF;

  IF array_length(v_errors, 1) > 0 THEN
    RAISE EXCEPTION
      'role_assignments_active_unique_idx does not match required catalog properties: %; this migration never drops or replaces an index - resolve it explicitly',
      array_to_string(v_errors, '; ')
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Seed canonical system administrator role + four read permissions
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  -- UUID literal là canonical theo ADR-0024 Quyết định 5 (định danh cố định
  -- `kind='system'`, `name='system-administrator'`, seed idempotent bằng `id`
  -- cố định); giá trị literal do chính migration này định nghĩa và được
  -- `0010` tham chiếu (ADR-0033 Quyết định 2). Hardcode là chủ đích.
  canonical_role_id constant uuid := 'eeb3abcb-31ef-479f-9dd1-198a9d520b1b';
  canonical_kind constant text := 'system';
  canonical_name constant text := 'system-administrator';
  -- Seed của chính file này: role phải có đủ bốn permission read ngay sau khi
  -- `0008` chạy, nên đây cũng là tập được kiểm "phải tồn tại và active".
  expected_permissions constant text[] := ARRAY[
    'audit.read',
    'permission.read',
    'role.read',
    'staff.read'
  ];
  -- Permission mà seed migration **sau** cấp thêm cho cùng role canonical. Mỗi
  -- seed grant mới phải thêm literal của nó vào đây (và ghi ADR tương ứng):
  -- assertion "sealed set" bên dưới so với hợp của hai mảng, nên một literal
  -- không khai báo ở đây làm lần apply kế tiếp dừng — đó là chủ đích.
  --   * `invitation.create` — `0010`, ADR-0033 Quyết định 1–2.
  later_seed_permissions constant text[] := ARRAY[
    'invitation.create'
  ];
  declared_permissions constant text[] := expected_permissions || later_seed_permissions;
  conflicting_id uuid;
  conflicting_status text;
  missing_permissions text;
  actual_permissions text[];
  extra_permissions text[];
BEGIN
  -- Cùng (kind, name) nhưng id khác: seed không được chọn hộ hàng nào là canonical.
  SELECT r.id
    INTO conflicting_id
    FROM staff_access.roles r
   WHERE r.kind = canonical_kind
     AND r.name = canonical_name
     AND r.id <> canonical_role_id
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'roles: a role with kind=% name=% already exists with id % (canonical id is %); refusing to seed a second identity',
      canonical_kind, canonical_name, conflicting_id, canonical_role_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Cùng id nhưng khác danh tính: id cố định đã bị dùng cho hàng khác.
  SELECT r.status
    INTO conflicting_status
    FROM staff_access.roles r
   WHERE r.id = canonical_role_id
     AND (r.kind <> canonical_kind OR r.name <> canonical_name);

  IF FOUND THEN
    RAISE EXCEPTION
      'roles: id % is reserved for the canonical system administrator role but is already used by a different role (status=%)',
      canonical_role_id, conflicting_status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  INSERT INTO staff_access.roles (id, name, kind, status)
  VALUES (canonical_role_id, canonical_name, canonical_kind, 'active')
  ON CONFLICT (id) DO NOTHING;

  -- Role đã tồn tại nhưng bị retired: không hồi sinh im lặng.
  SELECT r.status
    INTO conflicting_status
    FROM staff_access.roles r
   WHERE r.id = canonical_role_id
     AND r.status <> 'active';

  IF FOUND THEN
    RAISE EXCEPTION
      'roles: canonical system administrator role (%) is in status "%"; restoring it requires a reviewed seed migration, not a silent update',
      canonical_role_id, conflicting_status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Bốn permission phải tồn tại và active trước khi gắn.
  SELECT string_agg(p.id, ', ' ORDER BY p.id)
    INTO missing_permissions
    FROM unnest(expected_permissions) AS p(id)
   WHERE NOT EXISTS (
     SELECT 1
       FROM staff_access.permissions perm
      WHERE perm.id = p.id
        AND perm.status = 'active'
   );

  IF missing_permissions IS NOT NULL THEN
    RAISE EXCEPTION
      'role_permissions: canonical role requires active permissions that are missing: %',
      missing_permissions
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  INSERT INTO staff_access.role_permissions (role_id, permission_id)
  SELECT canonical_role_id, p.id
    FROM unnest(expected_permissions) AS p(id)
  ON CONFLICT (role_id, permission_id) DO NOTHING;

  -- Nội dung role là sealed data: một permission thừa nghĩa là role đã bị sửa ngoài
  -- seed migration, và im lặng chấp nhận sẽ cấp quyền mà ADR chưa chốt. Tập khai báo
  -- là bốn read của file này cộng các literal mà seed migration sau thêm.
  SELECT array_agg(rp.permission_id::text ORDER BY rp.permission_id::text)
    INTO actual_permissions
    FROM staff_access.role_permissions rp
   WHERE rp.role_id = canonical_role_id;

  SELECT array_agg(p.id ORDER BY p.id)
    INTO extra_permissions
    FROM unnest(actual_permissions) AS p(id)
   WHERE p.id <> ALL (declared_permissions);

  IF extra_permissions IS NOT NULL THEN
    RAISE EXCEPTION
      'role_permissions: canonical system administrator role has permissions outside the sealed set: % (declared exactly %)',
      array_to_string(extra_permissions, ', '), array_to_string(declared_permissions, ', ')
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Catalog vẫn sealed: assertion, không cấp thêm grant
-- ---------------------------------------------------------------------------
--
-- `0002_roles_and_grants.sql` đã REVOKE INSERT/UPDATE/DELETE trên ba bảng catalog
-- khỏi runtime role, và file này không tạo grant nào mới — seed chạy bằng migrator.
-- Assertion giữ cho một grant lọt vào sau này không đi qua mà không ai thấy.

DO $$
DECLARE
  v_table text;
  v_priv text;
  v_errors text[] := '{}';
BEGIN
  FOR v_table, v_priv IN (
    SELECT * FROM (VALUES
      ('roles', 'INSERT'),
      ('roles', 'UPDATE'),
      ('roles', 'DELETE'),
      ('permissions', 'INSERT'),
      ('permissions', 'UPDATE'),
      ('permissions', 'DELETE'),
      ('role_permissions', 'INSERT'),
      ('role_permissions', 'UPDATE'),
      ('role_permissions', 'DELETE')
    ) AS t(table_name, priv)
  ) LOOP
    IF has_table_privilege('ecoma_staff_access_runtime', 'staff_access.' || v_table, v_priv) THEN
      v_errors := array_append(
        v_errors,
        format('runtime has %s on staff_access.%s', v_priv, v_table)
      );
    END IF;
  END LOOP;

  IF array_length(v_errors, 1) > 0 THEN
    RAISE EXCEPTION
      'catalog: ecoma_staff_access_runtime holds write privilege on a sealed catalog table (%); the permission/role catalog must stay migrator-only',
      array_to_string(v_errors, '; ')
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END;
$$;

COMMIT;
