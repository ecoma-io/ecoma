import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { printReports, readStdinFrom, STDIN_MAX_BYTES } from './cli.ts';
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

describe('readStdinFrom', () => {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-stdin-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

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
