import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import {
  migrationsProjectPath,
  resolveCandidateIdentity,
  resolveDatabase,
  unresolvedBlockers,
  WORKSPACE_ROOT,
  type BaselineIdentity,
  type CandidateIdentity,
  type PgDatabaseContract,
} from './contract.ts';
import { buildValidationEvidence, maskSecrets } from './audit.ts';
import {
  captureBaseline,
  databaseUrl,
  grantMigrator,
  hostPgTools,
  loadBaseline,
  migrationHistoryState,
  recreateTargetDatabase,
  restoreBaseline,
  verifyRestoredIntegrity,
  type PgTools,
} from './pg.ts';
import { runValidation, type ValidationDeps } from './runner.ts';

/**
 * CLI của cơ chế baseline Release Validation (§3a.6, #379) — chạy
 * `node tools/release-validation/src/cli.ts <subcommand> ...` từ repo root.
 * Mọi đường sai luật đều exit 2 (refuse) trước khi chạm database; run chạy
 * thật exit 0 (passed) hoặc 1 (failed); evidence JSON in ra stdout cho
 * workflow caller lưu lại theo mẫu §7.4.1.
 *
 * Subcommands:
 * - `capture` — dump per-database từ instance chứa previous release + ghi
 *   baseline.json (baseline identity versioned per database).
 * - `validate` — restore baseline vào target DÙNG-ĐI (bắt buộc
 *   `--confirm-disposable-target`: mechanism DROP database hợp đồng trên
 *   target), integrity check, rồi apply candidate migrations từ
 *   baseline-verified qua migration authority thật (`databases/<slug>-db`
 *   runner — không runner thứ hai). Không có `--baseline` = first-release
 *   fresh-install path.
 */

const USAGE = `usage: node tools/release-validation/src/cli.ts <capture|validate> [flags]

capture
  --database <name>          logical database in the 02-delivery.md 3a.1 inventory
  --source-url <url>         admin URL of the instance holding the previous release
  --out <dir>                output directory for the dump and baseline.json

validate
  --database <name>          logical database in the 02-delivery.md 3a.1 inventory
  --target-url <url>         admin URL of the DISPOSABLE validation instance
  --migrator-url <url>       DATABASE_URL (role _migrator) of the contract database —
                             used for the restore and the candidate runner
  --migrator-url-docker <u>  the same migrator URL seen from INSIDE the --docker
                             container (restore psql runs there); required with
                             --docker --baseline
  --migrator-role <name>     role to re-grant on the recreated contract database
  --commit-sha <sha>         candidate commit SHA (or --manifest)
  --candidate-version <v>    candidate version (or --manifest)
  --manifest <path>          release manifest JSON (sha|commit + version)
  --baseline <dir>           baseline directory (dump + baseline.json); absent = first release
  --migrations-config <p>    drizzle config for the authority runner (default drizzle.config.ts)
  --confirm-disposable-target  required consent: the target contract database WILL BE DROPPED
  --docker <container>       run psql/pg_dump inside this container via docker exec`;

/**
 * Timeout spawn runner migration candidate (ms) — statement_timeout mặc định
 * 5 phút (§3a.5), nên run cần lớn hơn đáng kể để chứa cả cold start tsx/kit.
 */
export const VALIDATION_MIGRATION_TIMEOUT_MS = 600_000;

const SUBCOMMANDS = ['capture', 'validate'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const VALUE_FLAGS = new Set([
  '--database',
  '--source-url',
  '--out',
  '--target-url',
  '--migrator-url',
  '--migrator-url-docker',
  '--migrator-role',
  '--commit-sha',
  '--candidate-version',
  '--manifest',
  '--baseline',
  '--migrations-config',
  '--docker',
]);
const BOOLEAN_FLAGS = new Set(['--confirm-disposable-target']);

export interface CliArgs {
  readonly subcommand: Subcommand;
  readonly flags: ReadonlyMap<string, string | boolean>;
}

/** Strict parse: subcommand bắt buộc, flag lạ/trùng/thiếu value đều refuse. */
export function parseArgs(args: readonly string[]): CliArgs {
  const [subcommand] = args;
  if (subcommand === undefined || !(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    throw new Error(USAGE);
  }
  const flags = new Map<string, string | boolean>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i] as string;
    if (VALUE_FLAGS.has(flag)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${flag} requires a value`);
      }
      if (flags.has(flag)) {
        throw new Error(`${flag} given more than once — refusing to guess which one counts`);
      }
      flags.set(flag, value);
      i++;
      continue;
    }
    if (BOOLEAN_FLAGS.has(flag)) {
      flags.set(flag, true);
      continue;
    }
    throw new Error(`unknown argument: ${flag}\n${USAGE}`);
  }
  return { subcommand: subcommand as Subcommand, flags };
}

function requireFlags(
  flags: ReadonlyMap<string, string | boolean>,
  names: readonly string[],
): void {
  const missing = names.filter((name) => flags.get(name) === undefined);
  if (missing.length > 0) {
    throw new Error(`missing required flags: ${missing.join(', ')}\n${USAGE}`);
  }
}

function stringFlag(flags: ReadonlyMap<string, string | boolean>, name: string): string {
  return flags.get(name) as string;
}

/**
 * Spawn migration authority runner thật (`databases/<slug>-db/runner.mts
 * migrate`) qua tsx — cùng lệnh target `db-migrate` của project đó (advisory
 * lock + guard `current_database()` + kit atomic per-run, §3a.3/§3a.5).
 */
function spawnCandidateRunner(
  projectPath: string,
  migrationsConfig: string,
  migratorUrl: string,
): { readonly status: number; readonly output: string } {
  const require = createRequire(resolve(WORKSPACE_ROOT, 'package.json'));
  const tsxCli = require.resolve('tsx/cli');
  const result = spawnSync(
    process.execPath,
    [
      tsxCli,
      '--tsconfig',
      'tsconfig.db.json',
      'runner.mts',
      'migrate',
      '--config',
      migrationsConfig,
    ],
    {
      cwd: projectPath,
      env: { ...process.env, DATABASE_URL: migratorUrl },
      encoding: 'utf8',
      timeout: VALIDATION_MIGRATION_TIMEOUT_MS,
    },
  );
  return {
    status: result.status ?? 1,
    output: maskSecrets(`${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(-2000)),
  };
}

export function main(argv: readonly string[]): number {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  const { subcommand, flags } = args;
  const dockerContainer = flags.get('--docker') as string | undefined;

  try {
    if (subcommand === 'capture') {
      requireFlags(flags, ['--database', '--source-url', '--out']);
      const database = resolveDatabase(stringFlag(flags, '--database'));
      const result = captureBaseline(hostPgTools(dockerContainer), {
        database: database.database,
        sourceUrl: stringFlag(flags, '--source-url'),
        outDir: stringFlag(flags, '--out'),
      });
      process.stdout.write(
        `${JSON.stringify({ status: 'passed', baseline: result.identity, dumpPath: result.dumpPath }, null, 2)}\n`,
      );
      return 0;
    }

    requireFlags(flags, [
      '--database',
      '--target-url',
      '--migrator-url',
      '--migrator-role',
      '--confirm-disposable-target',
    ]);
    const database = resolveDatabase(stringFlag(flags, '--database'));

    // Fail-closed pre-flight: authority project phải tồn tại trên cây trước
    // khi chạm target — thiếu là refuse, không "chạy thử".
    const blockers = unresolvedBlockers(database);
    if (blockers.length > 0) {
      process.stderr.write(
        `release-validation is blocked by ${blockers.length} unresolved blocker(s):\n`,
      );
      for (const blocker of blockers) process.stderr.write(`  - ${blocker}\n`);
      return 2;
    }

    const manifestPath = flags.get('--manifest');
    const candidate: CandidateIdentity = resolveCandidateIdentity({
      commitSha: flags.get('--commit-sha') as string | undefined,
      version: flags.get('--candidate-version') as string | undefined,
      manifest:
        manifestPath === undefined
          ? undefined
          : JSON.parse(readFileSync(manifestPath as string, 'utf-8')),
    });

    const baselineDir = flags.get('--baseline');
    let baseline: BaselineIdentity | null = null;
    let dumpContent: string | undefined;
    if (baselineDir !== undefined) {
      const dir = baselineDir as string;
      const loaded = loadBaseline(
        resolve(dir, 'baseline.json'),
        resolve(dir, `${database.database}.sql`),
      );
      if (loaded.identity.database !== database.database) {
        throw new Error(
          `baseline identity is for ${loaded.identity.database}, not ${database.database} — refusing a cross-database baseline`,
        );
      }
      baseline = loaded.identity;
      dumpContent = loaded.dumpContent;
    }

    const tools = hostPgTools(dockerContainer);
    const targetUrl = stringFlag(flags, '--target-url');
    const migratorUrl = stringFlag(flags, '--migrator-url');
    const migratorRole = stringFlag(flags, '--migrator-role');
    const contractDbUrl = databaseUrl(targetUrl, database.database);
    // Restore + runner đều đi qua migrator URL — URL trỏ sai database là dump
    // được áp vào database sai trên target; refuse trước khi chạm dữ liệu.
    for (const [flag, url] of [
      ['--migrator-url', migratorUrl],
      ['--migrator-url-docker', flags.get('--migrator-url-docker') as string | undefined],
    ] as const) {
      if (url !== undefined && new URL(url).pathname.slice(1) !== database.database) {
        throw new Error(
          `${flag} must point at the contract database ${database.database} — got ${maskSecrets(url)}`,
        );
      }
    }
    // Với --docker, restore psql chạy TRONG container — host-mapped URL của
    // runner không tồn tại từ góc nhìn đó; bắt buộc nêu rõ URL nội tại thay
    // vì đoán port (refuse, không "chạy thử" rồi connection refused).
    const restoreMigratorUrl =
      (flags.get('--migrator-url-docker') as string | undefined) ?? migratorUrl;
    if (dockerContainer !== undefined && baseline !== null && restoreMigratorUrl === migratorUrl) {
      throw new Error(
        '--migrator-url-docker is required when --docker and --baseline are combined: the restore psql runs inside the container where the host-mapped migrator URL is unreachable',
      );
    }

    const deps = buildValidationDeps({
      tools,
      database,
      targetUrl,
      contractDbUrl,
      migratorUrl,
      restoreMigratorUrl,
      migratorRole,
      baseline,
      dumpContent,
      migrationsConfig:
        (flags.get('--migrations-config') as string | undefined) ?? 'drizzle.config.ts',
    });

    const outcome = runValidation({ database: database.database, candidate, baseline }, deps);
    const evidence = buildValidationEvidence(
      `pg-baseline-${new Date().toISOString()}`,
      { database: database.database, candidate, baseline },
      outcome,
    );
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    return outcome.status === 'passed' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${maskSecrets((error as Error).message)}\n`);
    return 2;
  }
}

interface DepsInput {
  readonly tools: PgTools;
  readonly database: PgDatabaseContract;
  readonly targetUrl: string;
  readonly contractDbUrl: string;
  readonly migratorUrl: string;
  /** URL migrator đúng góc nhìn nơi restore psql chạy (khác host view khi --docker). */
  readonly restoreMigratorUrl: string;
  readonly migratorRole: string;
  readonly baseline: BaselineIdentity | null;
  readonly dumpContent: string | undefined;
  readonly migrationsConfig: string;
}

/** Nối pg.ts + spawn runner vào stage machine — mọi lỗi stage đều thành result, không ném ra ngoài. */
function buildValidationDeps(input: DepsInput): ValidationDeps {
  return {
    installTarget: (_name, baselineId) => {
      try {
        // recreate do mechanism sở hữu (state trắng tuyệt đối — restore đè
        // database còn dư object của lần chạy trước sẽ để lại object lạ mà
        // fingerprint không kỳ vọng); DROP xóa ACL cấp database nên grant
        // lại cho role migrator — role vẫn thuộc slot provisioning.
        recreateTargetDatabase(input.tools, input.targetUrl, input.database.database);
        grantMigrator(input.tools, input.targetUrl, input.database.database, input.migratorRole);
        if (baselineId !== null) {
          restoreBaseline(input.tools, {
            // Restore bằng role migrator — dump --no-owner gán ownership cho
            // role chạy restore, và migrator là chủ đúng như trên nguồn.
            migratorUrl: input.restoreMigratorUrl,
            // dumpContent luôn định nghĩa khi baseline khác null (loadBaseline ở main).
            dumpContent: input.dumpContent as string,
          });
        }
        return {
          ok: true,
          detail:
            baselineId === null
              ? 'fresh-install: created empty contract database'
              : `restored baseline dump ${baselineId.dumpSha256.slice(0, 12)} (${baselineId.dumpBytes} bytes)`,
        };
      } catch (error) {
        return { ok: false, detail: maskSecrets((error as Error).message) };
      }
    },
    verifyIntegrity: (_name, baselineId) => {
      try {
        const result = verifyRestoredIntegrity(input.tools, {
          databaseUrl: input.contractDbUrl,
          expected: baselineId.integrity,
        });
        return result.ok
          ? {
              ok: true,
              detail:
                'integrity check passed: history + table inventory match the recorded baseline',
            }
          : { ok: false, detail: `integrity check failed: ${result.mismatches.join('; ')}` };
      } catch (error) {
        return { ok: false, detail: maskSecrets((error as Error).message) };
      }
    },
    runCandidateMigration: (_name) => {
      const runner = spawnCandidateRunner(
        migrationsProjectPath(input.database),
        input.migrationsConfig,
        input.migratorUrl,
      );
      // History đọc được cả sau migration lỗi (transaction đã rollback) —
      // thành `historyAfter` của evidence; lỗi đọc thì null, không che exit.
      let historyAfter: number | null;
      try {
        historyAfter = migrationHistoryState(input.tools, input.contractDbUrl).historyCount;
      } catch {
        historyAfter = null;
      }
      return {
        exit: runner.status,
        detail: `candidate migration runner exited ${runner.status}${runner.output === '' ? '' : `: ${runner.output}`}`,
        historyAfter,
      };
    },
  };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  process.exit(main(process.argv.slice(2)));
}
