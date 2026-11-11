-- 0004_tenant_classification_and_plan.sql — tenant classification, plan and the Free-slot invariant.
--
-- Implements the schema enforcement required by
-- docs/domains/pact-broker/domain-model.md §2.6 (classification, plan,
-- one-free-slot-per-owner): classification is a NOT NULL column with exactly
-- two values ('first_party' | 'customer'); a plan ('free' | 'paid') exists
-- if and only if classification is 'customer' (first_party tenants have no
-- plan); an owner holds at most one concurrent non-deleted 'free' tenant,
-- enforced by the partial unique index tenants_one_free_per_owner_key —
-- suspended tenants still consume the slot, deleted tenants release it, and
-- first_party tenants never match the predicate because their plan is NULL.
--
-- Canonical identity correction (ADR-0020 decision 9: every remaining
-- ecoma-internal reads as ecoma). A row named 'ecoma-internal' can only
-- have been written by this service's own internal writers - the bootstrap
-- helper (db/bootstrap-tenant.mts before its rename, then carrying the
-- name 'ecoma-internal') or the entitlement ensureTenant path; no
-- customer-facing path can produce that name. Renaming it to 'ecoma' is
-- therefore an origin-established correction, not a guess, and the
-- canonical row is classified 'first_party' with no plan. The rename
-- fails closed when both 'ecoma' and 'ecoma-internal' exist at the same
-- time: which row is canonical is then ambiguous and must be resolved by an
-- operator before the migration is re-run.
--
-- Rows that still have no classification after the first_party backfill
-- (for example a legacy 'local' seed row) fail the migration closed with
-- the offending names: local lane data is disposable and is rebuilt via
-- local-up after local-down; any other database needs an explicit operator
-- decision per row. No silent classification guess happens here.
--
-- Additive and forward-only; every statement is re-runnable (IF NOT
-- EXISTS / DO-block guards, like 0003), so the runner can replay every
-- file. Tenant, membership and machine-token rows are NOT inserted here:
-- ADR-0020 reserves bootstrap data for the bootstrap layer, not for
-- migrations.

BEGIN;

-- New columns are added nullable: the NOT NULL on classification is set
-- only after the fail-closed backfill below, so a legacy row is named in
-- the error instead of failing the constraint without explanation.
ALTER TABLE pact.tenants
  ADD COLUMN IF NOT EXISTS classification text,
  ADD COLUMN IF NOT EXISTS plan text;

-- Canonical identity correction (ADR-0020 decision 9).
DO $$
DECLARE
  legacy_count integer;
  canonical_count integer;
BEGIN
  SELECT count(*) INTO legacy_count FROM pact.tenants WHERE name = 'ecoma-internal';
  SELECT count(*) INTO canonical_count FROM pact.tenants WHERE name = 'ecoma';

  IF legacy_count > 0 AND canonical_count > 0 THEN
    RAISE EXCEPTION
      'migration 0004: both an "ecoma" and an "ecoma-internal" tenant row exist; which row is the canonical internal tenant is ambiguous. Resolve the duplicate manually (keep the row that carries real data) and re-run this migration';
  END IF;

  IF legacy_count > 0 THEN
    UPDATE pact.tenants SET name = 'ecoma' WHERE name = 'ecoma-internal';
  END IF;
END
$$;

-- Backfill: the canonical internal tenant is first_party with no plan
-- (domain model §2.6). Idempotent: re-running rewrites the same values.
UPDATE pact.tenants
   SET classification = 'first_party',
       plan = NULL
 WHERE name = 'ecoma';

-- Fail closed when any row is left without a classification: the NOT NULL
-- below would otherwise turn an unclassifiable legacy row into an
-- unexplained constraint failure.
DO $$
DECLARE
  unclassified text;
BEGIN
  SELECT string_agg(name, ', ' ORDER BY name) INTO unclassified
    FROM pact.tenants
   WHERE classification IS NULL;

  IF unclassified IS NOT NULL THEN
    RAISE EXCEPTION
      'migration 0004: tenant row(s) still without a classification after the first_party backfill: %. Classification is NOT NULL as of this migration and is never guessed. Local lane data is disposable: rebuild it with "pnpm nx run-many -t local-down -c local" followed by "pnpm nx run-many -t local-up -c local". For any other database, decide each named row explicitly (first_party via the internal bootstrap path, customer via the customer provisioning path) and re-run this migration',
      unclassified;
  END IF;
END
$$;

-- Idempotent: SET NOT NULL on an already NOT NULL column is a no-op.
ALTER TABLE pact.tenants
  ALTER COLUMN classification SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_classification_check'
      AND conrelid = 'pact.tenants'::regclass
  ) THEN
    ALTER TABLE pact.tenants
      ADD CONSTRAINT tenants_classification_check
      CHECK (classification IN ('first_party', 'customer'));
  END IF;
END
$$;

-- A plan value implies a customer tenant: first_party has no plan (not a
-- third enum value, the absence of one).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_plan_only_when_customer_check'
      AND conrelid = 'pact.tenants'::regclass
  ) THEN
    ALTER TABLE pact.tenants
      ADD CONSTRAINT tenants_plan_only_when_customer_check
      CHECK (plan IS NULL OR classification = 'customer');
  END IF;
END
$$;

-- A customer tenant carries exactly one of the two plans. The explicit
-- plan IS NOT NULL guard is required: a bare
-- `classification <> 'customer' OR plan IN ('free','paid')` evaluates to
-- NULL (and passes) when plan is NULL, because SQL CHECK constraints treat
-- NULL as satisfied.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_customer_plan_values_check'
      AND conrelid = 'pact.tenants'::regclass
  ) THEN
    ALTER TABLE pact.tenants
      ADD CONSTRAINT tenants_customer_plan_values_check
      CHECK (classification <> 'customer' OR (plan IS NOT NULL AND plan IN ('free', 'paid')));
  END IF;
END
$$;

-- Free-slot invariant (domain model §2.6): at most one concurrent
-- non-deleted 'free' tenant per owner_sub. Suspended still consumes the
-- slot (only status 'deleted' releases it); first_party never matches
-- because its plan is NULL. Index name follows the existing
-- <table>_<descriptor>_key convention.
CREATE UNIQUE INDEX IF NOT EXISTS tenants_one_free_per_owner_key
  ON pact.tenants (owner_sub)
  WHERE plan = 'free' AND status <> 'deleted';

COMMENT ON COLUMN pact.tenants.classification IS
  'Organizational classification of the tenant: first_party (Ecoma-owned, provisioned only through the internal bootstrap path) or customer (provisioned through the customer path). Never inferred from owner, name, environment or plan; immutable after provisioning; a plan value exists only when classification is customer (domain model 2.6).';
COMMENT ON COLUMN pact.tenants.plan IS
  'Commercial plan of a customer tenant: free or paid. NULL for first_party tenants (plan does not apply — it is not a third enum value). At most one concurrent non-deleted free tenant per owner_sub is enforced by the partial unique index tenants_one_free_per_owner_key; suspended tenants keep consuming the slot, deleted tenants release it (domain model 2.6).';

COMMIT;
