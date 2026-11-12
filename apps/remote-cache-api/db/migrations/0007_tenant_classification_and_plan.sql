-- 0007_tenant_classification_and_plan.sql — tenant classification, commercial
-- plan and the owner Free-slot invariant (issue #20).
--
-- Implements the schema requirements stated as checks by
-- docs/domains/remote-cache/domain-model.md §2.9 (Enforcement schema) and
-- §3 invariants 7-10, per ADR-0026 (first_party/customer classification axis):
--   classification — NOT NULL, exactly two values 'first_party' | 'customer'.
--     Default 'customer' keeps the customer provisioning path implicit; only
--     the controlled bootstrap/seed surface (ADR-0020) writes 'first_party'.
--   plan — nullable at the storage level; a value exists if and only if the
--     tenant is 'customer' ('free' | 'paid'). A first_party tenant has no plan
--     (absence, not a third enum value).
--   tenants_one_free_per_owner_key — partial UNIQUE index named verbatim per
--     §2.9: at most one concurrent non-deleted 'free' tenant per owner_sub.
--     Suspended tenants keep consuming the slot; only status 'deleted'
--     releases it; first_party tenants never match the predicate because
--     their plan is NULL.
--
-- Widens audit_log_action_check with the bootstrap action 'tenant_bootstrap'
-- (snake_case, matching the existing vocabulary style). The constraint name
-- is unchanged; drop-then-add keeps the statement re-runnable. 0005 is never
-- edited in place (forward-fix, invariant 10).
--
-- Defense in depth: the runtime role's table-level UPDATE on tenants is
-- revoked and re-granted at column scope (status only) — the lifecycle path
-- needs status changes, and no runtime code path may ever mutate
-- classification or plan (classification is immutable after provisioning,
-- §2.9; precedent: column-scoped grant on api_keys.revoked_at, 0002).
--
-- Safe on a greenfield database: no tenant row exists before this migration
-- in any environment (no runtime or seed path created tenants before #20),
-- so the NOT NULL DEFAULT backfill produces no rows that could violate the
-- plan constraint.
--
-- Every statement is re-runnable (the migration runner has no ledger):
-- ADD COLUMN IF NOT EXISTS, guarded constraint adds, CREATE UNIQUE INDEX IF
-- NOT EXISTS, DROP CONSTRAINT IF EXISTS before re-ADD, REVOKE/GRANT
-- idempotent. COMMENT ON text is English.

BEGIN;

-- ---------------------------------------------------------------------------
-- Columns: classification (NOT NULL, default 'customer') and plan (nullable)
-- ---------------------------------------------------------------------------

ALTER TABLE remote_cache.tenants
  ADD COLUMN IF NOT EXISTS classification text NOT NULL DEFAULT 'customer';

ALTER TABLE remote_cache.tenants
  ADD COLUMN IF NOT EXISTS plan text;

COMMENT ON COLUMN remote_cache.tenants.classification IS
  'Organizational classification of the tenant: first_party (Ecoma-owned, provisioned only through the controlled internal bootstrap surface of ADR-0020) or customer (customer provisioning path, the default). Never inferred from owner, name, email domain, environment, plan or membership role; immutable after provisioning — no customer-facing or operator-facing conversion exists in the MVP model (ADR-0026).';
COMMENT ON COLUMN remote_cache.tenants.plan IS
  'Commercial plan of a customer tenant: free or paid. NULL for first_party tenants (plan does not apply — absence, not a third enum value). At most one concurrent non-deleted free tenant per owner_sub is enforced by the partial unique index tenants_one_free_per_owner_key; suspended tenants keep consuming the slot, deleted tenants release it (domain model §2.9).';

-- ---------------------------------------------------------------------------
-- CHECK constraints — guarded adds probing pg_constraint (pattern 0003)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_classification_check'
      AND conrelid = 'remote_cache.tenants'::regclass
  ) THEN
    ALTER TABLE remote_cache.tenants
      ADD CONSTRAINT tenants_classification_check
      CHECK (classification IN ('first_party', 'customer'));
  END IF;
END
$$;

-- Plan exists if and only if the tenant is a customer. The `plan IS NOT NULL`
-- guard keeps the expression total: without it, a (customer, NULL) row makes
-- the first disjunct UNKNOWN, and CHECK constraints treat UNKNOWN as
-- satisfied (SQL three-valued logic — a constraint is violated only by a
-- FALSE result), so a customer tenant could leave its plan unset. With the
-- guard the row evaluates to FALSE and is rejected. The expression is also
-- self-contained: no classification value outside the two documented ones
-- satisfies either disjunct.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_plan_check'
      AND conrelid = 'remote_cache.tenants'::regclass
  ) THEN
    ALTER TABLE remote_cache.tenants
      ADD CONSTRAINT tenants_plan_check
      CHECK (
        (classification = 'customer' AND plan IS NOT NULL AND plan IN ('free', 'paid'))
        OR (classification = 'first_party' AND plan IS NULL)
      );
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Free-slot invariant: partial UNIQUE per owner (domain model §2.9, invariant 7)
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS tenants_one_free_per_owner_key
  ON remote_cache.tenants (owner_sub)
  WHERE plan = 'free' AND status <> 'deleted';

-- ---------------------------------------------------------------------------
-- Audit vocabulary: widen audit_log_action_check with the bootstrap action
-- ---------------------------------------------------------------------------

ALTER TABLE remote_cache.audit_log
  DROP CONSTRAINT IF EXISTS audit_log_action_check;

ALTER TABLE remote_cache.audit_log
  ADD CONSTRAINT audit_log_action_check
  CHECK (action IN ('quota_exceeded', 'quota_limit_set', 'retention_cleanup', 'cache_put', 'tenant_bootstrap'));

COMMENT ON CONSTRAINT audit_log_action_check ON remote_cache.audit_log IS
  'Closed action vocabulary of the audit log; widened by 0007 with tenant_bootstrap for the provisioning bootstrap run.';

-- ---------------------------------------------------------------------------
-- Defense in depth: scope the runtime UPDATE grant on tenants to (status)
-- ---------------------------------------------------------------------------

REVOKE UPDATE ON remote_cache.tenants FROM ecoma_remote_cache_runtime;
GRANT UPDATE (status) ON remote_cache.tenants TO ecoma_remote_cache_runtime;

COMMIT;
