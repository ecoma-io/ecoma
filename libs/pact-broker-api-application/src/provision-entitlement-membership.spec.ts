/**
 * Unit test cho `provisionEntitlementMembership` — fakes in-memory, không
 * dependency thật (PostgreSQL, Hono). Ghi các hành vi cốt lõi (P3.2, issue #21
 * — serving path read-only, không tạo tenant):
 *
 * - grant/revoke chỉ ĐỌC tenant canonical `ecoma` qua `getTenantByName`;
 *   fake không có khả năng tạo tenant — test tự seed tenant
 * - grant với tenant thiếu hoặc không active → throw fail-closed, KHÔNG ghi
 *   gì (không revision, không membership)
 * - granted + product pact-broker, chưa thấy revision → applied, reason 'first'
 * - granted + revision cao hơn → applied, reason 'newer'
 * - granted + revision trùng → không áp dụng, reason 'duplicate'
 * - granted + revision thấp hơn → không áp dụng, reason 'stale'
 * - entitlement.revoked: CAS revision TRƯỚC, sau đó mới lookup tenant —
 *   thiếu tenant → reason 'no-tenant' nhưng revision ĐÃ tiến; có tenant →
 *   mark projection revoked, KHÔNG upsert, KHÔNG xóa membership (P3.3 sở hữu
 *   logic thu hồi)
 * - sản phẩm khác 'pact-broker' → bỏ qua, reason 'not-product'
 * - envelope không hợp lệ (vì shouldApplyEntitlementEvent validate) → reason 'invalid'
 */

import { describe, expect, it } from 'vitest';

import type { EntitlementEvent } from '@ecoma-io/staff-access-contracts';
import {
  CANONICAL_TENANT_NAME,
  CanonicalTenantUnavailableError,
  type EntitlementSyncRepo,
  type MembershipRepo,
  type TenantLookup,
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

/** Id tenant canonical dùng trong mọi assert của spec này. */
const CANONICAL_TENANT_ID = 'tenant-ecoma';

class FakeMembershipRepo implements MembershipRepo {
  /** Các lần upsertMember — revoke không được phép gọi. */
  readonly calls: Array<{ tenantId: string; sub: string; role: string }> = [];
  /** Hàng tenant seed theo name — fake chỉ trả những gì test seed, không tự tạo. */
  readonly tenants: Record<string, TenantLookup> = {};
  readonly members: Record<string, string> = {}; // `${tenantId}|${sub}` → role
  readonly revoked: Record<string, { eventId: string; revision: number } | undefined> = {};
  /** Log tuần tự dùng chung với sync fake — chứng minh thứ tự lookup/CAS/upsert. */
  readonly ops: string[];

  constructor(ops: string[] = []) {
    this.ops = ops;
  }

  async getTenantByName(name: string): Promise<TenantLookup | null> {
    this.ops.push(`lookup:${name}`);
    return this.tenants[name] ?? null;
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
    this.ops.push('upsertMember');
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
    this.ops.push('markEntitlementRevoked');
    this.revoked[`${tenantId}|${sub}`] = { eventId, revision };
  }
}

class FakeEntitlementSyncRepo implements EntitlementSyncRepo {
  readonly revisions: Record<string, number | null> = {}; // `${staffId}|${product}` → revision | null
  /** Cùng mảng log với membership fake — thứ tự writeRevision đọc được từ đây. */
  readonly ops: string[];

  constructor(ops: string[] = []) {
    this.ops = ops;
  }

  async readRevision(staffId: string, product: string): Promise<number | null> {
    return this.revisions[`${staffId}|${product}`] ?? null;
  }

  async writeRevision(staffId: string, product: string, revision: number): Promise<boolean> {
    const current = this.revisions[`${staffId}|${product}`] ?? null;
    if (current !== null && revision <= current) {
      return false;
    }
    this.ops.push('writeRevision');
    this.revisions[`${staffId}|${product}`] = revision;
    return true;
  }
}

/**
 * Dự deps với log tuần tự dùng chung. Mặc định seed tenant canonical active
 * — đường hưởng thụ bình thường của serving path; `false` để mô phỏng tenant
 * canonical chưa được bootstrap.
 */
function makeDeps(seedCanonicalTenant = true): {
  membership: FakeMembershipRepo;
  sync: FakeEntitlementSyncRepo;
  ops: string[];
} {
  const ops: string[] = [];
  const membership = new FakeMembershipRepo(ops);
  const sync = new FakeEntitlementSyncRepo(ops);
  if (seedCanonicalTenant) {
    membership.tenants[CANONICAL_TENANT_NAME] = {
      id: CANONICAL_TENANT_ID,
      name: CANONICAL_TENANT_NAME,
      status: 'active',
    };
  }
  return { membership, sync, ops };
}

describe('provisionEntitlementMembership', () => {
  it('grants for pact-broker apply membership Member on the canonical tenant with reason first, lookup before the revision CAS', async () => {
    const deps = makeDeps();
    const result = await provisionEntitlementMembership(makeEvent(), deps);

    expect(result.applied).toBe(true);
    expect(result.reason).toBe('first');
    expect(deps.membership.calls).toEqual([
      { tenantId: CANONICAL_TENANT_ID, sub: 'staff-0001', role: 'member' },
    ]);
    expect(deps.sync.revisions['staff-0001|pact-broker']).toBe(1);
    // Thứ tự: lookup read-only TRƯỚC CAS TRƯỚC upsert — lookup fail-closed
    // trước CAS bảo đảm không side effect nào được ghi.
    expect(deps.ops).toEqual(['lookup:ecoma', 'writeRevision', 'upsertMember']);
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
    // Projection revoked được mark trên tenant canonical (membership đã
    // confluent nếu có — SQL chỉ áp source='entitlement').
    expect(deps.membership.revoked[`${CANONICAL_TENANT_ID}|staff-0001`]).toEqual({
      eventId: '0f0e0d0c-0b0a-4928-8276-001122334455',
      revision: 2,
    });
  });

  it('entitlement.revoked sau entitlement.granted → membership được tạo trước vẫn còn, không bị xóa (P3.3)', async () => {
    const deps = makeDeps();
    // Granted trước: upsert membership role Member.
    await provisionEntitlementMembership(makeEvent({ revision: 1 }), deps);
    expect(deps.membership.calls).toEqual([
      { tenantId: CANONICAL_TENANT_ID, sub: 'staff-0001', role: 'member' },
    ]);

    // Revoked sau: ghi revision, mark projection — KHÔNG upsert thêm, KHÔNG xóa.
    const result = await provisionEntitlementMembership(
      makeEvent({ type: 'entitlement.revoked', revision: 2 }),
      deps,
    );

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('newer');
    expect(deps.sync.revisions['staff-0001|pact-broker']).toBe(2);
    // Membership vẫn còn: upsertMember chỉ được gọi 1 lần (lúc granted), không bị xóa.
    expect(deps.membership.calls).toHaveLength(1);
    expect(deps.membership.members[`${CANONICAL_TENANT_ID}|staff-0001`]).toBe('member');
  });

  it('revoked with the canonical tenant present marks only the entitlement projection and never upserts membership (P3.3 isolation)', async () => {
    const deps = makeDeps();
    // Chưa thấy revision nào (null) → revoked revision 1 là 'first', áp dụng
    // revision nhưng KHÔNG tạo membership.
    const result = await provisionEntitlementMembership(
      makeEvent({ type: 'entitlement.revoked', revision: 1 }),
      deps,
    );

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('first');
    // Revoked chỉ ghi sync state + mark projection; không upsert membership nào.
    expect(deps.ops).toEqual(['writeRevision', 'lookup:ecoma', 'markEntitlementRevoked']);
    expect(deps.membership.calls).toHaveLength(0);
    expect(deps.sync.revisions['staff-0001|pact-broker']).toBe(1);
  });

  it('hai entitlement.revoked liên tiếp → membership vẫn giữ nguyên, revision tiến lên (P3.3)', async () => {
    const deps = makeDeps();
    await provisionEntitlementMembership(makeEvent({ revision: 1 }), deps);
    expect(deps.membership.members[`${CANONICAL_TENANT_ID}|staff-0001`]).toBe('member');

    await provisionEntitlementMembership(
      makeEvent({ type: 'entitlement.revoked', revision: 2 }),
      deps,
    );
    await provisionEntitlementMembership(
      makeEvent({ type: 'entitlement.revoked', revision: 3 }),
      deps,
    );

    expect(deps.sync.revisions['staff-0001|pact-broker']).toBe(3);
    expect(deps.membership.calls).toHaveLength(1); // Chỉ granted upsert membership
    expect(deps.membership.members[`${CANONICAL_TENANT_ID}|staff-0001`]).toBe('member');
  });

  it('sản phẩm khác pact-broker → bỏ qua, reason not-product', async () => {
    const deps = makeDeps();
    const result = await provisionEntitlementMembership(makeEvent({ product: 'backoffice' }), deps);

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('not-product');
    expect(deps.membership.calls).toHaveLength(0);
    expect(deps.sync.revisions['staff-0001|backoffice']).toBeUndefined();
    // Bỏ qua sớm: không lookup tenant, không đụng revision.
    expect(deps.ops).toEqual([]);
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
    expect(deps.ops).toEqual([]);
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
      { tenantId: CANONICAL_TENANT_ID, sub: 'staff-a', role: 'member' },
      { tenantId: CANONICAL_TENANT_ID, sub: 'staff-b', role: 'member' },
    ]);
  });

  it('every grant and revoke lookup targets the canonical tenant name ecoma', async () => {
    const deps = makeDeps();
    await provisionEntitlementMembership(makeEvent({ staff_id: 'staff-a' }), deps);
    await provisionEntitlementMembership(
      makeEvent({ staff_id: 'staff-b', type: 'entitlement.revoked', revision: 2 }),
      deps,
    );

    expect(CANONICAL_TENANT_NAME).toBe('ecoma');
    expect(deps.ops.filter((op) => op.startsWith('lookup:'))).toEqual([
      'lookup:ecoma',
      'lookup:ecoma',
    ]);
  });

  it('grant with a missing canonical tenant throws fail-closed and performs no write', async () => {
    // Không seed tenant nào — serving path không có khả năng tự tạo.
    const deps = makeDeps(false);

    await expect(provisionEntitlementMembership(makeEvent(), deps)).rejects.toThrow(
      CanonicalTenantUnavailableError,
    );

    // Không side effect: không revision write, không membership write.
    expect(deps.ops).toEqual(['lookup:ecoma']);
    expect(deps.sync.revisions['staff-0001|pact-broker']).toBeUndefined();
    expect(deps.membership.calls).toHaveLength(0);
  });

  it('grant with a suspended canonical tenant throws fail-closed and performs no write', async () => {
    const deps = makeDeps(false);
    deps.membership.tenants[CANONICAL_TENANT_NAME] = {
      id: CANONICAL_TENANT_ID,
      name: CANONICAL_TENANT_NAME,
      status: 'suspended',
    };

    await expect(provisionEntitlementMembership(makeEvent(), deps)).rejects.toThrow(
      /canonical tenant ecoma is suspended/u,
    );

    expect(deps.ops).toEqual(['lookup:ecoma']);
    expect(deps.sync.revisions['staff-0001|pact-broker']).toBeUndefined();
    expect(deps.membership.calls).toHaveLength(0);
  });

  it('revoked with a missing canonical tenant returns no-tenant with the revision already advanced by the CAS', async () => {
    const deps = makeDeps(false);

    const result = await provisionEntitlementMembership(
      makeEvent({ type: 'entitlement.revoked', revision: 1 }),
      deps,
    );

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('no-tenant');
    // CAS đã chạy TRƯỚC lookup — revision tiến dù tenant thiếu (không rollback).
    expect(deps.ops).toEqual(['writeRevision', 'lookup:ecoma']);
    expect(deps.sync.revisions['staff-0001|pact-broker']).toBe(1);
    expect(deps.membership.calls).toHaveLength(0);
  });
});
