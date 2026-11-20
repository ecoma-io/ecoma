import { describe, expect, it } from 'vitest';

import { printReports } from './cli.ts';
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
  it('counts one violation per violation line — main maps any count to exit 1', () => {
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
