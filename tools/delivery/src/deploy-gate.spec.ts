import { describe, expect, it } from 'vitest';

import { evaluateDeployGate, type DeployGateInput } from './deploy-gate.ts';
import type { EligibilityDecision } from './release-allowlist.ts';

/** Quyết định eligibility releaseable chuẩn cho input gate. */
const RELEASEABLE: EligibilityDecision = {
  project: '@ecoma-io/home',
  status: 'releaseable',
  source: 'explicit',
};

const FULL_SHA = 'a'.repeat(40);

/** Input hợp lệ đầy đủ — mỗi test deny bỏ đúng một vế để chốt fail-closed. */
function fullInput(overrides: Partial<DeployGateInput> = {}): DeployGateInput {
  return {
    project: '@ecoma-io/home',
    lane: 'staging',
    eligibility: RELEASEABLE,
    inReleaseProjects: true,
    unitIdentity: 'stg-ecoma-home',
    refSha: FULL_SHA,
    ...overrides,
  };
}

const CODES = (input: DeployGateInput) =>
  evaluateDeployGate(input).reasons.map((reason) => reason.code);

describe('evaluateDeployGate', () => {
  it('allows a fully specified staging deploy of a releaseable unit', () => {
    const decision = evaluateDeployGate(fullInput());
    expect(decision).toMatchObject({ allowed: true, lane: 'staging', reasons: [] });
  });

  it('denies an empty project name instead of producing a confusing quoted-empty message', () => {
    // eligibility trùng project rỗng để project-missing là lý do duy nhất.
    expect(CODES(fullInput({ project: '', eligibility: { ...RELEASEABLE, project: '' } }))).toEqual(
      ['project-missing'],
    );
  });

  it('denies when the lane parameter is missing — no default lane may exist', () => {
    expect(CODES(fullInput({ lane: undefined }))).toEqual(['lane-missing']);
  });

  it('denies an unknown lane value', () => {
    expect(CODES(fullInput({ lane: 'prod' }))).toEqual(['lane-invalid']);
  });

  it('denies the production lane outright and points at the promotion lifecycle', () => {
    const decision = evaluateDeployGate(fullInput({ lane: 'production' }));
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.map((reason) => reason.code)).toEqual(['production-lane-forbidden']);
    expect(decision.reasons[0]?.message).toMatch(/promotion|release lifecycle/u);
  });

  it('denies when no eligibility decision was provided', () => {
    expect(CODES(fullInput({ eligibility: undefined }))).toEqual(['eligibility-missing']);
  });

  it('denies when the eligibility decision names a different project', () => {
    expect(
      CODES(fullInput({ eligibility: { ...RELEASEABLE, project: '@ecoma-io/other' } })),
    ).toEqual(['project-unclassified']);
  });

  it('denies a non-releaseable project and carries the eligibility reason', () => {
    const decision = evaluateDeployGate(
      fullInput({
        project: '@ecoma-io/account',
        eligibility: {
          project: '@ecoma-io/account',
          status: 'excluded',
          source: 'explicit',
          reason: 'devOrigin placeholder in both lanes',
        },
      }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.map((reason) => reason.code)).toEqual(['project-not-releaseable']);
    expect(decision.reasons[0]?.message).toContain('devOrigin placeholder in both lanes');
  });

  it('degrades cleanly when a non-releaseable decision carries no reason', () => {
    const decision = evaluateDeployGate(
      fullInput({
        project: '@ecoma-io/account',
        eligibility: { project: '@ecoma-io/account', status: 'excluded', source: 'explicit' },
      }),
    );
    expect(decision.reasons.map((reason) => reason.code)).toEqual(['project-not-releaseable']);
    const message = decision.reasons[0]?.message ?? '';
    expect(message.endsWith('in deploy-eligibility.jsonc')).toBe(true);
    expect(message).not.toContain('undefined');
  });

  it('denies a project not confirmed in nx.json release.projects', () => {
    expect(CODES(fullInput({ inReleaseProjects: false }))).toEqual(['not-in-release-projects']);
    expect(CODES(fullInput({ inReleaseProjects: undefined }))).toEqual(['not-in-release-projects']);
  });

  it('denies when the staging unit identity is missing', () => {
    expect(CODES(fullInput({ unitIdentity: undefined }))).toEqual(['unit-identity-missing']);
  });

  it('denies a unit identity that is not a stg- staging identity', () => {
    expect(CODES(fullInput({ unitIdentity: 'ecoma-home' }))).toEqual(['unit-identity-invalid']);
    expect(CODES(fullInput({ unitIdentity: 'stg-' }))).toEqual(['unit-identity-invalid']);
  });

  it('denies when the ref SHA is missing', () => {
    expect(CODES(fullInput({ refSha: undefined }))).toEqual(['ref-sha-missing']);
  });

  it('denies a ref SHA that is not a full 40-hex commit SHA', () => {
    expect(CODES(fullInput({ refSha: 'abc123' }))).toEqual(['ref-sha-invalid']);
    expect(CODES(fullInput({ refSha: 'A'.repeat(40) }))).toEqual(['ref-sha-invalid']);
  });

  it('collects every deny reason in one evaluation instead of failing at the first', () => {
    const decision = evaluateDeployGate(
      fullInput({ eligibility: undefined, inReleaseProjects: false, refSha: 'nope' }),
    );
    expect(decision.reasons.map((reason) => reason.code)).toEqual([
      'eligibility-missing',
      'not-in-release-projects',
      'ref-sha-invalid',
    ]);
    expect(decision.allowed).toBe(false);
  });
});
