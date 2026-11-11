/**
 * Bootstrap tenant canonical `ecoma` trên PostgreSQL thật (ADR-0020,
 * 02-delivery.md §3.2 bước 5a).
 *
 * Gọi đúng core {@link bootstrapCanonicalTenant} mà CLI chạy
 * (runner-canonical, không viết vòng apply riêng) và kiểm tra trạng thái
 * database sau mỗi lần chạy. Đầu vào kết nối lấy từ harness với credential
 * runtime thật (`db.migratorUrl` sinh từ cùng harness đó — CLI sản phẩm nhận
 * đúng shape này qua biến môi trường `DATABASE_URL`).
 *
 * ⚠️ Suite cần Docker: probe hỏng làm `globalSetup` throw và cả run đỏ
 * (fail-loud, 06-testing.md §6) — skip với exit 0 không phải kết quả được
 * chấp nhận.
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
 * Audit detail sắp theo kết quả bootstrap — các lần chạy đồng thời commit
 * theo thứ tự bất kỳ, và jsonb không giữ thứ tự key, nên phép so sánh chạy
 * trên object đã parse với sort key xác định.
 */
function auditDetailsSorted(rows: AuditRow[]): Array<Record<string, string>> {
  return rows
    .map((row) => row.detail as Record<string, string>)
    .toSorted((a, b) => (a['bootstrap'] ?? '').localeCompare(b['bootstrap'] ?? ''));
}

/** Audit detail kỳ vọng của một lần created và một lần no-op, cùng thứ tự sort. */
function expectedAuditDetailsSorted(): Array<Record<string, string>> {
  return [
    { bootstrap: 'already_existed', tenant: CANONICAL_TENANT_NAME, membership: 'verified' },
    { bootstrap: 'created', tenant: CANONICAL_TENANT_NAME, membership: 'created' },
  ];
}

/**
 * Một lần bootstrap bọc trong đúng transaction mà CLI thực hiện
 * (BEGIN → bootstrap → COMMIT, ROLLBACK khi lỗi), trên credential runtime
 * thật.
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

    // Tenant: active, first_party, không có plan, owner được ghi.
    const tenants = await queryTenant(db);
    expect(tenants).toHaveLength(1);
    expect(tenants[0]?.id).toBe(result.tenantId);
    expect(tenants[0]?.status).toBe('active');
    expect(tenants[0]?.classification).toBe('first_party');
    expect(tenants[0]?.plan).toBeNull();
    expect(tenants[0]?.owner_sub).toBe('sub-owner-bootstrap');

    // Membership: đúng một membership owner, role member, source bootstrap,
    // staff_id NULL (chỉ dành cho ánh xạ entitlement).
    const memberships = await queryMemberships(db);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.tenant_id).toBe(result.tenantId);
    expect(memberships[0]?.sub).toBe('sub-owner-bootstrap');
    expect(memberships[0]?.role).toBe('member');
    expect(memberships[0]?.source).toBe('bootstrap');
    expect(memberships[0]?.staff_id).toBeNull();

    // Audit: đúng một event cho lần chạy created.
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

    // Bootstrap không seed machine token nào.
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
    // created_at không đổi: no-op không cập nhật hàng đã có.
    expect(after[0]?.created_at.getTime()).toBe(beforeCreatedAt?.getTime());

    // Membership vẫn đúng một hàng với shape bootstrap.
    const memberships = await queryMemberships(db);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe('member');
    expect(memberships[0]?.source).toBe('bootstrap');

    // Lần chạy no-op ghi audit event của riêng nó: created + already_existed.
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

    // Lần chạy bị từ chối không ghi gì: ownership giữ nguyên, không
    // membership cho sub thứ hai, không audit event.
    const tenants = await queryTenant(db);
    expect(tenants).toHaveLength(1);
    expect(tenants[0]?.owner_sub).toBe('sub-owner-bootstrap');

    const memberships = await queryMemberships(db);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.sub).toBe('sub-owner-bootstrap');

    expect(await queryBootstrapAuditEvents(db)).toHaveLength(1);
  });

  it('converges when two connections bootstrap concurrently', async () => {
    // Reset để lần chạy này là lần tạo đầu tiên: truncate mọi bảng domain mà
    // không đụng DDL/grants/trigger (harness cung cấp đúng vậy).
    await db.truncateData();

    // Mỗi bên bọc BEGIN/COMMIT quanh một lần bootstrap — đúng transaction
    // mà CLI thực hiện. ⚠️ COMMIT phải nằm BÊN TRONG promise của từng bên:
    // nếu commit xảy ra sau Promise.all, bên thua sẽ bị chặn trên lock của
    // bên thắng trong khi bên thắng đang chờ Promise.all — một deadlock tự
    // làm ra, lock còn giữ sẽ kéo timeout lan sang các test phía sau.
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

      // Đúng một bên created, một bên already-existed; cả hai kết quả trỏ về
      // cùng tenant id — không fatal error (ADR-0020 quyết định 5).
      expect([resultA.alreadyExisted, resultB.alreadyExisted].toSorted()).toEqual([false, true]);
      expect(resultA.tenantId).toBe(resultB.tenantId);
    } finally {
      await clientA.end();
      await clientB.end();
    }

    // Hội tụ: một tenant, một membership owner, một audit row mỗi lần chạy.
    const tenants = await queryTenant(db);
    expect(tenants).toHaveLength(1);

    const memberships = await queryMemberships(db);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe('member');
    expect(memberships[0]?.source).toBe('bootstrap');

    const audit = await queryBootstrapAuditEvents(db);
    expect(audit).toHaveLength(2);
    expect(auditDetailsSorted(audit)).toEqual(expectedAuditDetailsSorted());

    // Dọn audit trail để các assert đếm của test sau không thừa hưởng entry
    // từ race này.
    await db.truncateData();
  });

  it('refuses to resurrect an existing suspended tenant', async () => {
    // Reset về trạng thái sạch rồi tạo tenant bằng chính script: không được
    // giả định trạng thái do test trước để lại (mỗi it chịu trách nhiệm cho
    // dữ liệu đầu vào của nó).
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

    // Lần chạy bị từ chối giữ nguyên trạng thái suspended và không ghi audit.
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

    // Dựng trước một tenant shape customer: hợp lệ theo constraint của schema
    // (customer ⇒ plan free/paid), nhưng không phải trạng thái no-op hợp lệ
    // của bootstrap. (Tenant first_party CÓ plan không thể tạo qua SQL —
    // tenants_plan_only_when_customer_check cấm — nên shape customer là
    // mismatch classification có thể lưu được.)
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

    // Lần chạy bị từ chối không ghi đè classification hay plan, và không
    // ghi audit.
    const after = await queryTenant(db);
    expect(after[0]?.classification).toBe('customer');
    expect(after[0]?.plan).toBe('free');
    expect(await queryBootstrapAuditEvents(db)).toHaveLength(1);
  });

  it('fails closed on a conflicting owner membership role or provenance', async () => {
    await db.truncateData();
    await runBootstrapped(db, 'sub-owner-bootstrap');

    // Dựng trước role xung đột trên membership owner.
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

    // Dựng trước role đúng nhưng provenance xung đột.
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

    // Cả hai lần chạy bị từ chối giữ nguyên membership và audit (trạng thái
    // dựng cuối là provenance entitlement).
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
      // Một client fail đúng bước membership: INSERT tenant đã thành công
      // trước đó, nên chỉ ROLLBACK do caller quản lý mới hoàn tác được —
      // chứng minh tenant + membership + audit là atomic theo từng lần chạy.
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

      // Không có gì được lưu: không hàng tenant, không membership, không
      // audit event.
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
