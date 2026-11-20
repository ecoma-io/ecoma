/**
 * Grant sweep và ranh giới CONNECT của `db-remote-cache-app` — mirror của
 * `apps/remote-cache-api/tests/integrations/roles.spec.ts` cho DB thứ hai của
 * cutover #377 (AC4: runtime/migrator role separation verify được cho cả 2 DB),
 * pattern `apps/backoffice/tests/integrations/grants.spec.ts`.
 *
 * Đây là những test quan trọng nhất của suite: chúng kiểm chứng những thứ mà
 * review không nhìn thấy — một `GRANT` thừa hay một `REVOKE` không có tác dụng
 * đều để mọi test khác xanh. Suite này CHỈ chứng minh role separation; hành vi
 * trigger của bảng (`bff_sessions_immutable_guard`) thuộc suite runtime của app.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RemoteCacheAppDatabase, startRemoteCacheAppDatabase } from './harness.ts';

const RUNTIME = 'ecoma_remote_cache_app_runtime';

/**
 * Grant kỳ vọng của runtime, theo đúng `0001_remote_cache_app_bff_sessions.sql`
 * (authority `deploys/remote-cache-app-db`), theo từng bảng — danh sách tường
 * minh, không suy ra từ quy tắc chung:
 *
 * - `bff_sessions`: SELECT + INSERT + UPDATE + DELETE — sliding idle
 *   (`expires_at`), refresh rotate (`access_token`/`refresh_token`) và logout
 *   (`revoked_at`) là UPDATE; prune phiên hết hạn là DELETE (nội dung phiên
 *   không có giá trị lịch sử sau khi chết — token sinh lại được bằng login).
 *   Đổi chủ phiên (`account_sub`/`id_hash`/`created_at`) là việc của trigger
 *   `bff_sessions_immutable_guard`, không phải của grant — không phải điều
 *   suite này đo.
 * - `bff_login_flows`: SELECT + INSERT + DELETE, KHÔNG UPDATE — consume bằng
 *   DELETE là toàn bộ vòng đời (single-use, TTL 10 phút).
 * - `__drizzle_migrations`: bảng history của migration authority (cutover
 *   #377), hạ tầng của kit — chỉ role migrator chạm tới; runtime không được
 *   grant gì nên danh sách rỗng là điều ĐÚNG. Phải nằm trong tập kiểm để một
 *   `GRANT` thừa nhắm vào nó cũng bị bắt.
 */
const EXPECTED_PRIVILEGES: Record<string, readonly string[]> = {
  __drizzle_migrations: [],
  bff_login_flows: ['DELETE', 'INSERT', 'SELECT'],
  bff_sessions: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
};

describe('roles and grants on db-remote-cache-app', () => {
  let db: RemoteCacheAppDatabase;

  beforeAll(async () => {
    db = await startRemoteCacheAppDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('the runtime role holds exactly the intended table privileges', async () => {
    // Quét `has_table_privilege` trên TẤT CẢ bảng của schema, không chỉ các
    // bảng được grant: một `GRANT` thừa cho một bảng mới xuất hiện sau phải bị
    // bắt, chứ không nằm ngoài danh sách kiểm.
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
          WHERE n.nspname = 'remote_cache_app' AND c.relkind = 'r'
          ORDER BY c.relname`,
        [RUNTIME],
      );

      const actual = Object.fromEntries(
        rows.map((row) => [row.table_name, [...row.privileges].toSorted()]),
      );

      // toEqual so sánh cả tập bảng lẫn grant từng bảng: một bảng lạ xuất hiện
      // trong schema cũng phải làm test đỏ, chứ không bị lọc nhầm.
      expect(actual).toEqual(EXPECTED_PRIVILEGES);
    } finally {
      await client.end();
    }
  });

  it('the runtime role cannot create anything in the remote_cache_app schema', async () => {
    // Runtime chỉ có DML theo grant của 0001; DDL trong schema là việc của
    // migrator. Assert bằng `SET ROLE` — credential thật của runtime đã được
    // kiểm ở test `public.probe` dưới đây, hai đường không thay thế nhau.
    const runtime = await db.asRuntime();
    try {
      await expect(runtime.query('CREATE TABLE remote_cache_app.extra (id int)')).rejects.toThrow(
        /permission denied/iu,
      );
      await expect(runtime.query('CREATE SCHEMA remote_cache_app_more')).rejects.toThrow(
        /permission denied/iu,
      );
    } finally {
      await runtime.end();
    }
  });

  it('SR-008 pattern: the migrator role can do DDL while the runtime role cannot', async () => {
    // Migrator giữ `CREATE` trên database (provisioning step) nên là chủ schema;
    // tạo một bảng là proof thực tế — không assert "không ném", đọc `relkind`
    // để chứng minh bảng thật sự tồn tại sau DDL.
    const migrator = await db.asMigrator();
    try {
      // DROP trước CREATE: một crash trước `finally` của lần chạy trước để lại
      // bảng sót là lỗi "relation already exists" ở lần chạy này — idempotent,
      // không phụ thuộc lẫn nhau giữa các run.
      await migrator.query('DROP TABLE IF EXISTS remote_cache_app.migrator_probe');
      await migrator.query('CREATE TABLE remote_cache_app.migrator_probe (id int)');

      const client = await db.connect();
      try {
        const { rows } = await client.query<{ relkind: string }>(
          `SELECT c.relkind::text AS relkind
             FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'remote_cache_app' AND c.relname = 'migrator_probe'`,
        );
        expect(rows.map((row) => row.relkind)).toEqual(['r']);
      } finally {
        await client.end();
      }
    } finally {
      // Dọn trong `finally`: một bảng sót lại sẽ làm grant sweep đỏ ở lần chạy
      // kế tiếp, và phụ thuộc thứ tự test là kiểu test không nên có.
      await migrator.query('DROP TABLE IF EXISTS remote_cache_app.migrator_probe');
      await migrator.end();
    }
  });

  it('the runtime role cannot create a table on the public schema (real connection)', async () => {
    // `CREATE` trên `public` là quyền mặc định của `PUBLIC` ở PostgreSQL < 15
    // và vẫn là cách lách phổ biến nhất; provisioning step `REVOKE ALL ON
    // SCHEMA public FROM PUBLIC` giữ ghế đó. Assert **hành vi** bằng credential
    // thật (không `SET ROLE`) — PostgreSQL 17 đã rút `CREATE` khỏi PUBLIC nên
    // catalog-assert sẽ xanh ngay cả khi REVOKE bị xoá.
    const runtime = await db.connectAsRuntime();
    try {
      await expect(runtime.query('CREATE TABLE public.probe (id int)')).rejects.toThrow(
        /permission denied/iu,
      );
    } finally {
      await runtime.end();
    }
  });

  it('a role without a CONNECT grant cannot connect to the database (real connection)', async () => {
    // `REVOKE CONNECT ... FROM PUBLIC` + hai `GRANT CONNECT` per-role là toàn
    // bộ ranh giới kết nối của database này: chỉ đúng hai role app được vào.
    // Role probe không có grant nào — nỗ lực kết nối thật phải chết ở tầng
    // PostgreSQL, không phải ở password.
    await expect(db.connectUngrantedRole()).rejects.toThrow(/permission denied for database/iu);
  });
});
