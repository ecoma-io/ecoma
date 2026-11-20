import { describe, expect, it } from 'vitest';

import type { ExecResult } from '@ecoma-io/deployment';

import {
  buildWranglerDeployArgs,
  classifyWranglerFailure,
  deployStagingWorker,
  WRANGLER_ATTEMPT_TIMEOUT_MS,
  WRANGLER_DEPLOY_BACKOFF_MS,
  WRANGLER_DEPLOY_MAX_ATTEMPTS,
  type WranglerDeployDeps,
} from './wrangler-deploy.ts';

/** ExecResult thất bại/tành công giả cho deps inject. */
function fakeResult(overrides: Partial<ExecResult>): ExecResult {
  return { status: 0, stdout: '', stderr: '', ...overrides };
}

interface ExecCall {
  command: string;
  args: string[];
  cwd: string;
  options: { timeout: number };
}

/** Deps ghi lại mọi lời gọi exec và sleep — spec assert cả hai. */
function recordingDeps(results: ExecResult[]): {
  deps: WranglerDeployDeps;
  execCalls: ExecCall[];
  sleeps: number[];
} {
  const execCalls: ExecCall[] = [];
  const sleeps: number[] = [];
  let index = 0;
  const deps: WranglerDeployDeps = {
    execFn: (command, args, cwd, _env, options) => {
      execCalls.push({ command, args, cwd, options });
      const result = results[Math.min(index, results.length - 1)] as ExecResult;
      index += 1;
      return result;
    },
    sleepFn: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
  return { deps, execCalls, sleeps };
}

describe('classifyWranglerFailure', () => {
  it('classifies HTTP 5xx and 429 as transient', () => {
    expect(classifyWranglerFailure('A request to the Cloudflare API failed: HTTP 504')).toBe(
      'transient',
    );
    expect(classifyWranglerFailure('... HTTP 500 ...')).toBe('transient');
    expect(classifyWranglerFailure('... HTTP 429 ...')).toBe('transient');
  });

  it('classifies HTTP 401/403 as fatal — retrying auth errors hides the real cause', () => {
    expect(classifyWranglerFailure('... HTTP 403 ...')).toBe('fatal');
    expect(classifyWranglerFailure('... HTTP 401 ...')).toBe('fatal');
    expect(classifyWranglerFailure('... HTTP 404 ...')).toBe('fatal');
  });

  it('classifies the observed malformed-response and transport signatures as transient', () => {
    expect(classifyWranglerFailure('Received a malformed response from the API')).toBe('transient');
    expect(classifyWranglerFailure('fetch failed')).toBe('transient');
    expect(classifyWranglerFailure('SocketError: other side closed')).toBe('transient');
    expect(classifyWranglerFailure('socket hang up')).toBe('transient');
    expect(classifyWranglerFailure('ECONNRESET')).toBe('transient');
    expect(classifyWranglerFailure('ETIMEDOUT')).toBe('transient');
    expect(classifyWranglerFailure('killed by signal SIGTERM')).toBe('transient');
  });

  it('fails closed on unknown signatures and empty output — never retries a guess', () => {
    expect(classifyWranglerFailure('')).toBe('fatal');
    expect(classifyWranglerFailure('some completely unknown error')).toBe('fatal');
  });
});

describe('buildWranglerDeployArgs', () => {
  it('pins the explicit --env staging and both no-auto-provision flags', () => {
    const args = buildWranglerDeployArgs('apps/home/wrangler.jsonc');
    expect(args).toContain('--env');
    expect(args).toContain('staging');
    expect(args).toContain('--experimental-provision=false');
    expect(args).toContain('--experimental-auto-create=false');
    expect(args).toContain('apps/home/wrangler.jsonc');
    expect(args[0]).toBe('deploy');
  });
});

describe('deployStagingWorker', () => {
  const options = {
    configPath: '/repo/apps/home/wrangler.jsonc',
    env: { CLOUDFLARE_API_TOKEN: 'x' },
  };

  it('returns after the first successful attempt without sleeping', async () => {
    const { deps, execCalls, sleeps } = recordingDeps([
      fakeResult({ status: 0, stdout: 'deployed\n' }),
    ]);
    const result = await deployStagingWorker(options, deps);
    expect(result.attempts).toBe(1);
    expect(execCalls).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  it('retries a transient failure with the §7.4 backoff and then succeeds', async () => {
    const { deps, execCalls, sleeps } = recordingDeps([
      fakeResult({ status: 1, stderr: 'A request to the Cloudflare API failed: HTTP 504' }),
      fakeResult({ status: 0, stdout: 'deployed\n' }),
    ]);
    const result = await deployStagingWorker(options, deps);
    expect(result.attempts).toBe(2);
    expect(execCalls).toHaveLength(2);
    expect(sleeps).toEqual([WRANGLER_DEPLOY_BACKOFF_MS[0]]);
  });

  it('aborts immediately on a fatal failure — one exec call, no sleep', async () => {
    const { deps, execCalls, sleeps } = recordingDeps([
      fakeResult({ status: 1, stderr: 'A request to the Cloudflare API failed: HTTP 403' }),
      fakeResult({ status: 0, stdout: 'deployed\n' }),
    ]);
    await expect(deployStagingWorker(options, deps)).rejects.toThrowError(/HTTP 403/u);
    expect(execCalls).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  it('gives up after the max attempts and reports the last failure', async () => {
    const { deps, execCalls, sleeps } = recordingDeps([
      fakeResult({ status: 1, stderr: 'fetch failed' }),
    ]);
    await expect(deployStagingWorker(options, deps)).rejects.toThrowError(
      new RegExp(`after ${WRANGLER_DEPLOY_MAX_ATTEMPTS} attempts`, 'u'),
    );
    expect(execCalls).toHaveLength(WRANGLER_DEPLOY_MAX_ATTEMPTS);
    expect(sleeps).toEqual([...WRANGLER_DEPLOY_BACKOFF_MS]);
  });

  it('caps every attempt at the §7.4 four-minute timeout', async () => {
    const { deps, execCalls } = recordingDeps([fakeResult({ status: 0 })]);
    await deployStagingWorker(options, deps);
    expect(execCalls[0]?.options.timeout).toBe(WRANGLER_ATTEMPT_TIMEOUT_MS);
  });

  it('runs wrangler from the config directory with the config passed explicitly', async () => {
    const { deps, execCalls } = recordingDeps([fakeResult({ status: 0 })]);
    await deployStagingWorker(options, deps);
    expect(execCalls[0]?.command).toBe('npx');
    expect(execCalls[0]?.cwd).toBe('/repo/apps/home');
    expect(execCalls[0]?.args).toContain('/repo/apps/home/wrangler.jsonc');
  });
});
