/**
 * Spec cho lớp CLI: parse `--repo` và hành vi thực thi đơn luồng của app.
 * Không test nào chạm mạng — đường thực thi trong test luôn dừng ở preflight
 * (thiếu token) trước khi port GitHub được dựng.
 */

import { runCommand } from 'citty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from './index.js';
import { reconcileCommand, resolveRepoName } from './reconcile-command.js';

describe('resolveRepoName', () => {
  it('accepts a bare repository name', () => {
    expect(resolveRepoName('ecoma-io', 'ecoma')).toEqual({ ok: true, repo: 'ecoma' });
  });

  it('splits a full name whose owner matches --owner', () => {
    expect(resolveRepoName('ecoma-io', 'ecoma-io/ecoma')).toEqual({ ok: true, repo: 'ecoma' });
  });

  it('rejects a full name whose owner differs from --owner', () => {
    const resolved = resolveRepoName('ecoma-io', 'other-org/ecoma');
    expect(resolved).toEqual({
      ok: false,
      error: expect.stringContaining('does not match --owner "ecoma-io"'),
    });
  });

  it('rejects names with more than one slash or an empty name part', () => {
    expect(resolveRepoName('ecoma-io', 'a/b/c').ok).toBe(false);
    expect(resolveRepoName('ecoma-io', 'ecoma-io/').ok).toBe(false);
  });
});

describe('cli execution', () => {
  const previousProjectToken = process.env['PROJECT_MANAGEMENT_TOKEN'];
  const previousGithubToken = process.env['GITHUB_TOKEN'];

  afterEach(() => {
    if (previousProjectToken !== undefined) {
      process.env['PROJECT_MANAGEMENT_TOKEN'] = previousProjectToken;
    } else {
      delete process.env['PROJECT_MANAGEMENT_TOKEN'];
    }
    if (previousGithubToken !== undefined) {
      process.env['GITHUB_TOKEN'] = previousGithubToken;
    } else {
      delete process.env['GITHUB_TOKEN'];
    }
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('keeps the pipeline on the reconcile subcommand only', () => {
    // Root không được tái dùng run/args của subcommand — đó chính là bug in
    // report hai lần trước đây.
    expect(app.run).toBeUndefined();
    const subCommands = app.subCommands as Record<string, typeof reconcileCommand> | undefined;
    expect(subCommands?.['reconcile']).toBe(reconcileCommand);
  });

  it('executes exactly once for reconcile argv, failing fast without a token', async () => {
    delete process.env['PROJECT_MANAGEMENT_TOKEN'];
    delete process.env['GITHUB_TOKEN'];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      // Nuốt stderr của CLI trong test.
    });
    await runCommand(app, {
      rawArgs: ['reconcile', '--owner', 'ecoma-io', '--repo', 'ecoma-io/ecoma'],
    });
    // Đúng một thông báo thiếu token: hai lần nghĩa là pipeline chạy hai lần.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('No GitHub token available');
    expect(process.exitCode).toBe(1);
  });
});
