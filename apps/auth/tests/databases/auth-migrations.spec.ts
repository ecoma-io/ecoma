/**
 * Apply migration `db-auth` qua **runner canonical** (`db/apply.mts`) trên
 * PostgreSQL thật.
 *
 * ⚠️ Không dùng `describe.skipIf`: suite PG của repo đã đổi sang fail-loud —
 * `globalSetup` probe Docker một lần mỗi lần chạy và vắng Docker là lỗi thật
 * (commit d96c40de), không phải nửa suite skip với exit 0. `beforeAll` gọi
 * `startAuthRunnerDatabase()`; probe không đạt thì toàn bộ lần chạy đỏ từ
 * `globalSetup` trước khi worker nào kịp báo xanh giả.
 *
 * ⚠️ Đường code được test là ĐÚNG hàm mà CLI `db:migrate` chạy —
 * `applyAllMigrations` của `db/apply.mts`. Harness integration PG cũ của app
 * (`harness.ts` `applyMigrations`) tự nạp file bằng `postgres()` mà không qua
 * runner: nó phục vụ việc dựng schema cho suite khác, không chứng minh gì về
 * runner production. Test dưới đây là nơi kiểm protocol runner thật: advisory
 * lock, history table, checksum drift, re-apply qua lịch sử.
 */

import {
  mkdtempSync,
  copyFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import { applyAllMigrations } from '../../db/apply.mts';
import { AUTH_DATABASE, checksumMigration, listMigrations } from '../../db/migrate.mts';
import { startAuthRunnerDatabase, type RunnerDatabase } from './runner-harness.ts';

let db: RunnerDatabase;

beforeAll(async () => {
  db = await startAuthRunnerDatabase();
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

/** Client superuser — chỉ dùng đọc catalog và sửa ACL trong `finally`. */
function connectSuperuser(): Promise<Client> {
  return db.connectSuperuser();
}

/** Client migrator thật (credential thật, không SET ROLE) — đúng vai trò runner. */
function connectMigrator(): Promise<Client> {
  return db.connectMigrator();
}

describe('auth migration runner on a real PostgreSQL', () => {
  it('applies every migration file from an empty database, recording history', async () => {
    const migrator = await connectMigrator();
    try {
      const files = listMigrations();
      const result = await applyAllMigrations(migrator);

      expect(result.applied).toBe(files.length);

      const { rows } = await migrator.query<{ filename: string; checksum: string }>(
        'SELECT filename, checksum FROM auth.schema_migrations ORDER BY filename',
      );
      expect(rows.map((row) => row.filename)).toEqual(files.map((file) => file.name));
      // Checksum ghi đúng nội dung file — lệch một byte là drift phải bị bắt ở test khác.
      for (const row of rows) {
        const file = files.find((entry) => entry.name === row.filename);
        expect(row.checksum).toBe(checksumMigration(file?.sql ?? ''));
      }
      // Catalog là nguồn sự thật thứ hai, độc lập với bảng lịch sử: 15 bảng
      // từ migration (`CREATE TABLE auth.*` trong 0001–0013) cộng bảng lịch sử
      // `auth.schema_migrations` do runner tạo.
      expect(result.tablesInAuthSchema).toBe(15 + 1);
    } finally {
      await migrator.end();
    }
  });

  it('re-running applies nothing new: history makes a second run a no-op', async () => {
    const migrator = await connectMigrator();
    try {
      const result = await applyAllMigrations(migrator);
      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(listMigrations().length);
    } finally {
      await migrator.end();
    }
  });

  it('aborts with a drift error when an applied file no longer matches its recorded checksum', async () => {
    // Bản sao migration trong tmp dir — sửa file thật trong repo là đụng tài
    // nguyên dùng chung; `options.migrationsDir` tồn tại đúng cho trường hợp này.
    const tmpDir = mkdtempSync(join(tmpdir(), 'auth-migration-drift-'));
    try {
      for (const name of readdirSync(db.migrationsDir)) {
        copyFileSync(join(db.migrationsDir, name), join(tmpDir, name));
      }
      // "Drift" một file đã áp: thêm một dòng SQL vào file đã có trong lịch sử.
      const drifted = join(tmpDir, '0006_token_revocations.sql');
      writeFileSync(drifted, `${readFileSync(drifted, 'utf8')}\n-- drifted\n`, 'utf8');

      const migrator = await connectMigrator();
      try {
        await expect(applyAllMigrations(migrator, { migrationsDir: tmpDir })).rejects.toThrow(
          /0006_token_revocations\.sql has drifted/u,
        );
      } finally {
        await migrator.end();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('takes the advisory lock keyed to db-auth, distinct from the db-account key', async () => {
    // Khóa là `hashtext('db-auth')` phía server — test giữ chính khóa đó ở
    // session khác; nếu runner dùng key khác thì apply phải CHẠY TRỌN (migrations
    // đã áp rồi nên nó only-skip) và test đỏ vì không ném. Runner lấy đúng key
    // `db-auth` ⇒ apply bị chặn bởi lock, `lock_timeout` ngắn biến chỗ bị chặn
    // thành lỗi đo được thay vì treo suite.
    const holder = await connectSuperuser();
    const runner = await connectMigrator();
    try {
      await holder.query('SELECT pg_advisory_lock(hashtext($1))', [AUTH_DATABASE]);
      // Chứng minh khóa ở pg_locks mang đúng cặp (classid, objid) của
      // `pg_advisory_lock(int4)`: PostgreSQL ghi khóa single-int dưới dạng
      // (2^32-1, hashtext unsigned) — đo được trên postgres:17-alpine, không
      // phải (0, giá trị) như khóa 2-int. Liên kết giữa "key mà runner sẽ
      // lấy" và hàng lock thật trong catalog.
      const { rows: lockShape } = await holder.query<{ classid: string; objid: string }>(
        `SELECT l.classid::text AS classid, l.objid::text AS objid
           FROM pg_locks l
          WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid()`,
      );
      expect(lockShape).toHaveLength(1);
      const { rows: expected } = await holder.query<{ classid: string; objid: string }>(
        `SELECT (((2^32 - 1))::bigint)::text AS classid,
                (CASE WHEN hashtext($1) < 0 THEN (2^32 + hashtext($1))
                      ELSE hashtext($1) END)::text AS objid`,
        [AUTH_DATABASE],
      );
      expect(lockShape[0]?.classid).toBe(expected[0]?.classid);
      expect(lockShape[0]?.objid).toBe(expected[0]?.objid);

      await runner.query(`SET lock_timeout = '500ms'`);
      await expect(applyAllMigrations(runner)).rejects.toThrow(/lock timeout/iu);

      // Khóa đối xứng: `db-account` dùng hashtext('db-account') — hai runner
      // phải KHÔNG tranh khóa của nhau. Giữ khóa db-auth xong, khóa db-account
      // vẫn lấy được từ một session khác.
      const other = await db.connectSuperuser();
      try {
        await other.query('SELECT pg_advisory_lock(hashtext($1))', ['db-account']);
        await other.query('SELECT pg_advisory_unlock(hashtext($1))', ['db-account']);
      } finally {
        await other.end();
      }
    } finally {
      await runner.query('RESET lock_timeout').catch(() => undefined);
      await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [AUTH_DATABASE]);
      await holder.end();
      await runner.end();
    }
  });

  it('leaves schema auth owned by the migrator, so the runner-owned history table is maintainable', async () => {
    // History table do runner tạo (`CREATE SCHEMA ... AUTHORIZATION` +
    // `CREATE TABLE` từ session migrator): chủ sở hữu phải là
    // `ecoma_auth_migrator`, không phải owner hay superuser — đổi lại lần chạy
    // sau của chính runner luôn ghi được lịch sử mà không cần ai cấp quyền.
    const superuser = await connectSuperuser();
    try {
      const { rows } = await superuser.query<{ tableowner: string; schemaname: string }>(
        `SELECT schemaname, tableowner FROM pg_tables
          WHERE schemaname = 'auth' AND tablename = 'schema_migrations'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tableowner).toBe('ecoma_auth_migrator');
    } finally {
      await superuser.end();
    }
  });
});
