/**
 * Hai khoảng trống AC của issue #85 mà các suite còn lại của `db-backoffice`
 * chưa phủ:
 *
 *  1. **Apply migration hai lần là no-op ở tầng dữ liệu.** `apply.mts` cam kết
 *     "mọi DDL ở dạng idempotent, apply lại là no-op"; `tests/databases/
 *     migrations.spec.ts` đã chứng minh lần apply lại không sinh thêm **bảng**.
 *     Test này pin thêm ở tầng **hàng**: seed dữ liệu RBAC thật, apply lại qua
 *     đúng đường `applyMigrations`, rồi so số hàng của **mọi** bảng trong schema
 *     — không hàng nào được sinh thêm, catalog seed của `0003` không nhân bản,
 *     và advisory lock phải nhả để runner khác lấy được ngay.
 *
 *  2. **Race revoke/assign trên hai connection thật.** `role_assignments`
 *     (`0001`) **không có** PK và **không có** UNIQUE trên `(staff_sub,
 *     role_id)` — ràng buộc của nó chỉ là hai FK và hai CHECK thời gian (comment
 *     "PK (staff_sub, role_id)" ở `0001` dòng ~355 là stale: không có constraint
 *     nào tên như vậy tồn tại). §4.5: "một staff member có thể có nhiều role" và
 *     schema không cấm lặp cặp; tập quyền hiện hành là hợp các assignment còn
 *     hiệu lực đọc tại read-time (§4.6), nên bản ghi lặp không phải đường leo
 *     thang. Test này pin đúng hành vi đó: hai INSERT đồng thời từ hai connection
 *     đều commit — và nếu một migration sau thêm ràng buộc duy nhất, test ĐỎ và
 *     buộc xem lại contract. Cùng lúc đó đường UPDATE `revoked_at` của runtime bị
 *     trigger `0004` từ chối (F1, SR-005) **bất kể** có INSERT từ connection khác
 *     tranh chấp đồng thời hay không — kết cục của mỗi connection không phụ thuộc
 *     interleaving, vì refusal đến từ ngữ nghĩa trigger trên hàng đã tồn tại,
 *     không phải từ lock.
 *
 * Technique hai connection + `pg_sleep` barrier mirror `apps/account/tests/
 * integrations/handoff.spec.ts` (AC-008b2): `pg_sleep` bên trong transaction giữ
 * mỗi side mở tới khi cả hai đã sẵn sàng, nên hai statement thực sự tranh nhau
 * thay vì lần này chạy xong trước lần kia kịp bắt đầu.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BACKOFFICE_DATABASE } from '../../db/migrate.mts';
import { type BackofficeDatabase, applyMigrations, startBackofficeDatabase } from './harness.ts';

/**
 * Account ID hợp lệ theo định dạng `libs/backoffice-domain` (`sub_` + 32 ký tự
 * base32 viết thường). COPY từ `self-elevation-guard.spec.ts` — 06-testing.md §6
 * cấm shared test-support import chéo giữa các spec, nên helper nhỏ này được
 * nhân bản **có chủ đích** (hai harness giống hệt nhau là by-design, không phải
 * nợ kỹ thuật). CHECK `staff_sub_account_id_format_check` của `0004` chặn mọi
 * chuỗi tự do — fixture lệch định dạng là test đỏ vì lý do sai.
 */
const accountId = (seed: string): string => `sub_${seed.repeat(32)}`;

const STAFF_SUB = accountId('r');
const ACTOR_ONE = accountId('x');
const ACTOR_TWO = accountId('y');

/** Role custom (không `sys_`) — runtime chỉ gán được role custom (ADR-0004). */
const CUSTOM_ROLE = 'role_race_fixture';

/** Catalog seed của `0003` — đúng bốn permission read, không hơn. */
const EXPECTED_CATALOG_IDS = ['audit.read', 'permission.read', 'role.read', 'staff.read'];

/**
 * Toàn bộ bảng của schema `backoffice` — snapshot số hàng trên TẤT CẢ, vì
 * "apply lại là no-op" là claim về cả schema, không chỉ RBAC. Danh sách khớp
 * `EXPECTED_TABLES` của `tests/databases/migrations.spec.ts`; thêm bảng mới vào
 * schema mà quên thêm vào đây thì snapshot của test này không còn phủ bảng đó —
 * chính vì vậy danh sách được liệt kê tường minh thay vì sinh từ catalog.
 */
const ALL_TABLES = [
  'authorization_audit',
  'bff_login_flows',
  'bff_sessions',
  'permissions',
  'role_assignments',
  'role_permissions',
  'roles',
  'staff',
] as const;

/** Số hàng của mọi bảng — một câu SELECT, tên bảng là hằng compile-time. */
async function rowCountPerTable(db: BackofficeDatabase): Promise<Record<string, number>> {
  const client = await db.connect();
  try {
    const selectList = ALL_TABLES.map(
      (table) => `(SELECT count(*) FROM backoffice.${table}) AS "${table}"`,
    ).join(', ');
    const { rows } = await client.query<Record<string, string>>(`SELECT ${selectList}`);
    const [counts] = rows;
    return Object.fromEntries(
      Object.entries(counts ?? {}).map(([table, count]) => [table, Number(count)]),
    );
  } finally {
    await client.end();
  }
}

/** Id của catalog permission — để assert seed không nhân bản và không mất hàng. */
async function catalogIds(db: BackofficeDatabase): Promise<string[]> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM backoffice.permissions ORDER BY id`,
    );
    return rows.map((row) => row.id);
  } finally {
    await client.end();
  }
}

describe('double-apply no-op and assignment races on db-backoffice (#85)', () => {
  let db: BackofficeDatabase;

  beforeAll(async () => {
    db = await startBackofficeDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.truncateData();
    // ⚠️ `truncateData()` xoá cả `backoffice.permissions` — catalog seeded ở
    // `0003`. Khôi phục bằng cách apply lại (idempotent) — cùng cách
    // `self-elevation-guard.spec.ts` làm, giữ nguồn sự thật của catalog là seed
    // migration thay vì fixture tự INSERT permission.
    const migrator = await db.asMigrator();
    try {
      await applyMigrations(migrator);
    } finally {
      await migrator.end();
    }
  });

  // ---------------------------------------------------------------------------
  // Gap 1 — apply hai lần là no-op ở tầng hàng
  // ---------------------------------------------------------------------------

  it('a second and third full apply change no row in any backoffice table', async () => {
    // Seed dữ liệu RBAC bằng migrator để no-op phải bảo vệ HÀNG, không chỉ bảng:
    // một migration idempotent hỏng (vd `INSERT … SELECT` thiếu `WHERE NOT
    // EXISTS`) sinh hàng trùng ở lần apply lại — chỉ thấy được khi đếm hàng.
    await seedStaff(STAFF_SUB);
    await seedCustomRole(CUSTOM_ROLE);
    const seeder = await db.asMigrator();
    try {
      await seeder.query(
        `INSERT INTO backoffice.role_permissions (role_id, permission_id)
         VALUES ($1, 'staff.read')`,
        [CUSTOM_ROLE],
      );
      await seeder.query(
        `INSERT INTO backoffice.role_assignments (staff_sub, role_id, created_by_sub)
         VALUES ($1, $2, $3)`,
        [STAFF_SUB, CUSTOM_ROLE, ACTOR_ONE],
      );
      await seeder.query(
        `INSERT INTO backoffice.authorization_audit (actor_sub, target_sub, action, outcome)
         VALUES ($1, $2, 'role.assign', 'success')`,
        [ACTOR_ONE, STAFF_SUB],
      );
    } finally {
      await seeder.end();
    }

    // Snapshot TRƯỚC khi apply lại. Lịch sử apply tới điểm này: lần 1 trong
    // `startBackofficeDatabase`, lần 2 trong `beforeEach` (khôi phục catalog),
    // nên hai lần dưới đây là lần 3 và 4 — nếu idempotence chỉ đúng vài lần đầu
    // thì lịch sử dài hơn càng dễ bại lộ.
    const before = await rowCountPerTable(db);
    const catalogBefore = await catalogIds(db);

    // Đúng đường code mà lần apply đầu đã đi: `applyMigrations` →
    // `applyAllMigrations` với advisory lock (`harness.ts` giữ wrapper đúng vì
    // lý do đó). Phải không ném — lỗi ở lần apply lại là mất idempotence.
    const migrator = await db.asMigrator();
    try {
      await applyMigrations(migrator);
      await applyMigrations(migrator);
    } finally {
      await migrator.end();
    }

    expect(await rowCountPerTable(db)).toEqual(before);
    expect(await catalogIds(db)).toEqual(catalogBefore);
    // Seed idempotency nhìn thấy được: catalog vẫn đúng 4 row của `0003`,
    // `ON CONFLICT DO NOTHING` + `WHERE NOT EXISTS` không nhân bản chúng.
    expect(catalogBefore).toEqual(EXPECTED_CATALOG_IDS);
  });

  it('releases the advisory lock after a re-apply, so another runner can take it right away', async () => {
    const migrator = await db.asMigrator();
    try {
      await applyMigrations(migrator);
    } finally {
      await migrator.end();
    }

    // Lock là session-scoped (`pg_advisory_lock`, `apply.mts`), nhả khi
    // connection đóng — test này pin hành vi đầu-cuối: sau khi runner apply xong
    // và ngắt kết nối, runner khác phải lấy được lock NGAY (lock_timeout ngắn).
    // Nếu một thay đổi sau này giữ lock ở cơ chế khác (vd pool connection còn
    // sống), apply xong mà lock không nhả thì runner kế tiếp chết vì timeout —
    // đúng sự cố mà assertion này phải bắt.
    const nextRunner = await db.connect();
    try {
      await nextRunner.query(`SET lock_timeout = '500ms'`);
      await expect(
        nextRunner.query('SELECT pg_advisory_lock(hashtext($1))', [BACKOFFICE_DATABASE]),
      ).resolves.toBeDefined();
    } finally {
      await nextRunner
        .query('SELECT pg_advisory_unlock(hashtext($1))', [BACKOFFICE_DATABASE])
        .catch(() => undefined);
      await nextRunner.end();
    }
  });

  // ---------------------------------------------------------------------------
  // Gap 2 — race revoke/assign trên hai connection thật
  // ---------------------------------------------------------------------------

  it('two concurrent INSERTs of the same (staff_sub, role_id) from two connections both commit — role_assignments has no uniqueness rule (0001)', async () => {
    // Pin đúng contract hiện hành của `0001`: `role_assignments` chỉ có hai FK
    // (`staff_sub` → staff, `role_id` → roles) và hai CHECK thời gian — KHÔNG có
    // PK/UNIQUE trên `(staff_sub, role_id)` (comment "PK (staff_sub, role_id)"
    // ở `0001` ~dòng 355 là stale). §4.5 cho phép một staff có nhiều assignment
    // và schema không cấm lặp cặp; tính duy nhất của quyền hiện hành là việc của
    // read-time union (§4.6, workstream B), không phải ràng buộc dòng.
    //
    // Vì vậy cả hai INSERT phải cùng commit. Nếu một migration sau thêm ràng
    // buộc duy nhất cho cặp này, test ĐỎ ở đây — đó là hành vi mong muốn: một
    // thay đổi contract của assignment phải đi qua việc xem lại test này, không
    // được lọt qua im lặng.
    await seedStaff(STAFF_SUB);
    await seedCustomRole(CUSTOM_ROLE);

    // Hai credential runtime THẬT (`connectAsRuntime`, không `SET ROLE`) — đúng
    // ranh giới tầng kết nối mà `self-elevation-guard.spec.ts` kiểm, và trigger
    // `0004` đọc `current_user` nên credential thật là điều kiện để guard chạy
    // đúng nhánh runtime.
    const first = await db.connectAsRuntime();
    const second = await db.connectAsRuntime();
    try {
      const barrier = 'SELECT pg_sleep(0.5)';
      const insertSql = `INSERT INTO backoffice.role_assignments (staff_sub, role_id, created_by_sub)
                         VALUES ($1, $2, $3)`;

      // Hai actor khác nhau, cùng `staff_sub` + `role_id` — đúng kịch bản "hai
      // admin gán cùng role cho cùng người trong cùng khoảnh khắc".
      const one = (async () => {
        await first.query('BEGIN');
        await first.query(barrier);
        await first.query(insertSql, [STAFF_SUB, CUSTOM_ROLE, ACTOR_ONE]);
        await first.query('COMMIT');
        return 'committed' as const;
      })();
      const two = (async () => {
        await second.query('BEGIN');
        await second.query(barrier);
        await second.query(insertSql, [STAFF_SUB, CUSTOM_ROLE, ACTOR_TWO]);
        await second.query('COMMIT');
        return 'committed' as const;
      })();

      // Không side nào được ném: không ràng buộc nào để tranh, và trigger `0004`
      // cho cả hai qua (actor hợp lệ, khác `staff_sub`, role custom).
      expect(await Promise.all([one, two])).toEqual(['committed', 'committed']);

      const counter = await db.connect();
      try {
        const { rows } = await counter.query<{ created_by_sub: string }>(
          `SELECT created_by_sub FROM backoffice.role_assignments
            WHERE staff_sub = $1 AND role_id = $2`,
          [STAFF_SUB, CUSTOM_ROLE],
        );
        // Đúng HAI bản ghi sống sót sau race — không bản ghi nào bị mất, không
        // side nào bị rollback ngầm.
        expect(rows.map((row) => row.created_by_sub).toSorted()).toEqual(
          [ACTOR_ONE, ACTOR_TWO].toSorted(),
        );
      } finally {
        await counter.end();
      }
    } finally {
      await first.end();
      await second.end();
    }
  });

  it('a revoke attempt racing an INSERT from another connection is refused deterministically (0004 trigger, F1)', async () => {
    // Kịch bản: assignment đã tồn tại; cùng khoảnh khắc, connection A (runtime)
    // thu hồi bằng UPDATE `revoked_at` trong khi connection B (runtime) gán thêm
    // một assignment cùng cặp (staff, role). Kết cục phải KHÔNG phụ thuộc thứ tự
    // interleaving:
    //   * UPDATE bị trigger `role_assignments_no_self_elevation` (`0004`) từ chối
    //     — guard là BEFORE UPDATE per-row đọc `current_user`, không có đường
    //     nào qua được dù chạy trước hay sau INSERT; refusal mang đúng thông
    //     điệp F1, không phải lỗi lock hay serialization.
    //   * INSERT thành công — nó tạo hàng MỚI, không đụng lock của hàng gốc
    //     (không ràng buộc duy nhất để tranh, xem test trên).
    await seedStaff(STAFF_SUB);
    await seedCustomRole(CUSTOM_ROLE);
    // Hàng gốc do MIGRATOR tạo — trạng thái đã tồn tại khi race bắt đầu (một
    // assignment hợp lệ từ đường governance), chứ không phải do side nào trong
    // race tạo ra.
    const seeder = await db.asMigrator();
    try {
      await seeder.query(
        `INSERT INTO backoffice.role_assignments (staff_sub, role_id)
         VALUES ($1, $2)`,
        [STAFF_SUB, CUSTOM_ROLE],
      );
    } finally {
      await seeder.end();
    }

    const revoker = await db.connectAsRuntime();
    const assigner = await db.connectAsRuntime();
    try {
      const barrier = 'SELECT pg_sleep(0.5)';
      const revokeSql = `UPDATE backoffice.role_assignments
                            SET revoked_at = now()
                          WHERE staff_sub = $1 AND role_id = $2`;
      const insertSql = `INSERT INTO backoffice.role_assignments (staff_sub, role_id, created_by_sub)
                         VALUES ($1, $2, $3)`;

      let revokeError: unknown;
      const revoke = (async () => {
        try {
          await revoker.query('BEGIN');
          await revoker.query(barrier);
          await revoker.query(revokeSql, [STAFF_SUB, CUSTOM_ROLE]);
          await revoker.query('COMMIT');
          return 'committed' as const;
        } catch (error) {
          revokeError = error;
          // Transaction đã abort sau lỗi — ROLLBACK để connection đóng sạch.
          await revoker.query('ROLLBACK').catch(() => undefined);
          return 'refused' as const;
        }
      })();
      const assign = (async () => {
        await assigner.query('BEGIN');
        await assigner.query(barrier);
        await assigner.query(insertSql, [STAFF_SUB, CUSTOM_ROLE, ACTOR_TWO]);
        await assigner.query('COMMIT');
        return 'committed' as const;
      })();

      const [revokeOutcome] = await Promise.all([revoke, assign]);

      expect(revokeOutcome).toBe('refused');
      // Refusal là của guard F1 (SR-005) — đúng nhánh `revoked_at/valid_until`
      // của trigger `0004`, không phải lỗi lock/serialization: nếu refusal đổi
      // sang một lỗi khác (vd `deadlock detected`), race đã biến refusal thành
      // phụ thuộc timing và test này phải đỏ.
      expect((revokeError as Error).message).toMatch(
        /khong duoc thay doi revoked_at\/valid_until/u,
      );

      const counter = await db.connect();
      try {
        const { rows } = await counter.query<{
          created_by_sub: string | null;
          revoked_at: string | null;
        }>(
          `SELECT created_by_sub, revoked_at FROM backoffice.role_assignments
            WHERE staff_sub = $1 AND role_id = $2`,
          [STAFF_SUB, CUSTOM_ROLE],
        );
        // Hàng gốc (migrator, `created_by_sub` NULL) còn nguyên và CHƯA bị thu
        // hồi: UPDATE bị từ chối toàn phần trước khi kịp đổi anything — không
        // có trạng thái "thu hồi một phần" giữa chừng.
        const original = rows.find((row) => row.created_by_sub === null);
        expect(original).toBeDefined();
        expect(original?.revoked_at).toBeNull();
        // Assignment mới từ connection gán role vẫn commit được.
        expect(rows).toHaveLength(2);
        expect(rows.filter((row) => row.created_by_sub === ACTOR_TWO)).toHaveLength(1);
      } finally {
        await counter.end();
      }
    } finally {
      await revoker.end();
      await assigner.end();
    }
  });

  // ---------------------------------------------------------------------------
  // Fixtures — nhân bản từ `self-elevation-guard.spec.ts` vì 06-testing.md §6
  // cấm shared test-support import chéo giữa các spec.
  // ---------------------------------------------------------------------------

  /** Tạo staff row bằng migrator (runtime cũng INSERT được, nhưng fixture dùng
   *  migrator để test tập trung vào hành vi cần kiểm). */
  async function seedStaff(sub: string): Promise<void> {
    const migrator = await db.asMigrator();
    try {
      await migrator.query(`INSERT INTO backoffice.staff (sub) VALUES ($1)`, [sub]);
    } finally {
      await migrator.end();
    }
  }

  /** Tạo role custom bằng migrator — runtime chỉ có SELECT trên `roles`, tạo
   *  role là governance action (ADR-0004), nên fixture phải đi đường migrator. */
  async function seedCustomRole(id: string): Promise<void> {
    const migrator = await db.asMigrator();
    try {
      await migrator.query(`INSERT INTO backoffice.roles (id, is_system) VALUES ($1, false)`, [id]);
    } finally {
      await migrator.end();
    }
  }
});
