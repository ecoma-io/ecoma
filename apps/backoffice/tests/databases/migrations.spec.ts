/**
 * Apply migration lên PostgreSQL thật và đo trạng thái sau đó.
 *
 * ⚠️ Suite bắt buộc Docker: probe hỏng thì `globalSetup` ném và toàn bộ lần chạy
 * đỏ (fail-loud, 06-testing.md §6) - skip với exit 0 không phải kết quả chấp
 * nhận được.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BACKOFFICE_DATABASE } from '../../db/migrate.mts';
import {
  type BackofficeDatabase,
  applyMigrations,
  startBackofficeDatabase,
} from '../integrations/harness.ts';

const EXPECTED_TABLES = [
  'authorization_audit',
  'bff_login_flows',
  'bff_sessions',
  'permissions',
  'role_assignments',
  'role_permissions',
  'roles',
  'staff',
];

/**
 * Account ID hợp lệ theo định dạng `libs/backoffice-domain`: prefix `sub_` + 32
 * ký tự base32 viết thường. CHECK `staff_sub_account_id_format_check` (migration
 * `0004`) chặn mọi chuỗi tự do — fixture phải đúng định dạng đó.
 */
const SMOKE_SUB = `sub_${'m'.repeat(32)}`;

async function tableNames(db: BackofficeDatabase): Promise<string[]> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'backoffice' ORDER BY table_name`,
    );
    return rows.map((row) => row.table_name);
  } finally {
    await client.end();
  }
}

describe('db-backoffice migrations on a real PostgreSQL', () => {
  let db: BackofficeDatabase;

  beforeAll(async () => {
    db = await startBackofficeDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('applies every migration file from an empty database', async () => {
    expect(await tableNames(db)).toEqual(EXPECTED_TABLES);
  });

  it('is repeatable: re-applying every file changes nothing', async () => {
    // Quay lại đúng đường code mà lần apply đầu trong `startBackofficeDatabase`
    // đã đi: `applyAllMigrations` với advisory lock. Hai lần liên tiếp — file id
    // idempotent (`CREATE … IF NOT EXISTS`, guard `pg_roles`, `CREATE OR REPLACE
    // FUNCTION`) nên lần hai phải là no-op, và lần thứ ba chứng minh điều đó
    // thay vì tin lời bình luận.
    const client = await db.connect();
    try {
      await applyMigrations(client);
      await applyMigrations(client);
    } finally {
      await client.end();
    }

    expect(await tableNames(db)).toEqual(EXPECTED_TABLES);
  });

  it('refuses to migrate a foreign database before taking the advisory lock (F3)', async () => {
    // Mutation evidence: bỏ assert `current_database()` trong `apply.mts` là
    // test này đỏ — `DATABASE_URL` trỏ nhầm database (vd `db-account` trên cùng
    // cluster) vẫn migrate thành công, schema `backoffice` rơi vào database sai
    // mà không có tín hiệu nào. Assert phải chết TRƯỚC advisory lock: nếu nó
    // nằm sau, runner đã giữ khóa rồi migrate trước trên database sai.
    const { Client: PgClient } = await import('pg');
    // Connect tới database `postgres` — database mặc định mà runner không
    // được phép migrate thay cho `db-backoffice`. Superuser của harness được
    // dùng ở đây vì `DATABASE_URL` sai database là lỗi cấu hình vận hành, không phải
    // lỗi quyền: runner thật trỏ nhầm thì cũng connect được (PUBLIC có CONNECT
    // theo mặc định) — và đó chính là đường lỗi mà assert phải bắt.
    const wrongClient = new PgClient({
      host: db.host,
      port: db.port,
      user: 'ecoma_test_superuser',
      password: db.superuserPassword,
      database: 'postgres',
    });
    await wrongClient.connect();
    try {
      await expect(applyMigrations(wrongClient)).rejects.toThrow(
        /is connected to "postgres", expected "db-backoffice"/u,
      );
    } finally {
      await wrongClient.end();
    }
  });

  it('takes the pg advisory lock before applying, so a concurrent runner blocks', async () => {
    // Khóa là `hashtext(BACKOFFICE_DATABASE)` phía server (xem `apply.mts`) —
    // một số được chọn theo tên database để hai service chung instance không
    // tranh một khóa. Test hành vi: giữ khóa ở session khác + `lock_timeout`
    // ngắn ⇒ apply phải ném; nếu runner bị mất khóa (hay đổi cách lấy khóa)
    // thì apply chạy trọn (migrations idempotent) và test đỏ vì không ném gì.
    const holder = await db.connect();
    const runner = await db.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(hashtext($1))', [BACKOFFICE_DATABASE]);
      await runner.query(`SET lock_timeout = '500ms'`);
      await expect(applyMigrations(runner)).rejects.toThrow(/lock timeout/iu);
    } finally {
      await runner.query('RESET lock_timeout').catch(() => undefined);
      await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [BACKOFFICE_DATABASE]);
      await holder.end();
      await runner.end();
    }
  });

  it('leaves the runtime role able to do DML and nothing else', async () => {
    // DML smoke trên bảng `staff` qua runtime role, rồi một `CREATE TABLE` bị
    // từ chối. Hai nửa phải nằm trong MỘT test: "chỉ DML" là cặp điều kiện —
    // đủ DML và không DDL — tách hai test thì một nửa lỗi không làm đỏ cặp.
    //
    // ⚠️ `sub` phải là Account ID đúng định dạng (`sub_` + 32 ký tự base32
    // viết thường) — CHECK `staff_sub_account_id_format_check` ở migration
    // `0004` chặn mọi chuỗi tự do. Fixture ở đây dùng đúng định dạng đó.
    const runtime = await db.asRuntime();
    try {
      await runtime.query(`INSERT INTO backoffice.staff (sub) VALUES ($1)`, [SMOKE_SUB]);
      const { rows } = await runtime.query<{ sub: string }>(
        `SELECT sub FROM backoffice.staff WHERE sub = $1`,
        [SMOKE_SUB],
      );
      expect(rows).toHaveLength(1);
    } finally {
      await runtime.end();
    }

    const again = await db.asRuntime();
    try {
      await expect(again.query('CREATE TABLE backoffice.nope (id int)')).rejects.toThrow(
        /permission denied/iu,
      );
    } finally {
      await again.end();
    }
  });

  it('fails 0002 when the runtime role lost CONNECT on db-backoffice', async () => {
    // Guard trong `0002` phải kiểm `ecoma_backoffice_runtime`, không phải
    // `current_user`: migrator LUÔN có CONNECT (nó vừa kết nối để chạy
    // migration) nên kiểm `current_user` là câu đúng luôn đúng. Giữ tài sản này:
    // revoke CONNECT của runtime (và PUBLIC — CONNECT là quyền mặc định của
    // PUBLIC trên database của mình) ⇒ apply phải ném; thay đổi kiểm
    // `current_user` thì apply chạy trọn và test đỏ.
    //
    // Dọn dẹp trong `finally` khôi phục cả hai grant để các test khác không đỏ
    // vì cùng một database bị sửa.
    const client = await db.connect();
    try {
      await client.query(`REVOKE CONNECT ON DATABASE "${BACKOFFICE_DATABASE}" FROM PUBLIC`);
      await client.query(
        `REVOKE CONNECT ON DATABASE "${BACKOFFICE_DATABASE}" FROM ecoma_backoffice_runtime`,
      );
      await expect(applyMigrations(client)).rejects.toThrow(
        /ecoma_backoffice_runtime mat quyen CONNECT/u,
      );
    } finally {
      // `0002` bọc trong `BEGIN;` — khi DO block raise, simple query dừng giữa
      // chừng và để connection ở trạng thái aborted transaction; ROLLBACK
      // trước rồi mới cấp lại. (`ROLLBACK` không có transaction cũng vô hại.)
      await client.query('ROLLBACK').catch(() => undefined);
      await client.query(`GRANT CONNECT ON DATABASE "${BACKOFFICE_DATABASE}" TO PUBLIC`);
      await client.query(
        `GRANT CONNECT ON DATABASE "${BACKOFFICE_DATABASE}" TO ecoma_backoffice_runtime`,
      );
      await client.end();
    }
  });

  it('marks db:migrate cache false, because DATABASE_URL is not an input', async () => {
    // `nx:run-commands` được cache mặc định; `DATABASE_URL` không nằm trong inputs
    // nào nên lần chạy thứ hai trả kết quả **cached** và KHÔNG migrate database
    // thật — một lần chạy "xanh" không đổi gì. Cross-check đọc nguồn như các hằng
    // khác: package.json là JSON nên không thể comment trong đó
    // (`apps/backoffice/package.json` target `db:migrate`).
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');

    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8'),
    ) as { nx?: { targets?: Record<string, { cache?: boolean }> } };

    expect(manifest.nx?.targets?.['db:migrate']?.cache).toBe(false);
  });
});
