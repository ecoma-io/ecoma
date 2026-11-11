import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const DX_ROOT = resolve(import.meta.dirname, '../..');
const ENTRY = join(DX_ROOT, 'index.ts');
const TSX = join(DX_ROOT, '../../node_modules/tsx/dist/cli.mjs');

/**
 * Env tiến trình con tối thiểu, cố ý KHÔNG có biến `ECOMA_*_DATABASE_URL`:
 * stage runner từ chối sinh tiến trình CLI của bất kỳ service nào khi credential
 * của service sở hữu thiếu, nên mọi lần chạy dưới đây fail ngay và xác định ở
 * preflight — không tiến trình con thật, không database. `PATH`/`HOME` giữ
 * lại để `node` và tsx khởi động được; không biến nào khác (đặc biệt là
 * `ECOMA_BOOTSTRAP_EMAIL`) rò rỉ vào từ shell của người chạy bộ kiểm.
 */
const MINIMAL_ENV: NodeJS.ProcessEnv = {
  PATH: process.env['PATH'] ?? '',
  HOME: process.env['HOME'] ?? '',
};

/** Result of one CLI run — exit code plus both streams, whatever the exit was. */
interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Chạy CLI thật trong tiến trình con (cùng harness với `index.spec.ts`): module
 * cha đã nạp sẵn, nên chỉ tiến trình thực mới chứng minh được phân tích đối số,
 * tách luồng và hợp đồng mã thoát.
 */
async function runCli(args: string[], env: NodeJS.ProcessEnv = MINIMAL_ENV): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [TSX, ENTRY, ...args], {
      cwd: DX_ROOT,
      env,
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('bootstrap-superadmin command', () => {
  it('prints the single-line JSON envelope as the last stdout line and exits non-zero on a failed run', async () => {
    const run = await runCli([
      'bootstrap-superadmin',
      '--json',
      '--correlation-id',
      'corr-cli-json',
      '--operator-ref',
      'CHG-TEST',
    ]);

    expect(run.code).toBe(1);
    const lines = run.stdout.trim().split('\n');
    // Envelope là DUY NHẤT một dòng stdout: người đọc máy đọc nó mà không cần
    // lọc, tiến trình dành cho con người đã đi stderr.
    expect(lines).toHaveLength(1);
    const envelope = JSON.parse(lines[0] as string) as Record<string, string>;
    expect(envelope).toEqual({
      outcome: 'failed',
      correlationId: 'corr-cli-json',
      failedStage: 'account.verify',
      reason: `database_url_missing:ECOMA_ACCOUNT_DATABASE_URL`,
    });
    expect(Object.keys(envelope)).toEqual(['outcome', 'correlationId', 'failedStage', 'reason']);
    expect(run.stderr).toContain('account.verify');
  });

  it('keeps the human stage table on stdout and prints no JSON envelope without --json', async () => {
    const run = await runCli([
      'bootstrap-superadmin',
      '--correlation-id',
      'corr-cli-human',
      '--operator-ref',
      'CHG-TEST',
    ]);

    expect(run.code).toBe(1);
    // Bảng stage trên stdout; tóm tắt thất bại là đầu ra stderr (hợp đồng
    // `printResult` hiện có — thất bại không bao giờ được trang trí thành stdout).
    expect(run.stdout).toContain('[bootstrap-superadmin] correlation id: corr-cli-human');
    expect(run.stdout).toContain('account.verify');
    expect(run.stderr).toContain('failed at account.verify');
    expect(run.stdout).not.toMatch(/\{"outcome"/u);
  });

  it('refuses a non-canonical ECOMA_BOOTSTRAP_EMAIL before any stage, leaving stdout envelope-free', async () => {
    const run = await runCli(['bootstrap-superadmin', '--json'], {
      ...MINIMAL_ENV,
      ECOMA_BOOTSTRAP_EMAIL: 'admin@example.com',
    });

    // Lần từ chối xảy ra trước runner, nên không in envelope: người đọc máy
    // phải thấy thất bại qua mã thoát và stdout không phân tích được,
    // không qua một kết quả giả.
    expect(run.code).toBe(1);
    expect(run.stdout).not.toMatch(/\{"outcome"/u);
    expect(run.stderr).toContain('canonical');
  });

  it('describes the new flags in --help', async () => {
    const run = await runCli(['bootstrap-superadmin', '--help']);

    expect(run.code).toBe(0);
    expect(run.stdout + run.stderr).toContain('--resolve-if-bootstrapped');
    expect(run.stdout + run.stderr).toContain('--json');
  });
});
