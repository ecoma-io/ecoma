import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { maskSecrets } from './audit.ts';
import type { BaselineIdentity, RestoredStateFingerprint } from './contract.ts';

/**
 * Lớp PostgreSQL thật của cơ chế baseline (§3a.6 + `03-operations.md` §3.1):
 * dump/restore **per-database** bằng `pg_dump`/`psql` — `pg_dumpall` là
 * cluster-level (`04` PG1) nên mọi database đều đi đường này, đúng lớp dump
 * theo database mà §3.1 yêu cầu cho `account`/`auth`.
 *
 * Không driver `pg` nào ở đây: mọi truy vấn đi qua binary `psql` (§3.1 —
 * PostgreSQL client kết nối thẳng), và `PgTools` được inject để suite
 * integration bọc `docker exec` quanh binary của chính container (binary
 * luôn khớp phiên bản server container, host không cần cài client).
 */

export interface ExecResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PgTools {
  psql(args: readonly string[], input?: string): ExecResult;
  pgDump(args: readonly string[]): ExecResult;
}

/**
 * Client từ PATH của host — lane CI cung cấp PostgreSQL client (§3.1). Khi
 * `dockerContainer` được chỉ định, mọi lệnh bọc `docker exec -i` trong
 * container đích — cùng kỹ thuật docker-CLI của harness integration; URL
 * kết nối phải đúng góc nhìn nơi binary chạy (trong container là 127.0.0.1).
 */
export function hostPgTools(dockerContainer?: string): PgTools {
  const run = (command: string, args: readonly string[], input?: string): ExecResult => {
    const result =
      dockerContainer === undefined
        ? spawnSync(command, args, { input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
        : spawnSync('docker', ['exec', '-i', dockerContainer, command, ...args], {
            input,
            encoding: 'utf8',
            maxBuffer: 256 * 1024 * 1024,
          });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };
  return {
    psql: (args, input) => run('psql', args, input),
    pgDump: (args) => run('pg_dump', args),
  };
}

/** psql cho DDL/DML fail-closed — sai một câu là dừng, không chạy tiếp ngầm. */
const PSQL_EXEC = ['--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--quiet', '--dbname'] as const;
/** psql đọc giá trị — output tsv thuần, dễ assert, không bảng trang trí. */
const PSQL_VALUE = [
  '--no-psqlrc',
  '--set',
  'ON_ERROR_STOP=1',
  '--tuples-only',
  '--no-align',
  '--dbname',
] as const;

function queryRows(tools: PgTools, url: string, sql: string): readonly string[] {
  const result = tools.psql([...PSQL_VALUE, url, '--command', sql]);
  if (result.status !== 0) {
    throw new Error(
      `psql query failed: ${maskSecrets((result.stderr || result.stdout).slice(-2000))}`,
    );
  }
  return result.stdout.split('\n').filter((line) => line.length > 0);
}

export function pgIdentifier(name: string): string {
  return `"${name.replace(/"/gu, '""')}"`;
}

/** URL database suy từ URL admin — chỉ đổi path, giữ nguyên credential/port. */
export function databaseUrl(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * State history migration đọc bằng SQL — schema-agnostic: tìm
 * `__drizzle_migrations` qua catalog thay vì import drizzle config của
 * project authority (một database có history ở >1 schema là trạng thái hai
 * nguồn sự thật — refuse, không đoán).
 */
export function migrationHistoryState(
  tools: PgTools,
  url: string,
): { readonly historyCount: number; readonly historyMaxWhen: number | null } {
  const schemas = queryRows(
    tools,
    url,
    `select table_schema from information_schema.tables
     where table_name = '__drizzle_migrations' and table_type = 'BASE TABLE'
     order by table_schema`,
  );
  if (schemas.length > 1) {
    throw new Error(
      `ambiguous migration history: __drizzle_migrations exists in ${schemas.length} schemas (${schemas.join(', ')}) — refusing to guess`,
    );
  }
  if (schemas.length === 0) {
    return { historyCount: 0, historyMaxWhen: null };
  }
  const rows = queryRows(
    tools,
    url,
    `select count(*)::text, coalesce(max(created_at)::text, '')
     from ${pgIdentifier(schemas[0] as string)}.__drizzle_migrations`,
  );
  const [count, maxWhen] = (rows[0] ?? '').split('|');
  return {
    historyCount: Number(count ?? '0'),
    historyMaxWhen: maxWhen === undefined || maxWhen === '' ? null : Number(maxWhen),
  };
}

/** Inventory bảng BASE TABLE (trừ catalog) — sorted, deterministic theo SQL. */
export function tableInventory(tools: PgTools, url: string): readonly string[] {
  return queryRows(
    tools,
    url,
    `select table_schema || '.' || table_name from information_schema.tables
     where table_schema not in ('pg_catalog', 'information_schema')
       and table_type = 'BASE TABLE'
     order by 1`,
  );
}

function stateFingerprint(tools: PgTools, url: string): RestoredStateFingerprint {
  const history = migrationHistoryState(tools, url);
  return { ...history, tables: tableInventory(tools, url) };
}

/**
 * Mốc WAL lúc capture (`02-delivery.md` §12 — ghi vào release record).
 * Thông tin provenance của pipeline backup R2, KHÔNG phải điều kiện
 * restorable (điều kiện là integrity check) — role không expose được LSN thì
 * identity ghi `null` thay vì chặn capture một dump đã đọc thành công.
 */
function currentWalLsn(tools: PgTools, url: string): string | null {
  const result = tools.psql([...PSQL_VALUE, url, '--command', 'select pg_current_wal_lsn()::text']);
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

export interface CaptureBaselineInput {
  readonly database: string;
  /** URL admin của instance chứa database nguồn (previous release). */
  readonly sourceUrl: string;
  /** Thư mục output — dump + baseline.json được ghi vào đây. */
  readonly outDir: string;
}

export interface CaptureBaselineResult {
  readonly identity: BaselineIdentity;
  readonly dumpPath: string;
  readonly baselinePath: string;
}

/**
 * Capture baseline per-database: `pg_dump --format=plain --no-owner
 * --no-privileges` (ACL/OWNER bị loại khỏi dump để restore không phụ thuộc
 * role của instance đích), ghi dump + baseline.json. Fail-closed: pg_dump
 * lỗi hoặc dump rỗng là refuse — dump rỗng không phải baseline.
 */
export function captureBaseline(
  tools: PgTools,
  input: CaptureBaselineInput,
): CaptureBaselineResult {
  const dump = tools.pgDump([
    '--format=plain',
    '--no-owner',
    '--no-privileges',
    '--dbname',
    input.sourceUrl,
  ]);
  if (dump.status !== 0) {
    throw new Error(
      `pg_dump failed for ${input.database}: ${maskSecrets(dump.stderr.slice(-2000) || 'no stderr')}`,
    );
  }
  if (dump.stdout.length === 0) {
    throw new Error(
      'pg_dump produced an empty dump — refusing to record a baseline that restores to nothing',
    );
  }

  const dumpContent = dump.stdout;
  mkdirSync(input.outDir, { recursive: true });
  const dumpPath = resolve(input.outDir, `${input.database}.sql`);
  writeFileSync(dumpPath, dumpContent);

  const identity: BaselineIdentity = {
    mechanism: 'pg-dump-per-database',
    database: input.database,
    dumpSha256: createHash('sha256').update(dumpContent).digest('hex'),
    dumpBytes: Buffer.byteLength(dumpContent),
    capturedAt: new Date().toISOString(),
    sourceLsn: currentWalLsn(tools, input.sourceUrl),
    integrity: stateFingerprint(tools, input.sourceUrl),
  };
  const baselinePath = resolve(input.outDir, 'baseline.json');
  writeFileSync(baselinePath, `${JSON.stringify(identity, null, 2)}\n`);
  return { identity, dumpPath, baselinePath };
}

/**
 * Đọc baseline từ artifact (baseline.json + dump file) — fail-closed:
 * JSON sai hình dạng, thiếu trường, hoặc dump file không khớp sha256 đã ghi
 * là refuse trước khi bất kỳ restore nào chạy.
 */
export function loadBaseline(
  baselinePath: string,
  dumpPath: string,
): { readonly identity: BaselineIdentity; readonly dumpContent: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(baselinePath, 'utf-8'));
  } catch (error) {
    throw new Error(`baseline.json is not readable JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const identity = parsed as BaselineIdentity;
  if (
    identity?.mechanism !== 'pg-dump-per-database' ||
    typeof identity.database !== 'string' ||
    typeof identity.dumpSha256 !== 'string' ||
    typeof identity.dumpBytes !== 'number' ||
    typeof identity.integrity?.historyCount !== 'number' ||
    !Array.isArray(identity.integrity?.tables)
  ) {
    throw new Error(`baseline.json is not a pg-dump-per-database identity: ${baselinePath}`);
  }
  const dumpContent = readFileSync(dumpPath, 'utf-8');
  const actualSha = createHash('sha256').update(dumpContent).digest('hex');
  if (actualSha !== identity.dumpSha256) {
    throw new Error(
      `dump file does not match the recorded baseline identity: sha256 ${actualSha} != ${identity.dumpSha256} — refusing to restore an artifact nobody recorded`,
    );
  }
  return { identity, dumpContent };
}

/**
 * Recreate database hợp đồng trên target dùng-đi — state trắng tuyệt đối:
 * restore đè lên database còn dư object của lần chạy trước sẽ để lại object
 * lạ mà fingerprint không kỳ vọng, nên DROP + CREATE là cơ chế sạch duy nhất.
 * ⚠️ DROP xóa ACL cấp database (datacl sống trong pg_database) — caller phải
 * re-grant role migrator sau bước này (xem `grantMigrator`).
 */
export function recreateTargetDatabase(
  tools: PgTools,
  targetAdminUrl: string,
  database: string,
): void {
  const drop = tools.psql([
    ...PSQL_EXEC,
    targetAdminUrl,
    '--command',
    `DROP DATABASE IF EXISTS ${pgIdentifier(database)} WITH (FORCE)`,
  ]);
  if (drop.status !== 0) {
    throw new Error(
      `DROP DATABASE failed on disposable target: ${maskSecrets(drop.stderr.slice(-2000))}`,
    );
  }
  const create = tools.psql([
    ...PSQL_EXEC,
    targetAdminUrl,
    '--command',
    `CREATE DATABASE ${pgIdentifier(database)}`,
  ]);
  if (create.status !== 0) {
    throw new Error(
      `CREATE DATABASE failed on disposable target: ${maskSecrets(create.stderr.slice(-2000))}`,
    );
  }
}

/**
 * Re-grant quyền migrator trên database vừa recreate. Role là cluster-level
 * (slot provisioning #349 tạo nó); grant cấp database bị DROP xóa mất, nên
 * cơ chế tự phục hồi đúng phần nó phá — không đụng tạo/xóa role.
 */
export function grantMigrator(
  tools: PgTools,
  targetAdminUrl: string,
  database: string,
  migratorRole: string,
): void {
  const grant = tools.psql([
    ...PSQL_EXEC,
    targetAdminUrl,
    '--command',
    `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${pgIdentifier(database)} TO ${pgIdentifier(migratorRole)}`,
  ]);
  if (grant.status !== 0) {
    throw new Error(
      `GRANT for migrator role ${migratorRole} failed: ${maskSecrets(grant.stderr.slice(-2000))} — role must exist on the disposable instance (slot provisioning)`,
    );
  }
}

/**
 * Restore dump per-database vào database target — stdin, ON_ERROR_STOP fail-closed.
 * Caller phải đã recreate + grant migrator TRƯỚC khi gọi (restore tự DROP là
 * xoá mất grant vừa cấp). Restore chạy bằng **role migrator** (không admin):
 * dump `--no-owner` không mang ownership nên object trở thành của role chạy
 * restore — trên nguồn mọi object thuộc migrator (runner luôn migrate bằng
 * role đó), restore bằng migrator tái lập đúng ownership đó và candidate
 * migration (kit `select` từ history trong schema) chạy không cần vá ACL
 * schema nào.
 */
export function restoreBaseline(
  tools: PgTools,
  input: { readonly migratorUrl: string; readonly dumpContent: string },
): void {
  const result = tools.psql([...PSQL_EXEC, input.migratorUrl], input.dumpContent);
  if (result.status !== 0) {
    throw new Error(`restore failed: ${maskSecrets(result.stderr.slice(-2000))}`);
  }
}

export interface IntegrityResult {
  readonly ok: boolean;
  readonly mismatches: readonly string[];
}

/**
 * Integrity check §3a.6 — so state sau restore với fingerprint ghi lúc
 * capture. Lệch history (count/max) hay inventory bảng là corrupted restore:
 * "restore xong không lỗi" không đủ, state phải GIỐNG baseline đã ghi.
 */
export function verifyRestoredIntegrity(
  tools: PgTools,
  input: { readonly databaseUrl: string; readonly expected: RestoredStateFingerprint },
): IntegrityResult {
  const actual = stateFingerprint(tools, input.databaseUrl);
  const mismatches: string[] = [];
  if (actual.historyCount !== input.expected.historyCount) {
    mismatches.push(
      `history count ${actual.historyCount} != recorded ${input.expected.historyCount}`,
    );
  }
  if (actual.historyMaxWhen !== input.expected.historyMaxWhen) {
    mismatches.push(
      `history max(created_at) ${JSON.stringify(actual.historyMaxWhen)} != recorded ${JSON.stringify(input.expected.historyMaxWhen)}`,
    );
  }
  const expectedTables = input.expected.tables.join('\n');
  const actualTables = actual.tables.join('\n');
  if (expectedTables !== actualTables) {
    mismatches.push('table inventory differs from the recorded baseline');
  }
  return { ok: mismatches.length === 0, mismatches };
}
