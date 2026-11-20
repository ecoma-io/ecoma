/**
 * Kiểm chứng đường apply migration D1 `push` bằng **đúng công cụ production**
 * (`wrangler d1 migrations apply` — CLI, tiến trình riêng) theo hợp đồng
 * `docs/architecture/02-delivery.md` §3a.4 (cutover #382).
 *
 * ⚠️ Vì sao suite này tồn tại khi `d1-harness.ts` đã nạp schema: harness replay
 * statement qua `getPlatformProxy` để kiểm repository — nó KHÔNG đi qua đường
 * apply thật, không ghi bảng ledger `d1_migrations`, và không chứng minh
 * semantics apply/no-op của hợp đồng. Hai khẳng định dưới đây là bằng chứng
 * cutover: (1) apply từ database trắng ghi ĐỦ file vào `d1_migrations`
 * (adopt-no-replay là hệ quả của ledger), (2) chạy lần hai không áp lại file
 * nào (checkpoint per-file, retry an toàn — §3a.4).
 *
 * Không thêm dependency: `wrangler` là devDependency ở root, spawn qua
 * `createRequire` (tiền lệ `apps/transactional-mailer-job` cùng hình thức).
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_TIMEOUT = 120_000;

// Suite nằm ở `tests/integrations/`, hai cấp dưới root app — đi lên hai cấp mới ra appDir.
const appDir = dirname(dirname(import.meta.dirname));
const migrationsDir = join(appDir, 'migrations');
const req = createRequire(import.meta.url);
const wranglerCli = req.resolve('wrangler');

let stateDir: string;

type D1JsonOutput =
  | { results: Record<string, unknown>[]; success: boolean }[]
  | {
      error: { text: string };
    };

function runWrangler(args: string[]): string {
  return execFileSync(
    process.execPath,
    [
      wranglerCli,
      ...args,
      '--local',
      '--config',
      join(appDir, 'wrangler.jsonc'),
      '--persist-to',
      stateDir,
    ],
    {
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
}

function applyMigrations(): string {
  return runWrangler(['d1', 'migrations', 'apply', 'push']);
}

function query(sql: string): Record<string, unknown>[] {
  const raw = runWrangler(['d1', 'execute', 'push', '--json', '--command', sql]);
  const parsed = JSON.parse(raw.trim() || '[]') as D1JsonOutput;
  if (!Array.isArray(parsed)) {
    throw new Error(`d1 execute unexpected output: ${JSON.stringify(parsed)}`);
  }
  return parsed[0]?.results ?? [];
}

function ledgerNames(): string[] {
  return query(`SELECT name FROM d1_migrations ORDER BY name;`).map((row) => String(row['name']));
}

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'push-d1-apply-'));
  try {
    applyMigrations();
  } catch (error) {
    const detail = String(
      (error as { stdout?: string }).stdout ?? (error as { stderr?: string }).stderr ?? error,
    );
    throw new Error(`d1 migrations apply failed: ${detail}`, { cause: error });
  }
}, TEST_TIMEOUT * 2);

afterAll(() => {
  if (stateDir) {
    rmSync(stateDir, { force: true, recursive: true });
  }
});

describe('push D1 migrations via the production CLI apply path', () => {
  it(
    'applies every migration file from an empty database and records them in the ledger',
    () => {
      const expectedFiles = readdirSync(migrationsDir)
        .filter((name) => name.endsWith('.sql'))
        .toSorted();
      expect(expectedFiles.length).toBeGreaterThan(0);
      expect(ledgerNames()).toEqual(expectedFiles);
    },
    TEST_TIMEOUT,
  );

  it(
    'is idempotent: re-applying does not apply any file again',
    () => {
      const ledgerCountBefore = query(`SELECT count(*) AS n FROM d1_migrations;`)[0]?.['n'];
      const secondOutput = applyMigrations();
      expect(secondOutput).toContain('No migrations to apply');
      const ledgerCountAfter = query(`SELECT count(*) AS n FROM d1_migrations;`)[0]?.['n'];
      expect(ledgerCountAfter).toBe(ledgerCountBefore);
    },
    TEST_TIMEOUT,
  );
});
