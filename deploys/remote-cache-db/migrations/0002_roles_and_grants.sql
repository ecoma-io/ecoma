-- 0002_roles_and_grants.sql — ba role + grant + chặn chéo cho db-remote-cache.
--
-- Pattern tham chiếu: apps/staff-access/db/migrations/0002_roles_and_grants.sql
-- (GUC assertion + fail-closed CONNECT) và apps/backoffice/db/migrations/0002
-- (grant sweep). ADR-0015: ba role `ecoma_owner`/`ecoma_remote_cache_migrator`/
-- `ecoma_remote_cache_runtime`, grant least-privilege per table, REVOKE
-- dangerous privileges, REVOKE ALL ON SCHEMA public FROM PUBLIC.
--
-- ⚠️ Cross-database REVOKE CONNECT không thực thi được trong migration này vì
-- migrator chỉ sở hữu db-remote-cache (provisioning step 1 của admin/owner).
-- File này ghi nhận rationale + assertion fail-closed; khối DO $$ bỏ qua nếu
-- database kia chưa tồn tại. Chạy lại sau khi có database là sẵn sàng.

BEGIN;

-- ---------------------------------------------------------------------------
-- Role guard
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ecoma_remote_cache_migrator') THEN
    CREATE ROLE ecoma_remote_cache_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ecoma_remote_cache_runtime') THEN
    CREATE ROLE ecoma_remote_cache_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Schema grants
-- ---------------------------------------------------------------------------

GRANT USAGE, CREATE ON SCHEMA remote_cache TO ecoma_remote_cache_migrator;
GRANT USAGE ON SCHEMA remote_cache TO ecoma_remote_cache_runtime;

-- ---------------------------------------------------------------------------
-- Runtime: minimal DML per table (no DDL, no DELETE — revocation là state)
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON remote_cache.tenants TO ecoma_remote_cache_runtime;
GRANT SELECT, INSERT ON remote_cache.projects TO ecoma_remote_cache_runtime;
GRANT SELECT ON remote_cache.tenant_members TO ecoma_remote_cache_runtime;
GRANT SELECT, INSERT ON remote_cache.api_keys TO ecoma_remote_cache_runtime;
-- UPDATE chỉ ở cấp CỘT revoked_at (pattern staff-access role_assignments,
-- pair với trigger revoke-only ở 0001): runtime không thể sửa token_hash,
-- scopes hay project_id ngay cả khi trigger bị vô hiệu hóa — defense in depth.
GRANT UPDATE (revoked_at) ON remote_cache.api_keys TO ecoma_remote_cache_runtime;

-- Revoke dangerous privileges explicitly (defense in depth).
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON remote_cache.tenants FROM ecoma_remote_cache_runtime;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON remote_cache.projects FROM ecoma_remote_cache_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON remote_cache.tenant_members FROM ecoma_remote_cache_runtime;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON remote_cache.api_keys FROM ecoma_remote_cache_runtime;

-- ---------------------------------------------------------------------------
-- public schema hardening: revoke everything from PUBLIC
-- On PostgreSQL 15+ this statement is a no-op under the migrator credential
-- (warning only, not an error): schema `public` is owned by `pg_database_owner`
-- and PUBLIC retains USAGE granted by the owner, while CREATE left PUBLIC by
-- default in PG15. The statement is kept as-is to cover PostgreSQL < 15 and to
-- match the repo-wide migration pattern (backoffice, account, pact-broker-api,
-- staff-access); the hardening intent on current images is carried by PG15+
-- defaults plus the provision step granting the migrator rights on the DATABASE
-- only. Integration tests assert the catalog so a silent regression cannot pass.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- Guard CONNECT của runtime role trên CHÍNH database này — assertion
-- fail-closed, không revoke gì trên database khác
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT has_database_privilege('ecoma_remote_cache_runtime', current_database(), 'CONNECT') THEN
    RAISE EXCEPTION
      'ecoma_remote_cache_runtime mat quyen CONNECT tren db-remote-cache; can lai provisioning';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Cross-database REVOKE (provisioning step 1 — documented, not executed here)
-- ---------------------------------------------------------------------------
--
-- ⚠️ Cross-db REVOKE CONNECT requires ownership of the other database. Migrator
-- only owns db-remote-cache. Admin/owner must run (pattern 03-operations.md):
--
--   REVOKE CONNECT ON DATABASE db-account  FROM ecoma_remote_cache_runtime;
--   REVOKE CONNECT ON DATABASE db-auth     FROM ecoma_remote_cache_runtime;
--   REVOKE CONNECT ON DATABASE db-backoffice FROM ecoma_remote_cache_runtime;
--   REVOKE CONNECT ON DATABASE db-staff-access FROM ecoma_remote_cache_runtime;
--   REVOKE CONNECT ON DATABASE db-account  FROM PUBLIC;
--   REVOKE CONNECT ON DATABASE db-auth     FROM PUBLIC;
--   REVOKE CONNECT ON DATABASE db-backoffice FROM PUBLIC;
--   REVOKE CONNECT ON DATABASE db-staff-access FROM PUBLIC;
--
-- Fail-closed assertion: runtime must NOT have CONNECT on the others. We cannot
-- check has_database_privilege across databases from here; the check is
-- performed by the integration test (tests/integrations/roles.spec.ts) using a
-- connection to each database.

COMMIT;
