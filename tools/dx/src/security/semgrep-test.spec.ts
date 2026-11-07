import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runSemgrepTest, RULES_DIR } from './semgrep-test.js';
import { SEMGREP_IMAGE } from './semgrep-scan.js';
import semgrepTestCi from './semgrep-test-ci.js';
import semgrepTestLocal from './semgrep-test-local.js';

type SpawnArgs = [
  cmd: string,
  args: string[],
  options: { cwd: string; stdio: 'inherit'; env: NodeJS.ProcessEnv },
];

const mockSpawnSync = vi.hoisted(() =>
  vi.fn<(...args: SpawnArgs) => ReturnType<typeof spawnSync>>(),
);

const mockExistsSync = vi.hoisted(() => vi.fn<(path: string) => boolean>());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: mockSpawnSync };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: mockExistsSync };
});

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const CODE_ANALYSIS = resolve(REPO_ROOT, '.github/workflows/code-analysis.yml');
const LEFTHOOK = resolve(REPO_ROOT, 'lefthook.yml');
const LOCK_PATH = resolve(REPO_ROOT, 'tools/dx', 'security-tools.lock.json');

const CI_IMAGE = (JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as { semgrep: { image: string } })
  .semgrep.image;

const okRun = (): ReturnType<typeof spawnSync> =>
  ({ status: 0, error: undefined }) as ReturnType<typeof spawnSync>;

function runCommand(command: typeof semgrepTestCi): void {
  process.exitCode = 0;
  (command.run as (context: { args: Record<string, unknown> }) => void)({ args: {} });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = 0;
  mockExistsSync.mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockRestore();
});

describe('semgrep-test engine', () => {
  it('uses the same pinned image as the scan commands', () => {
    // Một image cho cả scan lẫn test: hai bộ rule chạy trên hai engine khác nhau
    // thì "rule đã pass fixture" không còn nói gì về engine lúc scan.
    expect(SEMGREP_IMAGE).toBe(CI_IMAGE);
  });

  it('runs semgrep --test via docker with the pinned image', () => {
    mockSpawnSync.mockReturnValue(okRun());

    const result = runSemgrepTest({});

    expect(result.ok).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    const [cmd, dockerArgs, options] = mockSpawnSync.mock.calls[0] as SpawnArgs;

    expect(cmd).toBe('docker');
    expect(options.cwd).toBe(REPO_ROOT);
    expect(options.stdio).toBe('inherit');
    expect(dockerArgs).toContain(CI_IMAGE);
    expect(dockerArgs).toContain('--test');
    expect(dockerArgs).toContain('--config');
    expect(dockerArgs).toContain(RULES_DIR);
  });

  it('fails when the rules directory does not exist, without running docker', () => {
    mockExistsSync.mockReturnValue(false);

    const result = runSemgrepTest({});

    expect(result.ok).toBe(false);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('fails when docker cannot be run', () => {
    mockSpawnSync.mockReturnValue({
      status: null,
      error: new Error('ENOENT: docker not found'),
      stdout: '',
      stderr: '',
    } as ReturnType<typeof spawnSync>);

    expect(runSemgrepTest({}).ok).toBe(false);
  });

  it('fails when semgrep test fails', () => {
    mockSpawnSync.mockReturnValue({ status: 1, error: undefined } as ReturnType<typeof spawnSync>);

    expect(runSemgrepTest({}).ok).toBe(false);
  });
});

describe('semgrep-test-local and semgrep-test-ci', () => {
  it('both run the shared engine and set exit code on failure', () => {
    mockSpawnSync.mockReturnValue(okRun());
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    runCommand(semgrepTestLocal);
    expect(process.exitCode).toBe(0);

    runCommand(semgrepTestCi);
    expect(process.exitCode).toBe(0);

    mockSpawnSync.mockReturnValue({ status: 1, error: undefined } as ReturnType<typeof spawnSync>);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    runCommand(semgrepTestCi);
    expect(process.exitCode).toBe(1);
  });

  it('runs semgrep-test-ci in CI and semgrep-test-local from the hook', () => {
    expect(readFileSync(CODE_ANALYSIS, 'utf8')).toContain('pnpm dx semgrep-test-ci');
    expect(readFileSync(CODE_ANALYSIS, 'utf8')).not.toContain('pnpm dx semgrep-test-local');
    expect(readFileSync(LEFTHOOK, 'utf8')).toContain('pnpm dx semgrep-test-local');
    // Đã bỏ container image: job chạy trên runner mặc định, dx tự pull image qua docker.
    expect(readFileSync(CODE_ANALYSIS, 'utf8')).not.toContain('container:');
  });
});
