/**
 * Bootstrap of the canonical `ecoma` tenant on a real PostgreSQL
 * (ADR-0020, 02-delivery.md §3.2 step 5a).
 *
 * Calls the exact {@link bootstrapCanonicalTenant} core the CLI runs
 * (runner-canonical, no separately written apply loop) and measures the
 * database state after each run. Connection input comes from the harness
 * with the real runtime credential (`db.migratorUrl` is generated from the
 * same harness — the production CLI receives exactly this shape through
 * the `DATABASE_URL` env var).
 *
 * ⚠️ Suite requires Docker: a broken probe makes `globalSetup` throw and
 * the whole run goes red (fail-loud, 06-testing.md §6) — skipping with
 * exit 0 is not an accepted result.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapCanonicalTenant,
  CANONICAL_TENANT_NAME,
  parseDatabaseUrl,
} from '../../db/bootstrap-tenant.mts';
import {
  type PactBrokerDatabase,
  PACT_BROKER_DATABASE as HARNESS_DATABASE,
  startPactBrokerDatabase,
} from '../integrations/harness';

interface TenantRow {
  id: string;
  name: string;
  status: string;
  classification: string;
  plan: string | null;
  owner_sub: string;
  created_at: Date;
}

async function queryTenant(db: PactBrokerDatabase): Promise<TenantRow[]> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<TenantRow>(
      `SELECT id, name, status, classification, plan, owner_sub, created_at
         FROM pact.tenants WHERE name = $1`,
      [CANONICAL_TENANT_NAME],
    );
    return rows;
  } finally {
    await client.end();
  }
}

interface MembershipRow {
  tenant_id: string;
  sub: string;
  role: string;
  source: string | null;
  staff_id: string | null;
}

async function queryMemberships(db: PactBrokerDatabase): Promise<MembershipRow[]> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<MembershipRow>(
      `SELECT tenant_id, sub, role, source, staff_id FROM pact.tenant_members`,
    );
    return rows;
  } finally {
    await client.end();
  }
}

interface AuditRow {
  tenant_id: string | null;
  action: string;
  outcome: string;
  detail: Record<string, unknown>;
}

async function queryBootstrapAuditEvents(db: PactBrokerDatabase): Promise<AuditRow[]> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<AuditRow>(
      `SELECT tenant_id, action, outcome, detail FROM pact.audit_events
        WHERE action = 'tenant.bootstrap' ORDER BY occurred_at, event_id`,
    );
    return rows;
  } finally {
    await client.end();
  }
}

/**
 * Audit details sorted by the bootstrap outcome — concurrent runs commit in
 * either order, and jsonb column storage does not preserve key order, so
 * the comparison runs on parsed objects with a deterministic sort key.
 */
function auditDetailsSorted(rows: AuditRow[]): Array<Record<string, string>> {
  return rows
    .map((row) => row.detail as Record<string, string>)
    .toSorted((a, b) => (a['bootstrap'] ?? '').localeCompare(b['bootstrap'] ?? ''));
}

/** Expected audit details of one created run plus one no-op run, in the same sort order. */
function expectedAuditDetailsSorted(): Array<Record<string, string>> {
  return [
    { bootstrap: 'already_existed', tenant: CANONICAL_TENANT_NAME, membership: 'verified' },
    { bootstrap: 'created', tenant: CANONICAL_TENANT_NAME, membership: 'created' },
  ];
}

/**
 * One bootstrap run wrapped in exactly the transaction the CLI performs
 * (BEGIN → bootstrap → COMMIT, ROLLBACK on failure), on a real runtime
 * credential.
 */
async function runBootstrapped(
  db: PactBrokerDatabase,
  ownerSub: string,
): Promise<Awaited<ReturnType<typeof bootstrapCanonicalTenant>>> {
  const client = await db.asRuntime();
  try {
    await client.query('BEGIN');
    try {
      const result = await bootstrapCanonicalTenant(client, ownerSub);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    await client.end();
  }
}

describe(`bootstrap of the canonical ${CANONICAL_TENANT_NAME} tenant on ${HARNESS_DATABASE}`, () => {
  let db: PactBrokerDatabase;

  beforeAll(async () => {
    db = await startPactBrokerDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('creates the first_party tenant, owner membership and one audit event together on the first run', async () => {
    expect(await queryTenant(db)).toEqual([]);

    const runtimeUrl = `postgres://ecoma_pact_broker_runtime:ecoma_test_role_pw@${db.host}:${db.port}/${HARNESS_DATABASE}`;
    expect(parseDatabaseUrl(runtimeUrl)).toEqual({ database: HARNESS_DATABASE });

    const result = await runBootstrapped(db, 'sub-owner-bootstrap');
    expect(result.alreadyExisted).toBe(false);
    expect(result.tenantName).toBe(CANONICAL_TENANT_NAME);

    // Tenant: active, first_party, no plan, owner persisted.
    const tenants = await queryTenant(db);
    expect(tenants).toHaveLength(1);
    expect(tenants[0]?.id).toBe(result.tenantId);
    expect(tenants[0]?.status).toBe('active');
    expect(tenants[0]?.classification).toBe('first_party');
    expect(tenants[0]?.plan).toBeNull();
    expect(tenants[0]?.owner_sub).toBe('sub-owner-bootstrap');

    // Membership: exactly one owner membership, role member, source
    // bootstrap, staff_id NULL (entitlement mapping only).
    const memberships = await queryMemberships(db);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.tenant_id).toBe(result.tenantId);
    expect(memberships[0]?.sub).toBe('sub-owner-bootstrap');
    expect(memberships[0]?.role).toBe('member');
    expect(memberships[0]?.source).toBe('bootstrap');
    expect(memberships[0]?.staff_id).toBeNull();

    // Audit: exactly one event for the created run.
    const audit = await queryBootstrapAuditEvents(db);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.tenant_id).toBe(result.tenantId);
    expect(audit[0]?.action).toBe('tenant.bootstrap');
    expect(audit[0]?.outcome).toBe('success');
    expect(audit[0]?.detail).toEqual({
      bootstrap: 'created',
      tenant: CANONICAL_TENANT_NAME,
      membership: 'created',
    });

    // No machine token is seeded by bootstrap.
    const counter = await db.connect();
    try {
      const { rows } = await counter.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM pact.machine_tokens`,
      );
      expect(rows[0]?.c).toBe('0');
    } finally {
      await counter.end();
    }
  });

  it('is a safe no-op on the second run and preserves existing state', async () => {
    const before = await queryTenant(db);
    expect(before).toHaveLength(1);
    const beforeId = before[0]?.id ?? '';
    const beforeCreatedAt = before[0]?.created_at;

    const result = await runBootstrapped(db, 'sub-owner-bootstrap');
    expect(result.alreadyExisted).toBe(true);
    expect(result.tenantId).toBe(beforeId);

    const after = await queryTenant(db);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(beforeId);
    expect(after[0]?.status).toBe('active');
    expect(after[0]?.classification).toBe('first_party');
    expect(after[0]?.plan).toBeNull();
    expect(after[0]?.owner_sub).toBe('sub-owner-bootstrap');
    // created_at unchanged: a no-op does not update the existing row.
    expect(after[0]?.created_at.getTime()).toBe(beforeCreatedAt?.getTime());

    // Membership stays exactly one row with the bootstrap shape.
    const memberships = await queryMemberships(db);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe('member');
    expect(memberships[0]?.source).toBe('bootstrap');

    // The no-op run writes its own audit event: created + already_existed.
    const audit = await queryBootstrapAuditEvents(db);
    expect(audit).toHaveLength(2);
    expect(auditDetailsSorted(audit)).toEqual(expectedAuditDetailsSorted());
  });

  it('never overwrites ownership when a second bootstrap passes a different owner', async () => {
    await db.truncateData();

    const first = await runBootstrapped(db, 'sub-owner-bootstrap');
    expect(first.alreadyExisted).toBe(false);

    const client = await db.asRuntime();
    try {
      await client.query('BEGIN');
      await expect(bootstrapCanonicalTenant(client, 'sub-owner-second')).rejects.toThrow(
        /ownership is never overwritten/u,
      );
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }

    // The refused run wrote nothing: ownership preserved, no membership for
    // the second subject, no audit event.
    const tenants = await queryTenant(db);
    expect(tenants).toHaveLength(1);
    expect(tenants[0]?.owner_sub).toBe('sub-owner-bootstrap');

    const memberships = await queryMemberships(db);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.sub).toBe('sub-owner-bootstrap');

    expect(await queryBootstrapAuditEvents(db)).toHaveLength(1);
  });

  it('converges when two connections bootstrap concurrently', async () => {
    // Reset so this run is the first creation: truncate every domain table
    // without touching DDL/grants/triggers (the harness provides exactly
    // that).
    await db.truncateData();

    // Each side wraps BEGIN/COMMIT around one bootstrap — exactly the
    // transaction the CLI performs. ⚠️ COMMIT must stay INSIDE each side's
    // promise: if commit happened after Promise.all, the losing side would
    // block on the winner's lock while the winner waits for Promise.all —
    // a self-made deadlock whose still-held lock cascades timeouts into
    // the tests after it.
    const runOne = async (client: Awaited<ReturnType<typeof db.asRuntime>>) => {
      await client.query('BEGIN');
      try {
        const result = await bootstrapCanonicalTenant(client, 'sub-owner-bootstrap');
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    };

    const clientA = await db.asRuntime();
    const clientB = await db.asRuntime();
    try {
      const [resultA, resultB] = await Promise.all([runOne(clientA), runOne(clientB)]);

      // Exactly one side created, one already-existed; both results resolve
      // to the same tenant id — no fatal error (ADR-0020 decision 5).
      expect([resultA.alreadyExisted, resultB.alreadyExisted].toSorted()).toEqual([false, true]);
      expect(resultA.tenantId).toBe(resultB.tenantId);
    } finally {
      await clientA.end();
      await clientB.end();
    }

    // Convergence: one tenant, one owner membership, one audit row per run.
    const tenants = await queryTenant(db);
    expect(tenants).toHaveLength(1);

    const memberships = await queryMemberships(db);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe('member');
    expect(memberships[0]?.source).toBe('bootstrap');

    const audit = await queryBootstrapAuditEvents(db);
    expect(audit).toHaveLength(2);
    expect(auditDetailsSorted(audit)).toEqual(expectedAuditDetailsSorted());

    // Clean the audit trail so count asserts of later tests do not inherit
    // entries from this race.
    await db.truncateData();
  });

  it('refuses to resurrect an existing suspended tenant', async () => {
    // Reset to a clean state, then create the tenant through the script
    // itself: state left behind by earlier tests must not be assumed (each
    // it is responsible for its own input data).
    await db.truncateData();
    await runBootstrapped(db, 'sub-owner-bootstrap');

    const client = await db.asRuntime();
    try {
      await client.query(`UPDATE pact.tenants SET status = 'suspended' WHERE name = $1`, [
        CANONICAL_TENANT_NAME,
      ]);
    } finally {
      await client.end();
    }

    const before = await queryTenant(db);
    expect(before[0]?.id).toBeDefined();

    const caller = await db.asRuntime();
    try {
      await caller.query('BEGIN');
      await expect(bootstrapCanonicalTenant(caller, 'sub-owner-bootstrap')).rejects.toThrow(
        /refusing to resurrect/u,
      );
      await caller.query('ROLLBACK');
    } finally {
      await caller.end();
    }

    // The refused run left the suspended state untouched and wrote no audit.
    const after = await queryTenant(db);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[0]?.status).toBe('suspended');
    expect(await queryBootstrapAuditEvents(db)).toHaveLength(1);
  });

  it('refuses to resurrect an existing deleted tenant', async () => {
    await db.truncateData();
    await runBootstrapped(db, 'sub-owner-bootstrap');

    const client = await db.asRuntime();
    try {
      await client.query(`UPDATE pact.tenants SET status = 'deleted' WHERE name = $1`, [
        CANONICAL_TENANT_NAME,
      ]);
    } finally {
      await client.end();
    }

    const before = await queryTenant(db);
    expect(before[0]?.id).toBeDefined();

    const caller = await db.asRuntime();
    try {
      await caller.query('BEGIN');
      await expect(bootstrapCanonicalTenant(caller, 'sub-owner-bootstrap')).rejects.toThrow(
        /refusing to resurrect/u,
      );
      await caller.query('ROLLBACK');
    } finally {
      await caller.end();
    }

    const after = await queryTenant(db);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[0]?.status).toBe('deleted');
    expect(await queryBootstrapAuditEvents(db)).toHaveLength(1);
  });

  it('fails closed when the existing tenant is not first_party', async () => {
    await db.truncateData();
    await runBootstrapped(db, 'sub-owner-bootstrap');

    // Stage a customer-shaped tenant: valid under the schema constraints
    // (customer ⇒ plan free/paid), but not a valid bootstrap no-op state.
    // (A first_party tenant WITH a plan is unreachable through SQL — the
    // tenants_plan_only_when_customer_check forbids it — so the customer
    // shape is the storable classification mismatch.)
    const client = await db.asRuntime();
    try {
      await client.query(
        `UPDATE pact.tenants SET classification = 'customer', plan = 'free' WHERE name = $1`,
        [CANONICAL_TENANT_NAME],
      );
      await client.query('BEGIN');
      await expect(bootstrapCanonicalTenant(client, 'sub-owner-bootstrap')).rejects.toThrow(
        /classification customer; expected 'first_party'/u,
      );
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }

    // The refused run did not overwrite classification or plan, and wrote
    // no audit.
    const after = await queryTenant(db);
    expect(after[0]?.classification).toBe('customer');
    expect(after[0]?.plan).toBe('free');
    expect(await queryBootstrapAuditEvents(db)).toHaveLength(1);
  });

  it('fails closed on a conflicting owner membership role or provenance', async () => {
    await db.truncateData();
    await runBootstrapped(db, 'sub-owner-bootstrap');

    // Stage a conflicting role on the owner membership.
    const roleClient = await db.asRuntime();
    try {
      await roleClient.query(
        `UPDATE pact.tenant_members SET role = 'admin' WHERE sub = 'sub-owner-bootstrap'`,
      );
      await roleClient.query('BEGIN');
      await expect(bootstrapCanonicalTenant(roleClient, 'sub-owner-bootstrap')).rejects.toThrow(
        /role admin, source bootstrap; expected role 'member' with source 'bootstrap'/u,
      );
      await roleClient.query('ROLLBACK');
    } finally {
      await roleClient.end();
    }

    // Stage the right role with a conflicting provenance.
    const sourceClient = await db.asRuntime();
    try {
      await sourceClient.query(
        `UPDATE pact.tenant_members SET role = 'member', source = 'entitlement'
          WHERE sub = 'sub-owner-bootstrap'`,
      );
      await sourceClient.query('BEGIN');
      await expect(bootstrapCanonicalTenant(sourceClient, 'sub-owner-bootstrap')).rejects.toThrow(
        /role member, source entitlement/u,
      );
      await sourceClient.query('ROLLBACK');
    } finally {
      await sourceClient.end();
    }

    // Both refused runs left membership and audit untouched (the last
    // staged state is the entitlement provenance).
    const memberships = await queryMemberships(db);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe('member');
    expect(memberships[0]?.source).toBe('entitlement');
    expect(await queryBootstrapAuditEvents(db)).toHaveLength(1);
  });

  it('rolls back the whole run when a step fails mid-transaction', async () => {
    await db.truncateData();

    const real = await db.asRuntime();
    try {
      // A client that fails exactly the membership step: the tenant insert
      // already succeeded, so only the caller-managed ROLLBACK can undo it —
      // proving tenant + membership + audit are atomic per run.
      const failingMembership = {
        query: async (sql: string, params?: unknown[]) => {
          if (sql.includes('pact.tenant_members')) {
            throw new Error('simulated membership insert failure');
          }
          return real.query(sql, params);
        },
      } as unknown as import('pg').Client;

      await real.query('BEGIN');
      try {
        await expect(
          bootstrapCanonicalTenant(failingMembership, 'sub-owner-rollback'),
        ).rejects.toThrow(/simulated membership insert failure/u);
      } finally {
        await real.query('ROLLBACK');
      }

      // Nothing persisted: no tenant row, no membership, no audit event.
      expect(await queryTenant(db)).toEqual([]);
      expect(await queryMemberships(db)).toEqual([]);
      expect(await queryBootstrapAuditEvents(db)).toEqual([]);
    } finally {
      await real.end();
    }
  });

  it('rejects a connection string without a database path', () => {
    expect(() => parseDatabaseUrl('postgres://user:pw@host:5432')).toThrow(/database name path/u);
    expect(() => parseDatabaseUrl('mysql://user:pw@host:5432/db')).toThrow(/postgres/u);
    expect(() => parseDatabaseUrl('postgres://user:pw@host:5432/')).toThrow(/non-empty/u);
    expect(parseDatabaseUrl('postgresql://user:pw@host:5432/other-db?sslmode=require')).toEqual({
      database: 'other-db',
    });
  });

  it('rejects invalid owner_sub without touching the database', async () => {
    const fakeClient = { query: async () => ({}) } as unknown as import('pg').Client;
    await expect(bootstrapCanonicalTenant(fakeClient, '')).rejects.toThrow(
      /owner_sub is required/u,
    );
    await expect(bootstrapCanonicalTenant(fakeClient, ' has space ')).rejects.toThrow(
      /owner_sub is required/u,
    );
    await expect(bootstrapCanonicalTenant(fakeClient, 'x'.repeat(201))).rejects.toThrow(
      /owner_sub is required/u,
    );
  });
});
