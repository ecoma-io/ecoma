import { describe, expect, it } from 'vitest';

import {
  runStagingSmoke,
  validateCheckPath,
  validateSmokeOrigin,
  type SmokeResponse,
  type StagingSmokeDeps,
  type StagingSmokeOptions,
} from './staging-smoke.ts';

/** Response giả tối thiểu — module chỉ đọc status và headers.get. */
function res(status: number, headers: Record<string, string> = {}): SmokeResponse {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  };
}

interface FetchCall {
  url: string;
  redirect: string;
}

/** Deps giả: script trả response/throw theo lượt, ghi lại URL và cờ redirect. */
function fakeFetch(script: Array<SmokeResponse | Error>): {
  deps: StagingSmokeDeps;
  calls: FetchCall[];
  sleeps: number[];
  lines: string[];
} {
  const calls: FetchCall[] = [];
  const sleeps: number[] = [];
  const lines: string[] = [];
  let index = 0;
  const deps: StagingSmokeDeps = {
    fetchImpl: (url, init) => {
      calls.push({ url, redirect: init.redirect });
      const step = script[Math.min(index, script.length - 1)] as SmokeResponse | Error;
      index += 1;
      if (step instanceof Error) return Promise.reject(step);
      return Promise.resolve(step);
    },
    sleepFn: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    out: { write: (text) => (lines.push(text), lines.length) },
  };
  return { deps, calls, sleeps, lines };
}

/** Lỗi transport mang `code` — đúng shape undici ném qua `cause`. */
function transportError(code: string): Error {
  const error = new Error('request failed') as Error & { code?: string };
  error.code = code;
  return error;
}

const HOME_OPTIONS: StagingSmokeOptions = {
  origin: 'https://ecoma.io.vn',
  redirects: [{ from: '/', to: '/en' }],
  healthPaths: ['/health'],
  noindexPaths: ['/en'],
  budgetMs: 90_000,
  requestTimeoutMs: 10_000,
};

/** Script chuẩn: cả ba kiểm của home pass trong một lượt. */
function passingScript(): SmokeResponse[] {
  return [
    res(302, { location: '/en' }),
    res(200),
    res(200, { 'x-robots-tag': 'noindex, nofollow' }),
  ];
}

describe('validateSmokeOrigin', () => {
  it('accepts a bare https origin', () => {
    expect(validateSmokeOrigin('https://ecoma.io.vn').origin).toBe('https://ecoma.io.vn');
  });

  it('refuses http:// — staging smoke must verify the TLS public surface', () => {
    expect(() => validateSmokeOrigin('http://ecoma.io.vn')).toThrowError(/must be https/u);
  });

  it('refuses a path, query or hash on the origin', () => {
    expect(() => validateSmokeOrigin('https://ecoma.io.vn/en')).toThrowError(/bare origin/u);
    expect(() => validateSmokeOrigin('https://ecoma.io.vn/?x=1')).toThrowError(/bare origin/u);
  });

  it('refuses a value that is not a URL at all', () => {
    expect(() => validateSmokeOrigin('not-a-url')).toThrowError(/not a valid URL/u);
  });
});

describe('validateCheckPath', () => {
  it('requires an absolute path without whitespace', () => {
    expect(validateCheckPath('/health', '--health')).toBe('/health');
    expect(() => validateCheckPath('health', '--health')).toThrowError(/absolute path/u);
    expect(() => validateCheckPath('/he alth', '--health')).toThrowError(/absolute path/u);
  });
});

describe('runStagingSmoke', () => {
  it('passes when every declared check holds and prints OK exactly once', async () => {
    const { deps, calls, lines } = fakeFetch(passingScript());
    const results = await runStagingSmoke(HOME_OPTIONS, deps);
    expect(results).toHaveLength(3);
    expect(calls.map((call) => call.url)).toEqual([
      'https://ecoma.io.vn/',
      'https://ecoma.io.vn/health',
      'https://ecoma.io.vn/en',
    ]);
    expect(calls.every((call) => call.redirect === 'manual')).toBe(true);
    const okLines = lines.filter((line) => line.startsWith('staging smoke OK'));
    expect(okLines).toHaveLength(1);
    expect(lines.join('')).toContain('3 check(s) passed');
  });

  it('fails immediately when the redirect status is not 302 — no retry hides a wrong surface', async () => {
    const { deps, calls, lines } = fakeFetch([res(200)]);
    await expect(
      runStagingSmoke({ ...HOME_OPTIONS, healthPaths: [], noindexPaths: [] }, deps),
    ).rejects.toThrowError(/GET \/: expected status 302/u);
    expect(calls).toHaveLength(1);
    expect(lines.join('')).not.toContain('staging smoke OK');
  });

  it('fails immediately when the redirect lands on the wrong location', async () => {
    const { deps } = fakeFetch([res(302, { location: '/vi' })]);
    await expect(
      runStagingSmoke({ ...HOME_OPTIONS, healthPaths: [], noindexPaths: [] }, deps),
    ).rejects.toThrowError(/expected location '\/en', got "\/vi"/u);
  });

  it('retries a 503 from a cold-starting origin and passes once every check is ready', async () => {
    // Lượt 1: request đầu nhận 503 (not-ready, retry-được); lượt 2: cả ba kiểm pass.
    const { deps, calls, sleeps, lines } = fakeFetch([
      res(503),
      res(302, { location: '/en' }),
      res(200),
      res(200, { 'x-robots-tag': 'noindex' }),
    ]);
    const results = await runStagingSmoke(HOME_OPTIONS, deps);
    expect(results).toHaveLength(3);
    expect(calls).toHaveLength(4);
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
    expect(lines.join('')).toContain('RETRY');
  });

  it('retries connection-refused transport errors within the budget', async () => {
    const script: Array<SmokeResponse | Error> = [
      transportError('ECONNREFUSED'),
      res(302, { location: '/en' }),
    ];
    const { deps, calls } = fakeFetch(script);
    const results = await runStagingSmoke(
      { ...HOME_OPTIONS, healthPaths: [], noindexPaths: [] },
      deps,
    );
    expect(results).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it('treats a request timeout as not-ready and retries', async () => {
    const timeout = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    const { deps } = fakeFetch([timeout, res(302, { location: '/en' })]);
    const results = await runStagingSmoke(
      { ...HOME_OPTIONS, healthPaths: [], noindexPaths: [] },
      deps,
    );
    expect(results).toHaveLength(1);
  });

  it('fails immediately on an unclassified transport error', async () => {
    const { deps, calls } = fakeFetch([transportError('ENOTFOUND')]);
    await expect(
      runStagingSmoke({ ...HOME_OPTIONS, healthPaths: [], noindexPaths: [] }, deps),
    ).rejects.toThrowError(/GET \/: request failed/u);
    expect(calls).toHaveLength(1);
  });

  it('fails when a staging surface is not noindex — skipped-by-capability, never skipped-because-failing', async () => {
    const { deps, lines } = fakeFetch([res(302, { location: '/en' }), res(200), res(200)]);
    await expect(runStagingSmoke(HOME_OPTIONS, deps)).rejects.toThrowError(
      /X-Robots-Tag .*§7\.5 item 9/u,
    );
    expect(lines.join('')).not.toContain('staging smoke OK');
  });

  it('throws FAILED after the budget is exhausted on a persistent not-ready origin', async () => {
    const { deps, calls } = fakeFetch([res(502)]);
    await expect(runStagingSmoke({ ...HOME_OPTIONS, budgetMs: 0 }, deps)).rejects.toThrowError(
      /staging smoke FAILED after \d+ms \(budget exhausted 0ms\)/u,
    );
    expect(calls).toHaveLength(1);
  });

  it('refuses an empty check list as a misconfiguration', async () => {
    const { deps, calls } = fakeFetch([]);
    await expect(
      runStagingSmoke({ ...HOME_OPTIONS, redirects: [], healthPaths: [], noindexPaths: [] }, deps),
    ).rejects.toThrowError(/received no checks/u);
    expect(calls).toHaveLength(0);
  });

  it('validates the origin before issuing any request', async () => {
    const { deps, calls } = fakeFetch([]);
    await expect(
      runStagingSmoke({ ...HOME_OPTIONS, origin: 'http://ecoma.io.vn' }, deps),
    ).rejects.toThrowError(/must be https/u);
    expect(calls).toHaveLength(0);
  });

  it('validates every check path before issuing any request — even without the CLI', async () => {
    const { deps, calls } = fakeFetch([]);
    await expect(
      runStagingSmoke({ ...HOME_OPTIONS, healthPaths: ['nope'] }, deps),
    ).rejects.toThrowError(/absolute path/u);
    expect(calls).toHaveLength(0);
  });

  it('fails closed — no retry — when fetchImpl violates the response contract', async () => {
    const { deps, calls } = fakeFetch([null as unknown as SmokeResponse]);
    await expect(runStagingSmoke(HOME_OPTIONS, deps)).rejects.toThrowError(
      /malformed response object/u,
    );
    expect(calls).toHaveLength(1);
  });

  it('fails closed when the response carries no headers — not a TypeError', async () => {
    const { deps, calls } = fakeFetch([{ status: 200 } as unknown as SmokeResponse]);
    await expect(
      runStagingSmoke({ ...HOME_OPTIONS, redirects: [], noindexPaths: [] }, deps),
    ).rejects.toThrowError(/malformed response object/u);
    expect(calls).toHaveLength(1);
  });
});
