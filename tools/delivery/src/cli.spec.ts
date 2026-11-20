import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isCliEntry,
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

describe('isCliEntry', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'delivery-entry-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('resolves identical real paths and symlinks to true', () => {
    const real = join(dir, 'entry.ts');
    writeFileSync(real, 'export {};\n');
    expect(isCliEntry(real, real)).toBe(true);
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
