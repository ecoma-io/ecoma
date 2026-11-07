import { describe, expect, it } from 'vitest';

import { createSellerActorId, createSellerTenantId } from '@ecoma-io/llm-seller-tenant-domain';
import { createEvidenceId, createVerificationCaseId } from './shared';
import { createEvidenceReference, type EvidenceReference } from './evidence';
import {
  createVerificationCase,
  decideVerification,
  deriveOnboardingState,
  deriveOperationalEligibility,
  expireVerificationCase,
  isVerificationCase,
  startVerificationReview,
  submitVerificationCase,
  type VerificationCase,
} from './verification';
import type { RestrictionEvaluation } from './restriction';

function expectOk<Value>(
  result: { ok: true; value: Value } | { ok: false; error: { code: string } },
): Value {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}`);
  }
  return result.value;
}

function expectRejection(result: { ok: true } | { ok: false; error: { code: string } }): string {
  if (result.ok) {
    throw new Error('expected rejection, got ok');
  }
  return result.error.code;
}

const TENANT = createSellerTenantId('tenant-1');
const OTHER_TENANT = createSellerTenantId('tenant-2');
const ACTOR = createSellerActorId('member-1');
const REVIEWER = createSellerActorId('reviewer-1');
const AT = 1_700_000_000_000;

const TENANT_TARGET = Object.freeze({ kind: 'tenant' as const });

const CLEAR: RestrictionEvaluation = {
  tenantId: TENANT,
  target: TENANT_TARGET,
  blocked: false,
  unevaluable: false,
  blockingRecordIds: [],
  unknownPolicies: [],
};

function verificationCase(type = 'business'): VerificationCase {
  return expectOk(
    createVerificationCase({
      id: createVerificationCaseId(`vc-${type}`),
      tenantId: TENANT,
      type,
      createdAt: AT,
    }),
  );
}

function evidence(id = 'e-1', tenantId = TENANT): EvidenceReference {
  return expectOk(
    createEvidenceReference({
      id: createEvidenceId(id),
      tenantId,
      kind: 'business_registration',
      storageRef: `blob://evidence/${tenantId}/${id}`,
      contentHash: 'sha256:abc',
      recordedAt: AT,
      recordedBy: ACTOR,
    }),
  );
}

function submittedCase(type = 'business'): VerificationCase {
  return expectOk(
    submitVerificationCase({
      verificationCase: verificationCase(type),
      submissionId: `s-${type}`,
      evidence: [evidence()],
      submittedBy: ACTOR,
      submittedAt: AT + 10,
    }),
  );
}

function approvedCase(type = 'business'): VerificationCase {
  const review = expectOk(
    startVerificationReview({
      verificationCase: submittedCase(type),
      reviewer: REVIEWER,
      reviewedAt: AT + 20,
    }),
  );
  return expectOk(
    decideVerification({
      verificationCase: review,
      decision: 'approved',
      decidedBy: REVIEWER,
      decidedAt: AT + 30,
    }),
  );
}

describe('verification does not change tenant creation semantics', () => {
  it('creates a draft case without touching tenant existence', () => {
    const created = verificationCase();
    expect(created.status).toBe('draft');
    expect(created.submissions).toEqual([]);
    expect(created).not.toHaveProperty('tenantStatus');
  });
});

describe('submitVerificationCase', () => {
  it('appends an immutable submission', () => {
    const submitted = submittedCase();
    expect(submitted.status).toBe('submitted');
    expect(submitted.submissions).toHaveLength(1);
    expect(Object.isFrozen(submitted.submissions[0])).toBe(true);
    expect(submitted.submissions[0]?.evidenceIds).toEqual(['e-1']);
  });

  it('rejects an empty evidence list', () => {
    expect(
      expectRejection(
        submitVerificationCase({
          verificationCase: verificationCase(),
          submissionId: 's-1',
          evidence: [],
          submittedBy: ACTOR,
          submittedAt: AT,
        }),
      ),
    ).toBe('evidence_missing');
  });

  it('rejects duplicate evidence within one submission', () => {
    expect(
      expectRejection(
        submitVerificationCase({
          verificationCase: verificationCase(),
          submissionId: 's-1',
          evidence: [evidence(), evidence()],
          submittedBy: ACTOR,
          submittedAt: AT,
        }),
      ),
    ).toBe('duplicate_evidence');
  });

  it('rejects evidence from another tenant', () => {
    expect(
      expectRejection(
        submitVerificationCase({
          verificationCase: verificationCase(),
          submissionId: 's-1',
          evidence: [evidence('e-foreign', OTHER_TENANT)],
          submittedBy: ACTOR,
          submittedAt: AT,
        }),
      ),
    ).toBe('evidence_not_in_tenant');
  });

  it('rejects a duplicate submission id', () => {
    const submitted = submittedCase();
    const rejected = expectOk(
      decideVerification({
        verificationCase: expectOk(
          startVerificationReview({
            verificationCase: submitted,
            reviewer: REVIEWER,
            reviewedAt: AT + 20,
          }),
        ),
        decision: 'rejected',
        decidedBy: REVIEWER,
        decidedAt: AT + 30,
        publicDecisionReason: 'Document unreadable.',
      }),
    );
    expect(
      expectRejection(
        submitVerificationCase({
          verificationCase: rejected,
          submissionId: 's-business',
          evidence: [evidence()],
          submittedBy: ACTOR,
          submittedAt: AT + 40,
        }),
      ),
    ).toBe('duplicate_submission_id');
  });

  it('rejects submission from an invalid state', () => {
    expect(
      expectRejection(
        submitVerificationCase({
          verificationCase: submittedCase(),
          submissionId: 's-2',
          evidence: [evidence()],
          submittedBy: ACTOR,
          submittedAt: AT + 40,
        }),
      ),
    ).toBe('invalid_verification_transition');
  });

  it('allows resubmission after rejection and preserves prior submissions', () => {
    const rejected = expectOk(
      decideVerification({
        verificationCase: expectOk(
          startVerificationReview({
            verificationCase: submittedCase(),
            reviewer: REVIEWER,
            reviewedAt: AT + 20,
          }),
        ),
        decision: 'rejected',
        decidedBy: REVIEWER,
        decidedAt: AT + 30,
        publicDecisionReason: 'Document unreadable.',
      }),
    );
    const resubmitted = expectOk(
      submitVerificationCase({
        verificationCase: rejected,
        submissionId: 's-business-2',
        evidence: [evidence('e-2')],
        submittedBy: ACTOR,
        submittedAt: AT + 40,
      }),
    );
    expect(resubmitted.status).toBe('submitted');
    expect(resubmitted.submissions).toHaveLength(2);
    expect(resubmitted.publicDecisionReason).toBeNull();
    expect(resubmitted.decidedAt).toBeNull();
  });
});

describe('verification decisions', () => {
  it('runs submitted -> under_review -> approved', () => {
    const approved = approvedCase();
    expect(approved.status).toBe('approved');
    expect(approved.decidedBy).toBe(REVIEWER);
  });

  it('rejects an unknown decision with a dedicated error code', () => {
    const review = expectOk(
      startVerificationReview({
        verificationCase: submittedCase(),
        reviewer: REVIEWER,
        reviewedAt: AT + 20,
      }),
    );
    expect(
      expectRejection(
        decideVerification({
          verificationCase: review,
          decision: 'maybe',
          decidedBy: REVIEWER,
          decidedAt: AT + 30,
        }),
      ),
    ).toBe('invalid_decision');
  });

  it('reports a corrupted case before validating primitive arguments', () => {
    const corrupted = { ...submittedCase(), status: 'unknown' } as unknown as VerificationCase;
    expect(
      expectRejection(
        decideVerification({
          verificationCase: corrupted,
          decision: 'maybe',
          decidedBy: '',
          decidedAt: 'nope' as never,
        }),
      ),
    ).toBe('invalid_verification_case');
    expect(
      expectRejection(
        startVerificationReview({
          verificationCase: corrupted,
          reviewer: '',
          reviewedAt: 'nope' as never,
        }),
      ),
    ).toBe('invalid_verification_case');
  });

  it('requires a public reason when rejecting', () => {
    const review = expectOk(
      startVerificationReview({
        verificationCase: submittedCase(),
        reviewer: REVIEWER,
        reviewedAt: AT + 20,
      }),
    );
    expect(
      expectRejection(
        decideVerification({
          verificationCase: review,
          decision: 'rejected',
          decidedBy: REVIEWER,
          decidedAt: AT + 30,
        }),
      ),
    ).toBe('missing_public_decision_reason');
  });

  it('rejects decisions from an invalid state', () => {
    expect(
      expectRejection(
        decideVerification({
          verificationCase: submittedCase(),
          decision: 'approved',
          decidedBy: REVIEWER,
          decidedAt: AT + 30,
        }),
      ),
    ).toBe('invalid_verification_transition');
  });

  it('expires an approved case only with a coherent window', () => {
    const approved = approvedCase();
    expect(
      expectRejection(
        expireVerificationCase({
          verificationCase: approved,
          expiresAt: AT + 30,
          expiredAt: AT + 30,
        }),
      ),
    ).toBe('invalid_verification_transition');
    expect(
      expectRejection(
        expireVerificationCase({
          verificationCase: approved,
          expiresAt: AT + 100,
          expiredAt: AT + 90,
        }),
      ),
    ).toBe('invalid_verification_transition');

    const expired = expectOk(
      expireVerificationCase({
        verificationCase: approved,
        expiresAt: AT + 100,
        expiredAt: AT + 100,
      }),
    );
    expect(expired.status).toBe('expired');
    expect(expired.expiresAt).toBe(AT + 100);
    expect(expired.expiredAt).toBe(AT + 100);
  });

  it('rejects expiring a case that was never approved', () => {
    expect(
      expectRejection(
        expireVerificationCase({
          verificationCase: verificationCase(),
          expiresAt: AT + 100,
          expiredAt: AT + 100,
        }),
      ),
    ).toBe('invalid_verification_transition');
  });
});

describe('deriveOnboardingState', () => {
  it('is complete only when every required type has an approved case', () => {
    const state = expectOk(
      deriveOnboardingState({
        tenantId: TENANT,
        cases: [approvedCase('business')],
        requiredTypes: ['business', 'identity'],
      }),
    );
    expect(state.complete).toBe(false);
    expect(state.pendingTypes).toEqual(['identity']);
  });

  it('reports a rejected required type as an issue', () => {
    const rejected = expectOk(
      decideVerification({
        verificationCase: expectOk(
          startVerificationReview({
            verificationCase: submittedCase('identity'),
            reviewer: REVIEWER,
            reviewedAt: AT + 20,
          }),
        ),
        decision: 'rejected',
        decidedBy: REVIEWER,
        decidedAt: AT + 30,
        publicDecisionReason: 'Expired document.',
      }),
    );
    const state = expectOk(
      deriveOnboardingState({
        tenantId: TENANT,
        cases: [rejected],
        requiredTypes: ['identity'],
      }),
    );
    expect(state.issues).toEqual(['identity']);
    expect(state.complete).toBe(false);
  });

  it('treats an expired approval as no longer complete', () => {
    const approved = approvedCase('business');
    const expired = expectOk(
      expireVerificationCase({
        verificationCase: approved,
        expiresAt: AT + 100,
        expiredAt: AT + 100,
      }),
    );
    const state = expectOk(
      deriveOnboardingState({ tenantId: TENANT, cases: [expired], requiredTypes: ['business'] }),
    );
    expect(state.complete).toBe(false);
    expect(state.pendingTypes).toEqual(['business']);
  });

  it('reports an issue only for the latest case of a type', () => {
    const rejected = expectOk(
      decideVerification({
        verificationCase: expectOk(
          startVerificationReview({
            verificationCase: submittedCase('identity'),
            reviewer: REVIEWER,
            reviewedAt: AT + 20,
          }),
        ),
        decision: 'rejected',
        decidedBy: REVIEWER,
        decidedAt: AT + 30,
        publicDecisionReason: 'Expired document.',
      }),
    );
    const resubmitted = expectOk(
      createVerificationCase({
        id: createVerificationCaseId('vc-identity-2'),
        tenantId: TENANT,
        type: 'identity',
        createdAt: AT + 40,
      }),
    );
    const resubmittedAndSubmitted = expectOk(
      submitVerificationCase({
        verificationCase: resubmitted,
        submissionId: 's-identity-2',
        evidence: [evidence('e-2')],
        submittedBy: ACTOR,
        submittedAt: AT + 50,
      }),
    );
    const state = expectOk(
      deriveOnboardingState({
        tenantId: TENANT,
        cases: [rejected, resubmittedAndSubmitted],
        requiredTypes: ['identity'],
      }),
    );
    expect(state.pendingTypes).toEqual(['identity']);
    expect(state.issues).toEqual([]);
  });

  it('rejects cases from another tenant', () => {
    const foreign = Object.freeze({ ...verificationCase(), tenantId: OTHER_TENANT });
    expect(
      expectRejection(
        deriveOnboardingState({
          tenantId: TENANT,
          cases: [foreign],
          requiredTypes: ['business'],
        }),
      ),
    ).toBe('inconsistent_context');
  });
});

describe('deriveOperationalEligibility', () => {
  const legal = [
    {
      tenantId: TENANT,
      version: 1,
      legalName: 'Acme Ltd',
      legalType: 'company',
      jurisdiction: 'VN',
      registrationReference: 'REG-1',
      effectiveFrom: AT - 100,
      recordedAt: AT - 100,
      recordedBy: ACTOR,
    },
  ];
  const tax = [
    {
      tenantId: TENANT,
      version: 1,
      taxResidency: 'VN',
      taxIdentifier: 'TAX-1',
      declarationReference: 'DECL-1',
      effectiveFrom: AT - 100,
      recordedAt: AT - 100,
      recordedBy: ACTOR,
    },
  ];

  it('is eligible when restriction, verification, legal and tax all pass', () => {
    const eligibility = expectOk(
      deriveOperationalEligibility({
        tenantId: TENANT,
        restrictions: CLEAR,
        cases: [approvedCase()],
        requiredTypes: ['business'],
        legalProfileVersions: legal,
        taxProfileVersions: tax,
        now: AT + 50,
      }),
    );
    expect(eligibility).toEqual({ eligible: true, blockers: [] });
  });

  it('fails closed when restriction was never evaluated', () => {
    const eligibility = expectOk(
      deriveOperationalEligibility({
        tenantId: TENANT,
        restrictions: undefined,
        cases: [approvedCase()],
        requiredTypes: ['business'],
        legalProfileVersions: legal,
        taxProfileVersions: tax,
        now: AT + 50,
      }),
    );
    expect(eligibility.blockers).toEqual(['restriction']);
  });

  it('fails closed when restriction is unevaluable', () => {
    expect(
      expectOk(
        deriveOperationalEligibility({
          tenantId: TENANT,
          restrictions: { ...CLEAR, unevaluable: true },
          cases: [approvedCase()],
          requiredTypes: ['business'],
          legalProfileVersions: legal,
          taxProfileVersions: tax,
          now: AT + 50,
        }),
      ).blockers,
    ).toEqual(['restriction']);
  });

  it('reports every independent blocker', () => {
    const blockers = expectOk(
      deriveOperationalEligibility({
        tenantId: TENANT,
        restrictions: { ...CLEAR, blocked: true },
        cases: [],
        requiredTypes: ['business'],
        legalProfileVersions: [],
        taxProfileVersions: [],
        now: AT + 50,
      }),
    ).blockers;
    expect(blockers).toEqual(['restriction', 'verification', 'legal_profile', 'tax_profile']);
  });

  it('ignores a profile version that is not yet effective', () => {
    const futureLegal = [{ ...legal[0], effectiveFrom: AT + 1000, version: 2 }];
    expect(
      expectOk(
        deriveOperationalEligibility({
          tenantId: TENANT,
          restrictions: CLEAR,
          cases: [approvedCase()],
          requiredTypes: ['business'],
          legalProfileVersions: futureLegal,
          taxProfileVersions: tax,
          now: AT + 50,
        }),
      ).blockers,
    ).toEqual(['legal_profile']);
  });

  it('fails closed on an evaluation from another tenant', () => {
    expect(
      expectOk(
        deriveOperationalEligibility({
          tenantId: TENANT,
          restrictions: { ...CLEAR, tenantId: OTHER_TENANT },
          cases: [approvedCase()],
          requiredTypes: ['business'],
          legalProfileVersions: legal,
          taxProfileVersions: tax,
          now: AT + 50,
        }),
      ).blockers,
    ).toEqual(['restriction']);
  });

  it('fails closed on a malformed or null evaluation', () => {
    for (const restrictions of [
      { tenantId: TENANT, target: TENANT_TARGET } as never,
      null as never,
    ]) {
      expect(
        expectOk(
          deriveOperationalEligibility({
            tenantId: TENANT,
            restrictions,
            cases: [approvedCase()],
            requiredTypes: ['business'],
            legalProfileVersions: legal,
            taxProfileVersions: tax,
            now: AT + 50,
          }),
        ).blockers,
      ).toEqual(['restriction']);
    }
  });

  it('fails closed on an evaluation for a capability target', () => {
    expect(
      expectOk(
        deriveOperationalEligibility({
          tenantId: TENANT,
          restrictions: { ...CLEAR, target: { kind: 'capability', capability: 'payout' } },
          cases: [approvedCase()],
          requiredTypes: ['business'],
          legalProfileVersions: legal,
          taxProfileVersions: tax,
          now: AT + 50,
        }),
      ).blockers,
    ).toEqual(['restriction']);
  });

  it('rejects profile versions from another tenant', () => {
    expect(
      expectRejection(
        deriveOperationalEligibility({
          tenantId: TENANT,
          restrictions: CLEAR,
          cases: [approvedCase()],
          requiredTypes: ['business'],
          legalProfileVersions: [{ ...legal[0], tenantId: OTHER_TENANT }],
          taxProfileVersions: tax,
          now: AT + 50,
        }),
      ),
    ).toBe('inconsistent_context');
  });

  it('rejects corrupted profile versions instead of throwing', () => {
    expect(
      expectRejection(
        deriveOperationalEligibility({
          tenantId: TENANT,
          restrictions: CLEAR,
          cases: [approvedCase()],
          requiredTypes: ['business'],
          legalProfileVersions: [null] as never,
          taxProfileVersions: tax,
          now: AT + 50,
        }),
      ),
    ).toBe('invalid_profile_version');
    expect(
      expectRejection(
        deriveOperationalEligibility({
          tenantId: TENANT,
          restrictions: CLEAR,
          cases: [approvedCase()],
          requiredTypes: ['business'],
          legalProfileVersions: legal,
          taxProfileVersions: [{ ...tax[0], taxResidency: '' }] as never,
          now: AT + 50,
        }),
      ),
    ).toBe('invalid_profile_version');
  });
});

describe('isVerificationCase', () => {
  it('returns a domain error rather than throwing on a corrupted case', () => {
    expect(
      expectRejection(
        startVerificationReview({
          verificationCase: null as never,
          reviewer: REVIEWER,
          reviewedAt: AT + 20,
        }),
      ),
    ).toBe('invalid_verification_case');
    expect(
      expectRejection(
        submitVerificationCase({
          verificationCase: { id: 'vc-1' } as never,
          submissionId: 's-1',
          evidence: [evidence()],
          submittedBy: ACTOR,
          submittedAt: AT + 10,
        }),
      ),
    ).toBe('invalid_verification_case');
    expect(
      expectRejection(
        createVerificationCase({
          id: createVerificationCaseId('vc-new'),
          tenantId: TENANT,
          type: 'business',
          createdAt: AT,
          existing: [null] as never,
        }),
      ),
    ).toBe('invalid_verification_case');
  });

  it('rejects inconsistent shapes', () => {
    const good = approvedCase();
    expect(isVerificationCase(good)).toBe(true);
    expect(isVerificationCase({ ...good, status: 'unknown' })).toBe(false);
    expect(isVerificationCase({ ...good, submissions: undefined })).toBe(false);
  });
});
