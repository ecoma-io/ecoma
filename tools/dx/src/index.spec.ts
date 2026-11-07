import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { app } from './index.js';

const execFileAsync = promisify(execFile);

const DX_ROOT = resolve(import.meta.dirname, '..');
const ENTRY = join(DX_ROOT, 'index.ts');
const TSX = join(DX_ROOT, '../../node_modules/tsx/dist/cli.mjs');

/**
 * Chạy CLI trong một tiến trình con.
 *
 * Tiến trình cha đã nạp module này rồi, nên một kiểm tra trong cùng tiến trình sẽ
 * không chứng minh được điều gì về phân tích argument hay cách nối `runMain`.
 * citty ghi usage ra stderr, nên cả hai stream đều được đọc.
 */
async function dx(...args: string[]): Promise<string> {
  return dxFrom(DX_ROOT, ...args);
}

/** Như `dx` nhưng chỉ định cả working directory của tiến trình con. */
async function dxFrom(cwd: string, ...args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync('node', [TSX, ENTRY, ...args], { cwd });

  return `${stdout}${stderr}`;
}

describe('app', () => {
  it('names itself', () => {
    // citty định kiểu `meta` là resolvable, nhưng một object thuần vẫn là giá trị
    // hợp lệ cho nó — bóc kiểu ra thay vì gọi nó.
    const meta = app.meta as { name?: string; description?: string };

    expect(meta.name).toBe('Ecoma DX');
    expect(meta.description).toBe('Devtools for ecoma-io repository');
  });

  it('declares repo-prepare, sync-agent-config, pr-check, arch-check, commit-signing, gitleaks-scope, the four semgrep modes, the local platform commands and the local worker runtime commands', () => {
    // Set thay cho mảng sort: cùng đẳng thức tập hợp, không mutation và không
    // cần `toSorted` (lib của repository hiện là es2022).
    expect(new Set(Object.keys(app.subCommands ?? {}))).toEqual(
      new Set([
        'repo-prepare',
        'sync-agent-config',
        'pr-check',
        'arch-check',
        'commit-signing',
        'gitleak-ci',
        'gitleaks-scope',
        'gitleak-local',
        'semgrep-scan-local',
        'semgrep-scan-ci',
        'semgrep-test-local',
        'semgrep-test-ci',
        'local-status',
        'local-cleanup',
        'local-worker-up',
        'local-worker-status',
        'local-worker-down',
      ]),
    );
  });

  it.each(['local-worker-up', 'local-worker-status', 'local-worker-down'])(
    'describes %s',
    async (subcommand) => {
      // Mỗi lệnh worker runtime phải có mô tả riêng — thêm subcommand mới mà
      // quên description là lỗi UX CLI im lặng.
      const output = await dx(subcommand, '--help');
      expect(output).toContain(subcommand);
      expect(output).not.toMatch(/undefined/u);
    },
  );

  it('resolves each subcommand to a command definition, not a module namespace', async () => {
    // citty cần định nghĩa; `import()` trả về `{ default }`. Một namespace chưa bóc
    // type-check dưới `any` được nhưng lại fail lúc dispatch.
    for (const [, load] of Object.entries(app.subCommands ?? {})) {
      const resolved = await (load as () => Promise<unknown>)();
      expect(resolved).toHaveProperty('meta');
      expect(resolved).toHaveProperty('run');
    }
  });
});

describe('dx cli', () => {
  it('does nothing when no subcommand is given', async () => {
    // `run()` trần là một no-op có chủ đích, nên bản thân `dx` im lặng và exit 0.
    // Usage chỉ hiện ra sau --help.
    await expect(dx()).resolves.toBe('');
  });

  it('lists every subcommand in help', async () => {
    const output = await dx('--help');

    expect(output).toContain('Ecoma DX');
    expect(output).toContain('repo-prepare');
    expect(output).toContain('sync-agent-config');
    expect(output).toContain('pr-check');
    expect(output).toContain('arch-check');
    expect(output).toContain('commit-signing');
  });

  it('describes each subcommand', async () => {
    expect(await dx('repo-prepare', '--help')).toContain('Prepare repository');
    expect(await dx('sync-agent-config', '--help')).toContain('Sync agent configuration');
    expect(await dx('pr-check', '--help')).toContain('Check a pull request');
    expect(await dx('arch-check', '--help')).toContain('Validate Nx architecture tags');
    expect(await dx('commit-signing', '--help')).toContain('Check commit signing');
  });

  it('runs sync-agent-config for real from a working directory other than the repository root', async () => {
    // Trái với `--help` (citty cắt usage trước khi chạy `run()`), lần gọi này thực
    // sự dispatch tới `run()` → `syncAgentConfig()`. `ROOT_DIR` được resolve từ vị
    // trí module chứ không phải từ cwd của caller, nên chạy từ một thư mục hoàn
    // toàn khác vẫn đồng bộ đúng repository hiện tại — và chỉ in đường dẫn tương
    // đối so với ROOT_DIR, không rò đường dẫn của caller vào output.
    const output = await dxFrom(tmpdir(), 'sync-agent-config');

    expect(output).toContain('Sync agent configuration');
    expect(output).not.toContain(tmpdir());
  });
});
