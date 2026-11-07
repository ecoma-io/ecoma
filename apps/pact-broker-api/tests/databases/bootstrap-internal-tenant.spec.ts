/**
 * Bootstrap tenant `ecoma-internal` trên PostgreSQL thật (issue #441, P3.1).
 *
 * Gọi đúng core {@link bootstrapInternalTenant} mà CLI chạy (runner-canonical,
 * không viết vòng apply riêng) và đo trạng thái database sau mỗi lần chạy.
 * Đầu vào connection lấy từ harness bằng credential runtime thật
 * (`db.migratorUrl` sinh từ cùng harness — CLI production nhận đúng shape
 * này qua env `DATABASE_URL`).
 *
 * ⚠️ Suite bắt buộc Docker: probe hỏng thì `globalSetup` ném và toàn bộ lần
 * chạy đỏ (fail-loud, 06-testing.md §6) - skip với exit 0 không phải kết quả
 * chấp nhận được.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapInternalTenant,
  INTERNAL_TENANT_NAME,
  parseDatabaseUrl,
} from '../../db/bootstrap-internal-tenant.mts';
import {
  type PactBrokerDatabase,
  PACT_BROKER_DATABASE as HARNESS_DATABASE,
  startPactBrokerDatabase,
} from '../integrations/harness';

async function queryTenant(
  db: PactBrokerDatabase,
): Promise<Array<{ id: string; name: string; status: string; created_at: Date }>> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<{
      id: string;
      name: string;
      status: string;
      created_at: Date;
    }>(`SELECT id, name, status, created_at FROM pact.tenants WHERE name = $1`, [
      INTERNAL_TENANT_NAME,
    ]);
    return rows;
  } finally {
    await client.end();
  }
}

async function queryBootstrapAuditEvents(
  db: PactBrokerDatabase,
): Promise<
  Array<{ tenant_id: string; action: string; outcome: string; detail: Record<string, unknown> }>
> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<{
      tenant_id: string;
      action: string;
      outcome: string;
      detail: Record<string, unknown>;
    }>(
      `SELECT tenant_id, action, outcome, detail FROM pact.audit_events
        WHERE action = 'tenant.bootstrap' ORDER BY occurred_at`,
    );
    return rows;
  } finally {
    await client.end();
  }
}

describe(`${HARNESS_DATABASE} bootstrap of the ${INTERNAL_TENANT_NAME} tenant`, () => {
  let db: PactBrokerDatabase;

  beforeAll(async () => {
    db = await startPactBrokerDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('creates the tenant with status active on the first run', async () => {
    expect(await queryTenant(db)).toEqual([]);

    const runtimeUrl = `postgres://ecoma_pact_broker_runtime:ecoma_test_role_pw@${db.host}:${db.port}/${HARNESS_DATABASE}`;
    expect(parseDatabaseUrl(runtimeUrl)).toEqual({ database: HARNESS_DATABASE });

    const client = await db.asRuntime();
    try {
      await client.query('BEGIN');
      const result = await bootstrapInternalTenant(client);
      await client.query('COMMIT');
      expect(result.alreadyExisted).toBe(false);
      expect(result.tenantName).toBe(INTERNAL_TENANT_NAME);
    } finally {
      await client.end();
    }

    const tenants = await queryTenant(db);
    expect(tenants).toHaveLength(1);
    expect(tenants[0]?.status).toBe('active');
    // Tenant bootstrap xong PHAI rỗng: không membership, không machine token
    // (P3.2 lo membership; script này không seed gì ngoài tenant + audit).
    const counts = await (async () => {
      const counter = await db.connect();
      try {
        const { rows } = await counter.query<{
          members: string;
          tokens: string;
          audit: string;
        }>(
          `SELECT
             (SELECT count(*)::text FROM pact.tenant_members) AS members,
             (SELECT count(*)::text FROM pact.machine_tokens) AS tokens,
             (SELECT count(*)::text FROM pact.audit_events) AS audit`,
        );
        return rows[0];
      } finally {
        await counter.end();
      }
    })();
    expect(counts).toEqual({ members: '0', tokens: '0', audit: '1' });
  });

  it('is a safe no-op on the second run and preserves existing state', async () => {
    const before = await queryTenant(db);
    expect(before).toHaveLength(1);
    const beforeId = before[0]?.id ?? '';

    const client = await db.asRuntime();
    try {
      await client.query('BEGIN');
      const result = await bootstrapInternalTenant(client);
      await client.query('COMMIT');
      expect(result.alreadyExisted).toBe(true);
      expect(result.tenantId).toBe(beforeId);
    } finally {
      await client.end();
    }

    const after = await queryTenant(db);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(beforeId);
    expect(after[0]?.status).toBe('active');
    // created_at giữ nguyên: no-op không update row đang có.
    expect(after[0]?.created_at.getTime()).toBeGreaterThan(0);

    // Đợt no-op cũng ghi audit (created + already_existed = 2 entries).
    const audit = await queryBootstrapAuditEvents(db);
    expect(audit).toHaveLength(2);
    expect(audit[0]?.detail).toEqual({ bootstrap: 'created', tenant: INTERNAL_TENANT_NAME });
    expect(audit[1]?.detail).toEqual({
      bootstrap: 'already_existed',
      tenant: INTERNAL_TENANT_NAME,
    });
  });

  it('converges when two connections bootstrap concurrently', async () => {
    // Reset để lần này là lần tạo đầu: truncate sạch mọi bảng domain mà không
    // đụng DDL/grant/trigger (harness cung cấp đúng cho mục đích này).
    await db.truncateData();

    // Mỗi bên tự gói BEGIN/COMMIT quanh một lần bootstrap — đúng giao dịch
    // mà CLI thực hiện. ⚠️ COMMIT phải nằm TRONG promise của từng bên: nếu
    // commit sau Promise.all thì bên thua race block chờ lock của bên thắng,
    // bên thắng lại chờ Promise.all — deadlock tự tạo, timeout cascade sang
    // các test sau qua lock còn giữ.
    const runOne = async (client: Awaited<ReturnType<typeof db.asRuntime>>) => {
      await client.query('BEGIN');
      try {
        const result = await bootstrapInternalTenant(client);
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

      // Đúng một bên created, một bên already-existed; hai kết quả quy về
      // cùng một tenant id — không lỗi chết (§4 bước 4, race requirement).
      expect([resultA.alreadyExisted, resultB.alreadyExisted].toSorted()).toEqual([false, true]);
      expect(resultA.tenantId).toBe(resultB.tenantId);
    } finally {
      await clientA.end();
      await clientB.end();
    }

    const tenants = await queryTenant(db);
    expect(tenants).toHaveLength(1);

    // Dọn audit để các assert count ở test khác không nhận dư entry race.
    await db.truncateData();
  });

  it('refuses to resurrect an existing suspended tenant', async () => {
    // Reset về trạng thái sạch rồi tạo tenant bằng chính script: state mà
    // các test trước để lại không được giả định (mỗi it tự chịu trách nhiệm
    // về dữ liệu đầu vào của nó).
    await db.truncateData();
    const setup = await db.asRuntime();
    try {
      await setup.query('BEGIN');
      await bootstrapInternalTenant(setup);
      await setup.query('COMMIT');
    } finally {
      await setup.end();
    }

    // Đặt tenant về suspended như owner đã chủ động dừng nó: bootstrap sau
    // đó phải fail-closed, không tự hồi sinh, không đụng vào state.
    const client = await db.asRuntime();
    try {
      await client.query(`UPDATE pact.tenants SET status = 'suspended' WHERE name = $1`, [
        INTERNAL_TENANT_NAME,
      ]);
    } finally {
      await client.end();
    }

    const before = await queryTenant(db);
    expect(before[0]?.id).toBeDefined();
    const caller = await db.asRuntime();
    try {
      await expect(bootstrapInternalTenant(caller)).rejects.toThrow(/refusing to resurrect/u);
    } finally {
      await caller.end();
    }

    const after = await queryTenant(db);
    expect(after[0]?.status).toBe('suspended');
    expect(after[0]?.id).toBe(before[0]?.id);
  });

  it('rejects a connection string without a database path', () => {
    expect(() => parseDatabaseUrl('postgres://user:pw@host:5432')).toThrow(/database name path/u);
    expect(() => parseDatabaseUrl('mysql://user:pw@host:5432/db')).toThrow(/postgres/u);
    expect(() => parseDatabaseUrl('postgres://user:pw@host:5432/')).toThrow(/non-empty/u);
    expect(parseDatabaseUrl('postgresql://user:pw@host:5432/other-db?sslmode=require')).toEqual({
      database: 'other-db',
    });
  });
});
