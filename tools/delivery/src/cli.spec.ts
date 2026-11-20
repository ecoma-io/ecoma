import { closeSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isCliEntry,
  parseStagingDeployArgv,
  parseStagingGuardArgv,
  parseStagingManifestArgv,
  parseStagingPlanArgv,
  parseStagingSmokeArgv,
  parseStagingUnitGateArgv,
  parseWorkerSecretArgv,
  printReports,
  readStdinFrom,
  STDIN_MAX_BYTES,
} from './cli.ts';
import type { EnvironmentReport } from './staging-environments.ts';

/** Writer thu thập text vào mảng — spec không đụng stdout thật. */
function capture(): { out: { write(text: string): unknown }; lines: string[] } {
  const lines: string[] = [];
  return { out: { write: (text) => (lines.push(text), lines.length) }, lines };
}

const cleanReport: EnvironmentReport = {
  environment: 'staging-home',
  exists: true,
  created: false,
  policyFixed: false,
  branchPolicyAdded: false,
  violations: [],
};

const badPolicyReport: EnvironmentReport = {
  environment: 'staging-home',
  exists: true,
  created: false,
  policyFixed: false,
  branchPolicyAdded: false,
  violations: [
    'deployment_branch_policy is not { custom_branch_policies: true } — the staging ' +
      'branch restriction cannot be verified (§6.13); run without --check to repair',
  ],
};

describe('printReports', () => {
  it('counts and prints one line per violation', () => {
    const { out, lines } = capture();
    const failed = printReports(out, [badPolicyReport]);
    expect(failed).toBe(1);
    expect(lines.join('')).toContain('VIOLATION');
    expect(lines.join('')).toContain('custom_branch_policies');
  });

  it('returns 0 only when every report is clean — the sole exit-0 path', () => {
    const { out } = capture();
    expect(printReports(out, [cleanReport, cleanReport])).toBe(0);
  });
});

describe('parseWorkerSecretArgv', () => {
  it('parses a well-formed put command', () => {
    expect(parseWorkerSecretArgv(['put', 'AXIOM_TOKEN', '--config', 'wrangler.jsonc'])).toEqual({
      kind: 'ok',
      action: 'put',
      secretName: 'AXIOM_TOKEN',
      configPath: 'wrangler.jsonc',
    });
  });

  it('refuses an action that is neither put nor stage', () => {
    expect(parseWorkerSecretArgv(['deploy', 'AXIOM_TOKEN', '--config', 'c.jsonc'])).toEqual({
      kind: 'usage',
      message: 'first argument must be "put" or "stage"',
    });
  });

  it('refuses a missing or blank SECRET_NAME', () => {
    expect(parseWorkerSecretArgv(['put'])).toEqual({
      kind: 'usage',
      message: 'missing SECRET_NAME argument',
    });
    expect(parseWorkerSecretArgv(['put', '   ', '--config', 'c.jsonc'])).toEqual({
      kind: 'usage',
      message: 'missing SECRET_NAME argument',
    });
  });

  it('refuses a missing --config flag and a --config without a value', () => {
    expect(parseWorkerSecretArgv(['put', 'AXIOM_TOKEN'])).toEqual({
      kind: 'usage',
      message: 'missing --config <wrangler.jsonc> path',
    });
    expect(parseWorkerSecretArgv(['put', 'AXIOM_TOKEN', '--config'])).toEqual({
      kind: 'usage',
      message: 'missing --config <wrangler.jsonc> path',
    });
    expect(parseWorkerSecretArgv(['put', 'AXIOM_TOKEN', '--config', '  '])).toEqual({
      kind: 'usage',
      message: 'missing --config <wrangler.jsonc> path',
    });
  });
});

describe('parseStagingManifestArgv', () => {
  it('parses a well-formed manifest command', () => {
    expect(
      parseStagingManifestArgv(['--config', 'apps/home/wrangler.jsonc', '--sha', 'a'.repeat(40)]),
    ).toEqual({
      kind: 'ok',
      configPath: 'apps/home/wrangler.jsonc',
      sha: 'a'.repeat(40),
    });
  });

  it('refuses a missing or valueless --config and --sha', () => {
    expect(parseStagingManifestArgv(['--sha', 'abc'])).toEqual({
      kind: 'usage',
      message: 'missing --config <wrangler.jsonc> path',
    });
    expect(parseStagingManifestArgv(['--config', 'c.jsonc', '--sha'])).toEqual({
      kind: 'usage',
      message: 'missing --sha <commit-sha> value',
    });
  });
});

describe('parseStagingDeployArgv', () => {
  const fullArgv = [
    '--config',
    'apps/home/wrangler.jsonc',
    '--project',
    '@ecoma-io/home',
    '--slug',
    'home',
    '--manifest',
    'build-manifest.json',
    '--expect-sha',
    'a'.repeat(40),
  ];

  it('treats a flag-looking token as a missing value, not a consumed one', () => {
    // indexOf có thể trúng tên cờ xuất hiện làm giá trị của cờ trước — token
    // bắt đầu '--' là thiếu giá trị, không phải giá trị.
    expect(parseStagingDeployArgv(['--config', '--sha', 'a'.repeat(40)])).toEqual({
      kind: 'usage',
      message: 'missing --config <wrangler.jsonc> path',
    });
  });

  it('parses the five required flags into params', () => {
    expect(parseStagingDeployArgv(fullArgv)).toEqual({
      kind: 'ok',
      params: {
        configPath: 'apps/home/wrangler.jsonc',
        project: '@ecoma-io/home',
        slug: 'home',
        manifestPath: 'build-manifest.json',
        expectSha: 'a'.repeat(40),
      },
    });
  });

  it('refuses each missing flag with its own usage message', () => {
    // Mỗi argv dựng tường minh thiếu ĐÚNG một flag-value — argv tự dồn cờ sẽ
    // biến flag kế tiếp thành giá trị của flag trước (không còn thiếu gì).
    const sha = 'a'.repeat(40);
    const head = [
      '--config',
      'apps/home/wrangler.jsonc',
      '--project',
      '@ecoma-io/home',
      '--slug',
      'home',
      '--manifest',
      'build-manifest.json',
    ];
    expect(
      parseStagingDeployArgv([
        '--project',
        '@ecoma-io/home',
        '--slug',
        'home',
        '--manifest',
        'm.json',
        '--expect-sha',
        sha,
      ]),
    ).toEqual({
      kind: 'usage',
      message: 'missing --config <wrangler.jsonc> path',
    });
    expect(
      parseStagingDeployArgv([
        '--config',
        'c.jsonc',
        '--slug',
        'home',
        '--manifest',
        'm.json',
        '--expect-sha',
        sha,
      ]),
    ).toEqual({
      kind: 'usage',
      message: 'missing --project <nx-project-name> value',
    });
    expect(
      parseStagingDeployArgv([
        '--config',
        'c.jsonc',
        '--project',
        '@ecoma-io/home',
        '--manifest',
        'm.json',
        '--expect-sha',
        sha,
      ]),
    ).toEqual({
      kind: 'usage',
      message: 'missing --slug <slug> value',
    });
    expect(
      parseStagingDeployArgv([
        '--config',
        'c.jsonc',
        '--project',
        '@ecoma-io/home',
        '--slug',
        'home',
        '--expect-sha',
        sha,
      ]),
    ).toEqual({
      kind: 'usage',
      message: 'missing --manifest <build-manifest.json> path',
    });
    expect(parseStagingDeployArgv(head)).toEqual({
      kind: 'usage',
      message: 'missing --expect-sha <commit-sha> value',
    });
  });

  it('enables before-deploy guard only when both guard flags are given', () => {
    const sha = 'a'.repeat(40);
    const withGuard = parseStagingDeployArgv([
      ...fullArgv,
      '--guard-run-id',
      '12',
      '--guard-head-sha',
      sha,
    ]);
    expect(withGuard).toEqual({
      kind: 'ok',
      params: expect.objectContaining({
        guard: { runId: 12, contextSha: sha },
      }),
    });
    // Bật một nửa là usage error của caller — không phải guard tắt ngầm.
    expect(parseStagingDeployArgv([...fullArgv, '--guard-run-id', '12'])).toEqual({
      kind: 'usage',
      message: expect.stringContaining('together'),
    });
    expect(parseStagingDeployArgv([...fullArgv, '--guard-head-sha', sha])).toEqual({
      kind: 'usage',
      message: expect.stringContaining('together'),
    });
  });
});

describe('parseStagingSmokeArgv', () => {
  it('parses the origin, repeated check flags and budget overrides', () => {
    expect(
      parseStagingSmokeArgv([
        'https://ecoma.io.vn',
        '--redirect',
        '/=/en',
        '--health',
        '/health',
        '--noindex',
        '/en',
        '--budget-ms',
        '120000',
        '--request-timeout-ms',
        '5000',
      ]),
    ).toEqual({
      kind: 'ok',
      options: {
        origin: 'https://ecoma.io.vn',
        redirects: [{ from: '/', to: '/en' }],
        healthPaths: ['/health'],
        noindexPaths: ['/en'],
        budgetMs: 120000,
        requestTimeoutMs: 5000,
      },
    });
  });

  it('defaults the budget and request timeout when the flags are absent', () => {
    const parsed = parseStagingSmokeArgv(['https://ecoma.io.vn', '--health', '/health']);
    if (parsed.kind !== 'ok') throw new Error('expected an ok parse for a well-formed argv');
    expect(parsed.options.budgetMs).toBeGreaterThan(0);
    expect(parsed.options.requestTimeoutMs).toBeGreaterThan(0);
    expect(parsed.options.redirects).toEqual([]);
    expect(parsed.options.noindexPaths).toEqual([]);
  });

  it('refuses a missing origin and an unexpected second positional', () => {
    expect(parseStagingSmokeArgv([])).toEqual({
      kind: 'usage',
      message: 'missing <origin> positional argument',
    });
    expect(parseStagingSmokeArgv(['https://a', 'https://b'])).toEqual({
      kind: 'usage',
      message: 'unexpected argument: https://b',
    });
  });

  it('refuses a redirect without the from=to form and unknown flags', () => {
    expect(parseStagingSmokeArgv(['https://a', '--redirect', '/en'])).toEqual({
      kind: 'usage',
      message: '--redirect must be in <from>=<to> form: /en',
    });
    expect(parseStagingSmokeArgv(['https://a', '--smoke-all'])).toEqual({
      kind: 'usage',
      message: 'unsupported flag: --smoke-all',
    });
    expect(parseStagingSmokeArgv(['https://a', '--health'])).toEqual({
      kind: 'usage',
      message: 'missing value for --health',
    });
  });

  it('refuses a non-positive or non-integer budget', () => {
    expect(parseStagingSmokeArgv(['https://a', '--budget-ms', '0'])).toEqual({
      kind: 'usage',
      message: '--budget-ms must be a positive integer: 0',
    });
    expect(parseStagingSmokeArgv(['https://a', '--request-timeout-ms', 'abc'])).toEqual({
      kind: 'usage',
      message: '--request-timeout-ms must be a positive integer: abc',
    });
    // Chỉ số nguyên dương thập phân thuần: Number() còn nhận hex, mũ và
    // khoảng trắng — tất cả đều bị chặn ở đây.
    expect(parseStagingSmokeArgv(['https://a', '--budget-ms', '0x10'])).toEqual({
      kind: 'usage',
      message: '--budget-ms must be a positive integer: 0x10',
    });
    expect(parseStagingSmokeArgv(['https://a', '--request-timeout-ms', '1e2'])).toEqual({
      kind: 'usage',
      message: '--request-timeout-ms must be a positive integer: 1e2',
    });
    const padded = ' 12 ';
    expect(parseStagingSmokeArgv(['https://a', '--budget-ms', padded])).toEqual({
      kind: 'usage',
      message: `--budget-ms must be a positive integer: ${padded}`,
    });
  });

  it('reports a missing numeric-flag value instead of a number error', () => {
    expect(parseStagingSmokeArgv(['https://a', '--budget-ms'])).toEqual({
      kind: 'usage',
      message: 'missing value for --budget-ms',
    });
    expect(parseStagingSmokeArgv(['https://a', '--budget-ms', '--health', '/health'])).toEqual({
      kind: 'usage',
      message: 'missing value for --budget-ms',
    });
  });

  it('enables before-status guard only when both guard flags are given', () => {
    const sha = 'a'.repeat(40);
    expect(
      parseStagingSmokeArgv([
        'https://a',
        '--health',
        '/health',
        '--guard-run-id',
        '5',
        '--guard-head-sha',
        sha,
      ]),
    ).toEqual({
      kind: 'ok',
      options: expect.objectContaining({
        guard: { runId: 5, contextSha: sha },
      }),
    });
    expect(parseStagingSmokeArgv(['https://a', '--guard-run-id', '5'])).toEqual({
      kind: 'usage',
      message: expect.stringContaining('together'),
    });
  });
});

describe('parseStagingPlanArgv', () => {
  it('parses both SHAs', () => {
    expect(parseStagingPlanArgv(['--sha', 'a'.repeat(40), '--base', 'b'.repeat(40)])).toEqual({
      kind: 'ok',
      deploySha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
    });
  });

  it('refuses a missing SHA flag', () => {
    expect(parseStagingPlanArgv(['--base', 'b'.repeat(40)])).toEqual({
      kind: 'usage',
      message: 'missing --sha <commit-sha> value',
    });
    expect(parseStagingPlanArgv(['--sha', 'a'.repeat(40)])).toEqual({
      kind: 'usage',
      message: 'missing --base <commit-sha> value',
    });
  });
});

describe('parseStagingUnitGateArgv', () => {
  it('parses the three required flags', () => {
    expect(
      parseStagingUnitGateArgv([
        '--project',
        '@ecoma-io/home',
        '--config',
        'apps/home/wrangler.jsonc',
        '--ref-sha',
        'a'.repeat(40),
      ]),
    ).toEqual({
      kind: 'ok',
      project: '@ecoma-io/home',
      configPath: 'apps/home/wrangler.jsonc',
      refSha: 'a'.repeat(40),
    });
  });

  it('refuses each missing flag with its own usage message', () => {
    const sha = 'a'.repeat(40);
    expect(parseStagingUnitGateArgv(['--config', 'c.jsonc', '--ref-sha', sha])).toEqual({
      kind: 'usage',
      message: 'missing --project <nx-project-name> value',
    });
    expect(parseStagingUnitGateArgv(['--project', 'p', '--ref-sha', sha])).toEqual({
      kind: 'usage',
      message: 'missing --config <wrangler.jsonc> path',
    });
    expect(parseStagingUnitGateArgv(['--project', 'p', '--config', 'c.jsonc'])).toEqual({
      kind: 'usage',
      message: 'missing --ref-sha <commit-sha> value',
    });
  });
});

describe('parseStagingGuardArgv', () => {
  const sha = 'a'.repeat(40);

  it('parses point, run id and head sha into guard inputs', () => {
    expect(
      parseStagingGuardArgv(['--point', 'coalesce', '--run-id', '9', '--head-sha', sha]),
    ).toEqual({
      kind: 'ok',
      input: { runId: 9, contextSha: sha, point: 'coalesce' },
    });
  });

  it('refuses an unknown point', () => {
    expect(
      parseStagingGuardArgv(['--point', 'mid-deploy', '--run-id', '9', '--head-sha', sha]),
    ).toEqual({
      kind: 'usage',
      message: '--point must be one of coalesce|before-deploy|before-status: mid-deploy',
    });
  });

  it('refuses missing flags and a non-integer run id', () => {
    expect(parseStagingGuardArgv(['--run-id', '9', '--head-sha', sha])).toEqual({
      kind: 'usage',
      message: 'missing --point <coalesce|before-deploy|before-status>',
    });
    expect(parseStagingGuardArgv(['--point', 'coalesce', '--head-sha', sha])).toEqual({
      kind: 'usage',
      message: 'missing --run-id <n> value',
    });
    expect(parseStagingGuardArgv(['--point', 'coalesce', '--run-id', '9'])).toEqual({
      kind: 'usage',
      message: 'missing --head-sha <commit-sha> value',
    });
    expect(
      parseStagingGuardArgv(['--point', 'coalesce', '--run-id', 'x', '--head-sha', sha]),
    ).toEqual({
      kind: 'usage',
      message: expect.stringContaining('positive integer'),
    });
  });
});

describe('isCliEntry', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'delivery-entry-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('resolves identical real paths to true', () => {
    const real = join(dir, 'entry.ts');
    writeFileSync(real, 'export {};\n');
    expect(isCliEntry(real, real)).toBe(true);
  });

  it('resolves a symlink pointing at the entry to true', () => {
    // Case symlink THẬT: bin shim/symlink khiến argv[1] lệch chữ với entry —
    // realpath hai bên phải khớp, đúng kịch bản `npx tsx` qua link.
    const real = join(dir, 'entry.ts');
    const link = join(dir, 'link.ts');
    writeFileSync(real, 'export {};\n');
    symlinkSync(real, link);
    expect(isCliEntry(link, real)).toBe(true);
  });

  it('returns false for two different existing paths', () => {
    const a = join(dir, 'a.ts');
    const b = join(dir, 'b.ts');
    writeFileSync(a, 'export {};\n');
    writeFileSync(b, 'export {};\n');
    expect(isCliEntry(a, b)).toBe(false);
  });

  it('rethrows when the literal path matches the entry but realpath cannot resolve', () => {
    const ghost = join(dir, 'ghost.ts');
    expect(() => isCliEntry(ghost, ghost)).toThrowError(/cannot determine whether this process/u);
  });

  it('returns false when a nonexistent path differs from the entry', () => {
    const ghost = join(dir, 'ghost.ts');
    const real = join(dir, 'real.ts');
    writeFileSync(real, 'export {};\n');
    expect(isCliEntry(ghost, real)).toBe(false);
  });
});

describe('readStdinFrom', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'delivery-stdin-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a whole fd to EOF', () => {
    const path = join(dir, 'small.txt');
    writeFileSync(path, 'secret-value');
    const fd = openSync(path, 'r');
    try {
      expect(readStdinFrom(fd)).toBe('secret-value');
    } finally {
      closeSync(fd);
    }
  });

  it('throws past the size cap instead of buffering an unbounded value', () => {
    const path = join(dir, 'big.bin');
    writeFileSync(path, Buffer.alloc(STDIN_MAX_BYTES + 1, 0x61));
    const fd = openSync(path, 'r');
    try {
      expect(() => readStdinFrom(fd)).toThrowError(/exceeds the .* cap/u);
    } finally {
      closeSync(fd);
    }
  });

  it('accepts exactly the cap', () => {
    const path = join(dir, 'exact.bin');
    writeFileSync(path, Buffer.alloc(STDIN_MAX_BYTES, 0x61));
    const fd = openSync(path, 'r');
    try {
      expect(readStdinFrom(fd)).toHaveLength(STDIN_MAX_BYTES);
    } finally {
      closeSync(fd);
    }
  });
});
