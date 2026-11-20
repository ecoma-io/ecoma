import { describe, expect, it } from 'vitest';

import type { ExecResult } from '@ecoma-io/deployment';

import {
  ensureStagingEnvironments,
  ghProcessEnv,
  isNotFound,
  isValidRepoIdentifier,
  stagingUnits,
  type GhApiDeps,
  type StagingEligibilityConfig,
} from './staging-environments.ts';

/** State giả lập của MỘT Environment trên GitHub. */
interface FakeEnvState {
  exists: boolean;
  customPolicy: boolean;
  patterns: string[];
  protectionRules: Array<{ type: string }>;
}

const NOT_FOUND: ExecResult = { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };

/**
 * Fake `gh api` có state — GET/PUT environment + GET/POST branch policies;
 * mọi đường khác trả 500 để spec thấy được những lời gọi không lường trước.
 */
function fakeGh(
  state: FakeEnvState,
  envName = 'staging-home',
  repo = 'ecoma-io/ecoma',
): GhApiDeps & { calls: Array<{ args: string[]; input?: string }> } {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const envPath = `repos/${repo}/environments/${envName}`;
  const deps: GhApiDeps & { calls: Array<{ args: string[]; input?: string }> } = {
    calls,
    ghApi: (args, input) => {
      calls.push({ args, input });
      const method = args[0] === '-X' ? (args[1] as string) : 'GET';
      const path = method === 'GET' ? (args[0] as string) : (args[2] as string);
      if (path === envPath) {
        if (method === 'GET') {
          if (!state.exists) return NOT_FOUND;
          return {
            status: 0,
            stdout: JSON.stringify({
              deployment_branch_policy: state.customPolicy
                ? { protected_branches: false, custom_branch_policies: true }
                : null,
              protection_rules: state.protectionRules,
            }),
            stderr: '',
          };
        }
        if (method === 'PUT') {
          const body = JSON.parse(input ?? '{}') as { deployment_branch_policy?: unknown };
          state.exists = true;
          state.customPolicy =
            JSON.stringify(body.deployment_branch_policy) ===
            JSON.stringify({ protected_branches: false, custom_branch_policies: true });
          return { status: 0, stdout: '{}', stderr: '' };
        }
      }
      if (path === `${envPath}/deployment-branch-policies`) {
        if (method === 'GET') {
          return {
            status: 0,
            stdout: JSON.stringify({
              branch_policies: state.patterns.map((name) => ({ name })),
            }),
            stderr: '',
          };
        }
        if (method === 'POST') {
          const body = JSON.parse(input ?? '{}') as { name?: string };
          state.patterns.push(body.name ?? '');
          return { status: 0, stdout: '{}', stderr: '' };
        }
      }
      return { status: 1, stdout: '', stderr: 'gh: unexpected call (HTTP 500)' };
    },
  };
  return deps;
}

const ELIGIBILITY: StagingEligibilityConfig = {
  projects: {
    '@ecoma-io/home': { staging: 'releaseable' },
    '@ecoma-io/auth-nonce-prune-job': { staging: 'releaseable' },
    '@ecoma-io/account': { staging: 'excluded' },
    'platform-deploy': { staging: 'excluded' },
  },
};

describe('stagingUnits', () => {
  it('derives one environment per staging-releaseable project and skips excluded ones', () => {
    expect(stagingUnits(ELIGIBILITY)).toEqual([
      {
        project: '@ecoma-io/auth-nonce-prune-job',
        slug: 'auth-nonce-prune-job',
        environment: 'staging-auth-nonce-prune-job',
      },
      { project: '@ecoma-io/home', slug: 'home', environment: 'staging-home' },
    ]);
  });

  it('refuses a project whose slug cannot be derived safely', () => {
    expect(() =>
      stagingUnits({ projects: { 'weird project': { staging: 'releaseable' } } }),
    ).toThrowError(/cannot derive a safe slug/u);
  });

  it('refuses an empty inventory instead of creating nothing silently', () => {
    expect(() => stagingUnits({ projects: {} })).toThrowError(/inventory is empty/u);
  });
});

describe('ghProcessEnv', () => {
  it('passes only the minimal gh env and never the whole process env', () => {
    const env = ghProcessEnv({
      PATH: '/usr/bin',
      HOME: '/home/op',
      GH_TOKEN: 't',
      GH_HOST: 'github.com',
      ECOMA_CLOUDFLARE_API_TOKEN: 'should-not-leak',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/op',
      GH_TOKEN: 't',
      GH_HOST: 'github.com',
    });
  });
});

describe('isNotFound', () => {
  it('recognises HTTP 404 in stderr and rejects other failures', () => {
    expect(isNotFound(NOT_FOUND)).toBe(true);
    expect(isNotFound({ status: 1, stdout: '', stderr: 'gh: Bad credentials (HTTP 401)' })).toBe(
      false,
    );
    expect(isNotFound({ status: 0, stdout: '{}', stderr: '' })).toBe(false);
  });
});

describe('isValidRepoIdentifier', () => {
  it('accepts exactly two safe segments and rejects paths, gaps and garbage', () => {
    expect(isValidRepoIdentifier('ecoma-io/ecoma')).toBe(true);
    expect(isValidRepoIdentifier('my.org/my_repo-1')).toBe(true);
    expect(isValidRepoIdentifier('owner/name/extra')).toBe(false);
    expect(isValidRepoIdentifier('owner')).toBe(false);
    expect(isValidRepoIdentifier('owner/')).toBe(false);
    expect(isValidRepoIdentifier('/name')).toBe(false);
    expect(isValidRepoIdentifier('owner name/x')).toBe(false);
    expect(isValidRepoIdentifier('owner/name extra')).toBe(false);
    expect(isValidRepoIdentifier('owner/../etc')).toBe(false);
  });
});

describe('ensureStagingEnvironments', () => {
  const unit = { project: '@ecoma-io/home', slug: 'home', environment: 'staging-home' };

  it('creates the environment with a custom branch policy in the same run when missing', () => {
    const state: FakeEnvState = {
      exists: false,
      customPolicy: false,
      patterns: [],
      protectionRules: [],
    };
    const deps = fakeGh(state);
    const [report] = ensureStagingEnvironments([unit], 'ecoma-io/ecoma', deps);
    expect(report.created).toBe(true);
    expect(report.exists).toBe(true);
    expect(report.policyFixed).toBe(true);
    expect(report.violations).toEqual([]);
    expect(state.customPolicy).toBe(true);
    // PUT tạo Environment luôn kèm policy — không có cửa sổ trống protection.
    const put = deps.calls.find((call) => call.args.includes('PUT'));
    expect(put?.input).toContain('custom_branch_policies');
  });

  it('adds only the "main" pattern and reports extra patterns instead of deleting them', () => {
    const deps = fakeGh({
      exists: true,
      customPolicy: true,
      patterns: ['dev-*'],
      protectionRules: [],
    });
    const [report] = ensureStagingEnvironments([unit], 'ecoma-io/ecoma', deps);
    expect(report.branchPolicyAdded).toBe(true);
    expect(report.created).toBe(false);
    expect(report.violations).toEqual([
      'unexpected deployment branch policies: dev-* — staging deploys run only from main; remove them in Settings → Environments',
    ]);
  });

  it('reports a required reviewers rule as a violation without removing it', () => {
    const deps = fakeGh({
      exists: true,
      customPolicy: true,
      patterns: ['main'],
      protectionRules: [{ type: 'required_reviewers' }],
    });
    const [report] = ensureStagingEnvironments([unit], 'ecoma-io/ecoma', deps);
    expect(report.created).toBe(false);
    expect(report.violations.some((violation) => violation.includes('required_reviewers'))).toBe(
      true,
    );
  });

  it('reports a wait timer rule as a violation without removing it', () => {
    const deps = fakeGh({
      exists: true,
      customPolicy: true,
      patterns: ['main'],
      protectionRules: [{ type: 'wait_timer' }],
    });
    const [report] = ensureStagingEnvironments([unit], 'ecoma-io/ecoma', deps);
    expect(report.violations.some((violation) => violation.includes('wait_timer'))).toBe(true);
  });

  it('is idempotent: a second run mutates nothing and reports no violations', () => {
    const state: FakeEnvState = {
      exists: false,
      customPolicy: false,
      patterns: [],
      protectionRules: [],
    };
    const first = fakeGh(state);
    ensureStagingEnvironments([unit], 'ecoma-io/ecoma', first);
    const mutationCount = first.calls.filter(
      (call) => call.args.includes('PUT') || call.args.includes('POST'),
    ).length;
    const second = fakeGh(state);
    const [report] = ensureStagingEnvironments([unit], 'ecoma-io/ecoma', second);
    expect(report).toEqual({
      environment: 'staging-home',
      exists: true,
      created: false,
      policyFixed: false,
      branchPolicyAdded: false,
      violations: [],
    });
    expect(
      second.calls.filter((call) => call.args.includes('PUT') || call.args.includes('POST')),
    ).toEqual([]);
    expect(mutationCount).toBeGreaterThan(0);
  });

  it('check mode reads state only and flags a missing environment as auto-create risk', () => {
    const deps = fakeGh({ exists: false, customPolicy: false, patterns: [], protectionRules: [] });
    const [report] = ensureStagingEnvironments([unit], 'ecoma-io/ecoma', deps, 'check');
    expect(report.exists).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toContain('auto-create it with no protection');
    // Không có lời gọi mutation nào (PUT/POST) trong mode check.
    expect(
      deps.calls.every((call) => !call.args.includes('PUT') && !call.args.includes('POST')),
    ).toBe(true);
  });

  it('check mode reports a non-custom policy as a violation without mutating', () => {
    const deps = fakeGh({ exists: true, customPolicy: false, patterns: [], protectionRules: [] });
    const [report] = ensureStagingEnvironments([unit], 'ecoma-io/ecoma', deps, 'check');
    expect(report.exists).toBe(true);
    expect(report.policyFixed).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toContain('custom_branch_policies');
    // Violation ở đây là exit 1 ở CLI — guard CI phải đỏ ở đúng state này (§6.13).
    expect(
      deps.calls.every((call) => !call.args.includes('PUT') && !call.args.includes('POST')),
    ).toBe(true);
  });

  it('reports a policy that stays non-custom after an ensure repair', () => {
    // PUT không đổi được policy (API không nhận) → phải báo thay vì giả định thành công.
    const deps: GhApiDeps = {
      ghApi: (args) => {
        const method = args[0] === '-X' ? (args[1] as string) : 'GET';
        const path = method === 'GET' ? (args[0] as string) : (args[2] as string);
        if (path === 'repos/ecoma-io/ecoma/environments/staging-home') {
          if (method === 'GET') {
            return {
              status: 0,
              stdout: JSON.stringify({
                deployment_branch_policy: {
                  protected_branches: true,
                  custom_branch_policies: false,
                },
                protection_rules: [],
              }),
              stderr: '',
            };
          }
          return { status: 0, stdout: '{}', stderr: '' }; // PUT "thành công" nhưng không đổi gì
        }
        return { status: 1, stdout: '', stderr: 'gh: unexpected call (HTTP 500)' };
      },
    };
    const [report] = ensureStagingEnvironments([unit], 'ecoma-io/ecoma', deps, 'ensure');
    expect(report.policyFixed).toBe(true);
    expect(
      report.violations.some((violation) => violation.includes('still not custom after repair')),
    ).toBe(true);
  });

  it('fails closed on API errors other than 404', () => {
    const deps: GhApiDeps = {
      ghApi: () => ({ status: 1, stdout: '', stderr: 'gh: Bad credentials (HTTP 401)' }),
    };
    expect(() => ensureStagingEnvironments([unit], 'ecoma-io/ecoma', deps)).toThrowError(
      /HTTP 401/u,
    );
  });

  it('repairs an existing environment whose policy is not custom', () => {
    const deps = fakeGh({ exists: true, customPolicy: false, patterns: [], protectionRules: [] });
    const [report] = ensureStagingEnvironments([unit], 'ecoma-io/ecoma', deps);
    expect(report.policyFixed).toBe(true);
    expect(report.created).toBe(false);
    expect(report.violations).toEqual([]);
  });
});
