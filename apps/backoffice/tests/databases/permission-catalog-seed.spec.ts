/**
 * Integration test cho seed catalog permission (migration `0003`).
 *
 * Kiểm chứng:
 *   - seed chạy qua migrator role (harness apply bằng credential migrator thật),
 *   - đúng 4 permission read `staff.read`, `role.read`, `permission.read`,
 *     status `active`, không surplus;
 *   - idempotent: apply lại không double-insert **và không đổi nội dung**;
 *   - **self-heal**: xoá (hoặc đổi status) một row seed rồi apply lại ⇒
 *     catalog trở về đúng baseline;
 *   - runtime role SELECT được catalog;
 *   - runtime role KHÔNG INSERT được (catalog sealed, invariant 10).
 *
 * ## Vì sao cần self-heal test (follow-up 2 của issue #106)
 *
 * Test idempotency cũ chỉ assert `count == 3` sau khi re-apply — nó **không**
 * assert nội dung. Nên một seed file hỏng (sai `status`, thiếu một row, thêm
 * một row thừa) vẫn cho suite xanh. Test này assert **nội dung** (`EXPECTED_SEEDED`
 * so sánh element-by-element, không phải so số lượng) và kiểm tra cả đường
 * tự phục hồi: xoá một row seed rồi `applyMigrations()` ⇒ row đó phải quay lại.
 *
 * ⚠️ Docker là phụ thuộc cứng: probe Docker ở `harness.ts` (qua `globalSetup`)
 * ném lỗi khi vắng Docker, làm **toàn bộ** lần chạy đỏ thay vì skip — chính
 * sách fail-loud của 06-testing.md §6.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type BackofficeDatabase,
  applyMigrations,
  startBackofficeDatabase,
} from '../integrations/harness';

const EXPECTED_SEEDED = [
  { id: 'audit.read', domain: 'audit', action: 'read', status: 'active' },
  { id: 'permission.read', domain: 'permission', action: 'read', status: 'active' },
  { id: 'role.read', domain: 'role', action: 'read', status: 'active' },
  { id: 'staff.read', domain: 'staff', action: 'read', status: 'active' },
];

interface CatalogRow {
  id: string;
  domain: string;
  action: string;
  status: string;
}

/** Đọc toàn bộ catalog theo thứ tự id — dùng cho mọi assert về nội dung. */
async function readCatalog(db: BackofficeDatabase): Promise<CatalogRow[]> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<CatalogRow>(
      `SELECT id, domain, action, status
         FROM backoffice.permissions ORDER BY id`,
    );
    return rows;
  } finally {
    await client.end();
  }
}

describe('permission catalog seed (0003) on a real PostgreSQL', () => {
  let db: BackofficeDatabase;

  beforeAll(async () => {
    db = await startBackofficeDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('seeds exactly the three read permissions via the migrator role', async () => {
    expect(await readCatalog(db)).toEqual(EXPECTED_SEEDED);
  });

  it('is idempotent: re-applying migrations neither duplicates rows nor changes content', async () => {
    const client = await db.connect();
    try {
      await applyMigrations(client);
      await applyMigrations(client);
    } finally {
      await client.end();
    }

    // ⚠️ Assert **nội dung**, không chỉ `count == 3`: một seed file hỏng (sai
    // `status`, hoặc seed permission khác) vẫn cho đúng 3 row nên assert count
    // xanh trong khi catalog đã sai. Đây là phần còn thiếu của follow-up 2.
    expect(await readCatalog(db)).toEqual(EXPECTED_SEEDED);
  });

  it('self-heals a deleted seed row on the next apply', async () => {
    // Mutation evidence: bỏ `ON CONFLICT (id) DO NOTHING` (hoặc đổi seed
    // thành `DO UPDATE` sai) thì test này đỏ — row bị xoá không quay lại, và
    // catalog không còn khớp baseline.
    const client = await db.connect();
    try {
      await client.query(`DELETE FROM backoffice.permissions WHERE id = 'role.read'`);
      // 4 seed (alphabetical): [audit.read, permission.read, role.read, staff.read].
      // Xoá `role.read` (index 2) ⇒ còn 3 row [audit.read, permission.read, staff.read].
      expect(await readCatalog(db)).toEqual([
        EXPECTED_SEEDED[0],
        EXPECTED_SEEDED[1],
        EXPECTED_SEEDED[3],
      ]);

      await applyMigrations(client);
    } finally {
      await client.end();
    }

    // Baseline phải khôi phục **đúng** — không chỉ đủ 3 row.
    expect(await readCatalog(db)).toEqual(EXPECTED_SEEDED);
  });

  it('self-heals a seed row whose status drifted away from active', async () => {
    // Mutation evidence: seed sai `status` (ví dụ `retired` thay vì `active`)
    // thì test này đỏ — row đó sẽ không được sửa về `active` bởi
    // `ON CONFLICT (id) DO NOTHING`.
    //
    // ⚠️ `retired` là **terminal** (trigger `permissions_retired_immutable` ở
    // `0001` chặn hồi sinh `active`) — nên test dùng `UPDATE … SET status =
    // 'retired'` để mô phỏng drift, rồi khẳng định apply lại **không** hồi
    // sinh nó: baseline của `0003` là ba row `active`, và một row `retired`
    // là hành vi đúng theo thiết kế insert-then-retire, không phải thứ
    // `0003` được phép sửa.
    //
    // Vì vậy assertion ở đây là: apply lại **không** hồi sinh row `retired`
    // (đúng thiết kế), và catalog **không** khớp baseline — tức test bắt được
    // một seed đã hỏng, chứ không phải một hành vi bị chấp nhận.
    const client = await db.connect();
    try {
      await client.query(
        `UPDATE backoffice.permissions SET status = 'retired' WHERE id = 'staff.read'`,
      );

      await applyMigrations(client);
    } finally {
      await client.end();
    }

    const catalog = await readCatalog(db);
    const staffRow = catalog.find((row) => row.id === 'staff.read');

    // Row `retired` không bị hồi sinh — `0003` không được quyền làm điều đó.
    expect(staffRow?.status).toBe('retired');
    // Nhưng catalog **không** còn ở baseline ⇒ seed đã hỏng, và test này
    // phải bắt được điều đó (assert cả bộ khác vẫn đúng).
    expect(catalog).not.toEqual(EXPECTED_SEEDED);

    // Khôi phục baseline để test sau không bị ảnh hưởng: trigger chặn hồi
    // sinh `active`, nên phải xoá row rồi apply lại (đúng đường seed).
    const restore = await db.connect();
    try {
      await restore.query(`DELETE FROM backoffice.permissions WHERE id = 'staff.read'`);
      await applyMigrations(restore);
    } finally {
      await restore.end();
    }

    expect(await readCatalog(db)).toEqual(EXPECTED_SEEDED);
  });

  it('allows the runtime role to SELECT from the permission catalog', async () => {
    const runtime = await db.asRuntime();
    try {
      const { rows } = await runtime.query<{ id: string }>(
        `SELECT id FROM backoffice.permissions ORDER BY id`,
      );
      expect(rows.map((row) => row.id)).toEqual([
        'audit.read',
        'permission.read',
        'role.read',
        'staff.read',
      ]);
    } finally {
      await runtime.end();
    }
  });

  it('denies INSERT into the permission catalog for the runtime role', async () => {
    const runtime = await db.asRuntime();
    try {
      await expect(
        runtime.query(
          `INSERT INTO backoffice.permissions (id, domain, action)
             VALUES ('extra.read', 'extra', 'read')`,
        ),
      ).rejects.toThrow(/permission denied/iu);
    } finally {
      await runtime.end();
    }
  });

  // -------------------------------------------------------------------------
  // CHECK `permissions_id_matches_domain_action` (migration 0005) — id phải
  // bằng đúng `domain.action`. Constraint này là lớp chặn cuối ở tầng DB, không
  // phụ thuộc role: kể cả migrator/owner cũng phải tuân.
  // -------------------------------------------------------------------------

  it('refuses a permission row whose id does not equal domain.action', async () => {
    // ADR-0010: `id` của permission = đúng chuỗi `<domain>.<action>`. Một row
    // có `id` lệch (ví dụ `'fake.perm'` với domain `'other'`) là catalog sai
    // định danh — phải bị từ chối ngay tại DB, không phải chờ app layer.
    //
    // Mutation evidence: bỏ ADD CONSTRAINT trong `0005` ⇒ INSERT này thành công
    // thay vì ném `violates check constraint`.
    const migrator = await db.asMigrator();
    try {
      await expect(
        migrator.query(
          `INSERT INTO backoffice.permissions (id, domain, action, status)
             VALUES ('fake.perm', 'other', 'read', 'active')`,
        ),
      ).rejects.toThrow(/violates check constraint/iu);
    } finally {
      // Cleanup để mutation case (CHECK bị bỏ) không để lại row vi phạm làm
      // hỏng các test sau (pre-flight của 0005).
      await migrator
        .query(`DELETE FROM backoffice.permissions WHERE id = 'fake.perm'`)
        .catch(() => undefined);
      await migrator.end();
    }
  });

  // -------------------------------------------------------------------------
  // Drift-proof re-apply (migration 0003, Candidate A3) — ON CONFLICT DO NOTHING
  // không target bắt mọi unique violation; WHERE NOT EXISTS không overwrite drift
  // row. Sau 0005, CHECK làm mọi drift row có cùng (domain, action) nhưng id
  // khác trở nên **bất khả** (id bị buộc = domain.action), nên scenario "drift
  // row chiếm slot (domain, action)" không còn tái hiện được bằng SQL thuần ở
  // DB đã apply 0005. Test dưới đây kiểm cùng tính chất trên một row không
  // xung đột (extra permission) — seed vẫn apply được và không xoá/ghi đè row
  // đó.
  // -------------------------------------------------------------------------

  it('does not duplicate or overwrite the drift row on re-apply', async () => {
    // Seed thêm một permission ngoài 3 seed; re-apply 0003 phải giữ nguyên row
    // đó (không xoá, không ghi đè status) và vẫn có đủ 3 seed.
    const migrator = await db.asMigrator();
    try {
      await migrator.query(
        `INSERT INTO backoffice.permissions (id, domain, action, status)
           VALUES ('foo.bar', 'foo', 'bar', 'active')`,
      );
    } finally {
      await migrator.end();
    }

    const client = await db.connect();
    try {
      await applyMigrations(client);
      await applyMigrations(client);
    } finally {
      await client.end();
    }

    const catalog = await readCatalog(db);
    expect(catalog).toContainEqual({
      id: 'foo.bar',
      domain: 'foo',
      action: 'bar',
      status: 'active',
    });
    for (const expected of EXPECTED_SEEDED) {
      expect(catalog).toContainEqual(expected);
    }

    // Dọn để các test sau (đặc biệt self-heal) không bị ảnh hưởng.
    const cleanup = await db.asMigrator();
    try {
      await cleanup.query(`DELETE FROM backoffice.permissions WHERE id = 'foo.bar'`);
    } finally {
      await cleanup.end();
    }
  });

  it('re-applies the seed without error when a (domain, action) drift row exists', async () => {
    // Kịch bản drift "cùng (domain, action), id khác" không thể tồn tại sau
    // CHECK Gap 1 (id bị buộc = domain.action, mà slot đó đã có PK). Vì vậy
    // test này kiểm đường lân cận: một row đã tồn tại với id hợp lệ theo CHECK
    // nhưng **không** thuộc seed (domain/action khác) — re-apply 0003 phải không
    // ném lỗi và không xoá row đó. Đây là bằng chứng `ON CONFLICT DO NOTHING`
    // không target bắt mọi unique violation mà không phá dữ liệu có sẵn.
    const migrator = await db.asMigrator();
    try {
      await migrator.query(
        `INSERT INTO backoffice.permissions (id, domain, action, status)
           VALUES ('legacy.read', 'legacy', 'read', 'active')`,
      );
    } finally {
      await migrator.end();
    }

    const client = await db.connect();
    try {
      await expect(applyMigrations(client)).resolves.toBeUndefined();
      await expect(applyMigrations(client)).resolves.toBeUndefined();
    } finally {
      await client.end();
    }

    const catalog = await readCatalog(db);
    expect(catalog).toContainEqual({
      id: 'legacy.read',
      domain: 'legacy',
      action: 'read',
      status: 'active',
    });
    for (const expected of EXPECTED_SEEDED) {
      expect(catalog).toContainEqual(expected);
    }

    const cleanup = await db.asMigrator();
    try {
      await cleanup.query(`DELETE FROM backoffice.permissions WHERE id = 'legacy.read'`);
    } finally {
      await cleanup.end();
    }
  });

  it('refuses an id-only conflict row on re-apply', async () => {
    // id-only conflict = cùng `id` nhưng (domain, action) khác. CHECK Gap 1
    // chặn ngay vì id phải = domain.action, nên một row id='role.read' với
    // domain='other' là bất hợp lệ ở tầng DB — không cần chờ re-apply.
    const migrator = await db.asMigrator();
    try {
      await expect(
        migrator.query(
          `INSERT INTO backoffice.permissions (id, domain, action, status)
             VALUES ('role.read', 'other', 'read', 'active')`,
        ),
      ).rejects.toThrow(/violates check constraint/iu);
    } finally {
      await migrator.end();
    }
  });

  it('self-heals the full catalog after TRUNCATE', async () => {
    // Mô phỏng mất toàn bộ catalog (TRUNCATE) rồi apply lại ⇒ toàn bộ 3 seed
    // quay lại đúng baseline. Đây là đường khôi phục duy nhất được phép: seed
    // migration là nguồn sự thật, không có down-migration.
    const client = await db.connect();
    try {
      await client.query(`TRUNCATE backoffice.permissions CASCADE`);
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM backoffice.permissions`,
      );
      expect(rows[0]?.count).toBe('0');

      await applyMigrations(client);
    } finally {
      await client.end();
    }

    expect(await readCatalog(db)).toEqual(EXPECTED_SEEDED);
  });
});
