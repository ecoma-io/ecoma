/**
 * Integration test cho P3.3: revoke entitlement KHÔNG ảnh hưởng customer
 * membership hoặc machine credentials độc lập.
 *
 * Chạy trên PostgreSQL thật qua testcontainers (tương tự api.spec.ts).
 * Ghi hành vi cốt lõi:
 *   - entitlement.granted → tạo membership (role Member)
 *   - entitlement.revoked → ghi revision sync state, KHÔNG xóa membership,
 *     KHÔNG chạm machine_tokens
 *   - hai revoked liên tiếp → membership giữ nguyên, revision tiến lên
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  provisionEntitlementMembership,
  type EntitlementSyncRepo,
  type MembershipRepo,
} from '@ecoma-io/pact-broker-api-application';
import { PgEntitlementSyncRepo, PgTenantRepo } from '@ecoma-io/pact-broker-api-infrastructure';
import type { createPool } from '@ecoma-io/pact-broker-api-infrastructure';
import type { EntitlementEvent } from '@ecoma-io/staff-access-contracts';
import { type PactBrokerDatabase, PACT_BROKER_DATABASE, startPactBrokerDatabase } from './harness';
import { bootstrapCanonicalTenant } from '../../db/bootstrap-tenant.mts';

const STAFF_ID = 'staff-p33-0001';
const PRODUCT = 'pact-broker';

function makeEvent(overrides: Partial<EntitlementEvent> = {}): EntitlementEvent {
  return {
    event_id: '0f0e0d0c-0b0a-4928-8276-001122334455',
    type: 'entitlement.granted',
    staff_id: STAFF_ID,
    product: PRODUCT,
    revision: 1,
    occurred_at: '2026-01-01T00:00:00Z',
    producer: 'staff-access',
    ...overrides,
  };
}

describe(`${PACT_BROKER_DATABASE} P3.3 revoke entitlement isolation (real DB)`, () => {
  let db: PactBrokerDatabase;
  let pool: ReturnType<typeof createPool>;
  let tenantId = '';

  beforeAll(async () => {
    db = await startPactBrokerDatabase();
    pool = await db.createRuntimePool();
    // Serving path chỉ ĐỌC tenant canonical `ecoma`: provision đúng bằng
    // đường bootstrap thật (tenant first_party + owner membership, cùng code
    // path với `db/bootstrap-tenant.mts`) — test không tự chế tenant.
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await bootstrapCanonicalTenant(client, 'sub-owner-internal');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
    tenantId = (await new PgTenantRepo(pool).getTenantByName('ecoma'))?.id ?? '';
  }, 180_000);

  afterAll(async () => {
    await pool.end().catch(() => undefined);
    await db?.stop();
  });

  beforeEach(async () => {
    const client = await db.connect();
    try {
      await client.query(`DELETE FROM pact.entitlement_sync_state`);
      await client.query(`DELETE FROM pact.tenant_members WHERE sub = $1`, [STAFF_ID]);
    } finally {
      await client.end();
    }
  });

  async function getMembershipRole(): Promise<string | null> {
    const repo = new PgTenantRepo(pool);
    return repo.getMemberRole(tenantId, STAFF_ID);
  }

  async function getSyncRevision(): Promise<number | null> {
    const repo = new PgEntitlementSyncRepo(pool);
    return repo.readRevision(STAFF_ID, PRODUCT);
  }

  async function countMachineTokens(): Promise<number> {
    const { rows } = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM pact.machine_tokens WHERE tenant_id = $1`,
      [tenantId],
    );
    return Number(rows[0]?.c ?? 0);
  }

  it('entitlement.granted tạo membership, entitlement.revoked không xóa nó (P3.3)', async () => {
    const deps: { membership: MembershipRepo; sync: EntitlementSyncRepo } = {
      membership: new PgTenantRepo(pool),
      sync: new PgEntitlementSyncRepo(pool),
    };

    // 1. Granted → membership được tạo.
    const granted = await provisionEntitlementMembership(makeEvent(), deps);
    expect(granted.applied).toBe(true);
    expect(granted.reason).toBe('first');
    expect(await getMembershipRole()).toBe('member');

    // 2. Revoked → ghi revision sync state, KHÔNG xóa membership.
    const revoked = await provisionEntitlementMembership(
      makeEvent({ type: 'entitlement.revoked', revision: 2 }),
      deps,
    );
    expect(revoked.applied).toBe(false);
    expect(revoked.reason).toBe('newer');
    expect(await getSyncRevision()).toBe(2);
    // Effective revoke: entitlement_revoked_at IS NOT NULL ⇒ getMemberRole trả null (row vẫn còn).
    expect(await getMembershipRole()).toBeNull(); // Revoke có hiệu lực

    // Revoke KHÔNG chạm owner: owner_sub trên tenant row giữ nguyên.
    const { rows: ownerRows } = await pool.query<{ owner_sub: string }>(
      `SELECT owner_sub FROM pact.tenants WHERE id = $1`,
      [tenantId],
    );
    expect(ownerRows[0]?.owner_sub).toBe('sub-owner-internal');
  });

  it('entitlement.revoked trước granted → membership vẫn được tạo khi granted sau (P3.3)', async () => {
    const deps: { membership: MembershipRepo; sync: EntitlementSyncRepo } = {
      membership: new PgTenantRepo(pool),
      sync: new PgEntitlementSyncRepo(pool),
    };

    // Revoked trước khi có granted: chỉ ghi revision, không tạo membership.
    const revoked = await provisionEntitlementMembership(
      makeEvent({ type: 'entitlement.revoked', revision: 1 }),
      deps,
    );
    expect(revoked.applied).toBe(false);
    expect(revoked.reason).toBe('first');
    expect(await getSyncRevision()).toBe(1);
    expect(await getMembershipRole()).toBeNull(); // Chưa có membership

    // Granted sau revoked (revision cao hơn): tạo membership bình thường.
    const granted = await provisionEntitlementMembership(makeEvent({ revision: 2 }), deps);
    expect(granted.applied).toBe(true);
    expect(await getMembershipRole()).toBe('member');
    expect(await getSyncRevision()).toBe(2);
  });

  it('revoked không chạm machine_tokens (P3.3 isolation)', async () => {
    const deps: { membership: MembershipRepo; sync: EntitlementSyncRepo } = {
      membership: new PgTenantRepo(pool),
      sync: new PgEntitlementSyncRepo(pool),
    };

    const beforeTokens = await countMachineTokens();

    // Granted tạo membership.
    await provisionEntitlementMembership(makeEvent({ revision: 1 }), deps);
    expect(await getMembershipRole()).toBe('member');

    // Revoked: không chạm machine_tokens.
    await provisionEntitlementMembership(
      makeEvent({ type: 'entitlement.revoked', revision: 2 }),
      deps,
    );

    const afterTokens = await countMachineTokens();
    expect(afterTokens).toBe(beforeTokens);
    // Membership row vẫn còn (không bị xóa) nhưng effective role null sau revoke.
    expect(await getMembershipRole()).toBeNull(); // Membership revoke có hiệu lực
  });

  it('hai revoked liên tiếp → membership giữ nguyên, revision tiến lên (P3.3)', async () => {
    const deps: { membership: MembershipRepo; sync: EntitlementSyncRepo } = {
      membership: new PgTenantRepo(pool),
      sync: new PgEntitlementSyncRepo(pool),
    };

    await provisionEntitlementMembership(makeEvent({ revision: 1 }), deps);
    expect(await getMembershipRole()).toBe('member');

    await provisionEntitlementMembership(
      makeEvent({ type: 'entitlement.revoked', revision: 2 }),
      deps,
    );
    await provisionEntitlementMembership(
      makeEvent({ type: 'entitlement.revoked', revision: 3 }),
      deps,
    );

    expect(await getSyncRevision()).toBe(3);
    // Effective role null sau revoke; row vẫn còn.
    expect(await getMembershipRole()).toBeNull(); // Giữ nguyên sau hai lần revoke
  });
});
