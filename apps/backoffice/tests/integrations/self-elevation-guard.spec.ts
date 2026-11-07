/**
 * Integration test cho guard self-elevation ở tầng database (migration `0004`).
 *
 * Đây là lớp phòng thủ **thứ hai** — tầng app (`requirePermission`, workstream
 * B) vẫn là checkpoint chính. Test ở đây chứng minh một điều khác và khó
 * hơn: **credential của đường serving** không đi được tới trạng thái leo
 * thang, kể cả khi tầng app bị lỗi.
 *
 * Vì vậy ranh giới được kiểm ở **tầng kết nối**: `db.connectAsRuntime()` mở
 * một connection bằng **credential thật** của `ecoma_backoffice_runtime`
 * (không phải `SET ROLE` từ superuser), và `db.asMigrator()` là đường
 * bootstrap/seed. `has_*_privilege` không đủ: một grant có vẻ đúng nhưng
 * trigger/CHECK không chạy vẫn là một đường leo thang mở.
 *
 * Mỗi guard có **mutation evidence** — xem mục "Mutation evidence" ở cuối file.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type BackofficeDatabase, applyMigrations, startBackofficeDatabase } from './harness.ts';

/**
 * Account ID hợp lệ theo định dạng `libs/backoffice-domain` (`sub_` + 32 ký tự
 * base32 viết thường). Dùng hằng `repeat` thay vì literal để con số 32 không
 * lệch khỏi `BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS`.
 */
const sub = (seed: string): string => `sub_${seed.repeat(32)}`;

/** Actor khác `staff_sub` — dùng khi test cần một assignment hợp lệ. */
const ACTOR = sub('a');
const OTHER_STAFF = sub('b');
const SUBJECT = sub('c');

/** Runtime role — tầng app dùng đúng credential này. */
const RUNTIME = 'ecoma_backoffice_runtime';

describe('self-elevation guard on db-backoffice (0004)', () => {
  let db: BackofficeDatabase;

  beforeAll(async () => {
    db = await startBackofficeDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.truncateData();
    // ⚠️ `truncateData()` của harness xoá **cả** `backoffice.permissions` — mà
    // đó là catalog seeded ở migration `0003`. Khôi phục nó bằng cách apply
    // lại migration (idempotent: `0003` dùng `ON CONFLICT (id) DO NOTHING`).
    // Cách này giữ đúng **nguồn sự thật** của catalog là seed migration, thay
    // vì fixture tự INSERT permission trong test — một permission do test tự
    // chế ra không chứng minh được catalog thật cũng qua guard.
    const migrator = await db.asMigrator();
    try {
      await applyMigrations(migrator);
    } finally {
      await migrator.end();
    }
  });

  /**
   * Tạo một role custom (không phải system-defined) bằng **migrator** — runtime
   * chỉ có SELECT trên `roles` (tạo role là governance action), nên fixture
   * phải tạo bằng migrator, nếu không test sẽ đỏ vì lý do sai.
   */
  async function seedCustomRole(id: string): Promise<void> {
    const migrator = await db.asMigrator();
    try {
      await migrator.query(`INSERT INTO backoffice.roles (id, is_system) VALUES ($1, false)`, [id]);
    } finally {
      await migrator.end();
    }
  }

  /** Tạo một system-defined role bằng migrator (id prefix `sys_`). */
  async function seedSystemRole(id: string): Promise<void> {
    const migrator = await db.asMigrator();
    try {
      await migrator.query(`INSERT INTO backoffice.roles (id, is_system) VALUES ($1, true)`, [id]);
    } finally {
      await migrator.end();
    }
  }

  /** Tạo một staff row hợp lệ bằng migrator (runtime cũng INSERT được, nhưng
   *  fixture dùng migrator để test tập trung vào trigger cần kiểm). */
  async function seedStaff(accountId: string): Promise<void> {
    const migrator = await db.asMigrator();
    try {
      await migrator.query(`INSERT INTO backoffice.staff (sub) VALUES ($1)`, [accountId]);
    } finally {
      await migrator.end();
    }
  }

  // -------------------------------------------------------------------------
  // staff.sub — CHECK định dạng Account ID
  // -------------------------------------------------------------------------

  it('refuses a staff row whose sub is not a valid Account ID', async () => {
    // `staff.sub` là reference opaque sang Account ID của `account` — không FK
    // xuyên database nên không có gì bảo đảm nó là Account ID thật. Trước
    // migration `0004` mọi chuỗi đều qua được, kể cả chuỗi mang PII.
    //
    // Mutation evidence: bỏ CHECK `staff_sub_account_id_format_check` ⇒ test
    // này đỏ (INSERT thành công thay vì ném).
    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(`INSERT INTO backoffice.staff (sub) VALUES ($1)`, ['not-an-account-id']),
      ).rejects.toThrow(/staff_sub_account_id_format_check/u);
    } finally {
      await runtime.end();
    }
  });

  it('refuses a staff row whose sub carries an email address', async () => {
    // PII trong bảng định danh là đúng thứ SR-014 cấm ở audit; ở đây nó là
    // việc `staff` trở thành chỗ chứa dữ liệu không kiểm soát được.
    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(`INSERT INTO backoffice.staff (sub) VALUES ($1)`, ['person@example.com']),
      ).rejects.toThrow(/staff_sub_account_id_format_check/u);
    } finally {
      await runtime.end();
    }
  });

  it('refuses a staff row whose sub has a non-base32 character', async () => {
    // Base32 RFC 4648 viết thường: `a`–`z`, `2`–`7`. `0`, `1`, `8`, `9` và
    // chữ hoa đều không thuộc alphabet — `sub_` + 32 ký tự nhưng sai alphabet
    // vẫn phải bị từ chối.
    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(`INSERT INTO backoffice.staff (sub) VALUES ($1)`, [`sub_${'0'.repeat(32)}`]),
      ).rejects.toThrow(/staff_sub_account_id_format_check/u);
    } finally {
      await runtime.end();
    }
  });

  it('refuses a staff row whose sub has the wrong entropy length', async () => {
    // 31 ký tự — thiếu một ký tự base32 là thiếu 5 bit entropy. Ngưỡng là
    // của **producer** (`libs/account-domain/src/subject.ts`), không phải con
    // số tự chọn.
    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(`INSERT INTO backoffice.staff (sub) VALUES ($1)`, [`sub_${'a'.repeat(31)}`]),
      ).rejects.toThrow(/staff_sub_account_id_format_check/u);
    } finally {
      await runtime.end();
    }
  });

  it('accepts a staff row whose sub is a valid Account ID', async () => {
    // Cặp điều kiện của CHECK: chặn cái sai thì phải **cho** cái đúng — một
    // CHECK chặn hết cũng là một guard hỏng.
    const runtime = await db.connectAsRuntime();
    try {
      await runtime.query(`INSERT INTO backoffice.staff (sub) VALUES ($1)`, [ACTOR]);
      const { rows } = await runtime.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM backoffice.staff WHERE sub = $1`,
        [ACTOR],
      );
      expect(rows[0]?.count).toBe('1');
    } finally {
      await runtime.end();
    }
  });

  // -------------------------------------------------------------------------
  // role_assignments — chặn self-assignment và gán system-defined role
  // -------------------------------------------------------------------------

  it('refuses a role assignment the runtime role makes to itself', async () => {
    // SR-005 / T-01 / AC-006: cấm tự gán role cho chính mình. Đây là lỗi ở
    // tầng app (tầng app chặn qua `requirePermission`), nhưng nếu một code path
    // ghi thẳng xuống DB thì tầng DB là lớp chặn cuối.
    //
    // Mutation evidence: bỏ điều kiện (4) trong trigger ⇒ test này đỏ (INSERT
    // thành công).
    await seedCustomRole('role_reader');
    await seedStaff(ACTOR);
    await seedStaff(OTHER_STAFF);

    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(
          `INSERT INTO backoffice.role_assignments (staff_sub, role_id, created_by_sub)
           VALUES ($1, 'role_reader', $1)`,
          [ACTOR],
        ),
      ).rejects.toThrow(/khong duoc tu gan role cho chinh minh/u);
    } finally {
      await runtime.end();
    }
  });

  it('refuses a role assignment to a system-defined role', async () => {
    // ADR-0004: giai đoạn này **chỉ có system-defined role**, và "thay đổi nội
    // dung role là một governance action có audit, không phải thao tác runtime
    // của admin". Runtime gán system-defined role là đường leo thang còn nguyên.
    //
    // Mutation evidence: bỏ điều kiện (1) trong trigger ⇒ test này đỏ.
    await seedSystemRole('sys_reader');
    await seedStaff(OTHER_STAFF);

    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(
          `INSERT INTO backoffice.role_assignments (staff_sub, role_id, created_by_sub)
           VALUES ($1, 'sys_reader', $2)`,
          [OTHER_STAFF, ACTOR],
        ),
      ).rejects.toThrow(/khong duoc gan system-defined role/u);
    } finally {
      await runtime.end();
    }
  });

  it('refuses a role assignment without a declared actor', async () => {
    // `created_by_sub` là actor của việc gán role. Không có actor thì không
    // truy vết được ai đã cấp quyền (SR-013) — và điều kiện "tự gán cho
    // chính mình" cũng bị bỏ qua theo khi actor bỏ trống.
    //
    // Mutation evidence: bỏ điều kiện (2) trong trigger ⇒ test này đỏ.
    await seedCustomRole('role_reader');
    await seedStaff(OTHER_STAFF);

    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(
          `INSERT INTO backoffice.role_assignments (staff_sub, role_id) VALUES ($1, 'role_reader')`,
          [OTHER_STAFF],
        ),
      ).rejects.toThrow(/phai khai bao actor/u);
    } finally {
      await runtime.end();
    }
  });

  it('refuses a role assignment whose actor is not a valid Account ID', async () => {
    // Actor là **danh tính được khai báo** — nó phải có đúng định dạng
    // Account ID để lớp chặn cuối cùng (và audit) đọc được.
    //
    // Mutation evidence: bỏ điều kiện (3) trong trigger ⇒ test này đỏ.
    await seedCustomRole('role_reader');
    await seedStaff(OTHER_STAFF);

    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(
          `INSERT INTO backoffice.role_assignments (staff_sub, role_id, created_by_sub)
           VALUES ($1, 'role_reader', 'actor-with-a-payload')`,
          [OTHER_STAFF],
        ),
      ).rejects.toThrow(/created_by_sub phai la Account ID dung dinh dang/u);
    } finally {
      await runtime.end();
    }
  });

  it('allows a role assignment between two different staff members', async () => {
    // Cặp điều kiện: guard chặn self-assignment thì phải **cho** gán role cho
    // người khác — nếu không thì guard chặn hết và bootstrap bằng runtime
    // không bao giờ chạy được.
    await seedCustomRole('role_reader');
    await seedStaff(OTHER_STAFF);

    const runtime = await db.connectAsRuntime();
    try {
      await runtime.query(
        `INSERT INTO backoffice.role_assignments (staff_sub, role_id, created_by_sub)
         VALUES ($1, 'role_reader', $2)`,
        [OTHER_STAFF, ACTOR],
      );
      const { rows } = await runtime.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM backoffice.role_assignments`,
      );
      expect(rows[0]?.count).toBe('1');
    } finally {
      await runtime.end();
    }
  });

  it('refuses revoking an assignment by setting revoked_at', async () => {
    // F1: runtime không được tự thay đổi `revoked_at` — un-revoke (SET NULL)
    // hay đặt giá trị mới đều là đường leo thang không có audit. Đường thu hồi
    // hợp lệ chưa tồn tại ở tầng app, nên block toàn phần là an toàn nhất.
    //
    // Mutation evidence: bỏ branch kiểm `revoked_at`/`valid_until` trong trigger
    // ⇒ test này đỏ (UPDATE thành công).
    await seedCustomRole('role_reader');
    await seedStaff(OTHER_STAFF);

    const runtime = await db.connectAsRuntime();
    try {
      await runtime.query(
        `INSERT INTO backoffice.role_assignments (staff_sub, role_id, created_by_sub)
         VALUES ($1, 'role_reader', $2)`,
        [OTHER_STAFF, ACTOR],
      );
      await expect(
        runtime.query(
          `UPDATE backoffice.role_assignments SET revoked_at = now() + interval '1 hour'
            WHERE staff_sub = $1`,
          [OTHER_STAFF],
        ),
      ).rejects.toThrow(/khong duoc thay doi revoked_at\/valid_until/u);
    } finally {
      await runtime.end();
    }
  });

  it('refuses un-revoking an assignment by setting revoked_at to NULL', async () => {
    // F1 bắt buộc: runtime SET revoked_at = NULL trên hàng đã revoked → fail.
    await seedCustomRole('role_reader');
    await seedStaff(OTHER_STAFF);

    const migrator = await db.asMigrator();
    try {
      await migrator.query(
        `INSERT INTO backoffice.role_assignments (staff_sub, role_id, created_by_sub, revoked_at)
         VALUES ($1, 'role_reader', $2, now() + interval '1 hour')`,
        [OTHER_STAFF, ACTOR],
      );
    } finally {
      await migrator.end();
    }

    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(
          `UPDATE backoffice.role_assignments SET revoked_at = NULL
            WHERE staff_sub = $1`,
          [OTHER_STAFF],
        ),
      ).rejects.toThrow(/khong duoc thay doi revoked_at\/valid_until/u);
    } finally {
      await runtime.end();
    }
  });

  it('refuses clearing valid_until on an assignment', async () => {
    // F1 bắt buộc: runtime SET valid_until = NULL → fail.
    await seedCustomRole('role_reader');
    await seedStaff(OTHER_STAFF);

    const runtime = await db.connectAsRuntime();
    try {
      await runtime.query(
        `INSERT INTO backoffice.role_assignments (staff_sub, role_id, created_by_sub, valid_until)
         VALUES ($1, 'role_reader', $2, now() + interval '1 day')`,
        [OTHER_STAFF, ACTOR],
      );
      await expect(
        runtime.query(
          `UPDATE backoffice.role_assignments SET valid_until = NULL
            WHERE staff_sub = $1`,
          [OTHER_STAFF],
        ),
      ).rejects.toThrow(/khong duoc thay doi revoked_at\/valid_until/u);
    } finally {
      await runtime.end();
    }
  });

  it('refuses extending valid_until on an assignment', async () => {
    // F1 bắt buộc: runtime SET valid_until = now() + interval '100 years' → fail.
    await seedCustomRole('role_reader');
    await seedStaff(OTHER_STAFF);

    const runtime = await db.connectAsRuntime();
    try {
      await runtime.query(
        `INSERT INTO backoffice.role_assignments (staff_sub, role_id, created_by_sub, valid_until)
         VALUES ($1, 'role_reader', $2, now() + interval '1 day')`,
        [OTHER_STAFF, ACTOR],
      );
      await expect(
        runtime.query(
          `UPDATE backoffice.role_assignments SET valid_until = now() + interval '100 years'
            WHERE staff_sub = $1`,
          [OTHER_STAFF],
        ),
      ).rejects.toThrow(/khong duoc thay doi revoked_at\/valid_until/u);
    } finally {
      await runtime.end();
    }
  });

  it('refuses an update that re-points an assignment to a system-defined role', async () => {
    // Đổi `role_id` trên một assignment là một lần cấp quyền mới — phải qua
    // guard như một INSERT.
    //
    // Mutation evidence: bỏ `role_id` khỏi danh sách cột của trigger
    // (`UPDATE OF staff_sub, role_id, created_by_sub`) ⇒ test này đỏ.
    await seedCustomRole('role_reader');
    await seedSystemRole('sys_reader');
    await seedStaff(OTHER_STAFF);

    const runtime = await db.connectAsRuntime();
    try {
      await runtime.query(
        `INSERT INTO backoffice.role_assignments (staff_sub, role_id, created_by_sub)
         VALUES ($1, 'role_reader', $2)`,
        [OTHER_STAFF, ACTOR],
      );
      await expect(
        runtime.query(`UPDATE backoffice.role_assignments SET role_id = 'sys_reader'`),
      ).rejects.toThrow(/khong duoc gan system-defined role/u);
    } finally {
      await runtime.end();
    }
  });

  // -------------------------------------------------------------------------
  // role_permissions — chỉ gắn permission `active`, không đụng role system
  // -------------------------------------------------------------------------

  it('refuses attaching a retired permission to a role', async () => {
    // `0001` đã chặn việc **hồi sinh** một entry `retired` (UPDATE status) —
    // nhưng chưa chặn việc **gắn lại** permission đã retired vào một role.
    // Đó là lỗ hổng của đường `role_permissions`.
    //
    // Mutation evidence: bỏ điều kiện (a) trong trigger `role_permissions` ⇒
    // test này đỏ (INSERT thành công).
    await seedCustomRole('role_reader');

    const migrator = await db.asMigrator();
    try {
      await migrator.query(
        `INSERT INTO backoffice.permissions (id, domain, action, status)
         VALUES ('delivery.retired', 'delivery', 'retired', 'retired')`,
      );
    } finally {
      await migrator.end();
    }

    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(
          `INSERT INTO backoffice.role_permissions (role_id, permission_id, created_by_sub)
           VALUES ('role_reader', 'delivery.retired', $1)`,
          [ACTOR],
        ),
      ).rejects.toThrow(/chi duoc gan permission dang active/u);
    } finally {
      await runtime.end();
    }
  });

  it('refuses attaching a permission that is not in the catalog at all', async () => {
    // Fail-closed: permission không tồn tại cũng là "không phải active". Guard
    // không dựa vào thứ tự lỗi của FK.
    await seedCustomRole('role_reader');

    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(
          `INSERT INTO backoffice.role_permissions (role_id, permission_id, created_by_sub)
           VALUES ('role_reader', 'delivery.invented', $1)`,
          [ACTOR],
        ),
      ).rejects.toThrow(/chi duoc gan permission dang active/u);
    } finally {
      await runtime.end();
    }
  });

  it('refuses attaching a permission to a system-defined role', async () => {
    // ADR-0004: nội dung của system-defined role là governance action có
    // audit, không phải thao tác runtime của admin.
    //
    // Mutation evidence: bỏ điều kiện (b) trong trigger `role_permissions` ⇒
    // test này đỏ.
    await seedSystemRole('sys_reader');

    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(
          `INSERT INTO backoffice.role_permissions (role_id, permission_id, created_by_sub)
           VALUES ('sys_reader', 'staff.read', $1)`,
          [ACTOR],
        ),
      ).rejects.toThrow(/khong duoc gan permission vao system-defined role/u);
    } finally {
      await runtime.end();
    }
  });

  it('refuses attaching a permission without a declared actor', async () => {
    // Cùng lý do với `role_assignments`: một lần gắn permission không có actor
    // thì không truy vết được ai đã cấp quyền (SR-013).
    //
    // Mutation evidence: bỏ điều kiện (c) trong trigger `role_permissions` ⇒
    // test này đỏ.
    await seedCustomRole('role_reader');

    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(
          `INSERT INTO backoffice.role_permissions (role_id, permission_id)
           VALUES ('role_reader', 'staff.read')`,
        ),
      ).rejects.toThrow(/phai khai bao actor/u);
    } finally {
      await runtime.end();
    }
  });

  it('refuses attaching a permission whose actor is not a valid Account ID', async () => {
    // Actor là **danh tính được khai báo** — nó phải có đúng định dạng
    // Account ID để lớp chặn cuối cùng (và audit) đọc được. Tương đương nhánh
    // format ở `role_assignments`; mutation M7 cần test này đỏ khi bỏ nhánh
    // `NEW.created_by_sub !~ '^sub_[a-z2-7]{32}$'`.
    //
    // Mutation evidence: bỏ nhánh format trong trigger `role_permissions` ⇒
    // test này đỏ.
    await seedCustomRole('role_reader');

    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(
          `INSERT INTO backoffice.role_permissions (role_id, permission_id, created_by_sub)
           VALUES ('role_reader', 'staff.read', 'actor-with-a-payload')`,
        ),
      ).rejects.toThrow(/created_by_sub phai la Account ID dung dinh dang/u);
    } finally {
      await runtime.end();
    }
  });

  it('allows attaching an active catalog permission to a custom role', async () => {
    // Cặp điều kiện: guard chặn permission không active thì phải **cho**
    // permission active.
    await seedCustomRole('role_reader');

    const runtime = await db.connectAsRuntime();
    try {
      await runtime.query(
        `INSERT INTO backoffice.role_permissions (role_id, permission_id, created_by_sub)
         VALUES ('role_reader', 'staff.read', $1)`,
        [ACTOR],
      );
      const { rows } = await runtime.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM backoffice.role_permissions`,
      );
      expect(rows[0]?.count).toBe('1');
    } finally {
      await runtime.end();
    }
  });

  it('refuses deleting a permission from a system-defined role', async () => {
    // F2: trigger trước đây chỉ bắt BEFORE INSERT, nên runtime DELETE được
    // permission khỏi system-defined role — thay đổi nội dung role là
    // governance action có audit (ADR-0004). DELETE phải qua guard như INSERT.
    //
    // Mutation evidence: bỏ trigger `role_permissions_no_system_delete` ⇒ test
    // này đỏ (DELETE thành công).
    await seedSystemRole('sys_reader');
    await seedCustomRole('role_reader');

    const migrator = await db.asMigrator();
    try {
      await migrator.query(
        `INSERT INTO backoffice.role_permissions (role_id, permission_id)
         VALUES ('sys_reader', 'staff.read')`,
      );
    } finally {
      await migrator.end();
    }

    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(
          `DELETE FROM backoffice.role_permissions
           WHERE role_id = 'sys_reader' AND permission_id = 'staff.read'`,
        ),
      ).rejects.toThrow(/khong duoc xoa permission khoi/u);
    } finally {
      await runtime.end();
    }
  });

  it('refuses deleting a permission from a custom role', async () => {
    // F2 — lựa chọn block toàn phần: nội dung role (cả custom role) là
    // governance action, runtime không compose role; đồng nhất với nguyên tắc
    // INSERT guard. Không có code path sản phẩm nào DELETE `role_permissions`
    // ở hiện tại, nên không có đường hợp lệ bị chặn nhầm.
    await seedCustomRole('role_reader');

    const migrator = await db.asMigrator();
    try {
      await migrator.query(
        `INSERT INTO backoffice.role_permissions (role_id, permission_id)
         VALUES ('role_reader', 'staff.read')`,
      );
    } finally {
      await migrator.end();
    }

    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(
          `DELETE FROM backoffice.role_permissions
           WHERE role_id = 'role_reader' AND permission_id = 'staff.read'`,
        ),
      ).rejects.toThrow(/khong duoc xoa permission khoi/u);
    } finally {
      await runtime.end();
    }
  });

  it('lets the migrator delete a permission from a role', async () => {
    // Bootstrap/governance phải đi qua được: migrator compose role bằng
    // INSERT/DELETE, guard không được chặn nhầm nó.
    await seedCustomRole('role_reader');

    const migrator = await db.asMigrator();
    try {
      await migrator.query(
        `INSERT INTO backoffice.role_permissions (role_id, permission_id)
         VALUES ('role_reader', 'staff.read')`,
      );
      await migrator.query(
        `DELETE FROM backoffice.role_permissions
         WHERE role_id = 'role_reader' AND permission_id = 'staff.read'`,
      );
      const { rows } = await migrator.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM backoffice.role_permissions`,
      );
      expect(rows[0]?.count).toBe('0');
    } finally {
      await migrator.end();
    }
  });

  // -------------------------------------------------------------------------
  // authorization_audit — CHECK độ dài correlation id + định dạng target_sub
  // -------------------------------------------------------------------------

  it('refuses an audit row whose request_id is longer than 128 characters', async () => {
    // Ngưỡng 128 là CÙNG con số với `AUTHORIZATION_AUDIT_ID_MAX_LENGTH` ở
    // `apps/backoffice/server/authorization-audit.ts`. Tầng app chặn trước khi
    // ghi; CHECK này chặn ở tầng DB cho mọi client không đi qua tầng app.
    //
    // Mutation evidence: bỏ CHECK `authorization_audit_request_id_length_check`
    // ⇒ test này đỏ.
    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(
          `INSERT INTO backoffice.authorization_audit (actor_sub, action, outcome, request_id)
           VALUES ($1, 'staff.view', 'success', $2)`,
          [ACTOR, 'r'.repeat(129)],
        ),
      ).rejects.toThrow(/authorization_audit_request_id_length_check/u);
    } finally {
      await runtime.end();
    }
  });

  it('refuses an audit row whose correlation_id is longer than 128 characters', async () => {
    // Mutation evidence: bỏ CHECK `authorization_audit_correlation_id_length_check`
    // ⇒ test này đỏ.
    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(
          `INSERT INTO backoffice.authorization_audit (actor_sub, action, outcome, correlation_id)
           VALUES ($1, 'staff.view', 'success', $2)`,
          [ACTOR, 'c'.repeat(129)],
        ),
      ).rejects.toThrow(/authorization_audit_correlation_id_length_check/u);
    } finally {
      await runtime.end();
    }
  });

  it('accepts an audit row whose correlation ids are exactly 128 characters', async () => {
    // Biên của CHECK: 128 phải qua (ngưỡng là "tối đa 128", không phải "dưới 128").
    const runtime = await db.connectAsRuntime();
    try {
      await runtime.query(
        `INSERT INTO backoffice.authorization_audit (actor_sub, action, outcome, request_id, correlation_id)
         VALUES ($1, 'staff.view', 'success', $2, $3)`,
        [ACTOR, 'r'.repeat(128), 'c'.repeat(128)],
      );
      const { rows } = await runtime.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM backoffice.authorization_audit`,
      );
      expect(rows[0]?.count).toBe('1');
    } finally {
      await runtime.end();
    }
  });

  it('refuses an audit row whose target_sub is not a valid Account ID', async () => {
    // `target_sub` là Account ID mà operation tác động, không phải chuỗi tự
    // do — ghi nó vào audit mà không kiểm soát là biến audit thành kênh rò dữ
    // liệu (S2, SR-014).
    //
    // Mutation evidence: bỏ CHECK `authorization_audit_target_sub_format_check`
    // ⇒ test này đỏ.
    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(
          `INSERT INTO backoffice.authorization_audit (actor_sub, target_sub, action, outcome)
           VALUES ($1, 'target-with-a-payload', 'staff.view', 'success')`,
          [ACTOR],
        ),
      ).rejects.toThrow(/authorization_audit_target_sub_format_check/u);
    } finally {
      await runtime.end();
    }
  });

  it('accepts an audit row whose target_sub is NULL', async () => {
    // Audit của một operation không tác động ai có `target_sub IS NULL` bình
    // thường — CHECK phải cho phép NULL, nếu không nó chặn nhầm đường deny.
    const runtime = await db.connectAsRuntime();
    try {
      await runtime.query(
        `INSERT INTO backoffice.authorization_audit (actor_sub, action, outcome)
         VALUES ($1, 'staff.view', 'denied')`,
        [ACTOR],
      );
      const { rows } = await runtime.query<{ target: string | null }>(
        `SELECT target_sub AS target FROM backoffice.authorization_audit`,
      );
      expect(rows[0]?.target).toBeNull();
    } finally {
      await runtime.end();
    }
  });

  // -------------------------------------------------------------------------
  // Đường bootstrap — migrator KHÔNG bị chặn nhầm
  // -------------------------------------------------------------------------

  it('lets the migrator create a staff row, a role and an assignment', async () => {
    // ⚠️ Đây là đường quan trọng nhất của file: ADR-0003 chốt bootstrap/recovery
    // là procedure IaC/manual SQL, và `0003` là seed migration chạy bằng
    // migrator. Nếu guard chặn nhầm migrator thì **bootstrap không bao giờ
    // chạy được** — đó là bug, không phải hành vi mong muốn.
    //
    // Mutation evidence: đổi điều kiện phân biệt runtime trong trigger thành
    // "chặn mọi role" ⇒ test này đỏ.
    const migrator = await db.asMigrator();
    try {
      await migrator.query(`INSERT INTO backoffice.staff (sub) VALUES ($1)`, [SUBJECT]);
      await migrator.query(
        `INSERT INTO backoffice.roles (id, is_system) VALUES ('sys_admin', true)`,
      );
      await migrator.query(
        `INSERT INTO backoffice.role_assignments (staff_sub, role_id, created_by_sub)
         VALUES ($1, 'sys_admin', $2)`,
        [SUBJECT, SUBJECT],
      );
      const { rows } = await migrator.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM backoffice.role_assignments`,
      );
      expect(rows[0]?.count).toBe('1');
    } finally {
      await migrator.end();
    }
  });

  it('lets the migrator attach a retired permission to a role', async () => {
    // Đường governance (compose role của procedure quản trị) phải chạy được:
    // guard chặn nhầm nó là chặn nhầm bootstrap.
    const migrator = await db.asMigrator();
    try {
      await migrator.query(
        `INSERT INTO backoffice.permissions (id, domain, action, status)
         VALUES ('delivery.legacy', 'delivery', 'legacy', 'retired')`,
      );
      await migrator.query(
        `INSERT INTO backoffice.roles (id, is_system) VALUES ('sys_admin', true)`,
      );
      await migrator.query(
        `INSERT INTO backoffice.role_permissions (role_id, permission_id) VALUES ('sys_admin', 'delivery.legacy')`,
      );
      const { rows } = await migrator.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM backoffice.role_permissions`,
      );
      expect(rows[0]?.count).toBe('1');
    } finally {
      await migrator.end();
    }
  });

  it('lets the migrator write an audit row without a valid actor', async () => {
    // `actor_sub` không có CHECK ở `0004` (có chủ ý): đường audit của tầng app
    // đã validate actor, và đường system (`recordAuthorizationFailure`) ghi
    // NULL. Migrator phải ghi được audit cho mọi thao tác quản trị.
    const migrator = await db.asMigrator();
    try {
      await migrator.query(
        `INSERT INTO backoffice.authorization_audit (actor_sub, action, outcome)
         VALUES (NULL, 'role.administer', 'success')`,
      );
      const { rows } = await migrator.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM backoffice.authorization_audit`,
      );
      expect(rows[0]?.count).toBe('1');
    } finally {
      await migrator.end();
    }
  });

  it('lets the superuser (owner) path still write — the guard is scoped to the runtime role', async () => {
    // `ecoma_owner` (ADR-0001) là đường bootstrap/recovery của ADR-0003; nó
    // chạy bằng SQL/IaC và phải qua được. Ở đây `db.connect()` là superuser của
    // harness — tương đương về mặt "không phải runtime".
    const client = await db.connect();
    try {
      await client.query(`INSERT INTO backoffice.staff (sub) VALUES ($1)`, [SUBJECT]);
      await client.query(`INSERT INTO backoffice.roles (id, is_system) VALUES ('sys_admin', true)`);
      await client.query(
        `INSERT INTO backoffice.role_assignments (staff_sub, role_id, created_by_sub)
         VALUES ($1, 'sys_admin', $1)`,
        [SUBJECT],
      );
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM backoffice.role_assignments`,
      );
      expect(rows[0]?.count).toBe('1');
    } finally {
      await client.end();
    }
  });

  // -------------------------------------------------------------------------
  // Ranh giới: guard không cấp thêm quyền nào cho runtime
  // -------------------------------------------------------------------------

  it('does not widen the runtime role privileges', async () => {
    // Guard không được là một cách "cấp thêm quyền để rồi chặn": invariant 11
    // (least privilege) — sweep `has_table_privilege` trên **tất cả** bảng của
    // schema, không chỉ các bảng có guard.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ table_name: string; privileges: string[] }>(
        `SELECT c.relname AS table_name,
                array_remove(ARRAY[
                  CASE WHEN has_table_privilege($1, c.oid, 'SELECT')     THEN 'SELECT' END,
                  CASE WHEN has_table_privilege($1, c.oid, 'INSERT')     THEN 'INSERT' END,
                  CASE WHEN has_table_privilege($1, c.oid, 'UPDATE')     THEN 'UPDATE' END,
                  CASE WHEN has_table_privilege($1, c.oid, 'DELETE')     THEN 'DELETE' END,
                  CASE WHEN has_table_privilege($1, c.oid, 'TRUNCATE')   THEN 'TRUNCATE' END,
                  CASE WHEN has_table_privilege($1, c.oid, 'TRIGGER')    THEN 'TRIGGER' END,
                  CASE WHEN has_table_privilege($1, c.oid, 'REFERENCES') THEN 'REFERENCES' END
                ], NULL) AS privileges
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'backoffice' AND c.relkind = 'r'
          ORDER BY c.relname`,
        [RUNTIME],
      );

      const actual = Object.fromEntries(
        rows.map((row) => [row.table_name, [...row.privileges].toSorted()]),
      );

      // Đúng như grant của `0002` — migration `0004` không đổi một quyền nào.
      // Hai bảng BFF của `0006` có grant riêng của migration đó (phiên là state
      // ứng dụng sống động: SELECT/INSERT/UPDATE/DELETE; luồng login:
      // SELECT/INSERT/DELETE — consume bằng DELETE, không UPDATE) — sweep này
      // vẫn ghim rằng `0004`+guard không **nới** gì so với bộ grant đã chốt.
      expect(actual).toEqual({
        authorization_audit: ['INSERT', 'SELECT'],
        bff_login_flows: ['DELETE', 'INSERT', 'SELECT'],
        bff_sessions: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
        permissions: ['SELECT'],
        role_assignments: ['INSERT', 'SELECT', 'UPDATE'],
        role_permissions: ['DELETE', 'INSERT', 'SELECT'],
        roles: ['SELECT'],
        staff: ['INSERT', 'SELECT', 'UPDATE'],
      });
    } finally {
      await client.end();
    }
  });

  it('does not let the runtime role read the audit table it must not alter', async () => {
    // Lớp 1 của append-only vẫn nguyên: runtime có SELECT + INSERT, không có
    // UPDATE/DELETE. Guard `0004` không nới lỏng và không thay thế.
    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(`UPDATE backoffice.authorization_audit SET outcome = 'failure'`),
      ).rejects.toThrow(/permission denied/iu);
    } finally {
      await runtime.end();
    }
  });
});
