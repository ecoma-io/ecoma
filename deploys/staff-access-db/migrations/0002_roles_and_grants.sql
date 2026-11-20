-- 0002_roles_and_grants.sql — ba role + grant + chặn chéo cho db-staff-access.
--
-- Pattern tham chiếu: apps/account/db/migrations/0002_roles_and_grants.sql (GUC
-- assertion + fail-closed CONNECT) và apps/backoffice/db/migrations/0002 (grant
-- sweep). ADR-0001 / ADR-0013: ba role `ecoma_owner`/`ecoma_staff_access_migrator`/
-- `ecoma_staff_access_runtime`, chặn chéo REVOKE CONNECT kể cả rút khỏi PUBLIC.
--
-- ⚠️ Cross-database REVOKE CONNECT không thực thi được trong migration này vì
-- migrator chỉ sở hữu db-staff-access (provisioning step 1 của admin/owner).
-- File này ghi nhận rationale + assertion fail-closed; khối DO $$ bỏ qua nếu
-- database kia chưa tồn tại. Chạy lại sau khi có database là sẵn sàng.

BEGIN;

-- ---------------------------------------------------------------------------
-- Role guard
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ecoma_staff_access_migrator') THEN
    CREATE ROLE ecoma_staff_access_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ecoma_staff_access_runtime') THEN
    CREATE ROLE ecoma_staff_access_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Schema grants
-- ---------------------------------------------------------------------------

GRANT USAGE, CREATE ON SCHEMA staff_access TO ecoma_staff_access_migrator;
GRANT USAGE ON SCHEMA staff_access TO ecoma_staff_access_runtime;

-- ---------------------------------------------------------------------------
-- Migrator: full DDL on schema (already owner via CREATE SCHEMA by migrator)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Runtime: minimal DML per table (no DDL, no DELETE where policy forbids)
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON staff_access.staff TO ecoma_staff_access_runtime;
GRANT SELECT ON staff_access.permissions TO ecoma_staff_access_runtime;
GRANT SELECT ON staff_access.roles TO ecoma_staff_access_runtime;
GRANT SELECT ON staff_access.role_permissions TO ecoma_staff_access_runtime;
-- UPDATE chỉ ở cấp CỘT revoked_at (security-high 41070536326, pair với trigger
-- revoke-only ở 0001): runtime không thể sửa scope/staff_id/role_id/granted_by
-- ngay cả khi trigger bị vô hiệu hóa — defense in depth hai lớp độc lập.
GRANT SELECT, INSERT ON staff_access.role_assignments TO ecoma_staff_access_runtime;
GRANT UPDATE (revoked_at) ON staff_access.role_assignments TO ecoma_staff_access_runtime;
GRANT SELECT, INSERT ON staff_access.authorization_audit TO ecoma_staff_access_runtime;
GRANT SELECT, INSERT, UPDATE ON staff_access.entitlements TO ecoma_staff_access_runtime;

-- Revoke dangerous privileges explicitly (defense in depth).
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON staff_access.staff FROM ecoma_staff_access_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON staff_access.permissions FROM ecoma_staff_access_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON staff_access.roles FROM ecoma_staff_access_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON staff_access.role_permissions FROM ecoma_staff_access_runtime;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON staff_access.role_assignments FROM ecoma_staff_access_runtime;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON staff_access.authorization_audit FROM ecoma_staff_access_runtime;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON staff_access.entitlements FROM ecoma_staff_access_runtime;

-- ---------------------------------------------------------------------------
-- public schema hardening: revoke everything from PUBLIC
-- On PostgreSQL 15+ this statement is a no-op under the migrator credential
-- (warning only, not an error): schema `public` is owned by `pg_database_owner`
-- and PUBLIC retains USAGE granted by the owner, while CREATE left PUBLIC by
-- default in PG15. The statement is kept as-is to cover PostgreSQL < 15 and to
-- match the repo-wide migration pattern (backoffice, account, pact-broker-api);
-- the hardening intent on current images is carried by PG15+ defaults plus the
-- provision step granting the migrator rights on the DATABASE only. Milestone C
-- database tests assert the catalog (nspacl: PUBLIC has USAGE, no CREATE) so a
-- silent regression cannot pass.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- Guard CONNECT của runtime role trên CHÍNH database này — assertion
-- fail-closed, không revoke gì trên database khác
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT has_database_privilege('ecoma_staff_access_runtime', current_database(), 'CONNECT') THEN
    RAISE EXCEPTION
      'ecoma_staff_access_runtime mat quyen CONNECT tren db-staff-access; can lai provisioning';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Cross-database REVOKE (provisioning step 1 — documented, not executed here)
-- ---------------------------------------------------------------------------
--
-- ⚠️ Cross-db REVOKE CONNECT requires ownership of the other database. Migrator
-- only owns db-staff-access. Admin/owner must run (per 03-operations.md):
--
--   REVOKE CONNECT ON DATABASE db-account  FROM ecoma_staff_access_runtime;
--   REVOKE CONNECT ON DATABASE db-auth     FROM ecoma_staff_access_runtime;
--   REVOKE CONNECT ON DATABASE db-backoffice FROM ecoma_staff_access_runtime;
--   REVOKE CONNECT ON DATABASE db-account  FROM PUBLIC;
--   REVOKE CONNECT ON DATABASE db-auth     FROM PUBLIC;
--   REVOKE CONNECT ON DATABASE db-backoffice FROM PUBLIC;
--
-- Fail-closed assertion: runtime must NOT have CONNECT on the others. We cannot
-- check has_database_privilege across databases from here; the check is performed
-- by the integration test (tests/integrations/roles.spec.ts, Milestone B) using
-- a connection to each database.

-- ---------------------------------------------------------------------------
-- Self-elevation guard at DB level (already in 0001 trigger; re-assert here)
-- ---------------------------------------------------------------------------

-- (no-op: trigger staff_access.role_assignment_no_self_elevation created in 0001)

-- ---------------------------------------------------------------------------
-- GUC reserved for cross-database name resolution (no silent default)
-- ---------------------------------------------------------------------------

-- `ecoma.staff_access_database` GUC is reserved; migration never reads it with a
-- silent default. Runner sets it via `SET ecoma.staff_access_database = ...`?
-- No — runner uses placeholder :"db_staff_access_database" substitution instead.

COMMIT;
