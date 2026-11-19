import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATION_LOCK_KEY } from '../../runner.mts';
import {
  historyRows,
  recreateContractDatabase,
  startAccountDatabase,
  tableExists,
  type AccountDatabase,
} from './harness.ts';

/**
 * Suite integration của migration runner (§3a.3) — runner THẬT (`runner.mts`)
 * spawn `drizzle-kit migrate` thật trên PostgreSQL thật. Mỗi test bắt đầu từ
 * database hợp đồng trắng (recreate) — ngữ nghĩa "environment chưa từng
 * migrate" của §3a.3 mục D.
 *
 * Các behavior được chứng minh:
 * - apply toàn bộ journal + history đúng số entry;
 * - chạy lần 2 KHÔNG apply lại (journal dùng CREATE TABLE không idempotent —
 *   replay là lỗi, exit 0 là bằng chứng không-replay);
 * - fail giữa batch → rollback toàn bộ lần chạy (kit atomic per-run — hành vi
 *   thật của drizzle-orm 0.45.4, verified thực nghiệm #374 comment 7015719641)
 *   → retry sau đó xanh;
 * - advisory lock: runner khác đang giữ lock là runner bị chặn, không apply;
 * - stamp: ghi history mà KHÔNG thực thi SQL; migrate sau stamp skip đúng;
 * - adopt (cutover #375): stack legacy (schema có bảng, chưa có history
 *   Drizzle) được stamp toàn bộ — migrate sau adopt không replay; stack trắng
 *   và stack đã-cutover là no-op;
 * - guard `current_database()`: sai database là fail closed.
 */

const projectRoot = resolve(import.meta.dirname, '../..');
const runnerPath = join(projectRoot, 'runner.mts');
const okConfigPath = 'tests/integrations/fixtures/ok.config.ts';
const failConfigPath = 'tests/integrations/fixtures/fail.config.ts';

const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');

interface RunnerResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runRunner(
  mode: string,
  configPath: string,
  databaseUrl: string,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [tsxCli, runnerPath, mode, '--config', configPath], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf-8',
    timeout: 120_000,
  });
}

function expectRunnerOk(result: SpawnSyncReturns<string>, context: string): RunnerResult {
  expect(
    result.status,
    `${context}: runner exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
  return result;
}

// Mỗi test spawn runner thật (tsx cold start + resolve drizzle-kit) nhiều lần —
// trên CI runner lạnh mỗi spawn có thể vượt default testTimeout 5s (bằng chứng:
// CI run 44548041423 fail 2 test "timed out in 5000ms" trong khi local xanh).
// Timeout cấp describe 180s khớp biên spawnSync 120s của runner; test lock giữ
// timeout riêng 30s của nó.
describe(
  'migration runner (drizzle-kit migrate under advisory-lock wrapper)',
  { timeout: 180_000 },
  () => {
    let db: AccountDatabase;

    beforeAll(async () => {
      db = await startAccountDatabase();
    });

    afterAll(async () => {
      await db.container.stop({ timeout: 10_000 });
    });

    it('applies the whole journal once and does not replay it on the second run', async () => {
      await recreateContractDatabase(db.adminUrl);

      expectRunnerOk(runRunner('migrate', okConfigPath, db.databaseUrl), 'first migrate');
      expect(await tableExists(db.databaseUrl, 'account', 'demo_items')).toBe(true);
      expect(await historyRows(db.databaseUrl, 'account')).toBe(3);

      // Lần 2: `0000_create_demo_items.sql` dùng CREATE TABLE không idempotent —
      // nếu runner apply lại thì kit lỗi và exit ≠ 0. Exit 0 + history vẫn 2
      // entry là bằng chứng "adopt, không replay" (điều kiện hoàn thành #375).
      expectRunnerOk(runRunner('migrate', okConfigPath, db.databaseUrl), 'second migrate');
      expect(await historyRows(db.databaseUrl, 'account')).toBe(3);
    });

    it('rolls back the whole run when a migration fails midway, then a retry applies everything', async () => {
      await recreateContractDatabase(db.adminUrl);

      const failed = runRunner('migrate', failConfigPath, db.databaseUrl);
      expect(failed.status).not.toBe(0);
      // Kit atomic per-run: entry 0 đã chạy trong transaction cũng bị rollback —
      // không bảng, không history row (bảng history tồn tại nhưng rỗng vì được
      // tạo ngoài transaction).
      expect(await tableExists(db.databaseUrl, 'account', 'fail_probe')).toBe(false);
      expect(await historyRows(db.databaseUrl, 'account')).toBe(0);

      // Retry trên cùng database: lastDbMigration không tồn tại → apply toàn bộ.
      expectRunnerOk(runRunner('migrate', okConfigPath, db.databaseUrl), 'retry after failure');
      expect(await historyRows(db.databaseUrl, 'account')).toBe(3);
    });

    it('blocks while another session holds the advisory lock, then proceeds after release', async () => {
      await recreateContractDatabase(db.adminUrl);

      const holder = new (await import('pg')).Client({ connectionString: db.databaseUrl });
      await holder.connect();
      try {
        await holder.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
        const child = spawn(
          process.execPath,
          [tsxCli, runnerPath, 'migrate', '--config', okConfigPath],
          {
            cwd: projectRoot,
            env: { ...process.env, DATABASE_URL: db.databaseUrl },
            stdio: 'ignore',
          },
        );
        const exited = new Promise<number | null>((done) => {
          child.once('exit', (code) => {
            done(code);
          });
        });

        // 1.5s trong khi lock bị giữ: runner phải vẫn đang chờ — chưa exit,
        // chưa apply gì. Không poll statement cấp thấp hơn vì pg_advisory_lock
        // là block indefinitely theo đúng hợp đồng §3a.3.
        await new Promise((done) => {
          setTimeout(done, 1_500);
        });
        expect(child.exitCode).toBeNull();
        expect(await historyRows(db.databaseUrl, 'account')).toBe(0);

        await holder.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
        expect(await exited).toBe(0);
        expect(await historyRows(db.databaseUrl, 'account')).toBe(3);
      } finally {
        await holder.end();
      }
    }, 30_000);

    it('stamp writes history without executing SQL; a later migrate skips everything', async () => {
      await recreateContractDatabase(db.adminUrl);

      expectRunnerOk(runRunner('stamp', okConfigPath, db.databaseUrl), 'stamp');
      expect(await historyRows(db.databaseUrl, 'account')).toBe(3);
      // Stamp KHÔNG thực thi SQL — điều kiện cutover "không chạm dữ liệu".
      expect(await tableExists(db.databaseUrl, 'account', 'demo_items')).toBe(false);

      // Migrate sau stamp: skip rule của kit là created_at — mọi entry đã được
      // stamp nên không SQL nào chạy, bảng vẫn không tồn tại.
      expectRunnerOk(runRunner('migrate', okConfigPath, db.databaseUrl), 'migrate after stamp');
      expect(await historyRows(db.databaseUrl, 'account')).toBe(3);
      expect(await tableExists(db.databaseUrl, 'account', 'demo_items')).toBe(false);
    });

    it('adopt stamps a legacy migrated stack so migrate does not replay', async () => {
      await recreateContractDatabase(db.adminUrl);

      // Dựng stack LEGACY: schema có bảng user (bằng chứng runner cũ) nhưng
      // chưa hề có history Drizzle — đúng hình một stack đã-migrate-cũ mà
      // chưa cutover. Dùng chính fixture SQL để dựng "migrations đã apply".
      const seeder = new (await import('pg')).Client({ connectionString: db.databaseUrl });
      await seeder.connect();
      try {
        await seeder.query(
          'CREATE SCHEMA IF NOT EXISTS account; CREATE TABLE account.demo_items (id integer PRIMARY KEY, label text NOT NULL);',
        );
      } finally {
        await seeder.end();
      }

      // Adopt: stamp toàn bộ journal, KHÔNG chạy SQL.
      const adopted = expectRunnerOk(runRunner('adopt', okConfigPath, db.databaseUrl), 'adopt');
      expect(adopted.stdout).toContain('stamped from legacy state');
      expect(await historyRows(db.databaseUrl, 'account')).toBe(3);

      // Migrate sau adopt: skip toàn bộ — không replay SQL (điều kiện "history
      // adopt không replay" của #375).
      expectRunnerOk(runRunner('migrate', okConfigPath, db.databaseUrl), 'migrate after adopt');
      expect(await historyRows(db.databaseUrl, 'account')).toBe(3);
    });

    it('adopt no-ops on a fresh database and after the journal is already covered', async () => {
      await recreateContractDatabase(db.adminUrl);

      // Stack trắng: adopt phải no-op — nếu stamp thì migrate đầu tiên sẽ
      // thành no-op và schema không bao giờ tồn tại (bẫy của adopt).
      const fresh = expectRunnerOk(runRunner('adopt', okConfigPath, db.databaseUrl), 'fresh adopt');
      expect(fresh.stdout).toContain('fresh database');
      expect(await historyRows(db.databaseUrl, 'account')).toBe(0);

      // Migrate thật vẫn apply đầy đủ sau adopt no-op.
      expectRunnerOk(runRunner('migrate', okConfigPath, db.databaseUrl), 'migrate');
      expect(await historyRows(db.databaseUrl, 'account')).toBe(3);

      // Stack đã-cutover: adopt lần 2 là no-op.
      const covered = expectRunnerOk(
        runRunner('adopt', okConfigPath, db.databaseUrl),
        'covered adopt',
      );
      expect(covered.stdout).toContain('already covers');
      expect(await historyRows(db.databaseUrl, 'account')).toBe(3);
    });

    it('refuses to run against a database other than the contract one', async () => {
      await recreateContractDatabase(db.adminUrl);

      const wrongDbUrl = db.adminUrl; // trờ vào database 'postgres', không phải db-account
      const result = runRunner('migrate', okConfigPath, wrongDbUrl);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('refusing to touch the wrong database');
    });
  },
);
