/**
 * Spec entry `pnpm dx local-worker-up` (OCR round-2 finding F6).
 *
 * Warning "no worker apps found" thuộc về COMMAND (không phải orchestration):
 * `startWorkerRuntime` trả rows rỗng là trạng thái hợp lệ, command mới là điểm
 * nhìn thấy "developer vừa yêu cầu up một runtime rỗng". Contract được chứng
 * minh bằng tiến trình con thật (tsx) vì exit code + phân luồng stdout/stderr
 * là hành vi của CLI, không mô phỏng được ở layer unit.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const DX_ROOT = resolve(import.meta.dirname, '../..');
const ENTRY = join(DX_ROOT, 'index.ts');
const TSX = join(DX_ROOT, '../../node_modules/tsx/dist/cli.mjs');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

/** Worktree fixture rỗng — không `apps/`, discovery trả 0 entry. */
function emptyWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'local-worker-up-spec-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * Worktree fixture có đúng một app opt-in hợp lệ — app này KHÔNG thể boot
 * thật trong test (`main` trỏ file không tồn tại), nên runtime sẽ fail-closed
 * trước khi báo ready; dùng để chứng minh warning rỗng KHÔNG hiện khi có
 * entry đang được boot.
 */
function worktreeWithOneApp(): string {
  const dir = emptyWorktree();
  const appDir = join(dir, 'apps', 'boot-fail');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    join(appDir, 'wrangler.jsonc'),
    JSON.stringify({
      name: 'ecoma-boot-fail',
      main: 'dist/does-not-exist.js',
      compatibility_date: '2026-10-05',
      d1_databases: [{ binding: 'db', database_name: 'boot-fail-db' }],
    }),
    'utf8',
  );
  writeFileSync(join(appDir, 'local-worker.jsonc'), '{"readiness": "log-banner"}\n', 'utf8');
  return dir;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Chạy CLI trong tiến trình con — exit code là một phần của contract (promise
 * body gán `process.exitCode`, chạy ngoài tiến trình test này), nên phải đo
 * trên chính tiến trình sẽ trả nó.
 */
async function dx(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [TSX, ENTRY, ...args], {
      cwd: DX_ROOT,
      timeout: 120_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

describe('local-worker-up command', () => {
  it('warns "no worker apps found" on stderr but still exits 0 when discovery finds zero entries', async () => {
    // OCR round-2 finding F6: 0 entry discovered phải quan sát được — mức
    // misconfig gần như chắc (marker gõ sai tên `local-worker.jsonc`, app dir
    // bị rename). Exit 0 giữ nguyên: không có gì sống là trạng thái hợp lệ.
    const worktree = emptyWorktree();
    const result = await dx(['local-worker-up', '--worktree-root', worktree]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('no worker apps found');
    expect(result.stderr).toContain('local-worker.jsonc');
    // Vẫn in dòng tóm tắt runtime ("up" với 0 worker) — chỉ khi CÓ worker mới
    // in dòng `worker <name> ready`; chặn nhầm dòng ready cho runtime rỗng.
    expect(result.stdout).not.toContain('ready at http://127.0.0.1:');
  });

  it('does not warn when at least one entry is being booted (empty warning is for zero entries only)', async () => {
    // Cảnh báo chỉ áp cho 0 entry — runtime có entry (dù boot fail sau đó)
    // không được dính cảnh báo rỗng, nếu không stderr của failure path là giả.
    const worktree = worktreeWithOneApp();
    const result = await dx([
      'local-worker-up',
      '--worktree-root',
      worktree,
      '--entry',
      'boot-fail',
    ]);
    expect(result.code).toBe(1); // boot fail thật — nhưng lý do không phải rỗng
    expect(result.stderr).not.toContain('no worker apps found');
    expect(result.stderr).toContain('[local-worker-up]');
  });

  it('splits comma-separated --entry into the directed set and fails closed on unknown name', async () => {
    // node:util.parseArgs collapse flag lặp lại (`--entry a --entry b` chỉ còn
    // `'b'`) — list nhiều entry phải viết comma-separated. Fail-closed tên lạ
    // chứng minh giá trị đã đi qua parser tới entryFilter thay vì bị nuốt.
    const worktree = worktreeWithOneApp();
    const result = await dx([
      'local-worker-up',
      '--worktree-root',
      worktree,
      '--entry',
      'boot-fail,no-such-app',
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('no-such-app');
    expect(result.stderr).toContain('boot-fail'); // discovered list trong message
  });
});
