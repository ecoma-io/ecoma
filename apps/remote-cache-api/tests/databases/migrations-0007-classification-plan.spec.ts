/**
 * Migration `0007_tenant_classification_and_plan.sql` trên PostgreSQL thật —
 * classification/plan CHECK, free-slot invariant và defense-in-depth grant.
 *
 * Nguồn shape: `docs/domains/remote-cache/domain-model.md` §2.9 (Enforcement
 * schema) + §3 invariants 7-10, ADR-0026 (trục classification first_party/
 * customer, plan chỉ tồn tại cho customer). Mỗi case probe đúng một tính chất
 * của schema, không của code ứng dụng.
 *
 * ⚠️ Docker là phụ thuộc cứng: `globalSetup` probe Docker, vắng Docker là đỏ,
 * không skip (06-testing.md §6).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type RemoteCacheDatabase, startRemoteCacheDatabase } from '../integrations/harness.ts';

let db: RemoteCacheDatabase;

beforeAll(async () => {
  db = await startRemoteCacheDatabase();
}, 180_000);

beforeEach(async () => {
  // Các case dùng tên tenant/owner cố định — truncate giữ mỗi case khởi động
  // từ trạng thái rỗng, không phụ thuộc thứ tự chạy.
  await db.truncateData();
});

afterAll(async () => {
  await db?.stop();
});

describe('migration 0007: classification, plan and the free-slot invariant', () => {
  it('creates the partial unique index with the exact documented name and predicate', async () => {
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'remote_cache' AND indexname = 'tenants_one_free_per_owner_key'`,
      );
      const indexdef = rows[0]?.indexdef ?? '';
      // Ghim đúng tên index và đúng predicate §2.9: (owner_sub) WHERE plan =
      // 'free' AND status <> 'deleted'. Postgres render `::text` cast trong
      // indexdef — so theo nội dung, không theo chuỗi nguyên văn.
      expect(indexdef).toContain('CREATE UNIQUE INDEX');
      expect(indexdef).toContain('ON remote_cache.tenants');
      expect(indexdef).toContain('(owner_sub)');
      expect(indexdef).toContain("plan = 'free'::text");
      expect(indexdef).toContain("status <> 'deleted'::text");
    } finally {
      await client.end();
    }
  });

  it('allows a first_party tenant and a free customer tenant for the same owner (first_party never consumes the slot)', async () => {
    const migrator = await db.connectAsMigrator();
    try {
      const owner = 'sub-owner-dual-classification';
      const first = await migrator.query<{ id: string }>(
        `INSERT INTO remote_cache.tenants (name, classification, plan, owner_sub)
         VALUES ('first-party-dual', 'first_party', NULL, $1) RETURNING id`,
        [owner],
      );
      expect(first.rows[0]?.id).not.toBe('');
      // Cùng owner, customer free — hợp lệ vì first_party không match predicate
      // (plan IS NULL): free-slot là bất biến của customer tenants, không phải
      // của mọi tenant.
      const second = await migrator.query<{ id: string }>(
        `INSERT INTO remote_cache.tenants (name, classification, plan, owner_sub)
         VALUES ('customer-free-dual', 'customer', 'free', $1) RETURNING id`,
        [owner],
      );
      expect(second.rows[0]?.id).not.toBe('');
    } finally {
      await migrator.end();
    }
  });

  it('rejects a second concurrent non-deleted free tenant for the same owner (exactly one commits)', async () => {
    // Hai client riêng biệt, INSERT autocommit READ COMMITTED: unique index
    // phân xử — bên đến sau chờ hàng đang chèn của bên trước, rồi nhận unique
    // violation. Đúng MỘT bên commit là invariant, bất kể thứ tự schedule.
    const first = await db.connectAsMigrator();
    const second = await db.connectAsMigrator();
    try {
      const owner = 'sub-owner-concurrent-free';
      const results = await Promise.allSettled([
        first.query(
          `INSERT INTO remote_cache.tenants (name, classification, plan, owner_sub)
           VALUES ('concurrent-free-a', 'customer', 'free', $1)`,
          [owner],
        ),
        second.query(
          `INSERT INTO remote_cache.tenants (name, classification, plan, owner_sub)
           VALUES ('concurrent-free-b', 'customer', 'free', $1)`,
          [owner],
        ),
      ]);
      const committed = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(committed).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const reason = (rejected[0] as PromiseRejectedResult).reason as Error;
      expect(reason.message).toMatch(/tenants_one_free_per_owner_key|duplicate key|unique/iu);
    } finally {
      await first.end();
      await second.end();
    }
  });

  it('rejects a second sequential free tenant for the same owner while the first is non-deleted', async () => {
    const migrator = await db.connectAsMigrator();
    try {
      const owner = 'sub-owner-sequential-free';
      await migrator.query(
        `INSERT INTO remote_cache.tenants (name, classification, plan, owner_sub)
         VALUES ('sequential-free-first', 'customer', 'free', $1)`,
        [owner],
      );
      await expect(
        migrator.query(
          `INSERT INTO remote_cache.tenants (name, classification, plan, owner_sub)
           VALUES ('sequential-free-second', 'customer', 'free', $1)`,
          [owner],
        ),
      ).rejects.toThrow(/tenants_one_free_per_owner_key|duplicate key|unique/iu);
    } finally {
      await migrator.end();
    }
  });

  it('keeps the slot consumed while the free tenant is suspended and releases it once deleted', async () => {
    const migrator = await db.connectAsMigrator();
    try {
      const owner = 'sub-owner-lifecycle-slot';
      const { rows } = await migrator.query<{ id: string }>(
        `INSERT INTO remote_cache.tenants (name, classification, plan, owner_sub)
         VALUES ('slot-holder', 'customer', 'free', $1) RETURNING id`,
        [owner],
      );
      const tenantId = rows[0]?.id ?? '';

      // Suspended vẫn chiếm slot — không tenant free thay thế được.
      await migrator.query(`UPDATE remote_cache.tenants SET status = 'suspended' WHERE id = $1`, [
        tenantId,
      ]);
      await expect(
        migrator.query(
          `INSERT INTO remote_cache.tenants (name, classification, plan, owner_sub)
           VALUES ('slot-replacement-suspended', 'customer', 'free', $1)`,
          [owner],
        ),
      ).rejects.toThrow(/tenants_one_free_per_owner_key|duplicate key|unique/iu);

      // Deleted nhả slot — tenant free mới cho cùng owner commit được.
      await migrator.query(`UPDATE remote_cache.tenants SET status = 'deleted' WHERE id = $1`, [
        tenantId,
      ]);
      const freed = await migrator.query<{ id: string }>(
        `INSERT INTO remote_cache.tenants (name, classification, plan, owner_sub)
         VALUES ('slot-replacement-deleted', 'customer', 'free', $1) RETURNING id`,
        [owner],
      );
      expect(freed.rows[0]?.id).not.toBe('');
    } finally {
      await migrator.end();
    }
  });

  it('enforces the conditional plan contract: customer needs free|paid, first_party needs NULL', async () => {
    const migrator = await db.connectAsMigrator();
    try {
      // Customer mà bỏ trống plan phải chết — CHECK chỉ vi phạm khi biểu thức
      // là FALSE, nên biểu thức phải total: guard `plan IS NOT NULL` đổi nhánh
      // (customer, NULL) từ UNKNOWN (được coi là thoả) thành FALSE.
      await expect(
        migrator.query(
          `INSERT INTO remote_cache.tenants (name, classification, plan, owner_sub)
           VALUES ('plan-contract-customer-null', 'customer', NULL, 'sub-owner-plan-contract')`,
        ),
      ).rejects.toThrow(/tenants_plan_check|violates check constraint/iu);
      // first_party không được có plan — plan không áp dụng, NULL là "không có",
      // không phải giá trị enum thứ ba.
      await expect(
        migrator.query(
          `INSERT INTO remote_cache.tenants (name, classification, plan, owner_sub)
           VALUES ('plan-contract-fp-free', 'first_party', 'free', 'sub-owner-plan-contract-2')`,
        ),
      ).rejects.toThrow(/tenants_plan_check|violates check constraint/iu);
      await expect(
        migrator.query(
          `INSERT INTO remote_cache.tenants (name, classification, plan, owner_sub)
           VALUES ('plan-contract-fp-paid', 'first_party', 'paid', 'sub-owner-plan-contract-3')`,
        ),
      ).rejects.toThrow(/tenants_plan_check|violates check constraint/iu);
      // Vocabulary đóng hai chiều: classification lạ và plan lạ đều chết ở CHECK.
      await expect(
        migrator.query(
          `INSERT INTO remote_cache.tenants (name, classification, plan, owner_sub)
           VALUES ('plan-contract-unknown-class', 'partner', 'free', 'sub-owner-plan-contract-4')`,
        ),
      ).rejects.toThrow(/tenants_classification_check|violates check constraint/iu);
      await expect(
        migrator.query(
          `INSERT INTO remote_cache.tenants (name, classification, plan, owner_sub)
           VALUES ('plan-contract-unknown-plan', 'customer', 'enterprise', 'sub-owner-plan-contract-5')`,
        ),
      ).rejects.toThrow(/tenants_plan_check|violates check constraint/iu);
      // Hai hình hợp lệ vẫn commit được sau các lần từ chối — CHECK từ chối đúng
      // hình lệch, không cấm nhánh hợp lệ.
      const customer = await migrator.query<{ id: string }>(
        `INSERT INTO remote_cache.tenants (name, classification, plan, owner_sub)
         VALUES ('plan-contract-ok-customer', 'customer', 'paid', 'sub-owner-plan-contract-6') RETURNING id`,
      );
      expect(customer.rows[0]?.id).not.toBe('');
      const firstParty = await migrator.query<{ id: string }>(
        `INSERT INTO remote_cache.tenants (name, classification, plan, owner_sub)
         VALUES ('plan-contract-ok-fp', 'first_party', NULL, 'sub-owner-plan-contract-7') RETURNING id`,
      );
      expect(firstParty.rows[0]?.id).not.toBe('');
    } finally {
      await migrator.end();
    }
  });

  it('scopes the runtime UPDATE grant to status: lifecycle works, classification and plan die at the grant', async () => {
    // Defense in depth của 0007 (REVOKE UPDATE + GRANT UPDATE (status)) đo bằng
    // credential runtime THẬT — lớp catalog (has_column_privilege) nằm ở
    // roles.spec.ts; lớp hành vi nằm ở đây cạnh migration tạo ra nó.
    const migrator = await db.connectAsMigrator();
    let tenantId = '';
    try {
      const { rows } = await migrator.query<{ id: string }>(
        `INSERT INTO remote_cache.tenants (name, classification, plan, owner_sub)
         VALUES ('runtime-scope-probe', 'customer', 'paid', 'sub-owner-runtime-scope') RETURNING id`,
      );
      tenantId = rows[0]?.id ?? '';
    } finally {
      await migrator.end();
    }
    const runtime = await db.connectAsRuntime();
    try {
      // Đúng vòng đời: suspend qua UPDATE status phải thành công.
      const suspended = await runtime.query(
        `UPDATE remote_cache.tenants SET status = 'suspended' WHERE id = $1`,
        [tenantId],
      );
      expect(suspended.rowCount).toBe(1);
      // Classification là bất biến sau provisioning (ADR-0026 §1) — runtime
      // không bao giờ tự chuyển customer sang first_party.
      await expect(
        runtime.query(
          `UPDATE remote_cache.tenants SET classification = 'first_party' WHERE id = $1`,
          [tenantId],
        ),
      ).rejects.toThrow(/permission denied/iu);
      await expect(
        runtime.query(`UPDATE remote_cache.tenants SET plan = 'free' WHERE id = $1`, [tenantId]),
      ).rejects.toThrow(/permission denied/iu);
    } finally {
      await runtime.end();
    }
  });
});
