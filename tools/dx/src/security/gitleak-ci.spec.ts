import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import gitleakCi from './gitleak-ci.js';

type SpawnArgs = [
  cmd: string,
  args: string[],
  options: { cwd: string; stdio: 'inherit'; env: NodeJS.ProcessEnv },
];

const mockSpawnSync = vi.hoisted(() =>
  vi.fn<(...args: SpawnArgs) => ReturnType<typeof spawnSync>>(),
);
const mockCheckScanRange = vi.hoisted(() =>
  vi.fn<
    (
      scope: Parameters<typeof import('./gitleaks-scope.js').checkScanRange>[0],
    ) => ReturnType<typeof import('./gitleaks-scope.js').checkScanRange>
  >(),
);

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: mockSpawnSync };
});

vi.mock('./gitleaks-scope.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./gitleaks-scope.js')>();
  return { ...actual, checkScanRange: mockCheckScanRange };
});

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const LOCK_PATH = resolve(ROOT_DIR, 'tools/dx', 'security-tools.lock.json');
const DOCKER_IMAGE = (
  JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as { gitleaks: { image: string } }
).gitleaks.image;

function runWith(args: Record<string, unknown>): void {
  process.exitCode = 0;
  (gitleakCi.run as (context: { args: Record<string, unknown> }) => void)({ args });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('gitleak-ci', () => {
  it('fails closed on an empty range without running docker', () => {
    runWith({ 'git-log-opts': '' });

    expect(process.exitCode).toBe(1);
    expect(mockCheckScanRange).not.toHaveBeenCalled();
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      '::error::--git-log-opts is required and must not be empty.',
    );
  });

  it('fails closed when git-log-opts is missing without running docker', () => {
    runWith({});

    expect(process.exitCode).toBe(1);
    expect(mockCheckScanRange).not.toHaveBeenCalled();
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      '::error::--git-log-opts is required and must not be empty.',
    );
  });

  it('fails closed when git cannot resolve the range', () => {
    mockCheckScanRange.mockReturnValue({
      ok: false,
      reason: 'range does not resolve',
    } as ReturnType<typeof import('./gitleaks-scope.js').checkScanRange>);

    runWith({ 'git-log-opts': 'nonexistent..HEAD' });

    expect(process.exitCode).toBe(1);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('calls checkScanRange before running docker', () => {
    mockCheckScanRange.mockReturnValue({ ok: true, commits: 3 } as ReturnType<
      typeof import('./gitleaks-scope.js').checkScanRange
    >);
    mockSpawnSync.mockReturnValue({ status: 0, error: undefined } as ReturnType<typeof spawnSync>);

    runWith({ 'git-log-opts': 'a..b' });

    expect(mockCheckScanRange).toHaveBeenCalledTimes(1);
    expect(mockCheckScanRange).toHaveBeenCalledWith({
      logOpts: 'a..b',
      description: 'git mode CI scan',
    });
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    expect(mockCheckScanRange.mock.invocationCallOrder[0]).toBeLessThan(
      mockSpawnSync.mock.invocationCallOrder[0],
    );
  });

  it('builds the docker command with the required args', () => {
    mockCheckScanRange.mockReturnValue({ ok: true, commits: 1 } as ReturnType<
      typeof import('./gitleaks-scope.js').checkScanRange
    >);
    mockSpawnSync.mockReturnValue({ status: 0, error: undefined } as ReturnType<typeof spawnSync>);

    runWith({ 'git-log-opts': 'main..HEAD' });

    const [cmd, dockerArgs, options] = mockSpawnSync.mock.calls[0] as [
      string,
      string[],
      { cwd: string; stdio: 'inherit'; env: NodeJS.ProcessEnv },
    ];

    expect(cmd).toBe('docker');
    expect(options.cwd).toBe(ROOT_DIR);
    expect(options.stdio).toBe('inherit');
    expect(Object.keys(options.env).some((key) => key.startsWith('GIT_'))).toBe(false);

    expect(dockerArgs).toContain('--rm');
    expect(dockerArgs).toContain('--volume');
    expect(dockerArgs).toContain(`${ROOT_DIR}:/repo`);
    // `.git` is mounted: required for git mode.
    expect(dockerArgs).toContain(`${ROOT_DIR}/.git:/repo/.git`);
    expect(dockerArgs).toContain('--workdir');
    expect(dockerArgs).toContain('/repo');
    // SARIF report dir is mounted to `/out` on the container.
    expect(dockerArgs.some((arg) => typeof arg === 'string' && arg.endsWith(':/out'))).toBe(true);
    // The PR cannot override the default rules.
    expect(dockerArgs).toContain('-e');
    expect(dockerArgs).toContain('GITLEAKS_CONFIG_TOML=[extend]\nuseDefault=true');
    expect(dockerArgs).toContain(DOCKER_IMAGE);
    expect(dockerArgs).toContain('detect');
    expect(dockerArgs).toContain('--source=/repo');
    expect(dockerArgs).toContain('--config=/repo/gitleaks.toml');
    expect(dockerArgs).toContain('--log-opts=main..HEAD');
    expect(dockerArgs).toContain('--redact');
    expect(dockerArgs).toContain('--exit-code=2');
    expect(dockerArgs).toContain('--report-format=sarif');
    expect(dockerArgs).toContain('--report-path=/out/results.sarif');
    // `.gitleaksignore` must not be mounted.
    expect(
      dockerArgs.some((arg) => typeof arg === 'string' && arg.includes('.gitleaksignore')),
    ).toBe(false);
  });

  it('exits with code 0 when docker passes with no secrets', () => {
    mockCheckScanRange.mockReturnValue({ ok: true, commits: 1 } as ReturnType<
      typeof import('./gitleaks-scope.js').checkScanRange
    >);
    mockSpawnSync.mockReturnValue({ status: 0, error: undefined } as ReturnType<typeof spawnSync>);

    runWith({ 'git-log-opts': 'main..HEAD' });

    expect(process.exitCode).toBe(0);
  });

  it('exits with code 2 when gitleaks finds secrets', () => {
    mockCheckScanRange.mockReturnValue({ ok: true, commits: 1 } as ReturnType<
      typeof import('./gitleaks-scope.js').checkScanRange
    >);
    mockSpawnSync.mockReturnValue({ status: 2, error: undefined } as ReturnType<typeof spawnSync>);

    runWith({ 'git-log-opts': 'main..HEAD' });

    expect(process.exitCode).toBe(2);
  });

  it('exits with code 1 on other docker errors', () => {
    mockCheckScanRange.mockReturnValue({ ok: true, commits: 1 } as ReturnType<
      typeof import('./gitleaks-scope.js').checkScanRange
    >);
    mockSpawnSync.mockReturnValue({ status: 1, error: undefined } as ReturnType<typeof spawnSync>);

    runWith({ 'git-log-opts': 'main..HEAD' });

    expect(process.exitCode).toBe(1);
  });

  it('exits with code 1 when docker cannot be run', () => {
    mockCheckScanRange.mockReturnValue({ ok: true, commits: 1 } as ReturnType<
      typeof import('./gitleaks-scope.js').checkScanRange
    >);
    mockSpawnSync.mockReturnValue({
      status: null,
      error: new Error('ENOENT: docker not found'),
      stdout: '',
      stderr: '',
    } as ReturnType<typeof spawnSync>);

    runWith({ 'git-log-opts': 'main..HEAD' });

    expect(process.exitCode).toBe(1);
  });
});
