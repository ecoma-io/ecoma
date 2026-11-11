/**
 * `node db/bootstrap-tenant.mts` — bootstrap the canonical first-party
 * tenant `ecoma` (tenant row + owner membership) in `db-pact-broker`.
 *
 * Implementation of step 5a of the bootstrap/seed contract: ADR-0020
 * (`docs/domains/staff-access/adr/0020-bootstrap-seed-contract.md`) via
 * `docs/architecture/02-delivery.md` §3.2. The canonical tenant name is the
 * constant `ecoma` in every environment and every product database that
 * runs this bootstrap (ADR-0020 decision 9); environment configuration
 * supplies connection input and the owner subject, never the tenant
 * identity.
 *
 * Script independent of the deploy pipeline: it runs directly from a CI
 * runner / ops box with a PostgreSQL client holding a valid credential
 * (runtime role), never from a Worker — same rationale as `db/apply.mts`
 * (HD6: Hyperdrive does not support advisory locks; this script only does
 * DML and needs no lock, but the runner/Worker boundary is kept unchanged).
 *
 * Behaviour (ADR-0020 decisions 5, 6, 9, 13; domain model §2.6), all inside
 * ONE caller-managed transaction:
 *  - INSERT `pact.tenants (name 'ecoma', status 'active', classification
 *    'first_party', plan NULL, owner_sub)`, idempotent `ON CONFLICT (name)
 *    DO NOTHING`.
 *  - On conflict, the existing row is read back and the run fails closed
 *    unless it is exactly a valid bootstrap no-op: `status = 'active'`,
 *    `owner_sub` equal to the supplied subject (ownership is never
 *    overwritten), `classification = 'first_party'`, `plan IS NULL`. Each
 *    mismatch is a distinct, specific error: a row that merely shares the
 *    name is not silently adopted.
 *  - INSERT the owner membership `pact.tenant_members (tenant_id, sub,
 *    role 'member', source 'bootstrap')`, idempotent `ON CONFLICT
 *    (tenant_id, sub) DO NOTHING`; the stored row must read back with
 *    `role = 'member' AND source = 'bootstrap'` — a conflicting role or
 *    provenance fails closed. `staff_id` stays NULL: that column is
 *    entitlement-mapping only.
 *  - Exactly ONE audit event per run in `pact.audit_events` (action
 *    `tenant.bootstrap`, outcome `success`), on the created path and the
 *    no-op path alike, so every run leaves an append-only trace.
 *
 * Race-safety without an advisory lock: every write target is guarded by a
 * natural key — `tenants.name` (unique) and the `tenant_members` primary
 * key `(tenant_id, sub)`. Under READ COMMITTED, a loser `INSERT ... ON
 * CONFLICT DO NOTHING` waits for the winner's in-progress insert to
 * commit, then skips; the loser takes the read-and-verify path against the
 * committed winner state and writes its own audit row. Two concurrent runs
 * therefore converge to one tenant and one owner membership with one audit
 * event each — no lock is needed because there is no state outside the
 * database and no read-modify-write without a conflict guard (ADR-0020
 * decision 5).
 *
 * Fail-closed when the tenant exists as `suspended`/`deleted` (ADR-0020
 * decision 6): bootstrap never resurrects it — revival is a deliberate
 * owner action.
 *
 * Environment variables:
 *
 * | Variable                     | Required | Meaning                                                       |
 * | ---------------------------- | -------- | ------------------------------------------------------------- |
 * | `DATABASE_URL`               | yes      | PostgreSQL connection string (runtime role of db-pact-broker) |
 * | `CANONICAL_TENANT_OWNER_SUB` | yes      | opaque `sub` of the canonical tenant owner                    |
 *
 * The password lives only in `DATABASE_URL` (env/stdin secret, never argv —
 * argv shows in `ps` + shell history, against the Secrets invariant).
 * Missing config exits non-zero with instructions: treating silence as
 * "the tenant is already bootstrapped" is how a one-time bootstrap
 * disappears. The script also asserts that the database in the URL is
 * `db-pact-broker` — pointing it at another database dies immediately
 * instead of creating a tenant in someone else's house.
 */

import { pathToFileURL } from 'node:url';

import { Client } from 'pg';
import { isOpaqueId, MAX_OPAQUE_ID_LENGTH } from '@ecoma-io/tenant-kernel-domain';

/** The one canonical first-party tenant this script is allowed to bootstrap. */
export const CANONICAL_TENANT_NAME = 'ecoma';

/** Database name this service owns; a URL pointing elsewhere is a config error. */
export const PACT_BROKER_DATABASE = 'db-pact-broker';

/** Database name parsed from a connection string — input of the CLI assert. */
export interface BootstrapDatabaseTarget {
  readonly database: string;
}

/** Result of one bootstrap run — printed by the CLI, asserted by tests. */
export interface BootstrapTenantResult {
  /** The tenant already existed before this run (`true` = this run was a no-op). */
  readonly alreadyExisted: boolean;
  /** Tenant id (uuid) — present on both the created and the no-op path. */
  readonly tenantId: string;
  /** Tenant name — constant `CANONICAL_TENANT_NAME`, returned for test asserts. */
  readonly tenantName: string;
}

/**
 * Parse the database name from a PostgreSQL connection string.
 *
 * Uses string slicing instead of `new URL()`: postgres URLs allow user/
 * password that is not encoded per the generic URL standard (`pg` accepts
 * it), and `new URL()` throws on a password containing characters like an
 * unencoded `%` or `/` — this parser only needs the database path, so it
 * never touches that part.
 */
export function parseDatabaseUrl(databaseUrl: string): BootstrapDatabaseTarget {
  if (
    databaseUrl.startsWith('postgres://') === false &&
    databaseUrl.startsWith('postgresql://') === false
  ) {
    throw new Error('must start with postgres:// or postgresql://');
  }
  const withoutScheme = databaseUrl.slice(databaseUrl.indexOf('://') + 3);
  const slashIndex = withoutScheme.indexOf('/');
  if (slashIndex === -1) {
    throw new Error('must include a database name path (postgres://host:port/db)');
  }
  const pathAndQuery = withoutScheme.slice(slashIndex + 1);
  const questionIndex = pathAndQuery.indexOf('?');
  const database = questionIndex === -1 ? pathAndQuery : pathAndQuery.slice(0, questionIndex);
  if (database === '') {
    throw new Error('must include a non-empty database name path');
  }
  return { database };
}

/** Environment variable holding the owner (opaque `sub`) of the canonical tenant. Required. */
export const CANONICAL_TENANT_OWNER_SUB_ENV = 'CANONICAL_TENANT_OWNER_SUB';

/** Outcome of the owner-membership step of one run — feeds the audit detail. */
type MembershipOutcome = 'created' | 'verified';

/**
 * Bootstrap the canonical tenant — core logic shared by the CLI and the
 * integration test (one single code path, the runner-canonical pattern of
 * `db/apply.mts`: an apply loop rewritten inside the test would test a
 * copy, not the runner).
 *
 * The client passed in must hold INSERT/SELECT privileges on `pact.tenants`,
 * `pact.tenant_members` and `pact.audit_events` (runtime role). The
 * function does NOT open/close a connection itself: the caller manages the
 * connection lifetime (the CLI below) and the transaction (the tests). The
 * DML statements of one bootstrap run execute inside the caller's single
 * transaction so tenant, membership and audit event exist together or not
 * at all.
 *
 * `ownerSub` is the opaque id of the tenant owner, persisted on the
 * `pact.tenants.owner_sub` column. It must pass the kernel guard
 * (`isOpaqueId`) — missing or invalid throws, with NO fallback and NO
 * tenant created without an owner.
 *
 * On the conflict path every stored field of the existing row is verified
 * against the expected bootstrap state and the run fails closed on the
 * first mismatch, before any write of this run: a `suspended`/`deleted`
 * tenant is never resurrected, a different owner is never overwritten, and
 * a row that is not `first_party` with no plan is not adopted as the
 * canonical tenant.
 */
export async function bootstrapCanonicalTenant(
  client: Client,
  ownerSub: string,
): Promise<BootstrapTenantResult> {
  if (!isOpaqueId(ownerSub)) {
    throw new Error(
      `owner_sub is required and must be a non-empty opaque id of at most ${MAX_OPAQUE_ID_LENGTH} characters`,
    );
  }

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO pact.tenants (name, status, classification, plan, owner_sub)
     VALUES ($1, 'active', 'first_party', NULL, $2)
     ON CONFLICT (name) DO NOTHING
     RETURNING id`,
    [CANONICAL_TENANT_NAME, ownerSub],
  );

  if (inserted.rows.length === 1) {
    const firstRow = inserted.rows[0];
    if (firstRow === undefined) {
      throw new Error('INSERT RETURNING produced a row count without a row');
    }
    const membership = await upsertOwnerMembership(client, firstRow.id, ownerSub);
    await insertBootstrapAuditEvent(client, firstRow.id, 'created', membership);
    return { alreadyExisted: false, tenantId: firstRow.id, tenantName: CANONICAL_TENANT_NAME };
  }

  // No row returned by ON CONFLICT → the tenant already exists: read the
  // stored state and verify it before treating this run as a no-op.
  const existing = await client.query<{
    id: string;
    status: string;
    owner_sub: string;
    classification: string;
    plan: string | null;
  }>(`SELECT id, status, owner_sub, classification, plan FROM pact.tenants WHERE name = $1`, [
    CANONICAL_TENANT_NAME,
  ]);
  const row = existing.rows[0];
  if (row === undefined) {
    // Cannot happen with ON CONFLICT + UNIQUE(name) on the same table, but
    // it must not be assumed: fail loud instead of assuming safety.
    throw new Error(`tenant ${CANONICAL_TENANT_NAME} missing after ON CONFLICT (unexpected state)`);
  }
  if (row.status !== 'active') {
    throw new Error(
      `tenant ${CANONICAL_TENANT_NAME} exists with status ${row.status}; refusing to resurrect (owner action required)`,
    );
  }
  if (row.owner_sub !== ownerSub) {
    throw new Error(
      `tenant ${CANONICAL_TENANT_NAME} exists with a different owner_sub; ownership is never overwritten — bootstrap refused for the supplied owner`,
    );
  }
  if (row.classification !== 'first_party') {
    throw new Error(
      `tenant ${CANONICAL_TENANT_NAME} exists with classification ${row.classification}; expected 'first_party' — classification is immutable after provisioning and never overwritten by bootstrap`,
    );
  }
  if (row.plan !== null) {
    // Defense in depth: the schema forbids first_party with a plan
    // (tenants_plan_only_when_customer_check), so this state is unreachable
    // through valid SQL; the check keeps the verify path self-contained.
    throw new Error(
      `tenant ${CANONICAL_TENANT_NAME} exists with plan ${row.plan}; a first_party tenant must have no plan (NULL)`,
    );
  }

  const membership = await upsertOwnerMembership(client, row.id, ownerSub);
  await insertBootstrapAuditEvent(client, row.id, 'already_existed', membership);
  return { alreadyExisted: true, tenantId: row.id, tenantName: CANONICAL_TENANT_NAME };
}

/**
 * Insert the owner membership of the canonical tenant (role `member`,
 * source `bootstrap`) idempotently, then read the stored row back and fail
 * closed unless it holds exactly that role and provenance: a membership row
 * that shares the natural key but carries a different role or source is a
 * conflicting state, not a no-op, and is never overwritten.
 *
 * `staff_id` is not written: it stays NULL because it is entitlement
 * mapping only, and this membership is created by bootstrap.
 */
async function upsertOwnerMembership(
  client: Client,
  tenantId: string,
  ownerSub: string,
): Promise<MembershipOutcome> {
  const inserted = await client.query<{ sub: string }>(
    `INSERT INTO pact.tenant_members (tenant_id, sub, role, source)
     VALUES ($1, $2, 'member', 'bootstrap')
     ON CONFLICT (tenant_id, sub) DO NOTHING
     RETURNING sub`,
    [tenantId, ownerSub],
  );
  if (inserted.rows.length === 1) {
    return 'created';
  }

  const existing = await client.query<{ role: string; source: string | null }>(
    `SELECT role, source FROM pact.tenant_members WHERE tenant_id = $1 AND sub = $2`,
    [tenantId, ownerSub],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    throw new Error(
      `owner membership on tenant ${CANONICAL_TENANT_NAME} missing after ON CONFLICT (unexpected state)`,
    );
  }
  if (row.role !== 'member' || row.source !== 'bootstrap') {
    throw new Error(
      `owner membership on tenant ${CANONICAL_TENANT_NAME} exists with role ${row.role}, source ${row.source ?? 'NULL'}; expected role 'member' with source 'bootstrap' — refusing to overwrite role or provenance`,
    );
  }
  return 'verified';
}

/**
 * Write the audit entry of one bootstrap run (created or no-op) into
 * `pact.audit_events` — the append-only table from migration `0001`, shape
 * matching the infrastructure `insertAuditEvent` (no new table invented).
 *
 * The actor is the ops script, not a user or a machine token, so
 * `actor_sub`/`actor_token_id` are NULL; `detail` records the outcome of
 * the run so created and no-op runs are distinguishable in audit queries.
 * The action follows the broker's `object.verb` convention
 * (`machine_token.create`, `environment.create`). Exactly one event per
 * successful run; a run that fails closed writes none, because every fail
 * path throws before this insert.
 */
async function insertBootstrapAuditEvent(
  client: Client,
  tenantId: string,
  bootstrapOutcome: 'created' | 'already_existed',
  membershipOutcome: MembershipOutcome,
): Promise<void> {
  await client.query(
    `INSERT INTO pact.audit_events (tenant_id, actor_sub, actor_token_id, action, outcome, detail)
     VALUES ($1, NULL, NULL, 'tenant.bootstrap', 'success', $2::jsonb)`,
    [
      tenantId,
      JSON.stringify({
        bootstrap: bootstrapOutcome,
        tenant: CANONICAL_TENANT_NAME,
        membership: membershipOutcome,
      }),
    ],
  );
}

/** CLI branch — runs only when this file is the main module. */
async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];

  if (databaseUrl === undefined || databaseUrl === '') {
    console.error(
      'DATABASE_URL is not set. Run this script from a CI runner or ops box with the runtime role credentials; the password goes in the connection string (env/stdin), never in argv.',
    );
    process.exit(1);
  }

  let target: BootstrapDatabaseTarget;
  try {
    target = parseDatabaseUrl(databaseUrl);
  } catch (error) {
    console.error('DATABASE_URL is invalid:', (error as Error).message);
    process.exit(1);
  }
  if (target.database !== PACT_BROKER_DATABASE) {
    console.error(
      `DATABASE_URL points at database ${target.database}; this script only bootstraps ${PACT_BROKER_DATABASE}.`,
    );
    process.exit(1);
  }

  const ownerSub = process.env[CANONICAL_TENANT_OWNER_SUB_ENV];
  if (typeof ownerSub !== 'string' || ownerSub === '') {
    console.error(
      `CANONICAL_TENANT_OWNER_SUB is not set. Set it to the opaque 'sub' of the canonical tenant owner (non-empty, max ${MAX_OPAQUE_ID_LENGTH} chars).`,
    );
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'ecoma-pact-broker-bootstrap-tenant',
  });

  try {
    await client.connect();
  } catch (error) {
    console.error('Failed to connect to database:', (error as Error).message);
    process.exit(1);
  }

  try {
    await client.query('BEGIN');
    const result = await bootstrapCanonicalTenant(client, ownerSub);
    await client.query('COMMIT');
    if (result.alreadyExisted) {
      console.log(
        `tenant ${result.tenantName} already exists (id ${result.tenantId}); no-op, state preserved`,
      );
    } else {
      console.log(`tenant ${result.tenantName} created (id ${result.tenantId})`);
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('bootstrap failed:', (error as Error).message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
