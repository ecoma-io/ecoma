import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  compareReleaseDeclarations,
  evaluateEligibility,
  matchEligibilityPattern,
  parseDeployEligibility,
  type DeployEligibilityConfig,
} from './release-allowlist.ts';
import { stripJsoncComments } from './worker-secrets.ts';

/** Config fixture tối thiểu đúng schema, dùng cho các test hành vi. */
function fixtureConfig(overrides: Partial<DeployEligibilityConfig> = {}): DeployEligibilityConfig {
  return {
    schemaVersion: 1,
    production: { status: 'excluded', reason: 'production eligibility is M3 scope' },
    rules: [
      { match: '*-db', staging: 'excluded', reason: 'database migration project' },
      { match: '@ecoma-io/*-domain', staging: 'excluded', reason: 'domain library' },
    ],
    projects: {
      '@ecoma-io/home': { staging: 'releaseable' },
      '@ecoma-io/account': { staging: 'excluded', reason: 'devOrigin placeholder' },
    },
    ...overrides,
  };
}

describe('parseDeployEligibility', () => {
  it('parses a valid config with rules, explicit projects and comment keys ignored', () => {
    const config = parseDeployEligibility(
      [
        '{',
        '  "//": ["policy comment"],',
        '  "schemaVersion": 1,',
        '  "production": { "status": "excluded", "reason": "M3 scope" },',
        '  "rules": [',
        '    { "match": "*-db", "staging": "excluded", "reason": "migration project" },',
        '  ],',
        '  "projects": {',
        '    "//": ["per-project comment"],',
        '    "@ecoma-io/home": { "staging": "releaseable" },',
        '    "@ecoma-io/account": { "staging": "excluded", "reason": "devOrigin placeholder" },',
        '  },',
        '}',
      ].join('\n'),
    );
    expect(config.schemaVersion).toBe(1);
    expect(config.production).toEqual({ status: 'excluded', reason: 'M3 scope' });
    expect(config.rules).toHaveLength(1);
    expect(Object.keys(config.projects)).toEqual(['@ecoma-io/home', '@ecoma-io/account']);
  });

  it('blocks on a wrong schemaVersion instead of guessing the schema', () => {
    const text = JSON.stringify({ ...fixtureConfig(), schemaVersion: 2 });
    expect(() => parseDeployEligibility(text)).toThrowError(/schemaVersion.*must be 1/u);
  });

  it('blocks on an unknown staging status value', () => {
    const text = JSON.stringify({
      ...fixtureConfig(),
      projects: { '@ecoma-io/x': { staging: 'maybe' } },
    });
    expect(() => parseDeployEligibility(text)).toThrowError(/projects\["@ecoma-io\/x"\]\.staging/u);
  });

  it('blocks on an excluded project without a reason', () => {
    const text = JSON.stringify({
      ...fixtureConfig(),
      projects: { '@ecoma-io/x': { staging: 'excluded' } },
    });
    expect(() => parseDeployEligibility(text)).toThrowError(
      /projects\["@ecoma-io\/x"\]\.reason.*non-empty/u,
    );
  });

  it('blocks on a rule missing its reason', () => {
    const text = JSON.stringify({
      ...fixtureConfig(),
      rules: [{ match: '*-db', staging: 'excluded' }],
    });
    expect(() => parseDeployEligibility(text)).toThrowError(/rules\[0\]\.reason/u);
  });

  it.each([
    [
      'rules is not an array',
      JSON.stringify({ ...fixtureConfig(), rules: {} }),
      /"rules" must be an array/u,
    ],
    [
      'production is missing',
      JSON.stringify({ ...fixtureConfig(), production: undefined }),
      /"production" must be an object/u,
    ],
    ['root is an array', '[]', /\(root\).*must be an object/u],
    ['text is not JSON at all', 'not json {', /not valid JSON\(C\)/u],
  ])('blocks when %s', (_label, text, pattern) => {
    expect(() => parseDeployEligibility(text)).toThrowError(pattern);
  });
});

describe('matchEligibilityPattern', () => {
  it('treats * as any substring with anchored literal parts', () => {
    expect(matchEligibilityPattern('*-db', 'auth-db')).toBe(true);
    expect(matchEligibilityPattern('*-db', 'auth-db-domain')).toBe(false);
    expect(matchEligibilityPattern('@ecoma-io/*-domain', '@ecoma-io/account-domain')).toBe(true);
    expect(matchEligibilityPattern('@ecoma-io/*-domain', '@ecoma-io/account-domain-app')).toBe(
      false,
    );
    expect(matchEligibilityPattern('*', 'anything/at-all')).toBe(true);
  });
});

describe('evaluateEligibility', () => {
  it('prefers the explicit project entry over any matching rule', () => {
    const config = fixtureConfig({
      rules: [{ match: '*', staging: 'excluded', reason: 'catch-all' }],
    });
    const decisions = evaluateEligibility(config, ['@ecoma-io/home']);
    expect(decisions).toEqual([
      {
        project: '@ecoma-io/home',
        status: 'releaseable',
        source: 'explicit',
        reason: undefined,
      },
    ]);
  });

  it('applies the FIRST matching rule in declared order', () => {
    const config = fixtureConfig({
      rules: [
        { match: 'db-auth', staging: 'releaseable', reason: 'first rule' },
        { match: 'db-*', staging: 'excluded', reason: 'second rule' },
      ],
      projects: {},
    });
    const decisions = evaluateEligibility(config, ['db-auth']);
    expect(decisions).toEqual([
      {
        project: 'db-auth',
        status: 'releaseable',
        source: 'rule',
        pattern: 'db-auth',
        reason: 'first rule',
      },
    ]);
  });

  it('classifies unlisted projects by rule and carries the rule reason', () => {
    const decisions = evaluateEligibility(fixtureConfig(), ['home-db']);
    expect(decisions).toEqual([
      {
        project: 'home-db',
        status: 'excluded',
        source: 'rule',
        pattern: '*-db',
        reason: 'database migration project',
      },
    ]);
  });

  it('throws a blocking error listing every unclassified project', () => {
    expect(() =>
      evaluateEligibility(fixtureConfig({ projects: {} }), [
        '@ecoma-io/unknown-a',
        '@ecoma-io/unknown-b',
      ]),
    ).toThrowError(/@ecoma-io\/unknown-a, @ecoma-io\/unknown-b.*BLOCKING/u);
  });
});

describe('compareReleaseDeclarations', () => {
  it('accepts equal lists in any order', () => {
    expect(() =>
      compareReleaseDeclarations(
        ['@ecoma-io/home', '@ecoma-io/auth-nonce-prune-job'],
        ['@ecoma-io/auth-nonce-prune-job', '@ecoma-io/home'],
      ),
    ).not.toThrow();
  });

  it('blocks when a project is releaseable in eligibility but missing from nx release.projects', () => {
    expect(() =>
      compareReleaseDeclarations(['@ecoma-io/home', '@ecoma-io/extra'], ['@ecoma-io/home']),
    ).toThrowError(/missing from nx\.json release\.projects: @ecoma-io\/extra/u);
  });

  it('blocks when a project is in nx release.projects but not staging-releaseable', () => {
    expect(() =>
      compareReleaseDeclarations(['@ecoma-io/home'], ['@ecoma-io/home', '@ecoma-io/phantom']),
    ).toThrowError(/not staging-releaseable in deploy-eligibility\.jsonc: @ecoma-io\/phantom/u);
  });

  it('names projects from both directions in one error', () => {
    expect(() => compareReleaseDeclarations(['a-only'], ['b-only'])).toThrowError(
      /a-only; .*b-only/u,
    );
  });
});

describe('the committed deploy-eligibility.jsonc contract (real file)', () => {
  // Đường dẫn tương đối từ src/ — file thật là một đầu vào hợp đồng của audit.
  const eligibilityText = readFileSync(
    new URL('../config/deploy-eligibility.jsonc', import.meta.url),
    'utf8',
  );
  const nxJsonText = readFileSync(new URL('../../../nx.json', import.meta.url), 'utf8');

  it('parses the real file under schemaVersion 1', () => {
    const config = parseDeployEligibility(eligibilityText);
    expect(config.schemaVersion).toBe(1);
    expect(config.production.status).toBe('excluded');
  });

  it('keeps the staging releaseable set equal to nx.json release.projects (no drift)', () => {
    const config = parseDeployEligibility(eligibilityText);
    // nx.json đọc bằng bộ đọc JSONC của repo — cùng reader với runtime, spec
    // không tự chế regex strip riêng.
    const nxRelease = JSON.parse(stripJsoncComments(nxJsonText)) as {
      release?: { projects?: string[] };
    };
    const releaseable = evaluateEligibility(config, Object.keys(config.projects))
      .filter((decision) => decision.status === 'releaseable')
      .map((decision) => decision.project);
    expect(releaseable).toEqual(['@ecoma-io/home', '@ecoma-io/auth-nonce-prune-job']);
    expect(() =>
      compareReleaseDeclarations(releaseable, nxRelease.release?.projects ?? []),
    ).not.toThrow();
  });

  it('classifies the two pipeline units as explicit releaseable entries', () => {
    const config = parseDeployEligibility(eligibilityText);
    const decisions = evaluateEligibility(config, [
      '@ecoma-io/home',
      '@ecoma-io/auth-nonce-prune-job',
    ]);
    expect(decisions.every((decision) => decision.status === 'releaseable')).toBe(true);
    expect(decisions.every((decision) => decision.source === 'explicit')).toBe(true);
  });

  it('keeps every excluded project carrying its own reason', () => {
    const config = parseDeployEligibility(eligibilityText);
    const reasons = Object.entries(config.projects)
      .filter(([, entry]) => entry.staging === 'excluded')
      .map(([project, entry]) => [project, entry.reason ?? ''] as const);
    // Ít nhất một project excluded phải tồn tại để test có nội dung thực.
    expect(reasons.length).toBeGreaterThan(0);
    for (const [project, reason] of reasons) {
      expect(reason, `reason for ${project}`).toMatch(/\S/u);
    }
  });

  it('blocks an unclassified project against the real rules', () => {
    const config = parseDeployEligibility(eligibilityText);
    expect(() => evaluateEligibility(config, ['@ecoma-io/not-in-the-file'])).toThrowError(
      /not-in-the-file.*BLOCKING/u,
    );
  });
});
