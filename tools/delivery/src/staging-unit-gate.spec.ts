import { describe, expect, it } from 'vitest';

import { evaluateStagingUnitGate } from './staging-unit-gate.ts';
import { deployEligibilityPath } from './staging-deploy.ts';
import { planNxJsonPath } from './staging-plan.ts';

const SHA = 'a'.repeat(40);
const CONFIG_PATH = '/repo/apps/home/wrangler.jsonc';

const ELIGIBILITY_TEXT = `
{
  "schemaVersion": 1,
  "production": { "status": "excluded", "reason": "promotion lane only" },
  "rules": [{ "match": "*", "staging": "excluded", "reason": "default closed" }],
  "projects": {
    "@ecoma-io/home": { "staging": "releaseable" },
    "@ecoma-io/ghost": { "staging": "excluded", "reason": "not shipped" }
  }
}
`;

/** Config sạch: identity đúng + lane staging khai lại đủ binding với id thật. */
const CLEAN_CONFIG = `
{
  "name": "ecoma-home",
  "kv_namespaces": [{ "binding": "KV_APP", "id": "top-kv-id" }],
  "env": {
    "staging": {
      "name": "stg-ecoma-home",
      "kv_namespaces": [{ "binding": "KV_APP", "id": "stg-kv-id" }]
    }
  }
}
`;

function deps(files: Record<string, string>): { readTextFile: (path: string) => string } {
  return {
    readTextFile: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: no such file: ${path}`);
      return text;
    },
  };
}

function happyFiles(configText: string = CLEAN_CONFIG): Record<string, string> {
  return {
    [CONFIG_PATH]: configText,
    [deployEligibilityPath()]: ELIGIBILITY_TEXT,
    [planNxJsonPath()]: JSON.stringify({
      release: { projects: ['@ecoma-io/home', '@ecoma-io/auth-nonce-prune-job'] },
    }),
  };
}

const INPUT = { project: '@ecoma-io/home', configPath: CONFIG_PATH, refSha: SHA };

describe('evaluateStagingUnitGate', () => {
  it('allows a clean releaseable unit whose lane re-declares every binding', () => {
    const result = evaluateStagingUnitGate(INPUT, deps(happyFiles()));
    expect(result.allowed).toBe(true);
    expect(result.decision.allowed).toBe(true);
    expect(result.decision.lane).toBe('staging');
    expect(result.bindingProblems).toEqual([]);
    expect(result.decision.reasons).toEqual([]);
  });

  it('denies with machine-readable reasons when the project is unclassified', () => {
    const files = happyFiles();
    // Bỏ rule catch-all để @ecoma-io/mystery THẬT SỰ không được phân loại —
    // evaluateEligibility throw là deny có code, message giữ nguyên nội dung chặn.
    files[deployEligibilityPath()] = ELIGIBILITY_TEXT.replace(
      '"rules": [{ "match": "*", "staging": "excluded", "reason": "default closed" }],',
      '"rules": [],',
    );
    const result = evaluateStagingUnitGate({ ...INPUT, project: '@ecoma-io/mystery' }, deps(files));
    expect(result.allowed).toBe(false);
    const codes = result.decision.reasons.map((reason) => reason.code);
    expect(codes).toContain('project-unclassified');
    expect(codes).toContain('not-in-release-projects');
    expect(
      result.decision.reasons.find((reason) => reason.code === 'project-unclassified')?.message,
    ).toContain('classifies none of: @ecoma-io/mystery');
  });

  it('denies an excluded project with project-not-releaseable', () => {
    const result = evaluateStagingUnitGate(
      { ...INPUT, project: '@ecoma-io/ghost' },
      deps(happyFiles()),
    );
    expect(result.allowed).toBe(false);
    expect(result.decision.reasons.map((reason) => reason.code)).toContain(
      'project-not-releaseable',
    );
  });

  it('denies a project absent from nx.json release.projects', () => {
    const files = happyFiles();
    files[planNxJsonPath()] = JSON.stringify({ release: { projects: ['@ecoma-io/other'] } });
    const result = evaluateStagingUnitGate(INPUT, deps(files));
    expect(result.allowed).toBe(false);
    expect(result.decision.reasons.map((reason) => reason.code)).toContain(
      'not-in-release-projects',
    );
  });

  it('denies with unit-identity-missing when the config declares no env.staging.name', () => {
    const files = happyFiles('{ "name": "ecoma-home", "env": {} }');
    const result = evaluateStagingUnitGate(INPUT, deps(files));
    expect(result.allowed).toBe(false);
    expect(result.decision.reasons.map((reason) => reason.code)).toContain('unit-identity-missing');
  });

  it('denies with unit-identity-invalid when the staging name is not an stg- identity', () => {
    const files = happyFiles(CLEAN_CONFIG.replace('stg-ecoma-home', 'ecoma-home'));
    const result = evaluateStagingUnitGate(INPUT, deps(files));
    expect(result.allowed).toBe(false);
    expect(result.decision.reasons.map((reason) => reason.code)).toContain('unit-identity-invalid');
  });

  it('denies with ref-sha-invalid on a short ref', () => {
    const result = evaluateStagingUnitGate({ ...INPUT, refSha: 'HEAD' }, deps(happyFiles()));
    expect(result.allowed).toBe(false);
    expect(result.decision.reasons.map((reason) => reason.code)).toEqual(['ref-sha-invalid']);
  });

  it('denies while binding problems are non-empty (§9.1)', () => {
    // Top-level KV không được khai lại ở lane staging → problem → deny.
    const files = happyFiles(
      CLEAN_CONFIG.replace(
        /[ \t]*"kv_namespaces": \[\{ "binding": "KV_APP", "id": "stg-kv-id" \}\]\n/u,
        '',
      ),
    );
    const result = evaluateStagingUnitGate(INPUT, deps(files));
    expect(result.allowed).toBe(false);
    expect(result.bindingProblems.map((problem) => problem.kind)).toContain(
      'top-level-not-redeclared',
    );
    // Config vẫn đúng identity — cổng deploy tự cho qua, deny đến từ bindings.
    expect(result.decision.allowed).toBe(true);
  });

  it('blocks (throws) on an unreadable wrangler config — no deny guessing', () => {
    expect(() => evaluateStagingUnitGate(INPUT, deps({}))).toThrowError(/ENOENT/u);
  });

  it('denies when the eligibility inventory is unparseable — the gate refuses a classification it cannot read', () => {
    const files = happyFiles();
    files[deployEligibilityPath()] = 'not json';
    const result = evaluateStagingUnitGate(INPUT, deps(files));
    expect(result.allowed).toBe(false);
    const unclassified = result.decision.reasons.find(
      (reason) => reason.code === 'project-unclassified',
    );
    expect(unclassified?.message).toContain('not valid JSON');
  });

  it('blocks (throws) on an unreadable nx.json', () => {
    const files = happyFiles();
    // Override readTextFile thay vì delete key (no-dynamic-delete): nx.json đọc hỏng.
    const broken: { readTextFile: (path: string) => string } = {
      readTextFile: (path) => {
        if (path === planNxJsonPath()) throw new Error(`ENOENT: no such file: ${path}`);
        const text = files[path];
        if (text === undefined) throw new Error(`ENOENT: no such file: ${path}`);
        return text;
      },
    };
    expect(() => evaluateStagingUnitGate(INPUT, broken)).toThrowError(/ENOENT/u);
  });
});
