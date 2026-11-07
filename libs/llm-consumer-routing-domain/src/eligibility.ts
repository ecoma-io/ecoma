/**
 * Candidate eligibility gate — chay TRUOC strategy selection. Chi candidate
 * pass eligibility moi vao tap strategy.
 *
 * Nhận facts làm input, không truy vấn bên ngoài. Mỗi fact là một điều kiện
 * độc lập; một candidate bị loại nếu bất kỳ fact nào không thoả mãn, và mọi
 * lý do từ chối được ghi lại cùng lúc (không dừng ở lý do đầu tiên).
 */

import type { Candidate, CandidateId } from './candidate';
import type { DomainOk, DomainRejection } from './shared';

export type EligibilityDenialReason =
  | 'candidate_inactive'
  | 'capability_mismatch'
  | 'health_unavailable'
  | 'policy_disallows_candidate'
  | 'tenant_scope_denied';

export type EligibilityFacts = {
  readonly capabilityMatches: boolean;
  readonly healthOk: boolean; // khong circuit-open, trong ngưỡng
  readonly policyAllows: boolean; // read-only: quyen dung candidate / policy tĩnh
  readonly tenantScopeAllows: boolean; // duoc duyen tu offer/tenant + principal, khong tu client input
};

export type CandidateEligibility =
  | DomainOk<{ readonly candidateId: CandidateId; readonly eligible: true }>
  | (DomainRejection<EligibilityDenialReason> & {
      readonly eligible: false;
      readonly denialReasons: readonly EligibilityDenialReason[];
    });

export function evaluateEligibility(
  candidate: Candidate,
  facts: EligibilityFacts,
): CandidateEligibility {
  const resolvedFacts = facts ?? emptyFacts();
  const denialReasons: EligibilityDenialReason[] = [];

  if (candidate.status !== 'active') {
    denialReasons.push('candidate_inactive');
  }
  if (!resolvedFacts.capabilityMatches) {
    denialReasons.push('capability_mismatch');
  }
  if (!resolvedFacts.healthOk) {
    denialReasons.push('health_unavailable');
  }
  if (!resolvedFacts.policyAllows) {
    denialReasons.push('policy_disallows_candidate');
  }
  if (!resolvedFacts.tenantScopeAllows) {
    denialReasons.push('tenant_scope_denied');
  }

  if (denialReasons.length > 0) {
    return {
      ok: false,
      eligible: false,
      reason: denialReasons[0],
      denialReasons,
      detail: `Candidate ${candidate.candidateId} is ineligible: ${denialReasons.join(', ')}.`,
    };
  }

  return { ok: true, eligible: true, candidateId: candidate.candidateId };
}

export function filterEligible(
  candidates: readonly Candidate[],
  factsById: Record<CandidateId, EligibilityFacts>,
): {
  readonly eligible: readonly Candidate[];
  readonly ineligible: readonly {
    readonly candidate: Candidate;
    readonly reasons: readonly EligibilityDenialReason[];
  }[];
} {
  const eligible: Candidate[] = [];
  const ineligible: {
    readonly candidate: Candidate;
    readonly reasons: readonly EligibilityDenialReason[];
  }[] = [];

  for (const candidate of candidates) {
    const facts = factsById[candidate.candidateId];
    const result = evaluateEligibility(candidate, facts ?? emptyFacts());
    if (result.ok) {
      eligible.push(candidate);
    } else {
      ineligible.push({ candidate, reasons: result.denialReasons });
    }
  }

  return { eligible, ineligible };
}

function emptyFacts(): EligibilityFacts {
  return {
    capabilityMatches: false,
    healthOk: false,
    policyAllows: false,
    tenantScopeAllows: false,
  };
}
