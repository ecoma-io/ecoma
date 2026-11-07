import { describe, expect, it } from 'vitest';

import { evaluateEligibility, filterEligible, type EligibilityFacts } from './eligibility';
import { CANDIDATE_STATUS, type Candidate, type CandidateId } from './candidate';

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    candidateId: 'cand-a' as CandidateId,
    status: CANDIDATE_STATUS.active,
    priority: 1,
    capability: { model: 'claude-3-5-sonnet', streaming: true },
    endpoints: ['https://endpoint-a.example.com'],
    offerId: 'offer-1',
    ...overrides,
  } as Candidate;
}

function facts(overrides: Partial<EligibilityFacts> = {}): EligibilityFacts {
  return {
    capabilityMatches: true,
    healthOk: true,
    policyAllows: true,
    tenantScopeAllows: true,
    ...overrides,
  };
}

describe('eligibility gate', () => {
  it('marks an active candidate eligible when all facts pass', () => {
    const result = evaluateEligibility(candidate(), facts());
    expect(result.ok).toBe(true);
    expect(result.ok && result.eligible).toBe(true);
  });

  it('rejects inactive candidate', () => {
    const result = evaluateEligibility(candidate({ status: 'disabled' }), facts());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.eligible).toBe(false);
    expect(!result.ok && result.denialReasons).toContain('candidate_inactive');
  });

  it('rejects retired candidate', () => {
    const result = evaluateEligibility(candidate({ status: 'retired' }), facts());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.denialReasons).toContain('candidate_inactive');
  });

  it('rejects capability mismatch', () => {
    const result = evaluateEligibility(candidate(), facts({ capabilityMatches: false }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.denialReasons).toContain('capability_mismatch');
  });

  it('rejects circuit-open / unhealthy candidate', () => {
    const result = evaluateEligibility(candidate(), facts({ healthOk: false }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.denialReasons).toContain('health_unavailable');
  });

  it('rejects policy-disallowed candidate', () => {
    const result = evaluateEligibility(candidate(), facts({ policyAllows: false }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.denialReasons).toContain('policy_disallows_candidate');
  });

  it('rejects out-of-tenant scope candidate', () => {
    const result = evaluateEligibility(candidate(), facts({ tenantScopeAllows: false }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.denialReasons).toContain('tenant_scope_denied');
  });

  it('records multiple simultaneous denial reasons', () => {
    const result = evaluateEligibility(
      candidate({ status: 'retired' }),
      facts({
        capabilityMatches: false,
        healthOk: false,
        policyAllows: false,
        tenantScopeAllows: false,
      }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.denialReasons).toHaveLength(5);
    const reasons = !result.ok ? new Set(result.denialReasons) : new Set<string>();
    expect(reasons).toEqual(
      new Set([
        'candidate_inactive',
        'capability_mismatch',
        'health_unavailable',
        'policy_disallows_candidate',
        'tenant_scope_denied',
      ]),
    );
  });

  it('filterEligible partitions eligible and ineligible', () => {
    const cands = [
      candidate({ candidateId: 'a' as CandidateId }),
      candidate({ candidateId: 'b' as CandidateId, status: 'retired' }),
    ];
    const byId: Record<string, EligibilityFacts> = {
      a: facts(),
      b: facts(),
    };
    const out = filterEligible(cands, byId as Record<CandidateId, EligibilityFacts>);
    expect(out.eligible).toHaveLength(1);
    expect(out.eligible[0].candidateId).toBe('a');
    expect(out.ineligible).toHaveLength(1);
    expect(out.ineligible[0].candidate.candidateId).toBe('b');
  });

  it('treats missing facts as all-false (fail-closed)', () => {
    const result = evaluateEligibility(candidate(), undefined as unknown as EligibilityFacts);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.denialReasons).toHaveLength(4);
  });
});
