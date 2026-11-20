import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BaselineIdentity } from '../../src/contract.ts';
import { migrationHistoryState, tableInventory } from '../../src/pg.ts';
import type { ValidationEvidence } from '../../src/audit.ts';
import {
  applyFixtureMigrations,
  CONTRACT_DATABASE,
  MIGRATOR_ROLE,
  prepareAuthority,
  startPostgres,
  type PgContainer,
} from './harness.ts';

/**
 * Suite integration của cơ chế baseline (§3a.6, #379) — chạy **CLI thật**
 * (`src/cli.ts`) trên hai container PostgreSQL thật qua docker CLI:
 * - source: instance chứa "previous release" (journal fixture baseline
 *   áp bằng runner thật của `deploys/remote-cache-db`);
 * - target: disposable validation instance mà mechanism recreate/restore.
 *
 * Các behavior được chứng minh:
 * - capture ghi dump per-database + baseline identity fingerprint đúng state;
 * - validate restore baseline vào target + integrity check + candidate
 *   migration chạy TIẾN từ baseline-verified (kit chỉ áp entry mới);
 * - corrupted restore (state lệch fingerprint) → integrity check fail closed,
 *   migration không chạy;
 * - dump hỏng → restore fail closed, không stage nào chạy tiếp;
 * - interrupted migration (kill -9 giữa pg_sleep) → state = baseline đã
 *   restore (rollback của kit, §3a.5), retry hoàn tất;
 * - first-release → fresh-install path trên database trống, evidence gắn
 *   candidate identity như thường.
 */

const projectRoot = resolve(import.meta.dirname, '../..');
const cliPath = join(projectRoot, 'src', 'cli.ts');
const fixturesDir = join(import.meta.dirname, 'fixtures');
const outRoot = join(projectRoot, 'test-output', 'integration');

/** SHA/version giả của candidate — chỉ để gắn danh tính vào evidence. */
const CANDIDATE_SHA = '9e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f';
const CANDIDATE_VERSION = '1.2.3-rc.1';

interface CliRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[], timeoutMs = 240_000): CliRun {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf-8',
    timeout: timeoutMs,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function expectEvidence(run: CliRun, context: string): ValidationEvidence {
  expect(
    run.status,
    `${context}: cli exited ${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
  ).toBe(0);
  return JSON.parse(run.stdout) as ValidationEvidence;
}

function validateArgs(options: {
  readonly target: PgContainer;
  readonly baselineDir?: string;
  readonly migrationsConfig: string;
}): string[] {
  // URL mang credential test-only đi vào argv CLI con — contract của CLI
  // bắt buộc flag argv, không có fallback env (cửa sổ phơi nhiễm: bảng tiến
  // trình runner-local của suite, chi tiết ở harness.ts).
  return [
    'validate',
    '--database',
    CONTRACT_DATABASE,
    '--docker',
    options.target.name,
    '--target-url',
    options.target.internalUrl('postgres'),
    '--migrator-url',
    options.target.hostMigratorUrl(),
    // Restore psql chạy TRONG container qua docker exec — cần URL nội tại
    // (host-mapped port không tồn tại từ góc nhìn đó).
    '--migrator-url-docker',
    options.target.internalMigratorUrl(),
    '--migrator-role',
    MIGRATOR_ROLE,
    '--commit-sha',
    CANDIDATE_SHA,
    '--candidate-version',
    CANDIDATE_VERSION,
    '--migrations-config',
    resolve(fixturesDir, options.migrationsConfig),
    '--confirm-disposable-target',
    ...(options.baselineDir === undefined ? [] : ['--baseline', options.baselineDir]),
  ];
}

/** Sao chép baseline đã capture sang thư mục khác với dump bị biến đổi + sha cập nhật theo. */
function writeTamperedBaseline(
  targetDir: string,
  originalDir: string,
  identity: BaselineIdentity,
  transform: (dump: string) => string,
): string {
  const dump = transform(readFileSync(join(originalDir, `${CONTRACT_DATABASE}.sql`), 'utf-8'));
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, `${CONTRACT_DATABASE}.sql`), dump);
  const tamperedIdentity: BaselineIdentity = {
    ...identity,
    // Cả hai trường suy từ dump đã biến đổi, đúng cách captureBaseline ghi
    // (sha256 + Buffer.byteLength) — integrity so dumpBytes thấy data thống nhất.
    dumpSha256: createHash('sha256').update(dump).digest('hex'),
    dumpBytes: Buffer.byteLength(dump),
  };
  writeFileSync(join(targetDir, 'baseline.json'), `${JSON.stringify(tamperedIdentity, null, 2)}\n`);
  return targetDir;
}

describe(
  'PostgreSQL baseline restore and candidate migration mechanism (docker CLI, real pg_dump/psql/runner)',
  { timeout: 420_000 },
  () => {
    let source: PgContainer;
    let target: PgContainer;
    let baseline: BaselineIdentity;
    let captureDir: string;

    beforeAll(async () => {
      source = await startPostgres();
      target = await startPostgres();
      prepareAuthority(source);
      prepareAuthority(target);

      // State "previous release" trên source: journal fixture baseline áp bằng
      // runner thật của migration authority — không vòng apply thứ hai.
      const applied = applyFixtureMigrations(source, 'baseline.config.ts');
      // Setup fail là throw (không expect — rule no-standalone-expect); lỗi
      // gốc vẫn nổi kèm full output, không bị TypeError của afterAll che.
      if (applied.status !== 0) {
        throw new Error(`baseline fixture migrate failed:\n${applied.stderr}\n${applied.stdout}`);
      }

      // Capture MỘT lần cho cả suite — mọi test validate tiêu thụ đúng artifact này.
      captureDir = join(outRoot, 'capture');
      // --source-url cũng đi argv vì contract (lý do chấp nhận ở harness.ts).
      const capture = runCli([
        'capture',
        '--database',
        CONTRACT_DATABASE,
        '--docker',
        source.name,
        '--source-url',
        source.internalUrl(CONTRACT_DATABASE),
        '--out',
        captureDir,
      ]);
      if (capture.status !== 0) {
        throw new Error(`capture failed:\n${capture.stdout}\n${capture.stderr}`);
      }
      baseline = (JSON.parse(capture.stdout) as { baseline: BaselineIdentity }).baseline;
    }, 300_000);

    afterAll(async () => {
      // beforeAll fail (Docker vắng/container chết) phải nổi đúng lỗi gốc —
      // không bị TypeError của afterAll che (fix OCR #503).
      if (source !== undefined) await source.stop();
      if (target !== undefined) await target.stop();
    }, 60_000);

    it('capture records a baseline identity that fingerprints the previous-release state', () => {
      expect(baseline.mechanism).toBe('pg-dump-per-database');
      expect(baseline.database).toBe(CONTRACT_DATABASE);
      expect(baseline.sourceLsn).toEqual(expect.any(String));

      const dumpPath = join(captureDir, `${CONTRACT_DATABASE}.sql`);
      expect(existsSync(dumpPath)).toBe(true);
      const dump = readFileSync(dumpPath, 'utf-8');
      expect(baseline.dumpSha256).toBe(createHash('sha256').update(dump).digest('hex'));
      expect(baseline.dumpBytes).toBe(Buffer.byteLength(dump));
      // Dump per-database với --no-owner: không phụ thuộc role của instance đích.
      expect(dump).toMatch('CREATE TABLE rvl.baseline_probe');
      expect(dump).not.toMatch(/OWNER TO/u);

      expect(new Date(baseline.capturedAt).getTime()).not.toBeNaN();
      expect(baseline.integrity.historyCount).toBe(1);
      expect(baseline.integrity.historyMaxWhen).toBe(1700000000000);
      expect(baseline.integrity.tables).toContain('rvl.baseline_probe');
      expect(baseline.integrity.tables).toContain('rvl.__drizzle_migrations');
    });

    it('validates a baseline by restoring it into a disposable target and applying candidate migrations forward', () => {
      const evidence = expectEvidence(
        runCli(
          validateArgs({
            target,
            baselineDir: captureDir,
            migrationsConfig: 'candidate.config.ts',
          }),
        ),
        'validate from baseline',
      );
      expect(evidence.status).toBe('passed');
      expect(evidence.mechanism).toBe('pg-baseline');
      // Danh tính candidate exact gắn vào evidence (#379/#346).
      expect(evidence.candidate).toEqual({ commitSha: CANDIDATE_SHA, version: CANDIDATE_VERSION });
      // Baseline identity versioned per database, trùng artifact đã capture.
      expect(evidence.baseline).toEqual(baseline);
      expect(evidence.firstRelease).toBe(false);
      expect(evidence.stages.map((stage) => [stage.stage, stage.status])).toEqual([
        ['target-install', 'passed'],
        ['integrity', 'passed'],
        ['candidate-migration', 'passed'],
      ]);
      // Candidate migration chạy TIẾN từ baseline: 1 entry cũ + 1 mới = 2.
      expect(evidence.historyAfter).toBe(2);

      // Restore mang theo data của baseline; candidate SQL áp lên trên nó.
      const dataRow = target.runSql('select count(*) from rvl.baseline_probe', CONTRACT_DATABASE);
      expect(dataRow.stdout.trim()).toBe('1');
      const candidateProbe = target.runSql(
        "select to_regclass('rvl.candidate_probe') is not null",
        CONTRACT_DATABASE,
      );
      expect(candidateProbe.stdout.trim()).toBe('t');
    });

    it('the integrity check fails closed when the restored state diverges from the recorded baseline', () => {
      const tamperedDir = writeTamperedBaseline(
        join(outRoot, 'tampered'),
        captureDir,
        baseline,
        (dump) => `${dump}\nDROP SCHEMA rvl CASCADE;\n`,
      );
      const run = runCli(
        validateArgs({ target, baselineDir: tamperedDir, migrationsConfig: 'candidate.config.ts' }),
      );
      expect(run.status).not.toBe(0);
      const evidence = JSON.parse(run.stdout) as ValidationEvidence;
      expect(evidence.status).toBe('failed');
      expect(evidence.candidate).toEqual({ commitSha: CANDIDATE_SHA, version: CANDIDATE_VERSION });
      expect(evidence.stages.map((stage) => [stage.stage, stage.status])).toEqual([
        ['target-install', 'passed'],
        ['integrity', 'failed'],
        ['candidate-migration', 'skipped'],
      ]);
      expect(evidence.stages[1]?.detail).toMatch(/integrity check failed/u);
      // Candidate migration không được phép chạy trên baseline chưa verify.
      expect(evidence.historyAfter).toBeNull();
    });

    it('the restore fails closed when the dump is truncated', () => {
      const truncatedDir = writeTamperedBaseline(
        join(outRoot, 'truncated'),
        captureDir,
        baseline,
        (dump) => dump.slice(0, Math.floor(dump.length / 2)),
      );
      const run = runCli(
        validateArgs({
          target,
          baselineDir: truncatedDir,
          migrationsConfig: 'candidate.config.ts',
        }),
      );
      expect(run.status).not.toBe(0);
      const evidence = JSON.parse(run.stdout) as ValidationEvidence;
      expect(evidence.status).toBe('failed');
      expect(evidence.stages.map((stage) => [stage.stage, stage.status])).toEqual([
        ['target-install', 'failed'],
        ['integrity', 'skipped'],
        ['candidate-migration', 'skipped'],
      ]);
      expect(evidence.stages[0]?.detail).toMatch(/restore failed/u);
    });

    it('an interrupted candidate migration leaves the restored baseline intact and a retry completes', async () => {
      const child = spawn(
        process.execPath,
        [
          cliPath,
          ...validateArgs({ target, baselineDir: captureDir, migrationsConfig: 'slow.config.ts' }),
        ],
        // Nhóm tiến trình riêng để kill -9 cả cụm CLI + runner + kit —
        // orphan giữ advisory lock làm vỡ mọi test sau trong suite.
        { detached: true, stdio: 'ignore' },
      );
      const exited = new Promise<number | null>((done, fail) => {
        child.once('exit', (code) => {
          done(code);
        });
        child.once('error', (error) => {
          fail(error);
        });
      });

      // Chờ migration thật sự đang chạy pg_sleep rồi mới kill — kill quá sớm
      // là test giả (chưa tới stage candidate-migration).
      let sawSleep = false;
      for (let i = 0; i < 100 && !sawSleep; i++) {
        const probe = target.runSql(
          "select count(*) from pg_stat_activity where query ilike '%pg_sleep%' and pid <> pg_backend_pid()",
        );
        sawSleep = probe.stdout.trim() === '1';
        if (!sawSleep)
          await new Promise<void>((done) => {
            setTimeout(done, 300);
          });
      }
      expect(sawSleep, 'pg_sleep migration never started — poll window too short').toBe(true);

      // pid undefined nghĩa là CLI đã chết trước cả khi kill được gọi — test
      // kỳ vọng nó đang chạy, fail ngay thay vì chờ `exited` treo tới timeout.
      if (child.pid === undefined) {
        throw new Error('CLI child pid is undefined — it was expected to be running at kill time');
      }
      // kill -9 cả nhóm: CLI, runner wrapper và kit con cùng chết; server
      // rollback transaction khi connection chết (§3a.5 — crash protection).
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Nhóm đã chết trước khi kill (ESRCH) — kết quả như ý.
      }
      await exited;

      // Backend đang pg_sleep không ghi gì xuống socket, chỉ hết sống khi
      // sleep xong và lần ghi kế tiếp chạm socket chết → abort + rollback
      // (§3a.5) — với pg_sleep(5) rollback hoàn tất ~5s sau kill; poll backend
      // biến mất tới deadline thay vì sleep cố định; quá hạn là fail, không nuốt.
      const deadBackendGone = (): boolean =>
        target
          .runSql(
            "select count(*) from pg_stat_activity where query ilike '%pg_sleep%' and pid <> pg_backend_pid()",
          )
          .stdout.trim() === '0';
      const settleDeadline = Date.now() + 15_000;
      while (!deadBackendGone()) {
        if (Date.now() >= settleDeadline) {
          throw new Error(
            'pg_sleep backend still alive 15s after SIGKILL — server never noticed the dead TCP peer',
          );
        }
        await new Promise<void>((done) => {
          setTimeout(done, 250);
        });
      }

      // Defined recoverable state = chính baseline đã restore: fingerprint
      // khớp từng trường, không DDL một phần, history không thêm entry.
      const contractUrl = target.internalUrl(CONTRACT_DATABASE);
      const history = migrationHistoryState(target.tools(), contractUrl);
      expect(history).toEqual({
        historyCount: baseline.integrity.historyCount,
        historyMaxWhen: baseline.integrity.historyMaxWhen,
      });
      expect(tableInventory(target.tools(), contractUrl)).toEqual(baseline.integrity.tables);

      // Recovery path: chạy lại validate từ baseline là hoàn tất — resume
      // đúng ngữ nghĩa checkpoint của kit, không replay entry đã commit.
      const retry = expectEvidence(
        runCli(
          validateArgs({
            target,
            baselineDir: captureDir,
            migrationsConfig: 'candidate.config.ts',
          }),
        ),
        'retry after interruption',
      );
      expect(retry.status).toBe('passed');
      expect(retry.historyAfter).toBe(2);
    });

    it('a first release falls back to the fresh-install path on an empty database', () => {
      const evidence = expectEvidence(
        runCli(validateArgs({ target, migrationsConfig: 'candidate.config.ts' })),
        'first-release fresh install',
      );
      expect(evidence.status).toBe('passed');
      expect(evidence.firstRelease).toBe(true);
      expect(evidence.baseline).toBeNull();
      expect(evidence.candidate).toEqual({ commitSha: CANDIDATE_SHA, version: CANDIDATE_VERSION });
      expect(evidence.stages.map((stage) => [stage.stage, stage.status])).toEqual([
        ['target-install', 'passed'],
        ['integrity', 'not-applicable'],
        ['candidate-migration', 'passed'],
      ]);
      expect(evidence.historyAfter).toBe(2);
      const candidateProbe = target.runSql(
        "select to_regclass('rvl.candidate_probe') is not null",
        CONTRACT_DATABASE,
      );
      expect(candidateProbe.stdout.trim()).toBe('t');
    });
  },
);
