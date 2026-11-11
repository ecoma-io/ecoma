/**
 * `PgTenantRepo.ensureDefaultTenant` trên PostgreSQL thật — đường tạo tenant
 * customer mặc định (docs/applications/pact-broker/01-architecture.md §4).
 *
 * Kiểm tra hợp đồng conflict-safety sau khi siết: khi tên đã có, hàng hiện có
 * phải được xác minh TOÀN BỘ (đúng owner_sub, classification 'customer', plan
 * 'free', status 'active') TRƯỚC khi ghi membership nào — sai khớp nào cũng
 * fail-closed với lỗi tường minh, rollback toàn bộ transaction: không gắn
 * caller vào tenant của người khác (canonical `ecoma` hay customer khác),
 * không ghi đè owner/classification/plan, không hồi sinh tenant đã xoá mềm.
 * Tenant canonical được seed qua chính {@link bootstrapCanonicalTenant} mà CLI
 * chạy — một đường code duy nhất; repo được dựng trên pool runtime thật
 * (`createRuntimePool()` — đúng credential Worker nhận qua Hyperdrive).
 *
 * ⚠️ Suite cần Docker: probe hỏng làm `globalSetup` throw và cả run đỏ
 * (fail-loud, 06-testing.md §6) — skip với exit 0 không phải kết quả được
 * chấp nhận.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgTenantRepo } from '@ecoma-io/pact-broker-api-infrastructure';

import { bootstrapCanonicalTenant, CANONICAL_TENANT_NAME } from '../../db/bootstrap-tenant.mts';
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

/** Hàng tenant đầy đủ mọi cột — để so sánh trước/sau các lần bị từ chối. */
async function queryTenantByName(
  db: PactBrokerDatabase,
  name: string,
): Promise<TenantRow | undefined> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<TenantRow>(
      `SELECT id, name, status, classification, plan, owner_sub, created_at
         FROM pact.tenants WHERE name = $1`,
      [name],
    );
    return rows[0];
  } finally {
    await client.end();
  }
}

interface MembershipRow {
  tenant_id: string;
  sub: string;
  role: string;
  source: string | null;
}

/** Toàn bộ membership — để so sánh trước/sau các lần bị từ chối. */
async function queryMemberships(db: PactBrokerDatabase): Promise<MembershipRow[]> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<MembershipRow>(
      `SELECT tenant_id, sub, role, source FROM pact.tenant_members ORDER BY sub`,
    );
    return rows;
  } finally {
    await client.end();
  }
}

/** Seed tenant canonical `ecoma` qua đúng helper bootstrap mà CLI chạy. */
async function seedCanonicalTenant(db: PactBrokerDatabase): Promise<void> {
  const client = await db.asRuntime();
  try {
    await client.query('BEGIN');
    try {
      await bootstrapCanonicalTenant(client, 'sub-owner-bootstrap');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    await client.end();
  }
}

/** Đột biến một cột của tenant có sẵn để dựng trạng thái sai khớp có thể lưu. */
async function mutateTenant(
  db: PactBrokerDatabase,
  name: string,
  assignments: string,
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query(`UPDATE pact.tenants SET ${assignments} WHERE name = $1`, [name]);
  } finally {
    await client.end();
  }
}

describe(`PgTenantRepo.ensureDefaultTenant on ${HARNESS_DATABASE}`, () => {
  let db: PactBrokerDatabase;
  let pool: Awaited<ReturnType<typeof db.createRuntimePool>>;
  let repo: PgTenantRepo;

  beforeAll(async () => {
    db = await startPactBrokerDatabase();
    pool = await db.createRuntimePool();
    repo = new PgTenantRepo(pool);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await db?.stop();
  });

  it('creates an active customer free tenant with the owner written and a member membership on the first call', async () => {
    await db.truncateData();

    const tenant = await repo.ensureDefaultTenant('tenant-customer-1', 'sub-owner-1');
    expect(tenant.id).toBeDefined();
    expect(tenant.name).toBe('tenant-customer-1');
    expect(tenant.status).toBe('active');

    // Hàng tenant: đúng shape đường tạo customer — classification/plan ghi
    // tường minh, owner được lưu.
    const row = await queryTenantByName(db, 'tenant-customer-1');
    expect(row?.id).toBe(tenant.id);
    expect(row?.status).toBe('active');
    expect(row?.classification).toBe('customer');
    expect(row?.plan).toBe('free');
    expect(row?.owner_sub).toBe('sub-owner-1');

    // Membership: đúng một hàng cho owner, role member, không provenance.
    const memberships = await queryMemberships(db);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.tenant_id).toBe(tenant.id);
    expect(memberships[0]?.sub).toBe('sub-owner-1');
    expect(memberships[0]?.role).toBe('member');
    expect(memberships[0]?.source).toBeNull();
  });

  it('is idempotent for the same owner and name and never duplicates or upgrades the membership', async () => {
    await db.truncateData();

    const first = await repo.ensureDefaultTenant('tenant-customer-2', 'sub-owner-2');
    const before = await queryTenantByName(db, 'tenant-customer-2');
    const membershipsBefore = await queryMemberships(db);

    const second = await repo.ensureDefaultTenant('tenant-customer-2', 'sub-owner-2');
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('active');

    // Hàng tenant không đổi (kể cả created_at): no-op không cập nhật hàng.
    const after = await queryTenantByName(db, 'tenant-customer-2');
    expect(after).toEqual(before);

    // Vẫn đúng một membership, role giữ nguyên — DO NOTHING không nâng role.
    const membershipsAfter = await queryMemberships(db);
    expect(membershipsAfter).toEqual(membershipsBefore);
    expect(membershipsAfter).toHaveLength(1);
    expect(membershipsAfter[0]?.sub).toBe('sub-owner-2');
    expect(membershipsAfter[0]?.role).toBe('member');
    expect(membershipsAfter[0]?.source).toBeNull();
  });

  it('rejects a name conflict with the canonical first_party ecoma tenant and mutates nothing', async () => {
    await db.truncateData();
    await seedCanonicalTenant(db);

    const before = await queryTenantByName(db, CANONICAL_TENANT_NAME);
    const membershipsBefore = await queryMemberships(db);
    expect(before?.classification).toBe('first_party');
    expect(before?.plan).toBeNull();

    // Cùng owner_sub của canonical: sai khớp classification phải là lỗi đầu
    // tiên bị ném (owner khớp nên không chặn trước).
    await expect(
      repo.ensureDefaultTenant(CANONICAL_TENANT_NAME, 'sub-owner-bootstrap'),
    ).rejects.toThrow(
      new RegExp(
        `tenant ${CANONICAL_TENANT_NAME} already exists with classification first_party`,
        'u',
      ),
    );

    // Tenant canonical không đổi (mọi cột), không membership nào được thêm.
    expect(await queryTenantByName(db, CANONICAL_TENANT_NAME)).toEqual(before);
    expect(await queryMemberships(db)).toEqual(membershipsBefore);
  });

  it('rejects a name conflict owned by a different customer and adds no membership for the caller', async () => {
    await db.truncateData();

    // Tenant của customer khác: customer/free/active, owner khác.
    await repo.ensureDefaultTenant('tenant-of-other', 'sub-owner-other');

    const before = await queryTenantByName(db, 'tenant-of-other');
    const membershipsBefore = await queryMemberships(db);

    await expect(repo.ensureDefaultTenant('tenant-of-other', 'sub-caller-new')).rejects.toThrow(
      /already exists under a different owner/u,
    );

    // Tenant không đổi và caller KHÔNG được gắn vào tenant đó.
    expect(await queryTenantByName(db, 'tenant-of-other')).toEqual(before);
    expect(await queryMemberships(db)).toEqual(membershipsBefore);
    expect(membershipsBefore.some((m) => m.sub === 'sub-caller-new')).toBe(false);
  });

  it('rejects an existing customer tenant with a paid plan under the same owner and mutates nothing', async () => {
    await db.truncateData();
    await repo.ensureDefaultTenant('tenant-paid', 'sub-owner-paid');
    await mutateTenant(db, 'tenant-paid', `plan = 'paid'`);

    const before = await queryTenantByName(db, 'tenant-paid');
    const membershipsBefore = await queryMemberships(db);

    await expect(repo.ensureDefaultTenant('tenant-paid', 'sub-owner-paid')).rejects.toThrow(
      /already exists with plan paid; expected 'free'/u,
    );

    expect(await queryTenantByName(db, 'tenant-paid')).toEqual(before);
    expect(await queryMemberships(db)).toEqual(membershipsBefore);
  });

  it('rejects an existing customer tenant with suspended status and mutates nothing', async () => {
    await db.truncateData();
    await repo.ensureDefaultTenant('tenant-suspended', 'sub-owner-suspended');
    await mutateTenant(db, 'tenant-suspended', `status = 'suspended'`);

    const before = await queryTenantByName(db, 'tenant-suspended');
    const membershipsBefore = await queryMemberships(db);

    await expect(
      repo.ensureDefaultTenant('tenant-suspended', 'sub-owner-suspended'),
    ).rejects.toThrow(/already exists with status suspended/u);

    expect(await queryTenantByName(db, 'tenant-suspended')).toEqual(before);
    expect(await queryMemberships(db)).toEqual(membershipsBefore);
  });

  it('rejects an existing customer tenant with deleted status and mutates nothing', async () => {
    await db.truncateData();
    await repo.ensureDefaultTenant('tenant-deleted', 'sub-owner-deleted');
    await mutateTenant(db, 'tenant-deleted', `status = 'deleted'`);

    const before = await queryTenantByName(db, 'tenant-deleted');
    const membershipsBefore = await queryMemberships(db);

    await expect(repo.ensureDefaultTenant('tenant-deleted', 'sub-owner-deleted')).rejects.toThrow(
      /already exists with status deleted/u,
    );

    // Fail-closed: tenant đã xoá mềm không được hồi sinh hay nhận thêm member.
    expect(await queryTenantByName(db, 'tenant-deleted')).toEqual(before);
    expect(await queryMemberships(db)).toEqual(membershipsBefore);
  });
});
