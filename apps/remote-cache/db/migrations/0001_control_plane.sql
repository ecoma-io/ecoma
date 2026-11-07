-- 0001_control_plane.sql — schema lõi control plane của bounded context
-- `remote-cache` trên db-remote-cache.
--
-- Source of truth đã đọc trước khi viết:
-- - docs/domains/remote-cache/adr/0015-remote-cache-bounded-context.md (canonical).
-- - docs/domains/remote-cache/README.md §2 (responsibility + boundaries).
-- - docs/applications/remote-cache/02-requirements.md R1–R3 (tenant/project/key shape).
-- - apps/pact-broker/db/migrations/0001_tenant_and_pact_domain.sql (pattern
--   tenant + machine token hash-only, KHÔNG last_used_at).
-- - apps/staff-access/db/migrations/0001 (pattern trigger guard + COMMENT ON).
--
-- ⚠️ Tenant của context này KHÁC tenant của pact-broker (glossary §2.4,
-- ADR-0015): cùng giá trị id không bao giờ nghĩa cùng entity — không FK,
-- không join chéo schema/database.
--
-- ⚠️ Không quota, không retention, không usage/audit ở file này (P4.3 pin
-- semantics trước khi implement — ADR-0015). Schema chỉ giữ khả năng
-- control-plane skeleton P4.1 cần: tenant, project, membership, API key.
--
-- ⚠️ API key là machine credential hash-only: bảng chỉ giữ SHA-256 hex,
-- show-once lúc tạo, revoke = SET revoked_at, KHÔNG last_used_at
-- (observability không được đòi hỏi ghi serving path).

BEGIN;

-- ---------------------------------------------------------------------------
-- Role migrator TRƯỚC schema
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ecoma_remote_cache_migrator') THEN
    CREATE ROLE ecoma_remote_cache_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS remote_cache;

COMMENT ON SCHEMA remote_cache IS
  'Application schema of db-remote-cache. Runtime role only has DML here; grants are issued in 0002_roles_and_grants.sql.';

-- ---------------------------------------------------------------------------
-- tenants — tenant của remote-cache, tách biệt tenant pact-broker
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS remote_cache.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_name_check CHECK (name ~ '^[a-zA-Z0-9._-]{1,255}$'),
  CONSTRAINT tenants_status_check CHECK (status IN ('active', 'suspended', 'deleted')),
  CONSTRAINT tenants_name_unique UNIQUE (name)
);

COMMENT ON TABLE remote_cache.tenants IS
  'Tenant of the remote-cache bounded context (ADR-0015). Distinct from pact-broker tenants: the same id value never denotes the same entity across the two contexts, and there is no cross-schema FK.';
COMMENT ON COLUMN remote_cache.tenants.id IS
  'Tenant identifier owned by remote-cache. Referenced by projects inside db-remote-cache only.';
COMMENT ON COLUMN remote_cache.tenants.name IS
  'Human-facing tenant label; uniqueness is enforced by tenants_name_unique.';
COMMENT ON COLUMN remote_cache.tenants.status IS
  'Lifecycle: active | suspended | deleted. Enforcement is fail-closed: credentials of a non-active tenant must be rejected (P4.4 wires the runtime check).';

-- ---------------------------------------------------------------------------
-- projects — con của tenant, đơn vị cách ly của data plane (P4.2)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS remote_cache.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES remote_cache.tenants (id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projects_name_check CHECK (name ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
  CONSTRAINT projects_tenant_name_unique UNIQUE (tenant_id, name)
);

COMMENT ON TABLE remote_cache.projects IS
  'Project owned by exactly one tenant; the isolation unit of the future data plane (P4.2). Control-plane skeleton P4.1 only creates and lists projects.';
COMMENT ON COLUMN remote_cache.projects.id IS
  'Project identifier owned by remote-cache; referenced by api_keys inside db-remote-cache.';
COMMENT ON COLUMN remote_cache.projects.tenant_id IS
  'Owning tenant. Enforces the R2 boundary: a key only reaches projects inside its own tenant.';
COMMENT ON COLUMN remote_cache.projects.name IS
  'Lowercase DNS-like label, unique per tenant (projects_tenant_name_unique); reused as the cache/namespace name of the data plane.';

CREATE INDEX IF NOT EXISTS projects_tenant_created_idx
  ON remote_cache.projects (tenant_id, created_at, id);

-- ---------------------------------------------------------------------------
-- tenant_members — membership người dùng của tenant (khác key machine)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS remote_cache.tenant_members (
  tenant_id uuid NOT NULL REFERENCES remote_cache.tenants (id),
  member_sub text NOT NULL,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, member_sub),
  CONSTRAINT tenant_members_role_check CHECK (role IN ('owner', 'member'))
);

COMMENT ON TABLE remote_cache.tenant_members IS
  'Human membership of a tenant. member_sub is an opaque reference to an account identity (no FK across databases, pattern pact.tenant_members). Machine credentials live in api_keys, not here.';
COMMENT ON COLUMN remote_cache.tenant_members.member_sub IS
  'Account identity of the member, opaque; ownership of the identity stays with the account context.';
COMMENT ON COLUMN remote_cache.tenant_members.role IS
  'Membership role inside this tenant only: owner | member. No staff-access permission vocabulary (ADR-0015: two vocabularies, never merged).';

-- ---------------------------------------------------------------------------
-- api_keys — machine credential hash-only, show-once, revoke-only
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS remote_cache.api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES remote_cache.projects (id),
  token_hash text NOT NULL UNIQUE,
  scopes text NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_key_scopes_check CHECK (scopes ~ '^(read|write)( (read|write))*$'),
  CONSTRAINT api_key_revoked_at_after_created_check CHECK (revoked_at IS NULL OR revoked_at > created_at)
);

COMMENT ON TABLE remote_cache.api_keys IS
  'Machine credential of a project (ADR-0015). Hash-only: token_hash is the SHA-256 hex of the token; the raw token is shown exactly once at creation and never stored. Revocation is a state change (revoked_at), never a DELETE. Deliberately NO last_used_at: usage timestamps are observability and must not be demanded from the serving path (pattern pact.machine_tokens).';
COMMENT ON COLUMN remote_cache.api_keys.id IS
  'API key identifier; referenced by future quota/usage rows (P4.3).';
COMMENT ON COLUMN remote_cache.api_keys.project_id IS
  'Owning project. Keys are project-scoped (R2); no tenant-level key exists in the skeleton.';
COMMENT ON COLUMN remote_cache.api_keys.token_hash IS
  'SHA-256 hex of the raw token, lowercase. UNIQUE — the lookup path of request authentication (P4.2 hardening: timing-safe compare, rate limit).';
COMMENT ON COLUMN remote_cache.api_keys.scopes IS
  'Space-separated scope list: read, write, or read write. DB CHECK validates the format; the no-duplicate rule is enforced at the application gate (pattern pact.machine_tokens).';
COMMENT ON COLUMN remote_cache.api_keys.revoked_at IS
  'NULL while the key is valid; a timestamp once revoked. Revocation is terminal and reconstructible from this column.';

-- ---------------------------------------------------------------------------
-- Revoke-only guard: revoked_at chỉ đi một chiều
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION remote_cache.api_key_revocation_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION
      'remote_cache: api_key da revoke la terminal; khong un-revoke va khong doi thoi diem revoke'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION remote_cache.api_key_revocation_guard() IS
  'Blocks UPDATEs that un-revoke a key or move its revoked_at; revocation is terminal and reconstructible.';

DROP TRIGGER IF EXISTS api_key_revocation_guard ON remote_cache.api_keys;
CREATE TRIGGER api_key_revocation_guard
  BEFORE UPDATE ON remote_cache.api_keys
  FOR EACH ROW
  EXECUTE FUNCTION remote_cache.api_key_revocation_guard();

COMMIT;
