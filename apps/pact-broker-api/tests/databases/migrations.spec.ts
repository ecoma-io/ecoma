/**
 * Apply migration lên PostgreSQL thật và đo trạng thái sau đó.
 *
 * ⚠️ Suite bắt buộc Docker: probe hỏng thì `globalSetup` ném và toàn bộ lần chạy
 * đỏ (fail-loud, 06-testing.md §6) - skip với exit 0 không phải kết quả chấp
 * nhận được.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyAllMigrations } from '../../db/apply.mts';
import {
  type PactBrokerDatabase,
  PACT_BROKER_DATABASE,
  startPactBrokerDatabase,
} from '../integrations/harness.ts';

/** 14 bảng của migration `0001` — thêm bảng ở migration mới là thêm ở đây. */
const EXPECTED_TABLES = [
  'audit_events',
  'deployed_versions',
  'entitlement_sync_state',
  'environments',
  'internal_nonces',
  'machine_tokens',
  'pacticipants',
  'pacts',
  'tags',
  'tenant_members',
  'tenants',
  'verifications',
  'versions',
  'webhook_executions',
  'webhooks',
];

async function tableNames(db: PactBrokerDatabase): Promise<string[]> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'pact' ORDER BY table_name`,
    );
    return rows.map((row) => row.table_name);
  } finally {
    await client.end();
  }
}

describe(`${PACT_BROKER_DATABASE} migrations on a real PostgreSQL`, () => {
  let db: PactBrokerDatabase;

  beforeAll(async () => {
    db = await startPactBrokerDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('applies every migration file from an empty database', async () => {
    expect(await tableNames(db)).toEqual(EXPECTED_TABLES);
  });

  it('is repeatable: re-applying every file changes nothing', async () => {
    // Gọi applyAllMigrations THÊM HAI LẦN trên database đã apply. KHÔNG có
    // ledger: runner áp dụng mọi file mỗi lần và idempotency là tính chất của
    // từng câu DDL (CREATE IF NOT EXISTS, grant lặp được) — nên `applied` luôn
    // đếm số file xử lý, không phải số file "mới". Điều phải giữ nguyên là
    // trạng thái database, đo bằng danh sách bảng.
    const migrator = await db.connectAsMigrator();
    try {
      const first = await applyAllMigrations(migrator);
      expect(first.applied).toBe(3);
      const second = await applyAllMigrations(migrator);
      expect(second.applied).toBe(3);
    } finally {
      await migrator.end();
    }

    expect(await tableNames(db)).toEqual(EXPECTED_TABLES);
  });

  it(
    'reports zero applied on a fresh database only through the real runner',
    // Thân test start MỘT container PostgreSQL mới (testcontainers + provision +
    // apply migrations) — cùng chi phí mà `beforeAll` chịu và `beforeAll` được
    // cấp 180s. testTimeout mặc định 5s chỉ đủ cho thao tác DB thuần; trên CI
    // 4 vCPU đang chạy song song các worker khác, start container vượt 5s và
    // test đỏ vì hết giờ chứ không phải vì counter sai.
    { timeout: 180_000 },
    async () => {
      // `applied` đếm file chạy trong lần gọi: lần đầu trên database trống phải
      // là 2 (hai file), chứng minh counter không phải luôn 0 — nếu counter hỏng
      // thì CLI in "0 file(s) applied" trong khi schema có mặt.
      const fresh = await startPactBrokerDatabase();
      try {
        const migrator = await fresh.connectAsMigrator();
        try {
          const result = await applyAllMigrations(migrator);
          expect(result.applied).toBe(3);
          expect(result.tablesInPactSchema).toBe(EXPECTED_TABLES.length);
        } finally {
          await migrator.end();
        }
      } finally {
        await fresh.stop();
      }
    },
  );

  it('leaves the runtime role able to do DML and nothing else', async () => {
    const runtime = await db.asRuntime();
    try {
      // DML được: INSERT tenant là hành vi bình thường của Worker.
      await runtime.query(`INSERT INTO pact.tenants (name) VALUES ('grant-probe')`);

      // DDL bị từ chối: runtime không sở hữu schema, không có CREATE.
      await expect(
        runtime.query(`CREATE TABLE pact.grant_probe_should_fail (id int)`),
      ).rejects.toThrow(/permission denied/u);
    } finally {
      await runtime.end();
    }
  });

  it('keeps audit_events append-only at the database level', async () => {
    const runtime = await db.asRuntime();
    try {
      await runtime.query(
        `INSERT INTO pact.audit_events (action, outcome) VALUES ('grant-probe', 'success')`,
      );
      const before = await runtime.query<{ event_id: string }>(
        `SELECT event_id FROM pact.audit_events WHERE action = 'grant-probe'`,
      );
      // Hai lớp append-only, cả hai phải chặn: (1) grant của runtime KHÔNG có
      // UPDATE → "permission denied"; (2) trigger chặn UPDATE từ role nào có
      // grant (migrator) → "append-only". Lớp (2) test bằng migrator.
      await expect(
        runtime.query(`UPDATE pact.audit_events SET action = 'rewritten'`),
      ).rejects.toThrow(/permission denied/u);

      const migrator = await db.connectAsMigrator();
      try {
        await expect(
          migrator.query(`UPDATE pact.audit_events SET action = 'rewritten'`),
        ).rejects.toThrow(/append-only/u);
      } finally {
        await migrator.end();
      }
      // DELETE runtime KHÔNG được — grant chỉ SELECT+INSERT: retention là
      // thao tác của owner hạ tầng (migrator), không phải của caller API.
      await expect(
        runtime.query(`DELETE FROM pact.audit_events WHERE action = 'grant-probe'`),
      ).rejects.toThrow(/permission denied/u);
      expect(before.rows).toHaveLength(1);
    } finally {
      await runtime.end();
    }
  });

  it('enforces tenant boundary through composite FKs, not code WHEREs', async () => {
    const runtime = await db.asRuntime();
    try {
      await runtime.query(`INSERT INTO pact.tenants (name) VALUES ('fk-a')`);
      await runtime.query(`INSERT INTO pact.tenants (name) VALUES ('fk-b')`);
      await runtime.query(
        `INSERT INTO pact.pacticipants (tenant_id, name)
         SELECT id, 'consumer-a' FROM pact.tenants WHERE name = 'fk-a'`,
      );

      // Bảng con tham chiếu version của tenant A nhưng khai tenant B →
      // composite FK (tenant_id, id) từ chối ngay ở DB, không phụ thuộc WHERE.
      await expect(
        runtime.query(
          `INSERT INTO pact.versions (tenant_id, pacticipant_id, number)
           SELECT (SELECT id FROM pact.tenants WHERE name = 'fk-b'), p.id, '1.0.0'
             FROM pact.pacticipants p WHERE p.name = 'consumer-a'`,
        ),
      ).rejects.toThrow(/versions_pacticipant_fk|foreign key/u);
      // Ngược lại: bảng con khai đúng tenant của cha thì được.
      await expect(
        runtime.query(
          `INSERT INTO pact.versions (tenant_id, pacticipant_id, number)
           SELECT (SELECT id FROM pact.tenants WHERE name = 'fk-a'), p.id, '1.0.0'
             FROM pact.pacticipants p WHERE p.name = 'consumer-a'`,
        ),
      ).resolves.toBeTruthy();
    } finally {
      await runtime.end();
    }
  });

  it('allows one active deployment per version+environment and keeps undeployed history', async () => {
    const runtime = await db.asRuntime();
    try {
      await runtime.query(`INSERT INTO pact.tenants (name) VALUES ('deploy-probe')`);
      await runtime.query(
        `INSERT INTO pact.pacticipants (tenant_id, name)
         SELECT id, 'svc' FROM pact.tenants WHERE name = 'deploy-probe'`,
      );
      await runtime.query(
        `INSERT INTO pact.versions (tenant_id, pacticipant_id, number)
         SELECT t.id, p.id, '1.0.0' FROM pact.tenants t, pact.pacticipants p
          WHERE t.name = 'deploy-probe' AND p.name = 'svc' AND p.tenant_id = t.id`,
      );
      await runtime.query(
        `INSERT INTO pact.environments (tenant_id, name)
         SELECT id, 'prod' FROM pact.tenants WHERE name = 'deploy-probe'`,
      );

      const first = await runtime.query<{ id: string }>(
        `INSERT INTO pact.deployed_versions (tenant_id, version_id, environment_id)
         SELECT v.tenant_id, v.id, e.id FROM pact.versions v, pact.environments e
          WHERE v.number = '1.0.0' AND e.name = 'prod' AND v.tenant_id = e.tenant_id
         RETURNING id`,
      );
      expect(first.rows).toHaveLength(1);

      // Đang deploy mà record lại → partial unique chặn (một hàng active).
      await expect(
        runtime.query(
          `INSERT INTO pact.deployed_versions (tenant_id, version_id, environment_id)
           SELECT v.tenant_id, v.id, e.id FROM pact.versions v, pact.environments e
            WHERE v.number = '1.0.0' AND e.name = 'prod' AND v.tenant_id = e.tenant_id`,
        ),
      ).rejects.toThrow(/deployed_versions_active_key/u);

      // Undeploy hàng cũ thì INSERT mới hợp lệ — re-record semantics upstream.
      await runtime.query(`UPDATE pact.deployed_versions SET undeployed_at = now() WHERE id = $1`, [
        first.rows[0]?.id,
      ]);
      await runtime.query(
        `INSERT INTO pact.deployed_versions (tenant_id, version_id, environment_id)
         SELECT v.tenant_id, v.id, e.id FROM pact.versions v, pact.environments e
          WHERE v.number = '1.0.0' AND e.name = 'prod' AND v.tenant_id = e.tenant_id`,
      );
      const history = await runtime.query<{ undeployed: boolean }>(
        `SELECT (undeployed_at IS NOT NULL) AS undeployed FROM pact.deployed_versions
          ORDER BY deployed_at`,
      );
      expect(history.rows.map((r) => r.undeployed)).toEqual([true, false]);
    } finally {
      await runtime.end();
    }
  });

  it('rejects a webhook whose url is not https', async () => {
    const runtime = await db.asRuntime();
    try {
      await runtime.query(`INSERT INTO pact.tenants (name) VALUES ('wh-probe')`);
      await runtime.query(
        `INSERT INTO pact.pacticipants (tenant_id, name)
         SELECT id, 'provider' FROM pact.tenants WHERE name = 'wh-probe'`,
      );
      // CHECK `url ~ '^https://'` chặn ở DB — SR-006 giữ nguyên cả khi code lỗi.
      await expect(
        runtime.query(
          `INSERT INTO pact.webhooks (tenant_id, provider_id, events, url)
           SELECT t.id, p.id, 'contract_published', 'http://insecure.example/hook'
             FROM pact.tenants t, pact.pacticipants p
            WHERE t.name = 'wh-probe' AND p.name = 'provider' AND p.tenant_id = t.id`,
        ),
      ).rejects.toThrow(/webhooks_url_https_check/u);
    } finally {
      await runtime.end();
    }
  });
});
