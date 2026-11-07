/**
 * Grant và ranh giới database — AC-012, AC-013, AC-014, NFR-002, NFR-002a,
 * NFR-002b, SR-008.
 *
 * Đây là những test **quan trọng nhất** của suite, vì chúng kiểm chứng những thứ
 * mà review không nhìn thấy: một `GRANT` thừa, hay một `REVOKE` không có tác
 * dụng, đều để mọi test khác xanh.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AUTH_DATABASE, listMigrations } from '../../db/migrate.mts';
import { type AccountDatabase, startAccountDatabase } from './harness.ts';
const RUNTIME = 'ecoma_account_runtime';

/**
 * Bảng được grant DML, theo đúng `0002_roles_and_grants.sql`.
 *
 * `email_addresses` và `otp_challenges` (`0005`/`0006`) theo hình dạng DML đầy
 * đủ: OTP verify phải UPDATE `attempts`/`consumed_at` và DELETE của `users`
 * cascade sang địa chỉ (FK RESTRICT, xoá user là việc của chính nó).
 *
 * Ba bảng data domain (`0008`) cũng DML đầy đủ: chúng thuộc nhóm (2) của §7.1
 * — bị xoá hoặc anonymize khi account bị xoá — nên DELETE là thao tác hợp lệ
 * của luồng đó; không bảng nào là append-only hay tombstone.
 */
const DML_TABLES = [
  'users',
  'account_sessions',
  'login_handoffs',
  'account_outbox_events',
  'email_addresses',
  'otp_challenges',
  'notification_preferences',
  'user_preferences',
  'user_profiles',
];

/** Bảng audit: đọc và ghi, nhưng **không** có `UPDATE`/`DELETE` (append-only). */
const INSERT_ONLY_TABLES = ['security_events'];

/**
 * Kho nonce (`0003_internal_nonces.sql`): `SELECT`/`INSERT`/`DELETE` nhưng
 * **không** `UPDATE`.
 *
 * Hình dạng grant thứ ba, khác cả DML đầy đủ lẫn append-only của audit: nonce là
 * bất biến nên không có `UPDATE` để nới cửa sổ replay, nhưng prune theo
 * `expires_at` cần `DELETE` — và đó **không** làm append-only. Ai đọc "chỉ có
 * `INSERT` nghĩa là audit" thì sẽ đoán sai bảng này.
 */
const NONCE_TABLES = ['internal_nonces'];

/** Grant kỳ vọng của `internal_nonces`, tách riêng để không suy ra từ quy tắc chung. */
const NONCE_PRIVILEGES = ['DELETE', 'INSERT', 'SELECT'];

/**
 * Bảng yêu cầu data subject (`0010_privacy_requests.sql`): `SELECT`/`INSERT`/
 * `UPDATE` nhưng **không** `DELETE`.
 *
 * Hình dạng grant thứ tư — gương chiếu của nonce nhưng theo chiều ngược (nonce
 * thiếu `UPDATE`, bảng này thiếu `DELETE`): hàng privacy request thuộc nhóm (3)
 * của §7.1 — bằng chứng "đã nhận yêu cầu" phải sống sót qua tombstone, nên
 * vòng đời xử lý chỉ đổi `status` (UPDATE), không bao giờ xoá hàng. `UPDATE`
 * có sẵn từ 0010 để vòng đời orchestration (FR-013a) không phải mở rộng grant.
 */
const PRIVACY_REQUEST_TABLES = ['privacy_requests'];

/** Grant kỳ vọng của `privacy_requests` — đủ DML trừ DELETE (nhóm 3). */
const PRIVACY_REQUEST_PRIVILEGES = ['INSERT', 'SELECT', 'UPDATE'];

/**
 * Bỏ comment `--` ra khỏi SQL trước khi quét nội dung.
 *
 * Cần thiết vì các file migration **có** giải thích bằng chính tên thứ mà
 * chúng cấm: comment nói "không có `postgres_fdw`, không có `dblink`" sẽ làm một
 * lần quét thô báo động giả. Giới hạn đã biết: không xử lý `--` nằm trong string
 * literal, và các migration này không có string nào chứa `--`.
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

describe('roles and grants on db-account', () => {
  let db: AccountDatabase;

  beforeAll(async () => {
    db = await startAccountDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('AC-012: the runtime role has no CONNECT on db-auth', async () => {
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ can_connect: boolean }>(
        `SELECT has_database_privilege($1, $2, 'CONNECT') AS can_connect`,
        [RUNTIME, AUTH_DATABASE],
      );
      expect(rows[0]?.can_connect).toBe(false);
    } finally {
      await client.end();
    }
  });

  it('AC-012: the boundary is enforced by a real connection, not only by the catalog', async () => {
    // `has_database_privilege` trả `false` là **chưa đủ** — nó là một hàm của
    // catalog, và một cấu hình sai cũng có thể cho kết quả đúng. Chỉ một kết nối
    // thật bị từ chối mới chứng minh ranh giới được thi hành.
    const pg = (await import('pg')).default;
    const attempt = new pg.Client({
      host: db.host,
      port: db.port,
      user: RUNTIME,
      password: db.rolePassword,
      database: AUTH_DATABASE,
    });
    await expect(attempt.connect()).rejects.toThrow(/permission denied for database/iu);
  });

  it('AC-012: CONNECT is revoked from PUBLIC, which is what actually denies it', async () => {
    // Chốt lại cái bẫy đã đo trên PostgreSQL 17: `CONNECT` là quyền của `PUBLIC`
    // theo mặc định, và một role thừa hưởng nó cho tới khi có ACL riêng làm đổi
    // kết quả. Nên `REVOKE CONNECT ... FROM ecoma_account_runtime` một mình là
    // một câu rỗng — sau khi chạy, ACL không hề có entry của role và
    // `has_database_privilege` vẫn trả `true`. `0002` vì vậy phải rút quyền của
    // `PUBLIC` **và** của role.
    //
    // Entry của `PUBLIC` trong `datacl` là entry có grantee rỗng, tức item bắt đầu
    // bằng `=`. Không được quét cả chuỗi: entry của chính owner cũng chứa `C`
    // (đó là quyền của owner trên database của nó).
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ acl: string | null }>(
        `SELECT datacl::text AS acl FROM pg_database WHERE datname = $1`,
        [AUTH_DATABASE],
      );

      const items = (rows[0]?.acl ?? '').split(',').filter((item) => item.length > 0);

      // Không có entry nào cho PUBLIC thì `datacl` **không** chứa item bắt đầu
      // bằng `=` — và đó mới là kết quả mong muốn. Cấu hình sạch nhất có item
      // `=T/...` (PUBLIC còn TEMPORARY nhưng đã mất CONNECT), nên cả hai hình
      // đều được chấp nhận; điều **không** được chấp nhận là item có `C`.
      const publicGrants = items
        .filter((item) => item.startsWith('='))
        .flatMap((item) => item.slice(1).split('/')[0]?.split(',') ?? []);

      expect({ acl: rows[0]?.acl, publicGrants }).toMatchObject({
        publicGrants: expect.not.arrayContaining(['C']),
      });

      // Và không có entry nào cấp CONNECT cho role runtime.
      expect(items.some((item) => item.startsWith(`${RUNTIME}=`) && item.includes('C'))).toBe(
        false,
      );
    } finally {
      await client.end();
    }
  });

  it('AC-014: the runtime role holds exactly the intended table privileges', async () => {
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
          WHERE n.nspname = 'account' AND c.relkind = 'r'
          ORDER BY c.relname`,
        [RUNTIME],
      );

      const actual = Object.fromEntries(
        rows.map((row) => [row.table_name, [...row.privileges].toSorted()]),
      );

      // `users` là ngoại lệ: tombstone là nhóm (1), nhóm duy nhất được giữ vĩnh
      // viễn, và DELETE giải phóng PK `sub` — mở lại đường tái phát hành
      // identifier (FR-001, FR-012d). Giữ đúng danh sách mong đợi, không suy ra
      // từ "bảng nào cũng DML đầy đủ".
      const USERS_PRIVILEGES = ['INSERT', 'SELECT', 'UPDATE'];
      const dml = ['DELETE', 'INSERT', 'SELECT', 'UPDATE'];
      const expected = Object.fromEntries(
        [...DML_TABLES, ...INSERT_ONLY_TABLES, ...NONCE_TABLES, ...PRIVACY_REQUEST_TABLES].map(
          (table) => [
            table,
            table === 'security_events'
              ? ['INSERT', 'SELECT']
              : table === 'internal_nonces'
                ? NONCE_PRIVILEGES
                : table === 'users'
                  ? USERS_PRIVILEGES
                  : table === 'privacy_requests'
                    ? PRIVACY_REQUEST_PRIVILEGES
                    : dml,
          ],
        ),
      );

      // So sánh theo từng bảng **và** theo tập bảng: một bảng lạ xuất hiện trong
      // schema cũng phải làm test đỏ, chứ không bị lọc nhầm.
      expect(Object.keys(actual).toSorted()).toEqual(Object.keys(expected).toSorted());
      expect(actual).toEqual(expected);

      // Tuyên bố tường minh đi kèm: runtime **thiếu** DELETE trên `users`. Vòng
      // so khớp ở trên đã bắt điều đó, nhưng một assertion đặt tên giữ tài sản
      // này sống lâu hơn mọi lần refactor danh sách privileges.
      expect(actual['users']).not.toContain('DELETE');
      // Cùng lập luận cho `privacy_requests`: thiếu DELETE là thuộc tính nhóm (3)
      // — bằng chứng request phải sống qua tombstone (FR-013).
      expect(actual['privacy_requests']).not.toContain('DELETE');
    } finally {
      await client.end();
    }
  });

  it('NFR-002a: the runtime role cannot create anything in the account schema', async () => {
    const runtime = await db.asRuntime();
    try {
      await expect(runtime.query('CREATE TABLE account.extra (id int)')).rejects.toThrow(
        /permission denied/iu,
      );
      await expect(runtime.query('CREATE SCHEMA account_more')).rejects.toThrow(
        /permission denied/iu,
      );
    } finally {
      await runtime.end();
    }
  });

  it('NFR-002a: the runtime role cannot create a table on the public schema', async () => {
    // `CREATE` trên `public` là quyền mặc định của `PUBLIC` ở PostgreSQL < 15 và
    // vẫn là cách phổ biến nhất để một runtime role lách khỏi grant mà AC-014 quét.
    //
    // ⚠️ Assert **hành vi** (một kết nối thật bị từ chối), không assert catalog
    // bằng `has_schema_privilege`: bản catalog-assert trước đây xanh cả khi `REVOKE`
    // trong `0002` bị xoá, vì PostgreSQL 17 đã rút `CREATE` trên `public` khỏi
    // `PUBLIC` từ mặc định — test khi đó không đo được thứ nó bảo vệ. Kết nối
    // thật bằng credential runtime (không `SET ROLE`) giữ đúng tài sản cần bảo vệ:
    // không tạo được object trong schema mà AC-014 không theo dõi.
    const runtime = await db.connectAsRuntime();
    try {
      await expect(runtime.query('CREATE TABLE public.probe (id int)')).rejects.toThrow(
        /permission denied/iu,
      );
    } finally {
      await runtime.end();
    }
  });

  it('SR-008: the migrator role can do DDL while the runtime role cannot', async () => {
    const migrator = await db.asMigrator();
    try {
      await migrator.query('CREATE TABLE account.migrator_probe (id int)');

      // Không assert bằng "không ném" — `await` rồi không làm gì cũng là một
      // pass, và test đó sẽ xanh ngay cả khi `CREATE` bị từ chối. Đọc `relkind`
      // là cách chứng minh bảng **thật sự** tồn tại sau DDL.
      const client = await db.connect();
      try {
        const { rows } = await client.query<{ relkind: string }>(
          `SELECT c.relkind::text AS relkind
             FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'account' AND c.relname = 'migrator_probe'`,
        );
        expect(rows.map((row) => row.relkind)).toEqual(['r']);
      } finally {
        await client.end();
      }
    } finally {
      // Dọn trong `finally`: một bảng sót lại sẽ làm AC-014 đỏ ở lần chạy kế
      // tiếp, và phụ thuộc thứ tự test là kiểu test không nên có.
      await migrator.query('DROP TABLE IF EXISTS account.migrator_probe');
      await migrator.end();
    }
  });

  it('AC-013: no foreign key points outside the account schema', async () => {
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ violations: number }>(
        `SELECT count(*)::int AS violations
           FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = rel.relnamespace
          WHERE con.contype = 'f'
            AND n.nspname NOT IN ('account', 'pg_catalog', 'information_schema')`,
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
      // PostgreSQL 13 nên mặc định của `security_events.event_id` tự giải
      // quyết. Chỉ còn `plpgsql` — extension mặc định của mọi database.
      expect(installed).toEqual(['plpgsql']);
    } finally {
      await client.end();
    }
  });

  it('AC-013: no migration executes a foreign data wrapper, dblink, or foreign table', async () => {
    // Query `pg_extension` chỉ thấy extension **đã cài**. Một câu
    // `CREATE EXTENSION postgres_fdw` bị comment lại, hay một `dblink_connect_to`
    // nằm trong migration, sẽ không xuất hiện ở query trên — nên phải đọc file.
    // Quét **SQL đã bỏ comment** vì các migration giải thích bằng chính tên thứ
    // chúng cấm.
    for (const migration of listMigrations()) {
      const sql = executableSql(migration.sql);
      expect({ file: migration.name, sql }).not.toMatchObject({
        sql: expect.stringMatching(
          /postgres_fdw|dblink|foreign\s+table|foreign\s+data\s+wrapper/iu,
        ),
      });
    }
  });

  it('NFR-002b: the only other database the migrations name is db-auth', async () => {
    for (const migration of listMigrations()) {
      const found = executableSql(migration.sql).match(/db-[a-z]+/gu) ?? [];
      for (const name of found) {
        expect({ file: migration.name, name }).toMatchObject({
          name: expect.stringMatching(/^db-(account|auth)$/u),
        });
      }
    }
  });

  it('0007: the DO-block fallback creates the pruner role shaped like provisioning, with LOGIN', () => {
    // Lưới an toàn của `0007` phải tạo đúng khuôn với các đường provisioning:
    // runbook (`apps/account/db/README.md` §"Provisioning") và harness integration
    // đều tạo pruner bằng `CREATE ROLE … LOGIN …`. Thiếu `LOGIN` thì trên một
    // cluster sạch role rơi ra `NOLOGIN` — Hyperdrive không xác thực được bằng
    // credential của nó, job đo `db_unreachable` vĩnh viễn trong khi migrations
    // vẫn trông xanh; chạy lại migration không cứu được vì guard `pg_roles` bỏ
    // qua role đã tồn tại.
    //
    // ⚠️ Assert trên FILE, không trên catalog: database test được provisioning
    // tạo role TRƯỚC khi migration chạy (harness `tests/integrations/harness.ts`),
    // nên guard của `0007` đi theo nhánh "đã tồn tại" và một mutation trong câu
    // `CREATE ROLE` không bao giờ lộ ra ở database đang chạy — chỉ mỗi file là
    // thứ sẽ lên production.
    const migration0007 = listMigrations().find(
      (file) => file.name === '0007_nonce_pruner_role.sql',
    );
    expect(migration0007).toBeDefined();
    const fallback = /CREATE ROLE\s+ecoma_account_nonce_pruner\s+(?<flags>[\S\s]*?)\s*END;/u.exec(
      executableSql(migration0007?.sql ?? ''),
    );
    const flags = fallback?.groups?.['flags'] ?? '';
    expect(flags).toMatch(/\bLOGIN\b/u);
    // Các cờ hạn chế còn lại phải giữ nguyên — `LOGIN` không được mua bằng cách
    // bỏ một cờ `NO*` nào, tức role fallback không được nới đặc quyền theo hướng khác.
    expect(flags).toMatch(/\bNOSUPERUSER\b/u);
    expect(flags).toMatch(/\bNOCREATEDB\b/u);
    expect(flags).toMatch(/\bNOCREATEROLE\b/u);
    expect(flags).toMatch(/\bNOINHERIT\b/u);
    expect(flags).toMatch(/\bNOBYPASSRLS\b/u);
  });
});
