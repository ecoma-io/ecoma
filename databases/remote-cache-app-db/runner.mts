import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

import { Client } from 'pg';

/**
 * Migration runner của `databases/remote-cache-app-db` — wrapper §3a.3 quanh
 * `drizzle-kit migrate`.
 *
 * Trách nhiệm của wrapper (kit không làm bất kỳ việc nào trong số này — đã
 * verified trên bundle 0.31.11: không call site `pg_advisory*`):
 * 1. guard `current_database()` TRƯỚC khi chạm DDL — sai database là fail
 *    closed ngay lập tức;
 * 2. giữ advisory lock `pg_advisory_lock(hashtext('db-remote-cache-app'))` trên
 *    một kết nối thẳng sống suốt lần migrate — hai runner song song trên cùng
 *    database là trạng thái serialization bị cấm (02 §3.1, 04 HD6);
 * 3. chặn statement_timeout mặc định cho cả kết nối lock lẫn kết nối của kit
 *    (§3a.5 — injecting `-c statement_timeout` vào `DATABASE_URL` của child);
 * 4. chế độ `stamp` cho cutover 2 bước (§3a.3 mục D): ghi history mà KHÔNG
 *    thực thi SQL.
 *
 * Hành vi `drizzle-kit migrate` thật (drizzle-orm 0.45.4 `PgDialect.migrate`):
 * một transaction duy nhất cho toàn bộ pending set của lần chạy — fail giữa
 * chừng rollback toàn bộ, retry chỉ apply phần chưa ghi history. Checkpoint
 * là per-run, không per-file. ĐÃ VERIFIED THỰC NGHIỆM 2026-11-19 (kit
 * 0.31.11 + PostgreSQL 17: E1–E6 — bằng chứng #374 comment 7015719641);
 * hợp đồng §3a.3/§3a.5 đã sửa theo cùng bằng chứng — không còn divergence.
 *
 * Chạy: `npx tsx --tsconfig tsconfig.db.json runner.mts [migrate|stamp]
 * [--config <path>]`. Cần `DATABASE_URL` của role `_migrator`.
 */

/** Tên database hợp đồng — hằng, không suy từ URL (guard fail closed). */
const EXPECTED_DATABASE = 'db-remote-cache-app';

/**
 * `hashtext('db-remote-cache-app')` trên PostgreSQL 17 (đo thật trên
 * `postgres:17-alpine`). Giữ nguyên khóa của runner cũ
 * `apps/remote-cache-app/db/apply.mts` — runner cũ tính `hashtext` phía server trên
 * chính tên database này, nên giá trị trùng khớp là điều kiện "một database
 * một lock identity, không đổi khóa khi cutover".
 */
export const MIGRATION_LOCK_KEY = 70_504_270n;

/** §3a.5 — statement_timeout mặc định của migration execution. */
export const STATEMENT_TIMEOUT_MS = 300_000;

const HISTORY_TABLE_DEFAULT = '__drizzle_migrations';

export type RunnerMode = 'migrate' | 'stamp';

export interface RunnerArgs {
  mode: RunnerMode;
  configPath: string;
}

export function parseArgs(argv: readonly string[]): RunnerArgs {
  let mode: RunnerMode = 'migrate';
  let configPath = 'drizzle.config.ts';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === 'migrate' || argv[i] === 'stamp') {
      mode = argv[i] as RunnerMode;
      continue;
    }
    if (argv[i] === '--config') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error('--config requires a path argument');
      }
      configPath = value;
      i++;
      continue;
    }
    throw new Error(`unknown argument: ${String(argv[i])}`);
  }
  return { mode, configPath };
}

/**
 * Gắn `-c statement_timeout=<ms>` vào URL kết nối cho child process của kit —
 * node-postgres nhận `options` từ query string của connection string. Nếu URL
 * đã có `options`, nối thêm thay vì ghi đè.
 */
export function withStatementTimeout(databaseUrl: string, timeoutMs: number): string {
  const url = new URL(databaseUrl);
  const directive = `-c statement_timeout=${timeoutMs}`;
  const existing = url.searchParams.get('options');
  url.searchParams.set('options', existing === null ? directive : `${existing} ${directive}`);
  return url.toString();
}

export interface JournalEntry {
  tag: string;
  when: number;
}

/**
 * Đọc journal theo layout phẳng của kit: `<out>/meta/_journal.json`, mỗi entry
 * có `tag` + `when`. Journal thiếu file hoặc entry thiếu field là fail closed —
 * stamp/migrate lên lịch theo journal nên dữ liệu sai không được đi tiếp.
 */
export function readJournalEntries(
  workspaceRoot: string,
  migrationsFolder: string,
): JournalEntry[] {
  const journalPath = resolve(workspaceRoot, migrationsFolder, 'meta', '_journal.json');
  if (!existsSync(journalPath)) {
    throw new Error(`migration journal not found: ${journalPath}`);
  }
  const journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as {
    entries?: Array<{ tag?: unknown; when?: unknown }>;
  };
  if (!Array.isArray(journal.entries)) {
    throw new Error(`migration journal has no entries array: ${journalPath}`);
  }
  return journal.entries.map((entry) => {
    if (typeof entry.tag !== 'string' || typeof entry.when !== 'number') {
      throw new Error(`migration journal entry missing tag or when: ${JSON.stringify(entry)}`);
    }
    return { tag: entry.tag, when: entry.when };
  });
}

export function pgIdentifier(name: string): string {
  return `"${name.replace(/"/gu, '""')}"`;
}

/**
 * Hình config mà runner đọc — cùng file `--config` mà kit nhận, nên mọi giá trị
 * (out, history table/schema) luôn khớp giữa kit và wrapper. Load động lúc
 * runtime qua tsx (không static import) để `--config` của test fixture có hiệu
 * lực trên TOÀN BỘ runner, không chỉ child kit.
 */
interface KitConfig {
  out?: string;
  migrations?: {
    table?: string;
    schema?: string;
  };
}

async function loadConfig(workspaceRoot: string, configPath: string): Promise<KitConfig> {
  const configUrl = pathToFileURL(resolve(workspaceRoot, configPath)).href;
  const module = (await import(configUrl)) as { default?: KitConfig };
  if (!module.default) {
    throw new Error(`config file has no default export: ${configPath}`);
  }
  return module.default;
}

/** DDL history khớp từng byte ngữ nghĩa với `PgDialect.migrate` của orm. */
function ensureHistoryTableSql(historySchema: string, historyTable: string): string[] {
  return [
    `CREATE SCHEMA IF NOT EXISTS ${pgIdentifier(historySchema)}`,
    `CREATE TABLE IF NOT EXISTS ${pgIdentifier(historySchema)}.${pgIdentifier(historyTable)} (
	id SERIAL PRIMARY KEY,
	hash text NOT NULL,
	created_at bigint
)`,
  ];
}

async function connectAndGuard(databaseUrl: string): Promise<Client> {
  const client = new Client({
    connectionString: databaseUrl,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });
  await client.connect();
  const { rows } = await client.query<{ current_database: string }>('select current_database()');
  const actual = rows[0]?.current_database;
  if (actual !== EXPECTED_DATABASE) {
    await client.end();
    throw new Error(
      `current_database() is '${actual}' but this runner owns '${EXPECTED_DATABASE}' — refusing to touch the wrong database`,
    );
  }
  return client;
}

/** Chế độ `stamp` (§3a.3 mục D bước 1): ghi history, KHÔNG thực thi SQL. */
async function stamp(
  client: Client,
  cfg: KitConfig,
  workspaceRoot: string,
  migrationsFolder: string,
): Promise<number> {
  const historySchema = cfg.migrations?.schema;
  if (!historySchema) {
    throw new Error(
      'drizzle config must set migrations.schema explicitly (no public/drizzle fallback per contract 02-delivery.md 3a.3)',
    );
  }
  const historyTable = cfg.migrations?.table ?? HISTORY_TABLE_DEFAULT;
  for (const sql of ensureHistoryTableSql(historySchema, historyTable)) {
    await client.query(sql);
  }
  const entries = readJournalEntries(workspaceRoot, migrationsFolder);
  const { rows } = await client.query<{ max: string | null }>(
    `select max(created_at)::text as max from ${pgIdentifier(historySchema)}.${pgIdentifier(historyTable)}`,
  );
  const stampedUpTo = rows[0]?.max === null ? -1 : Number(rows[0]?.max);
  let inserted = 0;
  for (const entry of entries) {
    if (entry.when <= stampedUpTo) continue;
    const sqlPath = resolve(workspaceRoot, migrationsFolder, `${entry.tag}.sql`);
    const hash = createHash('sha256').update(readFileSync(sqlPath, 'utf-8')).digest('hex');
    await client.query(
      `insert into ${pgIdentifier(historySchema)}.${pgIdentifier(historyTable)} ("hash", "created_at") values ($1, $2)`,
      [hash, entry.when],
    );
    inserted++;
  }
  return inserted;
}

/** Chờ child `drizzle-kit migrate` xong, giữ connection lock sống suốt. */
function runKitMigrate(workspaceRoot: string, configPath: string): Promise<number> {
  const require = createRequire(join(workspaceRoot, 'package.json'));
  // exports của drizzle-kit không expose './package.json' — resolve entry
  // point rồi đọc package.json bằng fs.
  const kitEntryPoint = require.resolve('drizzle-kit');
  const kitRoot = dirname(kitEntryPoint);
  const kitPackageJson = JSON.parse(readFileSync(join(kitRoot, 'package.json'), 'utf-8')) as {
    bin: string | Record<string, string>;
  };
  const binPath =
    typeof kitPackageJson.bin === 'string' ? kitPackageJson.bin : kitPackageJson.bin['drizzle-kit'];
  if (!binPath) throw new Error('cannot locate drizzle-kit CLI binary in package.json');
  const kitBin = join(kitRoot, binPath);
  const child = spawn(
    process.execPath,
    [kitBin, 'migrate', `--config=${resolve(workspaceRoot, configPath)}`],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        DATABASE_URL: withStatementTimeout(
          process.env.DATABASE_URL as string,
          STATEMENT_TIMEOUT_MS,
        ),
      },
      stdio: 'inherit',
    },
  );
  return new Promise((exitCode, onError) => {
    child.once('error', onError);
    child.once('exit', (code) => exitCode(code ?? 1));
  });
}

async function main(): Promise<void> {
  const { mode, configPath } = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is required (role _migrator per CI job contract 02-delivery.md 3.1)',
    );
  }
  const workspaceRoot = process.cwd();
  const cfg = await loadConfig(workspaceRoot, configPath);
  const migrationsFolder = typeof cfg.out === 'string' ? cfg.out : 'drizzle';
  const historySchema = cfg.migrations?.schema;
  const historyTable = cfg.migrations?.table ?? HISTORY_TABLE_DEFAULT;

  const client = await connectAndGuard(databaseUrl);
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    if (mode === 'stamp') {
      const inserted = await stamp(client, cfg, workspaceRoot, migrationsFolder);
      console.log(
        `stamp complete: ${inserted} journal entr${inserted === 1 ? 'y' : 'ies'} written to history, no SQL executed`,
      );
      return;
    }
    const exitCode = await runKitMigrate(workspaceRoot, configPath);
    if (exitCode !== 0) {
      throw new Error(`drizzle-kit migrate exited with code ${exitCode}`);
    }
    // Post-verify: history phải phủ entry mới nhất của journal — kit atomic
    // per-run nên vượt qua nghĩa là mọi entry pending đã ghi history.
    const entries = readJournalEntries(workspaceRoot, migrationsFolder);
    const lastWhen = entries.at(-1)?.when;
    if (lastWhen !== undefined) {
      // Fallback 'drizzle' khớp default của orm khi config thiếu migrations.schema.
      const resolvedSchema = historySchema ?? 'drizzle';
      const { rows } = await client.query<{ max: string | null }>(
        `select max(created_at)::text as max from ${pgIdentifier(resolvedSchema)}.${pgIdentifier(historyTable)}`,
      );
      const stampedUpTo = rows[0]?.max === null ? -1 : Number(rows[0]?.max);
      if (stampedUpTo < lastWhen) {
        throw new Error(
          `history max(created_at)=${stampedUpTo} is older than last journal entry when=${lastWhen}`,
        );
      }
    }
    console.log('migrate complete: history covers every journal entry');
  } finally {
    await client
      .query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

// Chỉ tự chạy khi được thực thi trực tiếp (tsx runner.mts ...); khi được
// import vào spec unit, module chỉ export hàm thuần — không chạm env/database.
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
