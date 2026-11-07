import { describe, expect, it, vi } from 'vitest';
import type { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDockerArgs, readGitleaksImage, runGitleaksLocal } from './gitleak-local.js';

const mockSpawnSync = vi.hoisted(() => vi.fn<() => ReturnType<typeof spawnSync>>());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: mockSpawnSync };
});

const DX_ROOT = join(import.meta.dirname, '../..');
const LOCK_PATH = join(DX_ROOT, 'security-tools.lock.json');

/**
 * Test chỉ assert việc đọc lock file và dựng args — không chạy docker, không
 * cần gitleaks binary. Riêng `runGitleaksLocal` mock `spawnSync` để pin exit
 * code: pre-push xanh trong khi gitleaks đỏ là lỗi tệ nhất của một hook.
 */

describe('readGitleaksImage', () => {
  it('reads the gitleaks image from security-tools.lock.json', () => {
    const image = readGitleaksImage(LOCK_PATH);

    expect(image).toBe(
      'zricethezav/gitleaks:v8.30.1@sha256:b109bc5f8f76a38196a3e413704fc5b9e3c32360bce4e4b603bd6f45b3721dbb',
    );
    expect(readFileSync(LOCK_PATH, 'utf8')).toContain(image);
  });

  it('throws when gitleaks.image is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitleak-local-test-'));
    const badLock = join(dir, 'security-tools.lock.json');
    writeFileSync(badLock, JSON.stringify({ gitleaks: {} }));

    expect(() => readGitleaksImage(badLock)).toThrow(/gitleaks image is not defined/u);

    rmSync(dir, { recursive: true, force: true });
  });

  it('throws a clear error when the lock file is not valid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitleak-local-test-'));
    const badLock = join(dir, 'security-tools.lock.json');
    writeFileSync(badLock, '{ not valid json');

    expect(() => readGitleaksImage(badLock)).toThrow(/failed to parse security-tools.lock.json/u);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('buildDockerArgs', () => {
  it('builds docker run args for scan-dir mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitleak-local-test-'));
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });

    const args = buildDockerArgs('zricethezav/gitleaks:v8.30.1', [], repo);

    expect(args).toEqual([
      'run',
      '--rm',
      '--volume',
      `${repo}:/repo`,
      '--workdir',
      '/repo',
      'zricethezav/gitleaks:v8.30.1',
      'dir',
      '--config',
      'gitleaks.toml',
      '--no-banner',
      '--redact',
      '--verbose',
      '--exit-code',
      '1',
    ]);

    rmSync(dir, { recursive: true, force: true });
  });

  it('mounts .git when the directory exists at root dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitleak-local-test-'));
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });

    const args = buildDockerArgs('zricethezav/gitleaks:v8.30.1', [], repo);

    expect(args).toContain(`${repo}/.git:/repo/.git`);
    // The .git volume must come before the image (before `dir` and gitleaks flags).
    expect(args.indexOf(`${repo}/.git:/repo/.git`)).toBeLessThan(args.indexOf('dir'));

    rmSync(dir, { recursive: true, force: true });
  });

  it('does not mount .git when the directory does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitleak-local-test-'));
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });

    const args = buildDockerArgs('zricethezav/gitleaks:v8.30.1', [], repo);

    expect(args).not.toContain('/repo/.git');

    rmSync(dir, { recursive: true, force: true });
  });

  it('forwards remaining CLI arguments to the end of the gitleaks command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitleak-local-test-'));
    const repo = join(dir, 'repo');
    mkdirSync(repo, { recursive: true });

    const args = buildDockerArgs('zricethezav/gitleaks:v8.30.1', ['--path', 'apps/foo'], repo);

    const imageIndex = args.indexOf('zricethezav/gitleaks:v8.30.1');
    expect(args.slice(imageIndex + 1)).toEqual([
      'dir',
      '--config',
      'gitleaks.toml',
      '--no-banner',
      '--redact',
      '--verbose',
      '--exit-code',
      '1',
      '--path',
      'apps/foo',
    ]);

    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * Chạy `run` với `process.exitCode` bắt đầu từ 0 và trả về giá trị nó để lại.
 *
 * Lefthook chỉ nhìn exit status của command. Nếu `runGitleaksLocal` in lỗi mà
 * không đặt `process.exitCode` thì một finding thật vẫn cho pre-push xanh —
 * đúng lỗi đã gặp với semgrep (thông điệp lỗi in ra nhưng vẫn exit 0).
 */
function withExitCodeRestored(run: () => void): number | undefined {
  const previous = process.exitCode;
  process.exitCode = 0;

  try {
    run();
    return process.exitCode;
  } finally {
    process.exitCode = previous;
  }
}

describe('runGitleaksLocal', () => {
  it('exits non-zero when gitleaks reports a finding', () => {
    mockSpawnSync.mockReturnValue({ status: 1, error: undefined } as ReturnType<typeof spawnSync>);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      expect(withExitCodeRestored(() => runGitleaksLocal('img', [], '/repo'))).toBe(1);
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('exits zero when gitleaks finds nothing', () => {
    mockSpawnSync.mockReturnValue({ status: 0, error: undefined } as ReturnType<typeof spawnSync>);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      expect(withExitCodeRestored(() => runGitleaksLocal('img', [], '/repo'))).toBe(0);
    } finally {
      log.mockRestore();
    }
  });

  it('exits non-zero when docker cannot run', () => {
    mockSpawnSync.mockReturnValue({
      status: null,
      error: new Error('ENOENT: docker not found'),
    } as ReturnType<typeof spawnSync>);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      expect(withExitCodeRestored(() => runGitleaksLocal('img', [], '/repo'))).toBe(1);
    } finally {
      error.mockRestore();
    }
  });
});
