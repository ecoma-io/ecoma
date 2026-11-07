/**
 * Grant và ranh giới database — SR-010, SR-014, SR-015, AC-012, AC-014, AC-015,
 * invariant 10/12; 02-requirements.md §3.4–§3.5 và 01-architecture.md §4.
 *
 * Đây là những test **quan trọng nhất** của suite, vì chúng kiểm chứng những
 * thứ mà review không nhìn thấy: một `GRANT` thừa, hay một `REVOKE` không có
 * tác dụng, đều để mọi test khác xanh.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { listMigrations } from '../../db/migrate.mts';
import { type BackofficeDatabase, startBackofficeDatabase } from './harness.ts';

const RUNTIME = 'ecoma_backoffice_runtime';

/**
 * Account ID hợp lệ theo định dạng `libs/backoffice-domain`: prefix `sub_` + 32
 * ký tự base32 viết thường (`a`–`z`, `2`–`7`).
 *
 * ⚠️ Từ migration `0004` (`staff_sub_account_id_format_check`) mọi `sub` phải
 * đúng định dạng này — fixture cũ dùng chuỗi tự do (`sub_unique_a`) thì bị
 * CHECK chặn **trước** khi assertion của test kịp chạy, tức test xanh vì
 * lý do sai. Fixture ở đây dùng đúng định dạng đó.
 */
const accountId = (seed: string): string => `sub_${seed.repeat(32)}`;

/**
 * Actor của các fixture ghi assignment. Khác `staff_sub` — vì trigger
 * `role_assignments_no_self_elevation` (`0004`) chặn việc runtime tự gán role
 * cho chính mình (SR-005).
 */
const FIXTURE_ACTOR = accountId('a');

/** `sub` của các fixture cụ thể — mỗi fixture một Account ID riêng. */
const NO_DELETE_SUB = accountId('b');
const NO_ASSIGNMENT_DELETE_SUB = accountId('c');
const UNIQUE_SUB = accountId('d');
const TERMINAL_SUB = accountId('e');
const RENAME_SUB = accountId('f');
const PAST_VALID_SUB = accountId('g');

/**
 * Bảng và grant kỳ vọng của runtime role, theo đúng `0002_roles_and_grants.sql`
 * và `0006_bff_sessions.sql`.
 *
 * Ba hình dạng grant khác nhau, không suy ra từ một quy tắc chung:
 *   * DML giới hạn (`staff`, `role_assignments`) — SELECT + INSERT + UPDATE,
 *     **không** DELETE ("không giả định xoá vật lý" §4.6; revoke là UPDATE
 *     `revoked_at`, không DELETE).
 *   * chỉ SELECT (`permissions`, `roles`) — catalog sealed (invariant 10 /
 *     SR-020), tạo/đổi role là governance action.
 *   * nối (`role_permissions`) — SELECT + INSERT + DELETE, **không** UPDATE:
 *     compose role làm bằng insert/delete để `created_at` giữ đúng "gắn từ
 *     khi nào".
 *   * append-only (`authorization_audit`) — SELECT + INSERT (SR-015).
 *   * protocol state sống động (`bff_sessions`) — đủ SELECT + INSERT + UPDATE
 *     + DELETE: sliding idle/refresh rotate/revoke là UPDATE; prune phiên hết
 *     hạn là DELETE — nội dung phiên không có giá trị lịch sử sau khi chết
 *     (token sinh lại được bằng login; khác audit/assignment giữ lại để điều
 *     tra). Mốc: `account.account_sessions` đủ bốn quyền ở runtime role.
 *   * write-once-consume-once (`bff_login_flows`) — SELECT + INSERT + DELETE,
 *     **không** UPDATE: consume bằng DELETE là toàn bộ vòng đời (single-use).
 */
const EXPECTED_RUNTIME_PRIVILEGES: Record<string, string[]> = {
  authorization_audit: ['INSERT', 'SELECT'],
  bff_login_flows: ['DELETE', 'INSERT', 'SELECT'],
  bff_sessions: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  permissions: ['SELECT'],
  role_assignments: ['INSERT', 'SELECT', 'UPDATE'],
  role_permissions: ['DELETE', 'INSERT', 'SELECT'],
  roles: ['SELECT'],
  staff: ['INSERT', 'SELECT', 'UPDATE'],
};

/**
 * Bỏ comment `--` ra khỏi SQL trước khi quét nội dung — các migration giải
 * thích bằng chính tên thứ mà chúng cấm (ví dụ comment nói "không có
 * `postgres_fdw`"), một lần quét thô sẽ báo động giả.
 */
function executableSql(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const marker = line.indexOf('--');
      return marker === -1 ? line : line.slice(0, marker);
    })
    .join('\n');
}

describe('roles and grants on db-backoffice', () => {
  let db: BackofficeDatabase;

  beforeAll(async () => {
    db = await startBackofficeDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.truncateData();
  });

  it('AC-014: the runtime role holds exactly the intended table privileges', async () => {
    // Quét `has_table_privilege` trên TẤT CẢ bảng của schema, không chỉ các
    // bảng được grant: một `GRANT` thừa cho một bảng mới xuất hiện sau phải
    // bị bắt, chứ không nằm ngoài danh sách kiểm.
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

      // So sánh theo từng bảng **và** theo tập bảng: một bảng lạ xuất hiện
      // trong schema cũng phải làm test đỏ, chứ không bị lọc nhầm.
      expect(Object.keys(actual).toSorted()).toEqual(
        Object.keys(EXPECTED_RUNTIME_PRIVILEGES).toSorted(),
      );
      expect(actual).toEqual(EXPECTED_RUNTIME_PRIVILEGES);
    } finally {
      await client.end();
    }
  });

  it('SR-015: every UPDATE and DELETE on the audit table is refused, grant layer', async () => {
    // Lớp 1 của append-only: runtime role không được cấp UPDATE/DELETE. Assert
    // bằng **hành vi** (một câu UPDATE bị từ chối), không chỉ bằng
    // `has_table_privilege` — hàm catalog trả `false` là chưa đủ, vì nó phụ
    // thuộc catalog đúng mà không chứng minh đường thực thi thật.
    const runtime = await db.asRuntime();
    try {
      await runtime.query(`INSERT INTO backoffice.authorization_audit (action, outcome)
        VALUES ('staff.view', 'success')`);
      await expect(
        runtime.query(`UPDATE backoffice.authorization_audit SET outcome = 'failure'`),
      ).rejects.toThrow(/permission denied/iu);
      await expect(runtime.query('DELETE FROM backoffice.authorization_audit')).rejects.toThrow(
        /permission denied/iu,
      );
    } finally {
      await runtime.end();
    }
  });

  it('SR-015: the append-only trigger also holds for the migrator — no UPDATE or DELETE on audit', async () => {
    // ⚠️ Với migrator, chặn append-only **không** đến từ tầng grant: migrator
    // là người tạo bảng nên là owner, mà owner luôn có UPDATE/DELETE trên
    // object của mình — không REVOKE nàoidiện được điều đó. Lớp chặn duy nhất
    // dành cho migrator là trigger. Đó chính là lý do schema cần hai lớp
    // (grant cho runtime, trigger cho **mọi** role): một migration tạm không
    // đạt chuẩn vẫn không được ghi đè audit.
    const migrator = await db.asMigrator();
    try {
      await migrator.query(`INSERT INTO backoffice.authorization_audit (action, outcome)
        VALUES ('staff.view', 'success')`);
      await expect(
        migrator.query(`UPDATE backoffice.authorization_audit SET outcome = 'failure'`),
      ).rejects.toThrow(/la bang audit append-only/u);
      await expect(migrator.query('DELETE FROM backoffice.authorization_audit')).rejects.toThrow(
        /la bang audit append-only/u,
      );
    } finally {
      await migrator.end();
    }
  });

  it('SR-015: the append-only trigger is the second layer — superuser also refused', async () => {
    // Lớp 2 chặn **mọi** role có quyền, kể cả superuser — một cấu hình sai ở
    // tầng grant thiếu lớp này phải đỏ tại đây. Assert INSERT vẫn được (SR-018:
    // đường deny ghi audit được) và UPDATE/DELETE bị trigger raise.
    const client = await db.connect();
    try {
      await client.query(`INSERT INTO backoffice.authorization_audit (action, outcome)
        VALUES ('staff.view', 'success')`);
      // Trigger raise `integrity_constraint_violation`, không luôn luôn là
      // `permission denied` — message là thứ cần khớp.
      await expect(
        client.query(`UPDATE backoffice.authorization_audit SET outcome = 'failure'`),
      ).rejects.toThrow(/la bang audit append-only/u);
      await expect(client.query('DELETE FROM backoffice.authorization_audit')).rejects.toThrow(
        /la bang audit append-only/u,
      );
    } finally {
      await client.end();
    }
  });

  it('SR-014: the audit context rejects top-level auth-secret-looking keys', async () => {
    // CHECK `authorization_audit_no_secret_keys` chỉ chặn TỐI THIẾU đúng các
    // top-level key liệt kê; đây là **soft-check**, không phải substitute cho
    // scrubbing app layer (SR-014). Test giữ cho CHECK cứng như khai báo — ai
    // bỏ nó để "tránh lỗi khi insert" sẽ làm test đỏ, không phải âm thầm
    // mở đường ghi secret vào audit.
    const runtime = await db.asRuntime();
    try {
      await expect(
        runtime.query(`INSERT INTO backoffice.authorization_audit (action, outcome, context)
          VALUES ('staff.view', 'success', '{"token": "ey"}')`),
      ).rejects.toThrow(/authorization_audit_no_secret_keys/u);
      await expect(
        runtime.query(`INSERT INTO backoffice.authorization_audit (action, outcome, context)
          VALUES ('staff.view', 'success', '{"password": "pw"}')`),
      ).rejects.toThrow(/authorization_audit_no_secret_keys/u);
      // Còn một hàng khác được INSERT bình thường: CHECK phải chặn payload, không
      // phải bảng.
      await runtime.query(`INSERT INTO backoffice.authorization_audit (action, outcome, context)
        VALUES ('staff.view', 'success', '{"actor_role": "reader"}')`);
    } finally {
      await runtime.end();
    }
  });

  it('§4.6: the runtime role cannot DELETE from staff', async () => {
    // "Không giả định xoá vật lý" (§4.6): staff status là trạng thái của
    // record; record không bị xoá. DELETE không nằm trong grant runtime,
    // hành vi phải chặn cả khi ai đó cấp nhầm — và trigger chỉ chặn UPDATE,
    // nên assertion cụ thể một DELETE là thứ bắt được.
    const runtime = await db.asRuntime();
    try {
      await runtime.query(`INSERT INTO backoffice.staff (sub) VALUES ($1)`, [NO_DELETE_SUB]);
      await expect(
        runtime.query(`DELETE FROM backoffice.staff WHERE sub = $1`, [NO_DELETE_SUB]),
      ).rejects.toThrow(/permission denied/iu);
    } finally {
      await runtime.end();
    }
  });

  it('invariant 10: the runtime role cannot INSERT into or UPDATE the permission catalog', async () => {
    // Catalog sealed (invariant 10 / SR-020): chỉ seed migration (chạy bằng
    // migrator) mới thêm permission. Runtime role tự thêm permission ngoài
    // catalog là việc phát minh phân quyền — đúng thứ invariant cấm. UPDATE
    // cũng không nằm trong grant (retire là governance action của migrator).
    const runtime = await db.asRuntime();
    try {
      await expect(
        runtime.query(`INSERT INTO backoffice.permissions (id, domain, action)
          VALUES ('perm_extra', 'extra_domain', 'extra_action')`),
      ).rejects.toThrow(/permission denied/iu);
      await expect(
        runtime.query(
          `UPDATE backoffice.permissions SET status = 'retired' WHERE id = 'perm_extra'`,
        ),
      ).rejects.toThrow(/permission denied/iu);
    } finally {
      await runtime.end();
    }
  });

  it('§4.6: the runtime role cannot DELETE from role_assignments', async () => {
    // Thu hồi là UPDATE `revoked_at` có audit (§4.6 / SR-007), không DELETE —
    // lịch sử assignment giữ lại để truy vấn được. Cột `revoked_at` là điều
    // chứng minh mô hình "history giữ lại" thật; DELETE bỏ đi được nó.
    //
    // Fixture role tạo bằng **migrator** (`asMigrator`): runtime cố ý chỉ có
    // SELECT trên `roles` (tạo role là governance action), nên INSERT role
    // phòng test bằng runtime sẽ bị từ chối vì lý do sai — mất đúng assertion
    // về DELETE của `role_assignments`.
    const migrator = await db.asMigrator();
    try {
      await migrator.query(`INSERT INTO backoffice.roles (id, is_system)
        VALUES ('role_reader_del', false)`);
    } finally {
      await migrator.end();
    }
    const runtime = await db.asRuntime();
    try {
      await runtime.query(`INSERT INTO backoffice.staff (sub) VALUES ($1)`, [
        NO_ASSIGNMENT_DELETE_SUB,
      ]);
      await runtime.query(
        `INSERT INTO backoffice.role_assignments (staff_sub, role_id, created_by_sub)
         VALUES ($1, 'role_reader_del', $2)`,
        [NO_ASSIGNMENT_DELETE_SUB, FIXTURE_ACTOR],
      );
      await expect(
        runtime.query(`DELETE FROM backoffice.role_assignments WHERE staff_sub = $1`, [
          NO_ASSIGNMENT_DELETE_SUB,
        ]),
      ).rejects.toThrow(/permission denied/iu);
    } finally {
      await runtime.end();
    }
  });

  it('SR-015: the runtime role cannot TRUNCATE any table', async () => {
    // TRUNCATE được cấp tường minh riêng ở PostgreSQL (không tự theo DELETE/INSERT),
    // nhưng không được grant cho runtime ở 0002 — đúng chỗ "không grant TRUNCATE cho
    // bảng nào" của comments. Bảng đáng kiểm nhất là `authorization_audit`, một
    // TRUNCATE ở đây là xoá sạch audit.
    const runtime = await db.connectAsRuntime();
    try {
      await expect(runtime.query('TRUNCATE backoffice.authorization_audit')).rejects.toThrow(
        /permission denied/iu,
      );
    } finally {
      await runtime.end();
    }
  });

  it('AC-011: staff sub is a unique opaque reference to an Account ID', async () => {
    // `sub` là PRIMARY KEY trên `staff` nên mapping 1:1 (§4.1). Mapping
    // nhiều-nhiều có thể dư (một sub hai hàng) sẽ phá đúng định nghĩa "một
    // Account ID tương ứng tối đa một staff entry".
    const runtime = await db.asRuntime();
    try {
      await runtime.query(`INSERT INTO backoffice.staff (sub) VALUES ($1)`, [UNIQUE_SUB]);
      await expect(
        runtime.query(`INSERT INTO backoffice.staff (sub) VALUES ($1)`, [UNIQUE_SUB]),
      ).rejects.toThrow(/unique|duplicate key/iu);
    } finally {
      await runtime.end();
    }
  });

  it('T-05: terminated is a terminal state — reviving a terminated staff member is refused', async () => {
    // `terminated` là trạng thái cuối (§4.2 + T-05 @ 02-requirements.md §3.4):
    // khôi phục membership là thao tác mới có audit, không phải "chuyển lại
    // về active" im lặng. runtime có UPDATE trên `staff` (suspend/terminate là
    // thao tác tầng app) nên **chỉ** trigger là thứ chặn được — CHECK không
    // nhìn thấy OLD row.
    const runtime = await db.asRuntime();
    try {
      await runtime.query(`INSERT INTO backoffice.staff (sub) VALUES ($1)`, [TERMINAL_SUB]);
      await runtime.query(`UPDATE backoffice.staff SET status = 'terminated' WHERE sub = $1`, [
        TERMINAL_SUB,
      ]);
      await expect(
        runtime.query(`UPDATE backoffice.staff SET status = 'active' WHERE sub = $1`, [
          TERMINAL_SUB,
        ]),
      ).rejects.toThrow(/terminated la trang thai terminal/u);
    } finally {
      await runtime.end();
    }
  });

  it('§4.1: staff sub cannot be changed on an existing row (identity mapping is 1:1)', async () => {
    // Đổi `sub` trên hàng đã tồn tại là đổi danh tính của staff member; PK
    // chỉ chặn trùng, không chặn UPDATE — trigger `staff_identity_and_terminal_guard`
    // là thứ chặn. "Tái dùng" sub cũ cho người khác là việc cấm
    // (T-01 đường thứ hai @ 02-requirements.md §3.4, §4.1).
    const runtime = await db.asRuntime();
    try {
      await runtime.query(`INSERT INTO backoffice.staff (sub) VALUES ($1)`, [RENAME_SUB]);
      await expect(
        runtime.query(`UPDATE backoffice.staff SET sub = $1 WHERE sub = $2`, [
          accountId('h'),
          RENAME_SUB,
        ]),
      ).rejects.toThrow(/khong duoc doi tren hang da ton tai/u);
    } finally {
      await runtime.end();
    }
  });

  it('01 §4.6: an assignment past its valid_until stays in the table — expiry is read-time, the filter is workstream B', async () => {
    // "valid_until không bị xoá bởi thời gian hết hạn" (§4.6): hết hạn là
    // trạng thái đọc ra tại **read-time** — ứng dụng lọc theo `valid_until >=
    // now()` khi build tập permission hiện hành (workstream B). Schema không
    // có job dọn và không DELETE vì thời gian: lịch sử assignment còn lại để
    // audit truy vấn được.
    //
    // Thực hiện bằng cách mở một assignment sẽ hết hạn sau 50 ms, chờ qua mốc,
    // rồi đo hàng VẪN còn. CHECK `valid_until > created_at` chỉ chặn tạo một
    // assignment **đã** hết hạn ngay từ đầu — nó không có cognitive nghĩa
    // "dọn hàng hết hạn".
    //
    // Trong phạm vi này chỉ model được test: filter trên read path là
    // contract của workstream B.
    const migrator = await db.asMigrator();
    try {
      await migrator.query(`INSERT INTO backoffice.roles (id, is_system)
        VALUES ('role_past_valid', false)`);
    } finally {
      await migrator.end();
    }
    const runtime = await db.asRuntime();
    try {
      await runtime.query(`INSERT INTO backoffice.staff (sub) VALUES ($1)`, [PAST_VALID_SUB]);
      await runtime.query(
        `INSERT INTO backoffice.role_assignments (staff_sub, role_id, created_by_sub, valid_until)
         VALUES ($1, 'role_past_valid', $2, now() + interval '50 milliseconds')`,
        [PAST_VALID_SUB, FIXTURE_ACTOR],
      );
    } finally {
      await runtime.end();
    }
    // Chờ đủ lâu để `valid_until` trở thành quá khứ (300 ms > 50 ms), rồi đo
    // bằng credential thật của runtime (đúng role sẽ làm read-time filter).
    await new Promise((done) => {
      setTimeout(done, 300);
    });
    const reader = await db.asRuntime();
    try {
      const { rows } = await reader.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM backoffice.role_assignments
          WHERE staff_sub = $1 AND valid_until < now()`,
        [PAST_VALID_SUB],
      );
      expect(rows[0]?.count).toBe('1');
    } finally {
      await reader.end();
    }
  });

  it('SR-016: the runtime role cannot create a table in the backoffice schema', async () => {
    // Runtime role không có DDL và không CREATE (SR-010, invariant 11): một
    // bảng runtime tự tạo sẽ nằm ngoài danh sách grant `0002`, nghĩa là ánh
    // xạ quyền không còn là nguồn sự thật. Assert bằng `SET ROLE` (session
    // người dùng superuser) — credential thật của runtime đã được kiểm ở test
    // `public.probe` ngay dưới đây, hai đường không thay thế nhau.
    const runtime = await db.asRuntime();
    try {
      await expect(runtime.query('CREATE TABLE backoffice.extra (id int)')).rejects.toThrow(
        /permission denied/iu,
      );
    } finally {
      await runtime.end();
    }
  });

  it('AC-012: the runtime role cannot create a table on the public schema (real connection)', async () => {
    // `CREATE` trên `public` là quyền mặc định của `PUBLIC` ở PostgreSQL < 15
    // và vẫn là cách lách phổ biến nhất. 0002 REVOKE ALL ON SCHEMA public FROM
    // PUBLIC giữ ghế đó — assert **hành vi** bằng credential thật (không
    // `SET ROLE`), vì một PostgreSQL mới (17) có rút `CREATE` khỏi PUBLIC từ
    // mặc định; catalog-assert sẽ xanh ngay khi REVOKE bị xoá.
    const runtime = await db.connectAsRuntime();
    try {
      await expect(runtime.query('CREATE TABLE public.probe (id int)')).rejects.toThrow(
        /permission denied/iu,
      );
    } finally {
      await runtime.end();
    }
  });

  it('SR-008-style: the migrator can do DDL while the runtime role cannot', async () => {
    // Migrator sở hữu object nó tạo nên (`CREATE` ở tầng schema cấp ở 0002);
    // tạo một bảng là proof thực tế — không assert "không ném". Dọn trong
    // `finally` vì bảng sót lại làm AC-014 đỏ ở lần chạy kế tiếp.
    const migrator = await db.asMigrator();
    try {
      await migrator.query('CREATE TABLE backoffice.migrator_probe (id int)');
      const client = await db.connect();
      try {
        const { rows } = await client.query<{ relkind: string }>(
          `SELECT c.relkind::text AS relkind
             FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'backoffice' AND c.relname = 'migrator_probe'`,
        );
        expect(rows.map((row) => row.relkind)).toEqual(['r']);
      } finally {
        await client.end();
      }
    } finally {
      await migrator.query('DROP TABLE IF EXISTS backoffice.migrator_probe');
      await migrator.end();
    }
  });

  it('AC-013: no foreign key points outside the backoffice schema', async () => {
    // Không FK xuyên database (§3 "Database trust"): `sub` là reference opaque
    // sang `db-account`, `account` chưa bao giờ là FK. Query chỉ thấy FK có
    // conrelid TRỪ `backoffice` (con của `pg_catalog` chỉ là core không cần
    // xét).
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ violations: number }>(
        `SELECT count(*)::int AS violations
           FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = rel.relnamespace
          WHERE con.contype = 'f'
            AND n.nspname NOT IN ('backoffice', 'pg_catalog', 'information_schema')`,
      );
      expect(rows[0]?.violations).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('AC-013: no foreign data wrapper and no dblink extension is installed', async () => {
    // Ranh giới None-DB (`00-ready` ABI của repo không chốt tên tài liệu, vẫn
    // là điều schema cùng `account` tuân theo): `gen_random_uuid()` là core
    // từ PostgreSQL 13 nên `authorization_audit.id` cần không cài extension.
    // Chỉ còn `plpgsql` — extension mặc định của mọi database.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ extname: string }>(
        `SELECT extname FROM pg_extension ORDER BY extname`,
      );
      const installed = rows.map((row) => row.extname);
      expect(installed).not.toContain('postgres_fdw');
      expect(installed).not.toContain('dblink');
      expect(installed).toEqual(['plpgsql']);
    } finally {
      await client.end();
    }
  });

  it('AC-013: no migration executes a foreign data wrapper, dblink, or foreign table', async () => {
    // `pg_extension` chỉ thấy extension **đã cài**. Một `CREATE EXTENSION
    // postgres_fdw` bị comment lại, hay một `dblink_connect_to` nằm trong
    // migration, không xuất hiện ở query trên — phải đọc file. Quét SQL đã bỏ
    // comment vì các migration giải thích bằng chính tên thứ chúng cấm.
    for (const migration of listMigrations()) {
      const sql = executableSql(migration.sql);
      expect({ file: migration.name, sql }).not.toMatchObject({
        sql: expect.stringMatching(
          /postgres_fdw|dblink|foreign\s+table|foreign\s+data\s+wrapper/iu,
        ),
      });
    }
  });

  it('NFR-002b: the only other database the migrations name is db-backoffice', async () => {
    for (const migration of listMigrations()) {
      const found = executableSql(migration.sql).match(/db-[a-z]+/gu) ?? [];
      for (const name of found) {
        expect({ file: migration.name, name }).toMatchObject({
          name: expect.stringMatching(/^db-backoffice$/u),
        });
      }
    }
  });
});
