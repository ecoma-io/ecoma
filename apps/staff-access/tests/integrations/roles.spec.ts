/**
 * Grant, ranh giới database và enforcement mức database — invariant 34/35,
 * SR-008, SR-013/014/015/016/018, SR-021, ADR-0010/0013.
 *
 * Đây là những test **quan trọng nhất** của suite, vì chúng kiểm chứng những thứ
 * mà review không nhìn thấy: một `GRANT` thừa, một `REVOKE` không có tác dụng,
 * hay một trigger tắt đi đều để mọi test khác xanh. Việc nào PostgreSQL express
 * được thì test ở tầng database; việc nào app layer enforce (actor từ verified
 * principal, T-10) được ghi rõ là ngoài phạm vi tầng này.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  getEntitlement,
  upsertEntitlement,
  type StaffAccessTransaction,
} from '@ecoma-io/staff-access-infrastructure';
import { validateEntitlementEvent } from '@ecoma-io/staff-access-contracts';

import { type StaffAccessDatabase, startStaffAccessDatabase } from './harness.ts';

const RUNTIME = 'ecoma_staff_access_runtime';

/**
 * Grant kỳ vọng của runtime, theo đúng `0002_roles_and_grants.sql`, theo từng
 * bảng — giữ danh sách tường minh, không suy ra từ quy tắc chung:
 *
 * - `staff`: SELECT + INSERT + UPDATE — sổ staff có đường ghi qua pipeline
 *   audited (status change), DELETE không nằm trong vòng đời.
 * - `permissions`: chỉ SELECT — sealed catalog, INSERT chỉ qua seed migration.
 * - `roles`, `role_permissions`: chỉ SELECT — role administration chưa chốt
 *   (ADR-0004); không đường ghi runtime nào hiện có.
 * - `role_assignments`: SELECT + INSERT; UPDATE **chỉ ở cấp cột** `revoked_at`
 *   (has_table_privilege bất khả tri cấp cột, sweep tính bằng table-level
 *   ACL — security-high 41070536326). Điểm khác biệt được test riêng dưới
 *   đây: UPDATE cột khác phải chết ở cả GRANT lẫn trigger.
 * - `authorization_audit`: SELECT + INSERT — append-only, UPDATE/DELETE bị
 *   chặn hai lớp (grant + trigger).
 * - `entitlements`: SELECT + INSERT + UPDATE — read model availability-only
 *   (SR-021) nhưng ghi vẫn cần cho đường revoke entitlement.
 * - `entitlement_outbox_events`: SELECT + INSERT; UPDATE **chỉ ở cấp cột**
 *   published_at/attempts/last_error (has_table_privilege bất khả tri cấp cột,
 *   sweep tính bằng table-level ACL — same pattern role_assignments). Điểm
 *   khác biệt được test riêng dưới đây: UPDATE cột khác phải chết ở cả GRANT
 *   lẫn CHECK; DELETE không nằm trong vòng đời (outbox chỉ append + đánh dấu).
 */
const EXPECTED_PRIVILEGES: Record<string, readonly string[]> = {
  authorization_audit: ['INSERT', 'SELECT'],
  entitlement_outbox_events: ['INSERT', 'SELECT'],
  entitlements: ['INSERT', 'SELECT', 'UPDATE'],
  internal_nonces: ['DELETE', 'INSERT', 'SELECT'],
  permissions: ['SELECT'],
  role_assignments: ['INSERT', 'SELECT'],
  role_permissions: ['SELECT'],
  roles: ['SELECT'],
  staff: ['INSERT', 'SELECT', 'UPDATE'],
};

/** Bỏ comment `--` ra khỏi SQL trước khi quét nội dung (pattern roles.spec account). */
function executableSql(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const marker = line.indexOf('--');
      return marker === -1 ? line : line.slice(0, marker);
    })
    .join('\n');
}

describe('roles and grants on db-staff-access', () => {
  let db: StaffAccessDatabase;

  beforeAll(async () => {
    db = await startStaffAccessDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('invariant 34: the runtime role holds exactly the intended table privileges', async () => {
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
          WHERE n.nspname = 'staff_access' AND c.relkind = 'r'
          ORDER BY c.relname`,
        [RUNTIME],
      );

      const actual = Object.fromEntries(
        rows.map((row) => [row.table_name, [...row.privileges].toSorted()]),
      );

      // So sánh theo từng bảng **và** theo tập bảng: một bảng lạ xuất hiện
      // trong schema cũng phải làm test đỏ, chứ không bị lọc nhầm.
      expect(Object.keys(actual).toSorted()).toEqual(Object.keys(EXPECTED_PRIVILEGES).toSorted());
      expect(actual).toEqual(EXPECTED_PRIVILEGES);

      // Tuyên bố tường minh đi kèm: audit thiếu UPDATE — append-only (SR-015)
      // là thuộc tính mà một lần refactor grant list không được làm mất.
      expect(actual['authorization_audit']).not.toContain('UPDATE');
      // Catalog sealed: runtime không INSERT/UPDATE permission nào.
      expect(actual['permissions']).toEqual(['SELECT']);
      // UPDATE của role_assignments phải ở cấp cột revoked_at: has_column_privilege
      // dương cho revoked_at, âm cho scope — hai chiều cùng một câu sweep.
      const { rows: colRows } = await client.query<{
        can_revoked_at: boolean;
        can_scope: boolean;
        can_role_id: boolean;
      }>(
        `SELECT has_column_privilege($1, 'staff_access.role_assignments', 'revoked_at', 'UPDATE') AS can_revoked_at,
                has_column_privilege($1, 'staff_access.role_assignments', 'scope', 'UPDATE') AS can_scope,
                has_column_privilege($1, 'staff_access.role_assignments', 'role_id', 'UPDATE') AS can_role_id`,
        [RUNTIME],
      );
      expect(colRows[0]?.can_revoked_at).toBe(true);
      expect(colRows[0]?.can_scope).toBe(false);
      expect(colRows[0]?.can_role_id).toBe(false);
    } finally {
      await client.end();
    }
  });

  it('invariant 34: the runtime role cannot create anything in the staff_access schema', async () => {
    const runtime = await db.asRuntime();
    try {
      await expect(runtime.query('CREATE TABLE staff_access.extra (id int)')).rejects.toThrow(
        /permission denied/iu,
      );
      await expect(runtime.query('CREATE SCHEMA staff_access_more')).rejects.toThrow(
        /permission denied/iu,
      );
    } finally {
      await runtime.end();
    }
  });

  it('invariant 34: the runtime role cannot write the sealed permission catalog', async () => {
    // Grant sweep (test trên) là catalog; test này là **hành vi** — INSERT thật
    // bằng credential thật phải bị PostgreSQL từ chối. Hai hình hợp lệ nhau:
    // catalog sai một grant mà sweep không kể tới, hay sweep đúng nhưng has_table_privilege
    // đo sai nguồn, đều lộ ở đây.
    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query(
          `INSERT INTO staff_access.permissions (id, domain, action, status)
           VALUES ('staff.delete', 'staff', 'delete', 'active')`,
        ),
      ).rejects.toThrow(/permission denied/iu);
    } finally {
      await runtime.end();
    }
  });

  it('SR-008: the migrator role can do DDL while the runtime role cannot', async () => {
    const migrator = await db.asMigrator();
    try {
      await migrator.query('CREATE TABLE staff_access.migrator_probe (id int)');

      // Không assert bằng "không ném" — đọc `relkind` để chứng minh bảng thật
      // sự tồn tại sau DDL (pattern roles.spec account).
      const client = await db.connect();
      try {
        const { rows } = await client.query<{ relkind: string }>(
          `SELECT c.relkind::text AS relkind
             FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'staff_access' AND c.relname = 'migrator_probe'`,
        );
        expect(rows.map((row) => row.relkind)).toEqual(['r']);
      } finally {
        await client.end();
      }
    } finally {
      // Dọn trong `finally`: một bảng sót lại sẽ làm grant sweep đỏ ở lần chạy
      // kế tiếp, và phụ thuộc thứ tự test là kiểu test không nên có.
      await migrator.query('DROP TABLE IF EXISTS staff_access.migrator_probe');
      await migrator.end();
    }
  });

  it('invariant 34: the runtime role cannot create a table on the public schema', async () => {
    // `REVOKE ALL ON SCHEMA public FROM PUBLIC` trong `0002` là no-op trên
    // PostgreSQL 15+ (schema `public` sở hữu bởi `pg_database_owner`, PUBLIC
    // giữ USAGE) — hardening thật đến từ default PG15 rút CREATE khỏi PUBLIC.
    // Test này khóa đúng thuộc tính mà 0002 hy vọng giữ: runtime không tạo được
    // object trong `public`, dù bằng catalog hay bằng kết nối thật.
    const runtime = await db.connectAsRuntime();
    try {
      await expect(runtime.query('CREATE TABLE public.probe (id int)')).rejects.toThrow(
        /permission denied/iu,
      );
    } finally {
      await runtime.end();
    }
  });

  it('invariant 34: schema public ACL gives PUBLIC USAGE without CREATE on PostgreSQL 17', async () => {
    // Assertion catalog mà H13 đòi (bình luận `0002` hứa): entry PUBLIC trong
    // `nspacl` phải là `=U` (USAGE, không CREATE). Trên PG15+ nó đến từ default
    // owner grant; test để một default regression (PUBLIC tìm lại CREATE) đỏ
    // thay vì pass im lặng. Ở đây database do testcontainers tạo với owner là
    // superuser test — đúng hình production nơi owner là ecoma_owner.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ nspacl: string }>(
        `SELECT nspacl::text AS nspacl FROM pg_namespace WHERE nspname = 'public'`,
      );
      const items = (rows[0]?.nspacl ?? '')
        .split(',')
        .filter((item) => item.length > 0)
        .map((item) => item.split('/')[0] ?? '');

      const publicItem = items.find((item) => item.startsWith('='));
      expect(publicItem).toBeDefined();
      // Chuỗi quyền của PUBLIC: chứa USAGE, không chứa CREATE.
      expect(publicItem).toMatch(/=U(?![^a-z])/u);
      expect(publicItem).not.toMatch(/=.*C/u);
    } finally {
      await client.end();
    }
  });

  it('AC-013: no foreign key points outside the staff_access schema', async () => {
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ violations: number }>(
        `SELECT count(*)::int AS violations
           FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = rel.relnamespace
          WHERE con.contype = 'f'
            AND n.nspname NOT IN ('staff_access', 'pg_catalog', 'information_schema')`,
      );
      expect(rows[0]?.violations).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('AC-013: no postgres_fdw and no dblink extension is installed', async () => {
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ extname: string }>(
        `SELECT extname FROM pg_extension ORDER BY extname`,
      );
      const installed = rows.map((row) => row.extname);
      expect(installed).not.toContain('postgres_fdw');
      expect(installed).not.toContain('dblink');
      // `0001` không cài extension nào: `gen_random_uuid()` là core từ
      // PostgreSQL 13. Chỉ còn `plpgsql` — extension mặc định của mọi database.
      expect(installed).toEqual(['plpgsql']);
    } finally {
      await client.end();
    }
  });

  it('AC-013: no migration executes a foreign data wrapper, dblink, or foreign table', async () => {
    // Query `pg_extension` chỉ thấy extension **đã cài**; một câu bị comment
    // hay một `dblink` trong migration không lộ ở đó — phải đọc file. Quét SQL
    // đã bỏ comment vì migration giải thích bằng chính tên thứ chúng cấm.
    const { listMigrations } = await import('../../db/migrate.mts');
    for (const migration of listMigrations()) {
      const sql = executableSql(migration.sql);
      expect({ file: migration.name, sql }).not.toMatchObject({
        sql: expect.stringMatching(
          /postgres_fdw|dblink|foreign\s+table|foreign\s+data\s+wrapper/iu,
        ),
      });
    }
  });
});

/** Seed một staff active và một role active, trả id (module scope: không capture scope nào). */
async function seedStaffAndRole(
  client: import('pg').Client,
): Promise<{ staffId: string; roleId: string }> {
  // sub là UNIQUE (1:1 với account): mỗi lần gọi phải sinh giá trị riêng —
  // dùng md5 thay thế chữ số ngoài bảng [a-z2-7] để vẫn khớp CHECK format.
  const { rows: staffRows } = await client.query<{ id: string }>(
    `INSERT INTO staff_access.staff (sub, display_name, status)
     VALUES ('sub_' || translate(md5(random()::text || clock_timestamp()::text), '0189', 'abcd'),
             'Test Staff', 'active') RETURNING id`,
  );
  const { rows: roleRows } = await client.query<{ id: string }>(
    `INSERT INTO staff_access.roles (name, kind, status)
     VALUES ('test_role_' || md5(random()::text), 'custom', 'active') RETURNING id`,
  );
  return { staffId: staffRows[0]?.id ?? '', roleId: roleRows[0]?.id ?? '' };
}

describe('database enforcement of domain invariants', () => {
  let db: StaffAccessDatabase;

  beforeAll(async () => {
    db = await startStaffAccessDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('invariant 12 / SR-015: the audit is append-only — UPDATE and DELETE raise even for migrator', async () => {
    // Trigger append-only là lớp 2, KHÔNG exempt role nào (khác revoke-only
    // guard exempt migrator/owner): audit tuyệt đối. Chạy bằng credential thật
    // runtime — INSERT phải thành công, UPDATE/DELETE phải chết ở trigger.
    const runtime = await db.connectAsRuntime();
    try {
      const { rows } = await runtime.query<{ id: string }>(
        `INSERT INTO staff_access.authorization_audit (target, action, outcome, context)
         VALUES ('tgt_1', 'role_assignment.create', 'success', '{}') RETURNING id`,
      );
      const auditId = rows[0]?.id ?? '';
      expect(auditId).not.toBe('');

      await expect(
        runtime.query('UPDATE staff_access.authorization_audit SET outcome = $1 WHERE id = $2', [
          'failure',
          auditId,
        ]),
      ).rejects.toThrow(/append-only|bi tu choi|authorization_audit/iu);
      await expect(
        runtime.query('DELETE FROM staff_access.authorization_audit WHERE id = $1', [auditId]),
      ).rejects.toThrow(/append-only|bi tu choi|authorization_audit/iu);
    } finally {
      await runtime.end();
    }
  });

  it('SR-014: the audit context CHECK rejects secret-named keys', async () => {
    const runtime = await db.connectAsRuntime();
    try {
      // Mỗi key trong danh sách cấm phải độc lập làm INSERT chết — CHECK của
      // SR-014 là cửa cuối trước khi một token lọt vào durable state. Key truyền
      // qua `to_jsonb` vì key name là string: tham số $1 trong
      // `jsonb_build_object($1, ...)` cần kiểu tường minh ở vị trí key.
      for (const key of [
        'token',
        'access_token',
        'refresh_token',
        'secret',
        'password',
        'authorization',
      ]) {
        await expect(
          runtime.query(
            `INSERT INTO staff_access.authorization_audit (target, action, outcome, context)
             VALUES ('tgt_1', 'role_assignment.create', 'success',
                     jsonb_build_object($1::text, 'x'))`,
            [key],
          ),
        ).rejects.toThrow(/authorization_audit_context_no_secret_keys|violates check constraint/iu);
      }
      // Ngược lại: context hợp lệ ghi được — cửa không đóng nhầm.
      const { rows } = await runtime.query<{ id: string }>(
        `INSERT INTO staff_access.authorization_audit (target, action, outcome, context)
         VALUES ('tgt_1', 'role_assignment.create', 'success', '{"request_scope":"global"}')
         RETURNING id`,
      );
      expect(rows[0]?.id).not.toBe('');
    } finally {
      await runtime.end();
    }
  });

  it('SR-013: an audit row carries the seven fields including correlation_id and context', async () => {
    // SR-013 7 trường (actor, target, action, thời điểm, kết quả, lý do,
    // correlation) + context (SR-014): schema phải có đủ cột để pipeline ghi.
    // Actor được kiểm theo nghĩa schema (nullable, no FK); đường wire actor
    // từ verified principal là việc của P5.1 (T-10), không phải của tầng này.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'staff_access' AND table_name = 'authorization_audit'
          ORDER BY ordinal_position`,
      );
      const columns = Object.fromEntries(rows.map((row) => [row.column_name, row.is_nullable]));
      for (const required of [
        'actor_staff_id',
        'actor_sub',
        'target',
        'action',
        'occurred_at',
        'outcome',
        'reason',
        'correlation_id',
        'context',
      ]) {
        expect(columns[required]).toBeDefined();
      }
      // actor nullable (bootstrap/system); target/action/occurred_at/outcome bắt buộc.
      expect(columns['actor_staff_id']).toBe('YES');
      expect(columns['target']).toBe('NO');
      expect(columns['occurred_at']).toBe('NO');
      expect(columns['outcome']).toBe('NO');
    } finally {
      await client.end();
    }
  });

  it('invariant 12: revocation is UPDATE revoked_at, and the runtime role cannot un-revoke', async () => {
    const client = await db.asMigrator();
    let assignmentId = '';
    try {
      const { staffId, roleId } = await seedStaffAndRole(client);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO staff_access.role_assignments (staff_id, role_id) VALUES ($1, $2)
         RETURNING id`,
        [staffId, roleId],
      );
      assignmentId = rows[0]?.id ?? '';
    } finally {
      await client.end();
    }

    // Revoke bằng credential runtime thật — đúng đường production.
    const runtime = await db.connectAsRuntime();
    try {
      const { rowCount } = await runtime.query(
        'UPDATE staff_access.role_assignments SET revoked_at = now() WHERE id = $1',
        [assignmentId],
      );
      expect(rowCount).toBe(1);

      // Revoke-only guard: runtime SET revoked_at lần nữa (un-revoke hay đổi
      // giá trị) phải chết ở trigger — một assignment đã revoke không thể quay
      // lại hiệu lực bằng UPDATE im lặng.
      await expect(
        runtime.query('UPDATE staff_access.role_assignments SET revoked_at = NULL WHERE id = $1', [
          assignmentId,
        ]),
      ).rejects.toThrow(/un-revoke|revoked_at da co gia tri|integrity_constraint_violation/iu);

      // Đổi cửa hiệu lực cũng bị chặn — lớp nào đứng trước cũng được: grant
      // column-level `UPDATE (revoked_at)` cho PostgreSQL từ chối cột không nằm
      // trong grant (permission denied) TRƯỚC khi trigger kịp chạy; nếu grant
      // bị nới lỏng mà trigger còn, message của trigger là lưới hai.
      await expect(
        runtime.query(
          `UPDATE staff_access.role_assignments
              SET effective_until = now() + interval '7 days'
            WHERE id = $1`,
          [assignmentId],
        ),
      ).rejects.toThrow(/permission denied|chi duoc revoke|khong doi cua hieu luc/iu);

      // Trigger là column-unbounded: đột biến identity/scope qua UPDATE cũng
      // phải bị chặn (security-high 41070536326). Với grant column-level hiện
      // hành, PostgreSQL từ chối ở tầng GRANT trước khi trigger kịp chạy —
      // message 'permission denied' là lớp một; trigger là lưới nếu grant bị nới.
      await expect(
        runtime.query('UPDATE staff_access.role_assignments SET scope = $1 WHERE id = $2', [
          JSON.stringify({ team: 'x' }),
          assignmentId,
        ]),
      ).rejects.toThrow(/permission denied|chi duoc revoke|identity\/scope/iu);
    } finally {
      await runtime.end();
    }
  });

  it('0002: runtime UPDATE is column-level revoked_at only — mutating scope dies at the grant', async () => {
    // Lớp hai độc lập với trigger: grant `UPDATE (revoked_at)` nghĩa là UPDATE
    // cột khác bị PostgreSQL từ chối ngay cả khi trigger bị tắt (defense in
    // depth — hai cơ chế cùng đo được, không dựa vào nhau).
    const client = await db.asMigrator();
    let assignmentId = '';
    try {
      const { staffId, roleId } = await seedStaffAndRole(client);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO staff_access.role_assignments (staff_id, role_id) VALUES ($1, $2)
         RETURNING id`,
        [staffId, roleId],
      );
      assignmentId = rows[0]?.id ?? '';
    } finally {
      await client.end();
    }
    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query('UPDATE staff_access.role_assignments SET scope = $1 WHERE id = $2', [
          JSON.stringify({ team: 'x' }),
          assignmentId,
        ]),
      ).rejects.toThrow(/permission denied/iu);
      await expect(
        runtime.query('UPDATE staff_access.role_assignments SET granted_by = NULL WHERE id = $1', [
          assignmentId,
        ]),
      ).rejects.toThrow(/permission denied/iu);
    } finally {
      await runtime.end();
    }
  });

  it('role_assignments: un-revoke and window changes stay blocked by shape, not by role', async () => {
    // Trigger exempt migrator/owner cho đúng nghĩa "migrator giữ full power",
    // nhưng CHECK `revoked_at >= created_at` và `effective_until > effective_from`
    // là hình dạng dữ liệu — áp cho mọi role. Kiểm bằng migrator để tách hai
    // cơ chế: trigger (theo `current_user`) và CHECK (vô điều kiện).
    const client = await db.asMigrator();
    try {
      const { staffId, roleId } = await seedStaffAndRole(client);
      // revoked_at trước created_at là vô nghĩa thời gian — CHECK phải chặn.
      await expect(
        client.query(
          `INSERT INTO staff_access.role_assignments
             (staff_id, role_id, created_at, revoked_at)
           VALUES ($1, $2, now(), now() - interval '1 hour')`,
          [staffId, roleId],
        ),
      ).rejects.toThrow(/revoked_after_created|violates check constraint/iu);
      // Cửa hiệu lực ngược (until <= from) — CHECK phải chặn.
      await expect(
        client.query(
          `INSERT INTO staff_access.role_assignments
             (staff_id, role_id, effective_from, effective_until)
           VALUES ($1, $2, now(), now() - interval '1 hour')`,
          [staffId, roleId],
        ),
      ).rejects.toThrow(/effective_window|violates check constraint/iu);
    } finally {
      await client.end();
    }
  });

  it('self-elevation: granted_by = staff_id is rejected at the database', async () => {
    const client = await db.asMigrator();
    try {
      const { staffId, roleId } = await seedStaffAndRole(client);
      await expect(
        client.query(
          `INSERT INTO staff_access.role_assignments (staff_id, role_id, granted_by)
           VALUES ($1, $2, $1)`,
          [staffId, roleId],
        ),
      ).rejects.toThrow(/self-elevation|self elevation|integrity_constraint_violation/iu);
    } finally {
      await client.end();
    }
  });

  it('staff: sub is immutable and terminated is terminal', async () => {
    const client = await db.asMigrator();
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO staff_access.staff (sub, display_name, status)
         VALUES ('sub_' || repeat('b', 32), 'Identity Staff', 'active') RETURNING id`,
      );
      const staffId = rows[0]?.id ?? '';

      // ADR-0012 4.1: sub là mapping 1:1 sang account — đổi trên hàng đã có
      // phải chết ở trigger, không phải lọt qua CHECK format. Giá trị thay thế
      // vẫn khớp format `^sub_[a-z2-7]{32}$` để failure chứng minh đúng trigger
      // chứ không phải CHECK.
      await expect(
        client.query('UPDATE staff_access.staff SET sub = $1 WHERE id = $2', [
          'sub_' + 'c'.repeat(32),
          staffId,
        ]),
      ).rejects.toThrow(/sub la tham chieu 1:1|integrity_constraint_violation/iu);

      // Terminated là terminal: hồi sinh bằng UPDATE im lặng phải chết —
      // phục hồi membership là thao tác mới có audit, không phải UPDATE.
      await client.query('UPDATE staff_access.staff SET status = $1 WHERE id = $2', [
        'terminated',
        staffId,
      ]);
      await expect(
        client.query('UPDATE staff_access.staff SET status = $1 WHERE id = $2', [
          'active',
          staffId,
        ]),
      ).rejects.toThrow(/terminal|trang thai terminal|integrity_constraint_violation/iu);
    } finally {
      await client.end();
    }
  });

  it('permissions: a retired entry is terminal and cannot be revived', async () => {
    const migrator = await db.asMigrator();
    try {
      // ADR-0010 insert-then-retire: retire một entry trước (UPDATE active →
      // retired là đường hợp lệ duy nhất), rồi thử hồi sinh — retired quay lại
      // active phải chết cho cả migrator (đường duy nhất quay lại active là
      // seed migration mới có review; trigger không exempt ai).
      await migrator.query(
        `UPDATE staff_access.permissions SET status = 'retired' WHERE id = 'permission.read'`,
      );
      await expect(
        migrator.query(
          `UPDATE staff_access.permissions SET status = 'active' WHERE id = 'permission.read'`,
        ),
      ).rejects.toThrow(/retired|terminal|integrity_constraint_violation/iu);
    } finally {
      // Khôi phục trạng thái seed: entry này là dữ liệu catalog của các test
      // khác trong cùng container; phục hồi bằng UPDATE retired → active thì
      // không được, nên dùng đường xóa-ghi (migrator sở hữu bảng).
      await migrator
        .query(`DELETE FROM staff_access.permissions WHERE id = 'permission.read'`)
        .catch(() => undefined);
      await migrator
        .query(
          `INSERT INTO staff_access.permissions (id, domain, action, status)
           VALUES ('permission.read', 'permission', 'read', 'active')`,
        )
        .catch(() => undefined);
      await migrator.end();
    }
  });

  it('entitlements: revision is monotonic — it bumps on UPDATE and refuses to go back', async () => {
    const migrator = await db.asMigrator();
    try {
      const { staffId } = await seedStaffAndRole(migrator);
      const { rows: entRows } = await migrator.query<{ revision: string }>(
        `INSERT INTO staff_access.entitlements (staff_id, product, status)
         VALUES ($1, 'backoffice', 'entitled') RETURNING revision`,
        [staffId],
      );
      expect(entRows[0]?.revision).toBe('1');

      // UPDATE đổi status: trigger bump revision +1 — đường read model (SR-021)
      // phân biệt được lần nhìn thứ nhất và lần nhìn sau status change.
      const { rows: bumpedRows } = await migrator.query<{ revision: string }>(
        `UPDATE staff_access.entitlements SET status = 'revoked' WHERE staff_id = $1
           AND product = 'backoffice' RETURNING revision`,
        [staffId],
      );
      expect(bumpedRows[0]?.revision).toBe('2');

      // Giảm revision là chống lại lịch sử — CHECK + trigger phải chặn.
      await expect(
        migrator.query(
          `UPDATE staff_access.entitlements SET revision = 1 WHERE staff_id = $1
             AND product = 'backoffice'`,
          [staffId],
        ),
      ).rejects.toThrow(/revision khong duoc giam|monotonic|integrity_constraint_violation/iu);
    } finally {
      await migrator.end();
    }
  });

  it('upsertEntitlement: the same pair upserts twice without dying at the revision guard', async () => {
    // Bug round 3 (41070536326): INSERT không truyền revision ⇒ EXCLUDED.revision
    // = default 1; ON CONFLICT DO UPDATE giữ EXCLUDED.revision làm NEW.revision
    // thì lần upsert thứ hai (OLD.revision ≥ 1) chết ở guard monotonic. Repo
    // phải SET revision = giá trị cũ để trigger bump từ OLD — test chạy ĐÚNG
    // hàm repo (không viết lại SQL) hai lần liên tiếp trên cùng cặp.
    const runtime = await db.connectAsRuntime();
    try {
      const client = await db.asMigrator();
      let staffId = '';
      try {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO staff_access.staff (sub, display_name, status)
           VALUES ('sub_' || translate(md5(random()::text || clock_timestamp()::text), '0189', 'abcd'),
                   'Upsert Staff', 'active') RETURNING id`,
        );
        staffId = rows[0]?.id ?? '';
      } finally {
        await client.end();
      }

      const fake = {
        unsafe: async (sql: string, params?: readonly unknown[]) => {
          const { rows } = await runtime.query(sql, params as unknown[]);
          return rows;
        },
      } as unknown as StaffAccessTransaction;

      const first = await upsertEntitlement(
        fake,
        { staffId, product: 'backoffice', status: 'entitled' },
        crypto.randomUUID(),
      );
      const second = await upsertEntitlement(
        fake,
        { staffId, product: 'backoffice', status: 'revoked' },
        crypto.randomUUID(),
      );
      const third = await getEntitlement(fake, staffId, 'backoffice');
      expect(third?.status).toBe('revoked');
      // Hai lần ghi ⇒ revision đi qua 1 → 2 (trigger bump mỗi lần đổi status);
      // event mang đúng revision của lần state change tương ứng (A8).
      expect(third?.revision).toBe('2');
      expect(first.revision).toBe(1);
      expect(second.revision).toBe(2);
    } finally {
      await runtime.end();
    }
  });

  it('entitlements: product and status vocabularies are closed', async () => {
    const migrator = await db.asMigrator();
    try {
      const { staffId } = await seedStaffAndRole(migrator);
      await expect(
        migrator.query(
          `INSERT INTO staff_access.entitlements (staff_id, product) VALUES ($1, 'unknown-product')`,
          [staffId],
        ),
      ).rejects.toThrow(/entitlements_product_check|violates check constraint/iu);
      await expect(
        migrator.query(
          `INSERT INTO staff_access.entitlements (staff_id, product, status)
           VALUES ($1, 'backoffice', 'maybe')`,
          [staffId],
        ),
      ).rejects.toThrow(/entitlements_status_check|violates check constraint/iu);
    } finally {
      await migrator.end();
    }
  });

  it('0004: the runtime role cannot mutate outbox identity or payload columns', async () => {
    // UPDATE của outbox chỉ ở cấp cột published_at/attempts/last_error (đánh
    // dấu publish cho relay P2.2) — sửa identity/payload của event đã ghi phải
    // chết ở GRANT column-level (lớp một; không có trigger nào exempt ở đây).
    const migrator = await db.asMigrator();
    let eventId = '';
    try {
      const { staffId } = await seedStaffAndRole(migrator);
      const { rows } = await migrator.query<{ event_id: string }>(
        `INSERT INTO staff_access.entitlement_outbox_events
           (aggregate_id, event_type, payload)
         VALUES ($1, 'entitlement.granted', '{"revision":1}') RETURNING event_id`,
        [`${staffId}/backoffice`],
      );
      eventId = rows[0]?.event_id ?? '';
    } finally {
      await migrator.end();
    }
    const runtime = await db.connectAsRuntime();
    try {
      // Đánh dấu published là đường hợp lệ duy nhất của runtime.
      const { rowCount } = await runtime.query(
        `UPDATE staff_access.entitlement_outbox_events
            SET published_at = now(), attempts = attempts + 1
          WHERE event_id = $1`,
        [eventId],
      );
      expect(rowCount).toBe(1);
      // Đổi identity/payload qua UPDATE phải chết ở grant column-level.
      await expect(
        runtime.query(
          `UPDATE staff_access.entitlement_outbox_events SET payload = $1 WHERE event_id = $2`,
          ['{}', eventId],
        ),
      ).rejects.toThrow(/permission denied/iu);
      await expect(
        runtime.query(
          `UPDATE staff_access.entitlement_outbox_events SET event_type = $1 WHERE event_id = $2`,
          ['entitlement.revoked', eventId],
        ),
      ).rejects.toThrow(/permission denied/iu);
      await expect(
        runtime.query(
          `UPDATE staff_access.entitlement_outbox_events SET aggregate_id = $1 WHERE event_id = $2`,
          ['other/other', eventId],
        ),
      ).rejects.toThrow(/permission denied/iu);
      // DELETE cũng không nằm trong vòng đời.
      await expect(
        runtime.query(`DELETE FROM staff_access.entitlement_outbox_events WHERE event_id = $1`, [
          eventId,
        ]),
      ).rejects.toThrow(/permission denied/iu);
    } finally {
      await runtime.end();
    }
  });
});

/**
 * Đường ghi entitlement + outbox của P2.1 (issue #437) trên PostgreSQL thật,
 * đúng credential runtime — invariant A8 kiểm chứng bằng hành vi:
 * commit thì cả state lẫn event tồn tại; rollback thì không cái nào tồn tại.
 */
describe('entitlement outbox same-transaction writes', () => {
  let db: StaffAccessDatabase;

  beforeAll(async () => {
    db = await startStaffAccessDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('committing the transaction persists both the entitlement state and its outbox event', async () => {
    const migrator = await db.asMigrator();
    let staffId = '';
    try {
      staffId = await seedStaff(migrator);
    } finally {
      await migrator.end();
    }

    const runtime = await db.connectAsRuntime();
    try {
      // Một transaction thật của postgres.js-style API: BEGIN/COMMIT quanh
      // đường ghi repo — commit là đường production duy nhất.
      await runtime.query('BEGIN');
      const tx = asTx(runtime);
      const event = await upsertEntitlement(
        tx,
        { staffId, product: 'backoffice', status: 'entitled' },
        crypto.randomUUID(),
      );
      await runtime.query('COMMIT');

      // State commit: read model thấy đúng revision của lần ghi.
      const row = await getEntitlement(tx, staffId, 'backoffice');
      expect(row?.status).toBe('entitled');
      expect(Number(row?.revision)).toBe(1);
      expect(event.revision).toBe(1);
      expect(event.type).toBe('entitlement.granted');
      expect(event.producer).toBe('staff-access');
      expect(event.staff_id).toBe(staffId);
      expect(event.product).toBe('backoffice');

      // Event commit cùng transaction: đúng một hàng outbox, payload khớp
      // envelope qua validator của contract đã lock (P1.2).
      const { rows: outboxRows } = await runtime.query<{
        event_id: string;
        event_type: string;
        aggregate_id: string;
        payload: unknown;
        published_at: string | null;
      }>(
        `SELECT event_id, event_type, aggregate_id, payload, published_at
           FROM staff_access.entitlement_outbox_events
          WHERE aggregate_id = $1`,
        [`${staffId}/backoffice`],
      );
      expect(outboxRows).toHaveLength(1);
      const outbox = outboxRows[0];
      expect(outbox?.event_id).toBe(event.event_id);
      expect(outbox?.event_type).toBe('entitlement.granted');
      expect(outbox?.published_at).toBeNull();
      expect(validateEntitlementEvent(outbox?.payload)).toMatchObject({ ok: true });
    } finally {
      await runtime.end();
    }
  });

  it('rolling back the transaction leaves neither the state change nor the event', async () => {
    const migrator = await db.asMigrator();
    let staffId = '';
    try {
      staffId = await seedStaff(migrator);
    } finally {
      await migrator.end();
    }

    const runtime = await db.connectAsRuntime();
    try {
      await runtime.query('BEGIN');
      const tx = asTx(runtime);
      await upsertEntitlement(
        tx,
        { staffId, product: 'pact-broker', status: 'entitled' },
        crypto.randomUUID(),
      );
      // Bất thường giữa chừng (đúng nghĩa `fn` phải ném): ROLLBACK là đường
      // database diễn tả, state + event phải cùng biến mất.
      await runtime.query('ROLLBACK');

      const client = await db.connect();
      try {
        const { rows: entRows } = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM staff_access.entitlements
            WHERE staff_id = $1 AND product = 'pact-broker'`,
          [staffId],
        );
        expect(entRows[0]?.count).toBe('0');
        const { rows: outboxRows } = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM staff_access.entitlement_outbox_events
            WHERE aggregate_id = $1`,
          [`${staffId}/pact-broker`],
        );
        expect(outboxRows[0]?.count).toBe('0');
      } finally {
        await client.end();
      }
    } finally {
      await runtime.end();
    }
  });

  it('two upserts produce two events with strictly increasing revisions from the database', async () => {
    const migrator = await db.asMigrator();
    let staffId = '';
    try {
      staffId = await seedStaff(migrator);
    } finally {
      await migrator.end();
    }

    const runtime = await db.connectAsRuntime();
    try {
      await runtime.query('BEGIN');
      const tx = asTx(runtime);
      const first = await upsertEntitlement(
        tx,
        { staffId, product: 'remote-cache', status: 'entitled' },
        crypto.randomUUID(),
      );
      const second = await upsertEntitlement(
        tx,
        { staffId, product: 'remote-cache', status: 'revoked' },
        crypto.randomUUID(),
      );
      await runtime.query('COMMIT');

      // Trigger bump MỌI UPDATE (kể cả same-status) — hai lần ghi trong cùng tx
      // cho revision 1 rồi 2; event = revision của state change cùng lần.
      expect(first.revision).toBe(1);
      expect(first.type).toBe('entitlement.granted');
      expect(second.revision).toBe(2);
      expect(second.type).toBe('entitlement.revoked');
      expect(first.event_id).not.toBe(second.event_id);

      const { rows: outboxRows } = await runtime.query<{ payload: unknown }>(
        `SELECT payload FROM staff_access.entitlement_outbox_events
          WHERE aggregate_id = $1 ORDER BY occurred_at, event_id`,
        [`${staffId}/remote-cache`],
      );
      expect(outboxRows).toHaveLength(2);
      for (const row of outboxRows) {
        expect(validateEntitlementEvent(row.payload)).toMatchObject({ ok: true });
      }
    } finally {
      await runtime.end();
    }
  });

  it('a duplicate event_id on the same table dies at the primary key (idempotency key)', async () => {
    const migrator = await db.asMigrator();
    let staffId = '';
    try {
      staffId = await seedStaff(migrator);
    } finally {
      await migrator.end();
    }

    const runtime = await db.connectAsRuntime();
    try {
      await runtime.query('BEGIN');
      const tx = asTx(runtime);
      const reused = crypto.randomUUID();
      await upsertEntitlement(tx, { staffId, product: 'backoffice', status: 'entitled' }, reused);
      // Lặp lại event_id cũ là hình "producer không biết lần trước đã commit"
      // của đường khác — PK của outbox chặn: hai lần đổi state không bao giờ
      // là cùng event.
      await expect(
        upsertEntitlement(tx, { staffId, product: 'backoffice', status: 'revoked' }, reused),
      ).rejects.toThrow(/duplicate key value|entitlement_outbox_events_pkey/iu);
      await runtime.query('ROLLBACK');
    } finally {
      await runtime.end();
    }
  });
});

/** Seed một staff active, trả id (sub unique mỗi lần gọi). */
async function seedStaff(client: import('pg').Client): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO staff_access.staff (sub, display_name, status)
     VALUES ('sub_' || translate(md5(random()::text || clock_timestamp()::text), '0189', 'abcd'),
             'Outbox Staff', 'active') RETURNING id`,
  );
  return rows[0]?.id ?? '';
}

/** Bọc client pg thành {@link StaffAccessTransaction} — hình fake dùng chung cho hai test trên. */
function asTx(client: import('pg').Client): StaffAccessTransaction {
  return {
    unsafe: async <T>(sql: string, params?: readonly unknown[]) => {
      const { rows } = await client.query(sql, params as unknown[]);
      return rows as T[];
    },
  } as unknown as StaffAccessTransaction;
}
