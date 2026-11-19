-- Fixture của suite integration: file này chứng minh GUC `ecoma.auth_database`
-- (hợp đồng của runner cũ, chuyển sang startup packet của kit qua
-- `kitConnectionDirectives`) thực sự hiện diện trong session migrate. Thiếu GUC
-- là fail tức thời — cùng hình fail-closed mà `0002_roles_and_grants.sql` thật
-- có khi GUC bị drop lặng lẽ.
DO $$
BEGIN
  IF coalesce(current_setting('ecoma.auth_database', true), '') = '' THEN
    RAISE EXCEPTION 'GUC ecoma.auth_database is missing from the migration session';
  END IF;
END
$$;
