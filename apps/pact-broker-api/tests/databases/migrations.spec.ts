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
      expect(first.applied).toBe(4);
      const second = await applyAllMigrations(migrator);
      expect(second.applied).toBe(4);
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
      // là số file migration, chứng minh counter không phải luôn 0 — nếu counter
      // hỏng thì CLI in "0 file(s) applied" trong khi schema có mặt.
      const fresh = await startPactBrokerDatabase();
      try {
        const migrator = await fresh.connectAsMigrator();
        try {
          const result = await applyAllMigrations(migrator);
          expect(result.applied).toBe(4);
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
      // DML được: INSERT tenant là hành vi bình thường của Worker
      // (classification NOT NULL + customer ⇒ plan kể từ migration `0004`).
      await runtime.query(
        `INSERT INTO pact.tenants (name, classification, plan, owner_sub)
         VALUES ('grant-probe', 'customer', 'free', 'sub-owner-grant-probe')`,
      );

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
      await runtime.query(
        `INSERT INTO pact.tenants (name, classification, plan, owner_sub)
         VALUES ('fk-a', 'customer', 'free', 'sub-owner-fk-a')`,
      );
      await runtime.query(
        `INSERT INTO pact.tenants (name, classification, plan, owner_sub)
         VALUES ('fk-b', 'customer', 'free', 'sub-owner-fk-b')`,
      );
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
      await runtime.query(
        `INSERT INTO pact.tenants (name, classification, plan, owner_sub)
         VALUES ('deploy-probe', 'customer', 'free', 'sub-owner-deploy-probe')`,
      );
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
      await runtime.query(
        `INSERT INTO pact.tenants (name, classification, plan, owner_sub)
         VALUES ('wh-probe', 'customer', 'free', 'sub-owner-wh-probe')`,
      );
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

  it('rejects machine token scopes outside the fixed read/write/admin vocabulary', async () => {
    // Declared limit của credentials doc: CHECK `machine_tokens_scopes_check`
    // trên cột `scopes` chưa từng được assert — token ngoài tập scope cố định
    // hoặc sai phân tách dấu cách phải bị PostgreSQL chặn, không phải chỉ ở
    // tầng validation của route.
    const runtime = await db.asRuntime();
    try {
      await runtime.query(
        `INSERT INTO pact.tenants (name, classification, plan, owner_sub)
         VALUES ('mt-probe', 'customer', 'free', 'sub-owner-mt-probe')`,
      );
      const insertToken = (hash: string, scopes: string) =>
        runtime.query(
          `INSERT INTO pact.machine_tokens (token_hash, tenant_id, name, scopes)
           SELECT $1, id, 'probe-token', $2 FROM pact.tenants WHERE name = 'mt-probe'`,
          [hash, scopes],
        );

      // Hợp lệ: tập scope phân tách dấu cách, lặp lại cũng được.
      await insertToken('probe-hash-valid', 'read write');
      await insertToken('probe-hash-admin', 'admin');

      // Scope ngoài tập cố định → CHECK chặn.
      await expect(insertToken('probe-hash-deploy', 'read deploy')).rejects.toThrow(
        /machine_tokens_scopes_check/u,
      );
      // Token không scope nào = vô dụng → CHECK chặn.
      await expect(insertToken('probe-hash-empty', '')).rejects.toThrow(
        /machine_tokens_scopes_check/u,
      );
      // Sai phân tách (dấu phẩy, khoảng trắng kép) → CHECK chặn.
      await expect(insertToken('probe-hash-comma', 'read,write')).rejects.toThrow(
        /machine_tokens_scopes_check/u,
      );
      await expect(insertToken('probe-hash-double-space', 'read  write')).rejects.toThrow(
        /machine_tokens_scopes_check/u,
      );
    } finally {
      await runtime.end();
    }
  });

  it('rejects owner_sub violating tenants_owner_sub_check (empty, spaced, too long)', async () => {
    const runtime = await db.asRuntime();
    try {
      // owner_sub rỗng vi phạm length BETWEEN 1 AND 200.
      await expect(
        runtime.query(
          `INSERT INTO pact.tenants (name, classification, plan, owner_sub)
           VALUES ('owner-sub-empty', 'customer', 'free', '')`,
        ),
      ).rejects.toThrow(/tenants_owner_sub_check|violates check constraint/iu);
      // owner_sub có khoảng cách đầu/cuối vi phạm owner_sub = trim(owner_sub).
      await expect(
        runtime.query(
          `INSERT INTO pact.tenants (name, classification, plan, owner_sub)
           VALUES ('owner-sub-spaced', 'customer', 'free', ' has space ')`,
        ),
      ).rejects.toThrow(/tenants_owner_sub_check|violates check constraint/iu);
      // owner_sub quá 200 ký tự vi phạm length BETWEEN 1 AND 200.
      await expect(
        runtime.query(
          `INSERT INTO pact.tenants (name, classification, plan, owner_sub) VALUES ($1, $2, $3, $4)`,
          ['owner-sub-too-long', 'customer', 'free', 'x'.repeat(201)],
        ),
      ).rejects.toThrow(/tenants_owner_sub_check|violates check constraint/iu);
    } finally {
      await runtime.end();
    }
  });

  it('rejects inserting a tenant without owner_sub (not-null)', async () => {
    const runtime = await db.asRuntime();
    try {
      // owner_sub là NOT NULL — chèn thiếu cột này phải bị PostgreSQL từ chối
      // ngay ở catalog, không cần đến CHECK.
      await expect(
        runtime.query(`INSERT INTO pact.tenants (name) VALUES ('tenant-no-owner-sub')`),
      ).rejects.toThrow(/owner_sub|not-null|violates not-null/iu);
    } finally {
      await runtime.end();
    }
  });

  it('rejects role owner on tenant_members (ownership is not a membership role)', async () => {
    const runtime = await db.asRuntime();
    try {
      await runtime.query(
        `INSERT INTO pact.tenants (name, classification, plan, owner_sub)
         VALUES ('tenant-role-owner', 'customer', 'free', 'sub-owner-role-owner')`,
      );
      const { rows } = await runtime.query<{ id: string }>(
        `SELECT id FROM pact.tenants WHERE name = 'tenant-role-owner'`,
      );
      const tenantId = rows[0]?.id ?? '';
      // role 'owner' không nằm trong ('admin','member','viewer') → CHECK từ chối.
      await expect(
        runtime.query(
          `INSERT INTO pact.tenant_members (tenant_id, sub, role) VALUES ($1, 'sub-owner-probe', 'owner')`,
          [tenantId],
        ),
      ).rejects.toThrow(/tenant_members_role_check|violates check constraint/iu);
    } finally {
      await runtime.end();
    }
  });

  // -------------------------------------------------------------------------
  // classification + plan + Free slot (migration `0004`, domain-model §2.6).
  // -------------------------------------------------------------------------

  it('accepts customer tenants with a free or paid plan', async () => {
    const runtime = await db.asRuntime();
    try {
      await runtime.query(
        `INSERT INTO pact.tenants (name, status, classification, plan, owner_sub)
         VALUES ('plan-free', 'active', 'customer', 'free', 'sub-owner-plan-free')`,
      );
      await runtime.query(
        `INSERT INTO pact.tenants (name, status, classification, plan, owner_sub)
         VALUES ('plan-paid', 'active', 'customer', 'paid', 'sub-owner-plan-paid')`,
      );
      const { rows } = await runtime.query<{ name: string; plan: string | null }>(
        `SELECT name, plan FROM pact.tenants WHERE name IN ('plan-free', 'plan-paid') ORDER BY name`,
      );
      expect(rows.map((row) => row.plan)).toEqual(['free', 'paid']);
    } finally {
      await runtime.end();
    }
  });

  it('accepts a first_party tenant with no plan', async () => {
    const runtime = await db.asRuntime();
    try {
      await runtime.query(
        `INSERT INTO pact.tenants (name, status, classification, plan, owner_sub)
         VALUES ('plan-first-party', 'active', 'first_party', NULL, 'sub-owner-plan-first-party')`,
      );
      const { rows } = await runtime.query<{ classification: string; plan: string | null }>(
        `SELECT classification, plan FROM pact.tenants WHERE name = 'plan-first-party'`,
      );
      expect(rows[0]?.classification).toBe('first_party');
      // first_party không có plan: NULL là "không có giá trị", không phải giá
      // trị thứ ba của enum.
      expect(rows[0]?.plan).toBeNull();
    } finally {
      await runtime.end();
    }
  });

  it('rejects a first_party tenant that carries a plan', async () => {
    const runtime = await db.asRuntime();
    try {
      // plan chỉ tồn tại khi classification là customer → CHECK từ chối.
      await expect(
        runtime.query(
          `INSERT INTO pact.tenants (name, status, classification, plan, owner_sub)
           VALUES ('plan-first-party-with-plan', 'active', 'first_party', 'free', 'sub-owner-fp-plan')`,
        ),
      ).rejects.toThrow(/tenants_plan_only_when_customer_check|violates check constraint/iu);
    } finally {
      await runtime.end();
    }
  });

  it('rejects a customer tenant without a plan or with a plan outside free/paid', async () => {
    const runtime = await db.asRuntime();
    try {
      // customer mà thiếu plan vi phạm tenants_customer_plan_values_check.
      await expect(
        runtime.query(
          `INSERT INTO pact.tenants (name, status, classification, plan, owner_sub)
           VALUES ('plan-customer-null', 'active', 'customer', NULL, 'sub-owner-cust-null')`,
        ),
      ).rejects.toThrow(/tenants_customer_plan_values_check|violates check constraint/iu);
      // customer với plan ngoài enum ('free','paid') vi phạm cùng CHECK đó.
      await expect(
        runtime.query(
          `INSERT INTO pact.tenants (name, status, classification, plan, owner_sub)
           VALUES ('plan-customer-invalid', 'active', 'customer', 'enterprise', 'sub-owner-cust-invalid')`,
        ),
      ).rejects.toThrow(/tenants_customer_plan_values_check|violates check constraint/iu);
    } finally {
      await runtime.end();
    }
  });

  it('rejects a tenant row without classification (not-null since 0004)', async () => {
    const runtime = await db.asRuntime();
    try {
      // classification NOT NULL kể từ `0004` — thiếu cột này bị catalog từ chối,
      // không cần đến CHECK.
      await expect(
        runtime.query(
          `INSERT INTO pact.tenants (name, owner_sub)
           VALUES ('tenant-no-classification', 'sub-owner-no-classification')`,
        ),
      ).rejects.toThrow(/classification|not-null/iu);
    } finally {
      await runtime.end();
    }
  });

  it('rejects a second non-deleted free tenant for the same owner (free slot)', async () => {
    const runtime = await db.asRuntime();
    try {
      await runtime.query(
        `INSERT INTO pact.tenants (name, status, classification, plan, owner_sub)
         VALUES ('slot-first', 'active', 'customer', 'free', 'sub-owner-slot')`,
      );
      // Partial unique `tenants_one_free_per_owner_key` chặn tenant free thứ
      // hai của cùng owner ngay ở database — application check đơn thuần không đủ.
      await expect(
        runtime.query(
          `INSERT INTO pact.tenants (name, status, classification, plan, owner_sub)
           VALUES ('slot-second', 'active', 'customer', 'free', 'sub-owner-slot')`,
        ),
      ).rejects.toThrow(/tenants_one_free_per_owner_key|duplicate key/iu);
    } finally {
      await runtime.end();
    }
  });

  it('releases the free slot only after logical deletion commits', async () => {
    const runtime = await db.asRuntime();
    try {
      await runtime.query(
        `INSERT INTO pact.tenants (name, status, classification, plan, owner_sub)
         VALUES ('slot-deleted', 'active', 'customer', 'free', 'sub-owner-slot-deleted')`,
      );
      await runtime.query(`UPDATE pact.tenants SET status = 'deleted' WHERE name = 'slot-deleted'`);
      // status = 'deleted' thoả predicate → slot được nhả, tenant thay thế được nhận.
      await expect(
        runtime.query(
          `INSERT INTO pact.tenants (name, status, classification, plan, owner_sub)
           VALUES ('slot-replacement', 'active', 'customer', 'free', 'sub-owner-slot-deleted')`,
        ),
      ).resolves.toBeTruthy();
    } finally {
      await runtime.end();
    }
  });

  it('keeps the free slot consumed by a suspended tenant', async () => {
    const runtime = await db.asRuntime();
    try {
      await runtime.query(
        `INSERT INTO pact.tenants (name, status, classification, plan, owner_sub)
         VALUES ('slot-suspended', 'active', 'customer', 'free', 'sub-owner-slot-suspended')`,
      );
      await runtime.query(
        `UPDATE pact.tenants SET status = 'suspended' WHERE name = 'slot-suspended'`,
      );
      // suspended vẫn tiêu slot: predicate chỉ loại trừ status = 'deleted'.
      await expect(
        runtime.query(
          `INSERT INTO pact.tenants (name, status, classification, plan, owner_sub)
           VALUES ('slot-suspended-second', 'active', 'customer', 'free', 'sub-owner-slot-suspended')`,
        ),
      ).rejects.toThrow(/tenants_one_free_per_owner_key|duplicate key/iu);
    } finally {
      await runtime.end();
    }
  });

  it('keeps free slots independent across owners and ignores first_party tenants', async () => {
    const runtime = await db.asRuntime();
    try {
      // Owner khác nhau: mỗi owner tự có một slot free, không xung đột.
      await runtime.query(
        `INSERT INTO pact.tenants (name, status, classification, plan, owner_sub)
         VALUES ('slot-owner-a', 'active', 'customer', 'free', 'sub-owner-slot-a')`,
      );
      await runtime.query(
        `INSERT INTO pact.tenants (name, status, classification, plan, owner_sub)
         VALUES ('slot-owner-b', 'active', 'customer', 'free', 'sub-owner-slot-b')`,
      );
      // first_party không có plan nên không bao giờ khớp predicate free slot:
      // owner của nó vẫn sở hữu thêm một tenant free customer.
      await runtime.query(
        `INSERT INTO pact.tenants (name, status, classification, plan, owner_sub)
         VALUES ('slot-first-party', 'active', 'first_party', NULL, 'sub-owner-slot-fp')`,
      );
      await runtime.query(
        `INSERT INTO pact.tenants (name, status, classification, plan, owner_sub)
         VALUES ('slot-fp-customer', 'active', 'customer', 'free', 'sub-owner-slot-fp')`,
      );
      const { rows } = await runtime.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM pact.tenants WHERE owner_sub = 'sub-owner-slot-fp'`,
      );
      expect(rows[0]?.c).toBe('2');
    } finally {
      await runtime.end();
    }
  });
});
