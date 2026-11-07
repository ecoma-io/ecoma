/**
 * Apply migration lên PostgreSQL thật và đo trạng thái sau đó.
 *
 * ⚠️ Suite bắt buộc Docker: probe hỏng thì `globalSetup` ném và toàn bộ lần chạy
 * đỏ (fail-loud, 06-testing.md §6) - skip với exit 0 không phải kết quả chấp
 * nhận được.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyAllMigrations } from '../../db/apply.mts';
import { ACCOUNT_DATABASE, AUTH_DATABASE } from '../../db/migrate.mts';
import {
  type AccountDatabase,
  applyMigrations,
  startAccountDatabase,
} from '../integrations/harness.ts';
const EXPECTED_TABLES = [
  'account_outbox_events',
  'account_sessions',
  'email_addresses',
  'internal_nonces',
  'login_handoffs',
  'notification_preferences',
  'otp_challenges',
  'privacy_requests',
  'security_events',
  'user_preferences',
  'user_profiles',
  'users',
];

async function tableNames(db: AccountDatabase): Promise<string[]> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'account' ORDER BY table_name`,
    );
    return rows.map((row) => row.table_name);
  } finally {
    await client.end();
  }
}

describe('db-account migrations on a real PostgreSQL', () => {
  let db: AccountDatabase;

  beforeAll(async () => {
    db = await startAccountDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('applies every migration file from an empty database', async () => {
    expect(await tableNames(db)).toEqual(EXPECTED_TABLES);
  });

  it('is repeatable: re-applying every file changes nothing', async () => {
    // `db-auth` bị xoá rồi tạo lại là cố ý. Đó là tình huống `REVOKE` phải chạy
    // lại: database đích bị xoá và tạo lại sẽ cấp lại `CONNECT` cho `PUBLIC`.
    // Giữ nguyên `db-auth` thì lệnh vẫn chạy nhưng không chứng minh được việc
    // chạy lại là cần thiết — và AC-012 chỉ pass sau lần apply này.
    const client = await db.connect();
    try {
      await client.query(`DROP DATABASE "${AUTH_DATABASE}"`);
      await client.query(`CREATE DATABASE "${AUTH_DATABASE}"`);
      await applyMigrations(client);
      await applyMigrations(client);
    } finally {
      await client.end();
    }

    expect(await tableNames(db)).toEqual(EXPECTED_TABLES);
  });

  it('leaves the runtime role able to do DML and nothing else', async () => {
    const runtime = await db.asRuntime();
    try {
      await runtime.query(`INSERT INTO account.users (sub) VALUES ('sub-migrations-smoke')`);
      const { rows } = await runtime.query<{ sub: string }>(
        `SELECT sub FROM account.users WHERE sub = 'sub-migrations-smoke'`,
      );
      expect(rows).toHaveLength(1);
    } finally {
      await runtime.end();
    }

    const again = await db.asRuntime();
    try {
      await expect(again.query('CREATE TABLE account.nope (id int)')).rejects.toThrow(
        /permission denied/iu,
      );
    } finally {
      await again.end();
    }
  });

  it('sets the ecoma.auth_database GUC that migration 0002 reads', async () => {
    // `0002` đọc tên database cần `REVOKE CONNECT` qua GUC này thay vì hard-code.
    // Bỏ câu `SET` khỏi runner thì guard trong `0002` bỏ qua âm thầm (đọc setting
    // rỗng) và AC-012 pass đúng lúc boundary biến mất — hành vi, không phải cấu
    // trúc catalog, mới bắt được điều đó.
    const client = await db.connect();
    try {
      await applyAllMigrations(client);
      const { rows } = await client.query<{ guc: string | null }>(
        `SELECT current_setting('ecoma.auth_database', true) AS guc`,
      );
      expect(rows[0]?.guc).toBe(AUTH_DATABASE);
    } finally {
      await client.end();
    }
  });

  it('takes the pg advisory lock before applying, so a concurrent runner blocks', async () => {
    // Bỏ `pg_advisory_lock` khỏi runner từng xanh toàn bộ 86 test: hai CI job
    // chạy song song sẽ đụng nhau giữa chừng và một trong hai fail gián đoạn.
    // Test hành vi: giữ lock ở session khác + `lock_timeout` ngắn ⇒ apply phải
    // ném; runner không còn lock thì apply chạy trọn (migrations idempotent)
    // và test đỏ vì không ném gì.
    const holder = await db.connect();
    const runner = await db.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(hashtext($1))', [ACCOUNT_DATABASE]);
      await runner.query(`SET lock_timeout = '500ms'`);
      await expect(applyAllMigrations(runner)).rejects.toThrow(/lock timeout/iu);
    } finally {
      await runner.query(`RESET lock_timeout`).catch(() => undefined);
      await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [ACCOUNT_DATABASE]);
      await holder.end();
      await runner.end();
    }
  });

  it('fails 0002 when the runtime role lost CONNECT on db-account', async () => {
    // Guard trong `0002` phải kiểm `ecoma_account_runtime`, không phải
    // `current_user`: migrator LUÔN có CONNECT (nó vừa kết nối để chạy
    // migration) nên kiểm `current_user` là câu đúng luôn đúng. Mục đích thật
    // là bắt provisioning quên GRANT CONNECT cho role mà Worker dùng.
    //
    // `CONNECT` của runtime đến từ PUBLIC theo mặc định — đúng cái bẫy mà
    // AC-012 ghi cho `db-auth` — nên revoke cả hai, rồi phục hồi đúng hai grant
    // đó trong `finally` để các test khác không đỏ vì tài nguyên bị sửa.
    const client = await db.connect();
    try {
      await client.query(`REVOKE CONNECT ON DATABASE "${ACCOUNT_DATABASE}" FROM PUBLIC`);
      await client.query(
        `REVOKE CONNECT ON DATABASE "${ACCOUNT_DATABASE}" FROM ecoma_account_runtime`,
      );
      await expect(applyAllMigrations(client)).rejects.toThrow(
        /ecoma_account_runtime mat quyen CONNECT/u,
      );
    } finally {
      // `0002` bọc trong `BEGIN;` — khi DO block raise, simple query dừng giữa
      // chừng và để connection ở trạng thái aborted transaction. GRANT tiếp theo
      // vì thế nhận `25P02` thay vì phục hồi grant; ROLLBACK trước rồi mới
      // cấp lại. (`ROLLBACK` không có transaction cũng vô hại — warning, không
      // phải lỗi.)
      await client.query('ROLLBACK').catch(() => undefined);
      await client.query(`GRANT CONNECT ON DATABASE "${ACCOUNT_DATABASE}" TO PUBLIC`);
      await client.query(
        `GRANT CONNECT ON DATABASE "${ACCOUNT_DATABASE}" TO ecoma_account_runtime`,
      );
      await client.end();
    }
  });

  it('marks db:migrate cache false, because DATABASE_URL is not an input', async () => {
    // `nx:run-commands` được cache mặc định; `DATABASE_URL` không nằm trong inputs
    // nào nên lần chạy thứ hai trả kết quả **cached** và KHÔNG migrate database
    // thật — một lần chạy "xanh" không đổi gì. Cross-check đọc nguồn như các hằng
    // giao thức khác: package.json là JSON nên không có chỗ cho comment giải thích.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');

    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8'),
    ) as { nx?: { targets?: Record<string, { cache?: boolean }> } };

    expect(manifest.nx?.targets?.['db:migrate']?.cache).toBe(false);
  });
});
