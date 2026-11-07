/**
 * Unit test cho `provisionEntitlementMembership` — fakes in-memory, không
 * dependency thật (PostgreSQL, Hono). Ghi các hành vi cốt lõi (P3.2):
 *
 * - granted + product pact-broker, chưa thấy revision → applied, reason 'first'
 * - granted + revision cao hơn → applied, reason 'newer'
 * - granted + revision trùng → không áp dụng, reason 'duplicate'
 * - granted + revision thấp hơn → không áp dụng, reason 'stale'
 * - entitlement.revoked → không áp dụng membership, reason 'newer' (ghi revision,
 *   không xóa membership — P3.3 sở hữu logic thu hồi)
 * - sản phẩm khác 'pact-broker' → bỏ qua, reason 'not-product'
 * - envelope không hợp lệ (vì shouldApplyEntitlementEvent validate) → reason 'invalid'
 */

import { describe, expect, it } from 'vitest';

import type { EntitlementEvent } from '@ecoma-io/staff-access-contracts';
import {
  type EntitlementSyncRepo,
  type MembershipRepo,
  provisionEntitlementMembership,
} from './provision-entitlement-membership';

function makeEvent(overrides: Partial<EntitlementEvent> = {}): EntitlementEvent {
  return {
    event_id: '0f0e0d0c-0b0a-4928-8276-001122334455',
    type: 'entitlement.granted',
    staff_id: 'staff-0001',
    product: 'pact-broker',
    revision: 1,
    occurred_at: '2026-01-01T00:00:00Z',
    producer: 'staff-access',
    ...overrides,
  };
}

class FakeMembershipRepo implements MembershipRepo {
  readonly calls: Array<{ tenantId: string; sub: string; role: string }> = [];
  tenants: Record<string, string> = {}; // name → id
  members: Record<string, string> = {}; // `${tenantId}|${sub}` → role
  revoked: Record<string, { eventId: string; revision: number } | undefined> = {};

  async ensureTenant(name: string): Promise<string> {
    if (this.tenants[name] === undefined) {
      this.tenants[name] = `tenant-${name}`;
    }
    return this.tenants[name];
  }

  async upsertMember(
    tenantId: string,
    sub: string,
    role: string,
    provenance?: {
      eventId: string;
      revision: number;
      source: 'entitlement' | 'bootstrap' | 'admin';
    },
  ): Promise<void> {
    this.calls.push({ tenantId, sub, role });
    this.members[`${tenantId}|${sub}`] = role;
    void provenance;
  }

  async markEntitlementRevoked(
    tenantId: string,
    sub: string,
    eventId: string,
    revision: number,
  ): Promise<void> {
    this.revoked[`${tenantId}|${sub}`] = { eventId, revision };
  }
}

class FakeEntitlementSyncRepo implements EntitlementSyncRepo {
  revisions: Record<string, number | null> = {}; // `${staffId}|${product}` → revision | null

  async readRevision(staffId: string, product: string): Promise<number | null> {
    return this.revisions[`${staffId}|${product}`] ?? null;
  }

  async writeRevision(staffId: string, product: string, revision: number): Promise<boolean> {
    const current = this.revisions[`${staffId}|${product}`] ?? null;
    if (current !== null && revision <= current) {
      return false;
    }
    this.revisions[`${staffId}|${product}`] = revision;
    return true;
  }
}

function makeDeps(): {
  membership: FakeMembershipRepo;
  sync: FakeEntitlementSyncRepo;
} {
  return { membership: new FakeMembershipRepo(), sync: new FakeEntitlementSyncRepo() };
}

describe('provisionEntitlementMembership', () => {
  it('granted đầu tiên cho pact-broker → applied, reason first, tạo tenant + membership Member', async () => {
    const deps = makeDeps();
    const result = await provisionEntitlementMembership(makeEvent(), deps);

    expect(result.applied).toBe(true);
    expect(result.reason).toBe('first');
    expect(deps.membership.calls).toEqual([
      { tenantId: 'tenant-ecoma-internal', sub: 'staff-0001', role: 'member' },
    ]);
    expect(deps.sync.revisions['staff-0001|pact-broker']).toBe(1);
  });

  it('revision cao hơn → applied, reason newer, ghi revision mới', async () => {
    const deps = makeDeps();
    deps.sync.revisions['staff-0001|pact-broker'] = 3;
    const result = await provisionEntitlementMembership(makeEvent({ revision: 5 }), deps);

    expect(result.applied).toBe(true);
    expect(result.reason).toBe('newer');
    expect(deps.sync.revisions['staff-0001|pact-broker']).toBe(5);
  });

  it('revision trùng → không áp dụng, reason duplicate', async () => {
    const deps = makeDeps();
    deps.sync.revisions['staff-0001|pact-broker'] = 3;
    const result = await provisionEntitlementMembership(makeEvent({ revision: 3 }), deps);

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('duplicate');
    expect(deps.membership.calls).toHaveLength(0);
    expect(deps.sync.revisions['staff-0001|pact-broker']).toBe(3);
  });

  it('revision thấp hơn → không áp dụng, reason stale', async () => {
    const deps = makeDeps();
    deps.sync.revisions['staff-0001|pact-broker'] = 5;
    const result = await provisionEntitlementMembership(makeEvent({ revision: 2 }), deps);

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('stale');
    expect(deps.membership.calls).toHaveLength(0);
  });

  it('entitlement.revoked → không xóa membership, reason newer (ghi revision, P3.3 sở hữu thu hồi)', async () => {
    const deps = makeDeps();
    deps.sync.revisions['staff-0001|pact-broker'] = 1;
    const result = await provisionEntitlementMembership(
      makeEvent({ type: 'entitlement.revoked', revision: 2 }),
      deps,
    );

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('newer');
    expect(deps.membership.calls).toHaveLength(0);
    expect(deps.sync.revisions['staff-0001|pact-broker']).toBe(2);
  });

  it('entitlement.revoked sau entitlement.granted → membership được tạo trước vẫn còn, không bị xóa (P3.3)', async () => {
    const deps = makeDeps();
    // Granted trước: tạo membership role Member.
    await provisionEntitlementMembership(makeEvent({ revision: 1 }), deps);
    expect(deps.membership.calls).toEqual([
      { tenantId: 'tenant-ecoma-internal', sub: 'staff-0001', role: 'member' },
    ]);

    // Revoked sau: ghi revision, KHÔNG gọi MembershipRepo, membership giữ nguyên.
    const result = await provisionEntitlementMembership(
      makeEvent({ type: 'entitlement.revoked', revision: 2 }),
      deps,
    );

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('newer');
    expect(deps.sync.revisions['staff-0001|pact-broker']).toBe(2);
    // Membership vẫn còn: upsertMember chỉ được gọi 1 lần (lúc granted), không bị xóa.
    expect(deps.membership.calls).toHaveLength(1);
    expect(deps.membership.members['tenant-ecoma-internal|staff-0001']).toBe('member');
  });

  it('entitlement.revoked không gọi MembershipRepo — chỉ ghi sync state (P3.3 isolation)', async () => {
    const deps = makeDeps();
    // Chưa thấy revision nào (null) → revoked revision 1 là 'first', áp dụng revision nhưng KHÔNG tạo membership.
    const result = await provisionEntitlementMembership(
      makeEvent({ type: 'entitlement.revoked', revision: 1 }),
      deps,
    );

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('first');
    // Revoked chỉ ghi sync state, không đụng membership.
    expect(deps.membership.calls).toHaveLength(0);
    expect(deps.sync.revisions['staff-0001|pact-broker']).toBe(1);
  });

  it('hai entitlement.revoked liên tiếp → membership vẫn giữ nguyên, revision tiến lên (P3.3)', async () => {
    const deps = makeDeps();
    await provisionEntitlementMembership(makeEvent({ revision: 1 }), deps);
    expect(deps.membership.members['tenant-ecoma-internal|staff-0001']).toBe('member');

    await provisionEntitlementMembership(
      makeEvent({ type: 'entitlement.revoked', revision: 2 }),
      deps,
    );
    await provisionEntitlementMembership(
      makeEvent({ type: 'entitlement.revoked', revision: 3 }),
      deps,
    );

    expect(deps.sync.revisions['staff-0001|pact-broker']).toBe(3);
    expect(deps.membership.calls).toHaveLength(1); // Chỉ granted tạo membership
    expect(deps.membership.members['tenant-ecoma-internal|staff-0001']).toBe('member');
  });

  it('sản phẩm khác pact-broker → bỏ qua, reason not-product', async () => {
    const deps = makeDeps();
    const result = await provisionEntitlementMembership(makeEvent({ product: 'backoffice' }), deps);

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('not-product');
    expect(deps.membership.calls).toHaveLength(0);
    expect(deps.sync.revisions['staff-0001|backoffice']).toBeUndefined();
  });

  it('envelope không hợp lệ → reason invalid', async () => {
    const deps = makeDeps();
    const result = await provisionEntitlementMembership(
      { ...makeEvent(), revision: 0 } as EntitlementEvent,
      deps,
    );

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('invalid');
    expect(deps.membership.calls).toHaveLength(0);
  });

  it('idempotent: event trùng được gửi hai lần chỉ tạo membership một lần', async () => {
    const deps = makeDeps();
    const event = makeEvent({ revision: 2 });
    await provisionEntitlementMembership(event, deps);
    await provisionEntitlementMembership(event, deps);

    expect(deps.membership.calls).toHaveLength(1);
    expect(deps.sync.revisions['staff-0001|pact-broker']).toBe(2);
  });

  it('hai staff khác nhau có revision độc lập', async () => {
    const deps = makeDeps();
    await provisionEntitlementMembership(makeEvent({ staff_id: 'staff-a', revision: 1 }), deps);
    await provisionEntitlementMembership(makeEvent({ staff_id: 'staff-b', revision: 1 }), deps);

    expect(deps.membership.calls).toEqual([
      { tenantId: 'tenant-ecoma-internal', sub: 'staff-a', role: 'member' },
      { tenantId: 'tenant-ecoma-internal', sub: 'staff-b', role: 'member' },
    ]);
  });

  it('tenant ecoma-internal chỉ tạo một lần dù nhiều staff', async () => {
    const deps = makeDeps();
    await provisionEntitlementMembership(makeEvent({ staff_id: 'staff-a' }), deps);
    await provisionEntitlementMembership(makeEvent({ staff_id: 'staff-b' }), deps);

    expect(Object.keys(deps.membership.tenants)).toEqual(['ecoma-internal']);
  });
});
