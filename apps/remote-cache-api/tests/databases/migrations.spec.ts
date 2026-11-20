/**
 * Apply migration `db-remote-cache` qua **runner thật của migration authority**
 * (`deploys/remote-cache-db/runner.mts` — cutover #377) trên PostgreSQL thật,
 * rồi đo trạng thái database sau apply.
 *
 * ⚠️ Không dùng `describe.skipIf`: suite PG của repo đã đổi sang fail-loud —
 * `globalSetup` probe Docker một lần mỗi lần chạy và vắng Docker là lỗi thật,
 * không phải nửa suite skip với exit 0.
 *
 * ⚠️ Suite này đo **HÌNH DẠNG schema** sau khi authority apply (catalog, CHECK,
 * ownership). Semantics của runner (no-replay, checkpoint per-run, stamp,
 * advisory-lock mutual exclusion, guard wrong-database) thuộc suite integration
 * của chính authority — `deploys/remote-cache-db/tests/integrations/`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  REMOTE_CACHE_DATABASE,
  type RemoteCacheDatabase,
  startRemoteCacheDatabase,
} from '../integrations/harness.ts';

let db: RemoteCacheDatabase;

// Tên bảng trong schema `remote_cache` sau khi áp xong toàn bộ migrations:
// 5 bảng data (P4.1/P4.2) + 3 bảng P4.3 (quota_limits, usage_counters, audit_log)
// + internal_nonces (portal authorization #202) = 9 bảng. Dùng chung cho các
// test assertions để tổng số bảng không bị hardcode riêng lẻ.
const EXPECTED_REMOTE_CACHE_TABLES = [
  'api_keys',
  'audit_log',
  'cache_entries',
  'internal_nonces',
  'projects',
  'quota_limits',
  'tenant_members',
  'tenants',
  'usage_counters',
].toSorted();

beforeAll(async () => {
  db = await startRemoteCacheDatabase();
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

describe(`${REMOTE_CACHE_DATABASE} migrations on a real PostgreSQL`, () => {
  it('applies every migration file from an empty database, leaving the catalog as truth', async () => {
    const client = await db.connect();
    try {
      // Đếm bảng `CREATE TABLE remote_cache.*` qua catalog thật. Bảng history
      // `__drizzle_migrations` của authority (cutover #377) cũng nằm trong
      // schema — loại nó ra trước so sánh; sự hiện diện của nó là bằng chứng
      // runner đã ghi checkpoint, không phải bảng nghiệp vụ.
      const { rows } = await client.query<{ relname: string }>(
        `SELECT c.relname
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'remote_cache' AND c.relkind IN ('r', 'p')
          ORDER BY c.relname`,
      );
      expect(
        rows.map((row) => row.relname).filter((name) => name !== '__drizzle_migrations'),
      ).toEqual(EXPECTED_REMOTE_CACHE_TABLES);
    } finally {
      await client.end();
    }
  });

  it('leaves schema remote_cache owned by the migrator', async () => {
    // `CREATE SCHEMA` chạy từ session migrator: owner phải là
    // `ecoma_remote_cache_migrator` — điều kiện để các lần chạy sau của chính
    // runner luôn ghi được DDL mà không cần ai cấp quyền thêm.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ nspowner: string }>(
        `SELECT pg_get_userbyid(n.nspowner) AS nspowner
           FROM pg_namespace n WHERE n.nspname = 'remote_cache'`,
      );
      expect(rows[0]?.nspowner).toBe('ecoma_remote_cache_migrator');
    } finally {
      await client.end();
    }
  });

  it('keeps tenant CHECK vocabularies closed to the ADR-0015 lifecycle labels', async () => {
    const client = await db.connect();
    try {
      const { rows: constraintRows } = await client.query<{ conname: string }>(
        `SELECT con.conname
           FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = rel.relnamespace
          WHERE n.nspname = 'remote_cache' AND con.contype = 'c'
          ORDER BY con.conname`,
      );
      const constraints = constraintRows.map((row) => row.conname);
      // CHECK định nghĩa khả năng của schema — tập đầy đủ phải khớp đúng
      // migration, CHECK lạ xuất hiện cũng phải đỏ như CHECK thiếu. (Index
      // unique từng phần `tenants_one_free_per_owner_key` KHÔNG nằm trong
      // pg_constraint — nó là index, được probe riêng trong
      // migrations-0007-classification-plan.spec.ts.)
      expect(constraints).toEqual(
        [
          'api_key_revoked_at_after_created_check',
          'api_key_scopes_check',
          'audit_log_action_check',
          'audit_log_outcome_check',
          'cache_entries_size_positive',
          'projects_name_check',
          'quota_limits_nonnegative',
          'tenants_classification_check',
          'tenants_name_check',
          'tenants_owner_sub_check',
          'tenants_plan_check',
          'tenants_status_check',
          'tenant_members_role_check',
          'usage_counters_nonnegative',
        ].toSorted(),
      );

      // Status tenant: đúng ba nhãn lifecycle của ADR-0015 — chèn nhãn lạ phải
      // chết ở CHECK, không phải ở lỗi type hay thứ tự cột. classification/plan
      // được khai tường minh ('customer','paid') để CHECK duy nhất bị vi phạm là
      // CHECK đang probe.
      await expect(
        client.query(
          `INSERT INTO remote_cache.tenants (name, status, classification, plan, owner_sub)
           VALUES ('check-tenant', 'terminated', 'customer', 'paid', 'sub-owner-check-tenant')`,
        ),
      ).rejects.toThrow(/tenants_status_check|violates check constraint/iu);
      await expect(
        client.query(
          `INSERT INTO remote_cache.tenants (name, status, classification, plan, owner_sub)
           VALUES ('check tenant', 'active', 'customer', 'paid', 'sub-owner-check-tenant-2')`,
        ),
      ).rejects.toThrow(/tenants_name_check|violates check constraint/iu);
    } finally {
      await client.end();
    }
  });

  it('rejects inserting a tenant without owner_sub (not-null)', async () => {
    const client = await db.connect();
    try {
      // owner_sub là NOT NULL — chèn thiếu cột này phải bị từ chối ngay ở catalog.
      // classification/plan khai tường minh để owner_sub là vi phạm duy nhất.
      await expect(
        client.query(
          `INSERT INTO remote_cache.tenants (name, classification, plan) VALUES ('no-owner-sub', 'customer', 'paid')`,
        ),
      ).rejects.toThrow(/owner_sub|not-null|violates not-null/iu);
    } finally {
      await client.end();
    }
  });

  it('rejects role owner on tenant_members (ownership is not a membership role)', async () => {
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO remote_cache.tenants (name, classification, plan, owner_sub)
         VALUES ('role-owner-tenant', 'customer', 'paid', 'sub-owner-role-owner') RETURNING id`,
      );
      const tenantId = rows[0]?.id ?? '';
      // remote_cache chỉ cho phép role 'member' → 'owner' bị CHECK từ chối.
      await expect(
        client.query(
          `INSERT INTO remote_cache.tenant_members (tenant_id, member_sub, role) VALUES ($1, 'sub-owner-probe', 'owner')`,
          [tenantId],
        ),
      ).rejects.toThrow(/tenant_members_role_check|violates check constraint/iu);
    } finally {
      await client.end();
    }
  });

  it('persists owner_sub independently of membership (zero members is valid)', async () => {
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ id: string; owner_sub: string }>(
        `INSERT INTO remote_cache.tenants (name, classification, plan, owner_sub)
         VALUES ('no-members-tenant', 'customer', 'paid', 'sub-owner-no-members') RETURNING id, owner_sub`,
      );
      expect(rows[0]?.owner_sub).toBe('sub-owner-no-members');
      const tenantId = rows[0]?.id ?? '';
      const { rows: memberRows } = await client.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM remote_cache.tenant_members WHERE tenant_id = $1`,
        [tenantId],
      );
      expect(memberRows[0]?.c).toBe('0');
    } finally {
      await client.end();
    }
  });
});
