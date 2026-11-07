-- 0001_staff_access_domain.sql — schema lõi của RBAC domain `db-staff-access`.
--
-- Source of truth đã đọc trước khi viết:
-- - docs/domains/staff-access/domain-model.md §3–§5, §9 invariant 1–12.
-- - docs/domains/staff-access/adr/0013-staff-access-ownership-transfer.md (canonical).
-- - docs/architecture/01-architecture.md invariant 34/35.
-- - apps/backoffice/db/migrations/0001_backoffice_domain.sql (pattern tham chiếu).
--
-- ⚠️ Status labels stay proposed (P1.4 Milestone A): CHECK encode proposed
-- labels; COMMENT ON ghi chú "pending confirmation" bằng tiếng Anh.
--
-- ⚠️ Không seed role, không seed staff, không outbox/transport, không sync-call
-- contract ở file này (Milestone B sẽ làm). Schema chỉ giữ khả năng.

BEGIN;

-- ---------------------------------------------------------------------------
-- Role migrator TRƯỚC schema
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'ecoma_staff_access_migrator') THEN
    CREATE ROLE ecoma_staff_access_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS staff_access;

COMMENT ON SCHEMA staff_access IS
  'Application schema of db-staff-access. Runtime role only has DML here; grants are issued in 0002_roles_and_grants.sql.';

-- ---------------------------------------------------------------------------
-- staff — sổ staff, trục trạng thái riêng khỏi account
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS staff_access.staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sub text NOT NULL UNIQUE,
  display_name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_sub_format_check CHECK (sub ~ '^sub_[a-z2-7]{32}$'),
  CONSTRAINT staff_status_check CHECK (status IN ('active', 'suspended', 'terminated'))
);

COMMENT ON TABLE staff_access.staff IS
  'Staff directory. sub is an opaque reference to the account Account ID, 1:1, no cross-database FK (ADR-0012, ADR-0013). Email does not live in this table.';
COMMENT ON COLUMN staff_access.staff.id IS
  'Internal staff identifier owned by staff-access. Referenced by FKs inside db-staff-access.';
COMMENT ON COLUMN staff_access.staff.sub IS
  'Account ID (sub form) of the staff member. UNIQUE = 1:1 mapping; opaque reference, changing sub on an existing row is blocked (staff_identity_and_terminal_guard).';
COMMENT ON COLUMN staff_access.staff.display_name IS
  'Display name mirrored for audit/read surfaces; canonical profile lives in account (proposed label, pending confirmation).';
COMMENT ON COLUMN staff_access.staff.status IS
  'Independent axis (proposed labels, pending confirmation): active | suspended | terminated. Terminated is terminal; a trigger silently blocks restoration.';

-- Index cho truy vấn theo sub (đường token → staff, ADR-0012 §4).
CREATE INDEX IF NOT EXISTS staff_sub_idx ON staff_access.staff (sub);

-- terminated là terminal: chặn hồi sinh im lặng + sub là identity mapping 1:1.
CREATE OR REPLACE FUNCTION staff_access.staff_identity_and_terminal_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.sub IS DISTINCT FROM OLD.sub THEN
    RAISE EXCEPTION
      'staff: sub la tham chieu 1:1 sang account, khong duoc doi tren hang da ton tai (ADR-0012 4.1)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.status = 'terminated'
     AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION
      'staff: terminated la trang thai terminal; phuc hoi membership la thao tac moi co audit, khong phai UPDATE im lang'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION staff_access.staff_identity_and_terminal_guard() IS
  'Blocks UPDATEs that change sub or move status away from terminated; restoring membership must be a new audited operation.';

DROP TRIGGER IF EXISTS staff_identity_and_terminal_guard ON staff_access.staff;
CREATE TRIGGER staff_identity_and_terminal_guard
  BEFORE UPDATE ON staff_access.staff
  FOR EACH ROW
  EXECUTE FUNCTION staff_access.staff_identity_and_terminal_guard();

-- ---------------------------------------------------------------------------
-- permissions — sealed catalog, insert-then-retire
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS staff_access.permissions (
  id text PRIMARY KEY,
  domain text NOT NULL,
  action text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT permissions_status_check CHECK (status IN ('active', 'retired')),
  CONSTRAINT permissions_domain_action_unique UNIQUE (domain, action),
  CONSTRAINT permissions_id_format_check CHECK (id = domain || '.' || action)
);

COMMENT ON TABLE staff_access.permissions IS
  'Permission catalog — sealed: INSERT only via the seed migration run by the migrator; the runtime role cannot INSERT/UPDATE (0002). Unique (domain, action). id = domain.action.';
COMMENT ON COLUMN staff_access.permissions.id IS
  'Permission identifier in <domain>.<action> form (ADR-0010).';
COMMENT ON COLUMN staff_access.permissions.domain IS
  'Resource domain of the permission (e.g. staff, role, permission).';
COMMENT ON COLUMN staff_access.permissions.action IS
  'Action name within the resource domain.';

-- Status retired là terminal.
CREATE OR REPLACE FUNCTION staff_access.permissions_retired_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> OLD.status AND OLD.status = 'retired' THEN
    RAISE EXCEPTION
      'permissions: entry da retired la terminal, quay lai active phai la seed migration moi co review (ADR-0010)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION staff_access.permissions_retired_immutable() IS
  'Insert-then-retire only: a retired entry is terminal, returning to active is silently blocked.';

DROP TRIGGER IF EXISTS permissions_retired_immutable ON staff_access.permissions;
CREATE TRIGGER permissions_retired_immutable
  BEFORE UPDATE ON staff_access.permissions
  FOR EACH ROW
  EXECUTE FUNCTION staff_access.permissions_retired_immutable();

-- ---------------------------------------------------------------------------
-- roles + role_permissions — role là tập permission có tên
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS staff_access.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_kind_check CHECK (kind IN ('system', 'custom')),
  CONSTRAINT roles_status_check CHECK (status IN ('active', 'retired'))
);

COMMENT ON TABLE staff_access.roles IS
  'Role = a named set of permissions. No bypass role: every role is a finite set via role_permissions (SR-016).';
COMMENT ON COLUMN staff_access.roles.kind IS
  'system | custom. Custom role administration is not finalized (ADR-0004).';
COMMENT ON COLUMN staff_access.roles.status IS
  'active | retired.';

CREATE TABLE IF NOT EXISTS staff_access.role_permissions (
  role_id uuid NOT NULL REFERENCES staff_access.roles (id),
  permission_id text NOT NULL REFERENCES staff_access.permissions (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_permissions_role_permission_pk PRIMARY KEY (role_id, permission_id)
);

COMMENT ON TABLE staff_access.role_permissions IS
  'Permission set of each role. Changing a role permission set happens only through role_permissions.';

CREATE INDEX IF NOT EXISTS role_permissions_role_id_idx ON staff_access.role_permissions (role_id);

-- ---------------------------------------------------------------------------
-- role_assignments — gán role cho staff, minimal scope, giữ lịch sử
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS staff_access.role_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES staff_access.staff (id),
  role_id uuid NOT NULL REFERENCES staff_access.roles (id),
  scope jsonb,
  effective_from timestamptz,
  effective_until timestamptz,
  granted_by uuid REFERENCES staff_access.staff (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT role_assignments_effective_window_check CHECK (
    effective_from IS NULL OR effective_until IS NULL OR effective_until > effective_from
  ),
  CONSTRAINT role_assignments_revoked_after_created CHECK (
    revoked_at IS NULL OR revoked_at >= created_at
  )
);

COMMENT ON TABLE staff_access.role_assignments IS
  'Assigns roles to staff, N per staff. scope is JSONB NULL (proposed label, pending confirmation). valid_until is read-time filter in app layer; revocation is UPDATE revoked_at, not DELETE (invariant 12).';
COMMENT ON COLUMN staff_access.role_assignments.scope IS
  'Optional scope (JSONB) for the assignment; NULL means global. Proposed shape, pending confirmation.';
COMMENT ON COLUMN staff_access.role_assignments.effective_from IS
  'Start of effective window; NULL means effective immediately.';
COMMENT ON COLUMN staff_access.role_assignments.effective_until IS
  'End of effective window; NULL means no expiry. Read-time filter.';
COMMENT ON COLUMN staff_access.role_assignments.granted_by IS
  'staff_id of the granting staff member; NULL for bootstrap/migrator-created rows.';

CREATE INDEX IF NOT EXISTS role_assignments_staff_idx ON staff_access.role_assignments (staff_id);
CREATE INDEX IF NOT EXISTS role_assignments_role_idx ON staff_access.role_assignments (role_id);

-- ---------------------------------------------------------------------------
-- authorization_audit — append-only, SR-013 7 trường, không secret (SR-014)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS staff_access.authorization_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_staff_id uuid,
  actor_sub text,
  target text NOT NULL,
  action text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL,
  reason text,
  correlation_id text,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT authorization_audit_outcome_check CHECK (outcome IN ('success', 'failure', 'denied')),
  CONSTRAINT authorization_audit_context_no_secret_keys CHECK (
    NOT (context ?| ARRAY['token', 'access_token', 'refresh_token', 'secret', 'password', 'authorization'])
  )
);


COMMENT ON TABLE staff_access.authorization_audit IS
  'Append-only audit (SR-013, SR-015, invariant 12). UPDATE/DELETE are blocked in two layers: the runtime role has no grant (0002) and a trigger raises an exception. No token/secret columns.';
COMMENT ON COLUMN staff_access.authorization_audit.actor_staff_id IS
  'Actor staff id, may be NULL for system operations or when actor is not a staff member. No FK so audit survives any change to the staff directory.';
COMMENT ON COLUMN staff_access.authorization_audit.actor_sub IS
  'Actor sub, may be NULL for system operations.';
COMMENT ON COLUMN staff_access.authorization_audit.target IS
  'Target identifier (staff id, role id, permission id, entitlement pair).';
COMMENT ON COLUMN staff_access.authorization_audit.action IS
  'Action performed (e.g. staff.read, role.read, permission.read).';
COMMENT ON COLUMN staff_access.authorization_audit.outcome IS
  'Operation outcome: success | failure | denied. Denials must also be audited (SR-018).';
COMMENT ON COLUMN staff_access.authorization_audit.reason IS
  'Optional reason code or human-readable reason (no secrets).';
COMMENT ON COLUMN staff_access.authorization_audit.correlation_id IS
  'Correlation/request id for tracing.';

CREATE INDEX IF NOT EXISTS authorization_audit_actor_idx
  ON staff_access.authorization_audit (actor_sub, occurred_at DESC)
  WHERE actor_sub IS NOT NULL;

-- Append-only enforcement trigger.
CREATE OR REPLACE FUNCTION staff_access.authorization_audit_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'authorization_audit la bang audit append-only: % bi tu choi',
    TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

COMMENT ON FUNCTION staff_access.authorization_audit_append_only() IS
  'Blocks UPDATE/DELETE on the audit with an absolute exception; INSERT stays open so every value gets recorded. Layer 2; layer 1 is the grant in 0002.';

DROP TRIGGER IF EXISTS authorization_audit_append_only ON staff_access.authorization_audit;
CREATE TRIGGER authorization_audit_append_only
  BEFORE UPDATE OR DELETE ON staff_access.authorization_audit
  FOR EACH ROW
  EXECUTE FUNCTION staff_access.authorization_audit_append_only();

-- ---------------------------------------------------------------------------
-- entitlements — product availability per staff, revision monotonic
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS staff_access.entitlements (
  staff_id uuid NOT NULL REFERENCES staff_access.staff (id),
  product text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'entitled',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entitlements_pk PRIMARY KEY (staff_id, product),
  CONSTRAINT entitlements_product_check CHECK (product IN ('backoffice', 'pact-broker', 'remote-cache')),
  CONSTRAINT entitlements_status_check CHECK (status IN ('entitled', 'revoked')),
  CONSTRAINT entitlements_revision_positive_check CHECK (revision >= 1)
);

COMMENT ON TABLE staff_access.entitlements IS
  'Product entitlement per staff. revision is monotonic per (staff_id, product); status entitled | revoked. Entitlement is product-level availability, not per-resource authorization (ADR-0009).';
COMMENT ON COLUMN staff_access.entitlements.revision IS
  'Monotonic revision counter per (staff_id, product). Bumped by trigger on every status change.';
COMMENT ON COLUMN staff_access.entitlements.product IS
  'Product identifier: backoffice | pact-broker | remote-cache (ENTITLEMENT_PRODUCTS).';
COMMENT ON COLUMN staff_access.entitlements.status IS
  'entitled | revoked.';

-- Revision monotonic trigger: bumps revision on every UPDATE.
CREATE OR REPLACE FUNCTION staff_access.entitlements_revision_monotonic()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION
      'entitlements: revision khong duoc giam (monotonic)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION staff_access.entitlements_revision_monotonic() IS
  'Bumps revision by 1 on every UPDATE; rejects decreasing revision (monotonic per staff_id, product).';

DROP TRIGGER IF EXISTS entitlements_revision_monotonic ON staff_access.entitlements;
CREATE TRIGGER entitlements_revision_monotonic
  BEFORE UPDATE ON staff_access.entitlements
  FOR EACH ROW
  EXECUTE FUNCTION staff_access.entitlements_revision_monotonic();

-- Self-elevation guard where expressible: a staff member cannot grant themselves
-- a role assignment. Enforced at DB level via trigger comparing granted_by.
CREATE OR REPLACE FUNCTION staff_access.role_assignment_no_self_elevation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.granted_by IS NOT NULL AND NEW.granted_by = NEW.staff_id THEN
    RAISE EXCEPTION
      'role_assignments: self-elevation bi tu choi (granted_by khong duoc bang staff_id)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION staff_access.role_assignment_no_self_elevation() IS
  'Blocks self-elevation: granted_by must not equal staff_id. App layer also enforces; DB is defense in depth.';

DROP TRIGGER IF EXISTS role_assignment_no_self_elevation ON staff_access.role_assignments;
CREATE TRIGGER role_assignment_no_self_elevation
  BEFORE INSERT OR UPDATE ON staff_access.role_assignments
  FOR EACH ROW
  EXECUTE FUNCTION staff_access.role_assignment_no_self_elevation();

-- Revoke-only guard for the runtime role (pattern: backoffice 0004). Runtime
-- UPDATE exists solely to set revoked_at; un-revoke or window extension would
-- be privilege mutation without audit. Migrator/owner keep full power.
-- ⚠️ Trigger KHONG khai bao OF-column list: runtime UPDATE cot khac (scope,
-- staff_id, role_id, granted_by, updated_at) phai cung roi vao day de bi
-- chan — chi trigger unbounded moi phu toan (revoke-only la tham soi
-- security-high round 3, 41070536326).
CREATE OR REPLACE FUNCTION staff_access.role_assignment_revoke_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user::text <> 'ecoma_staff_access_runtime' THEN
    RETURN NEW;
  END IF;
  IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
     AND OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION
      'role_assignments: runtime role khong duoc un-revoke (revoked_at da co gia tri)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.effective_until IS DISTINCT FROM OLD.effective_until THEN
    RAISE EXCEPTION
      'role_assignments: runtime role chi duoc revoke (SET revoked_at), khong doi cua hieu luc'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.staff_id IS DISTINCT FROM OLD.staff_id
     OR NEW.role_id IS DISTINCT FROM OLD.role_id
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.granted_by IS DISTINCT FROM OLD.granted_by THEN
    RAISE EXCEPTION
      'role_assignments: runtime role chi duoc revoke (SET revoked_at), khong doi identity/scope/granted_by'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION staff_access.role_assignment_revoke_only() IS
  'Runtime role may only SET revoked_at (revocation). Un-revoke, effective window changes, or any identity/scope/granted_by mutation are rejected for ecoma_staff_access_runtime; migrator/owner are exempt. Column-unbounded so every runtime UPDATE lands here.';

DROP TRIGGER IF EXISTS role_assignment_revoke_only ON staff_access.role_assignments;
CREATE TRIGGER role_assignment_revoke_only
  BEFORE UPDATE
  ON staff_access.role_assignments
  FOR EACH ROW
  EXECUTE FUNCTION staff_access.role_assignment_revoke_only();

COMMIT;
