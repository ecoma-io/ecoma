import { describe, expect, it } from 'vitest';

import { createSellerActorId, createSellerTenantId } from '@ecoma-io/llm-seller-tenant-domain';
import { createEvidenceId, createLegalPrincipalId, createVerificationCaseId } from './shared';
import {
  createEvidenceReference,
  createPrincipalEvidenceReference,
  type EvidenceReference,
  type PrincipalEvidenceReference,
} from './evidence';
import { appendLegalProfileVersion } from './legal-profile';
import {
  createVerificationCase,
  decideVerification,
  deriveOnboardingState,
  deriveOperationalEligibility,
  expireVerificationCase,
  isVerificationCase,
  isVerificationProfileAxes,
  startVerificationReview,
  submitPrincipalVerificationCase,
  submitVerificationCase,
  type DeriveOperationalEligibilityInput,
  type VerificationCase,
  type VerificationProfileAxes,
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
const PRINCIPAL_ID = createLegalPrincipalId('principal-1');

const TENANT_TARGET = Object.freeze({ kind: 'tenant' as const });

const AXES: VerificationProfileAxes = Object.freeze([
  Object.freeze({ type: 'legal-identity', axis: 'legal' as const }),
  Object.freeze({ type: 'tax', axis: 'tax' as const }),
]);

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

function principalVerificationCase(type = 'legal-identity'): VerificationCase {
  return expectOk(
    createVerificationCase({
      id: createVerificationCaseId(`pc-${type}`),
      principalId: PRINCIPAL_ID,
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

function principalEvidence(id = 'pe-1'): PrincipalEvidenceReference {
  return expectOk(
    createPrincipalEvidenceReference({
      id: createEvidenceId(id),
      principalId: PRINCIPAL_ID,
      kind: 'business_registration',
      storageRef: `external://authoritative/${id}`,
      contentHash: 'sha256:principal',
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

function reviewOf(testCase: VerificationCase): VerificationCase {
  return expectOk(
    startVerificationReview({
      verificationCase: testCase,
      reviewer: REVIEWER,
      reviewedAt: AT + 20,
    }),
  );
}

/** Quyết định `approved` cho case tenant-scoped; trả lại case sau quyết định. */
function approvedCase(type = 'business'): VerificationCase {
  return expectOk(
    decideVerification({
      verificationCase: reviewOf(submittedCase(type)),
      decision: 'approved',
      decidedBy: REVIEWER,
      decidedAt: AT + 30,
    }),
  ).verificationCase;
}

describe('verification does not change tenant creation semantics', () => {
  it('creates a draft case without touching tenant existence', () => {
    const created = verificationCase();
    expect(created.status).toBe('draft');
    expect(created.submissions).toEqual([]);
    expect(created).not.toHaveProperty('tenantStatus');
  });
});

describe('verification case subjects (§3.3)', () => {
  it('creates a case with exactly one subject — tenant or principal, never both', () => {
    const tenantCase = verificationCase('business');
    expect(tenantCase.tenantId).toBe(TENANT);
    expect(tenantCase.principalId).toBeNull();
    const principalCase = principalVerificationCase('legal-identity');
    expect(principalCase.principalId).toBe(PRINCIPAL_ID);
    expect(principalCase.tenantId).toBeNull();
    expect(
      expectRejection(
        createVerificationCase({
          id: createVerificationCaseId('vc-both'),
          tenantId: TENANT,
          principalId: PRINCIPAL_ID,
          type: 'business',
          createdAt: AT,
        }),
      ),
    ).toBe('inconsistent_context');
    expect(
      expectRejection(
        createVerificationCase({
          id: createVerificationCaseId('vc-neither'),
          type: 'business',
          createdAt: AT,
        }),
      ),
    ).toBe('ambiguous_context');
  });

  it('rejects an existing collection mixing subjects', () => {
    expect(
      expectRejection(
        createVerificationCase({
          id: createVerificationCaseId('vc-mixed'),
          tenantId: TENANT,
          type: 'business',
          createdAt: AT,
          existing: [principalVerificationCase()],
        }),
      ),
    ).toBe('inconsistent_context');
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
    const rejected = expectOk(
      decideVerification({
        verificationCase: reviewOf(submittedCase()),
        decision: 'rejected',
        decidedBy: REVIEWER,
        decidedAt: AT + 30,
        publicDecisionReason: 'Document unreadable.',
      }),
    ).verificationCase;
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
        verificationCase: reviewOf(submittedCase()),
        decision: 'rejected',
        decidedBy: REVIEWER,
        decidedAt: AT + 30,
        publicDecisionReason: 'Document unreadable.',
      }),
    ).verificationCase;
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

describe('submitPrincipalVerificationCase (§3.8)', () => {
  it('appends a submission carrying the principal subject', () => {
    const submitted = expectOk(
      submitPrincipalVerificationCase({
        verificationCase: principalVerificationCase('legal-identity'),
        submissionId: 's-p-1',
        evidence: [principalEvidence()],
        submittedBy: ACTOR,
        submittedAt: AT + 10,
      }),
    );
    expect(submitted.status).toBe('submitted');
    expect(submitted.submissions[0]?.principalId).toBe(PRINCIPAL_ID);
    expect(submitted.submissions[0]?.tenantId).toBeNull();
  });

  it('rejects a tenant-scoped case on the principal path', () => {
    expect(
      expectRejection(
        submitPrincipalVerificationCase({
          verificationCase: verificationCase('business'),
          submissionId: 's-p-x',
          evidence: [principalEvidence()],
          submittedBy: ACTOR,
          submittedAt: AT + 10,
        }),
      ),
    ).toBe('inconsistent_context');
  });

  it('rejects principal evidence from another principal', () => {
    const foreignEvidence = expectOk(
      createPrincipalEvidenceReference({
        id: createEvidenceId('pe-foreign'),
        principalId: createLegalPrincipalId('principal-other'),
        kind: 'business_registration',
        storageRef: 'external://other',
        contentHash: 'sha256:other',
        recordedAt: AT,
        recordedBy: ACTOR,
      }),
    );
    expect(
      expectRejection(
        submitPrincipalVerificationCase({
          verificationCase: principalVerificationCase(),
          submissionId: 's-p-foreign',
          evidence: [foreignEvidence],
          submittedBy: ACTOR,
          submittedAt: AT + 10,
        }),
      ),
    ).toBe('inconsistent_context');
  });
});

describe('verification decisions', () => {
  it('runs submitted -> under_review -> approved', () => {
    const approved = approvedCase();
    expect(approved.status).toBe('approved');
    expect(approved.decidedBy).toBe(REVIEWER);
  });

  it('rejects an unknown decision with a dedicated error code', () => {
    expect(
      expectRejection(
        decideVerification({
          verificationCase: reviewOf(submittedCase()),
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
    expect(
      expectRejection(
        decideVerification({
          verificationCase: reviewOf(submittedCase()),
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

describe('decideVerification coverage pinning (§3.6)', () => {
  const legalV1 = [
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
  const taxV1 = [
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

  it('pins the profile version effective at decidedAt for an axis-bound type', () => {
    const approved = expectOk(
      decideVerification({
        verificationCase: reviewOf(submittedCase('legal-identity')),
        decision: 'approved',
        decidedBy: REVIEWER,
        decidedAt: AT + 30,
        profileAxes: AXES,
        legalProfileVersions: legalV1,
      }),
    ).verificationCase;
    expect(approved.verifiedProfileVersions).toEqual([{ axis: 'legal', version: 1 }]);
    // Type không gắn trục thì không pin.
    const unbound = approvedCase('business');
    expect(unbound.verifiedProfileVersions).toEqual([]);
  });

  it('counts only a pin matching the version effective at now, per axis', () => {
    const legalApproved = expectOk(
      decideVerification({
        verificationCase: reviewOf(submittedCase('legal-identity')),
        decision: 'approved',
        decidedBy: REVIEWER,
        decidedAt: AT + 30,
        profileAxes: AXES,
        legalProfileVersions: legalV1,
      }),
    ).verificationCase;
    // Trục legal được phủ; trục tax chưa có case nào ⇒ vẫn pending.
    const state = expectOk(
      deriveOnboardingState({
        tenantId: TENANT,
        cases: [legalApproved],
        requiredTypes: ['legal-identity', 'tax'],
        profileAxes: AXES,
        legalProfileVersions: legalV1,
        taxProfileVersions: taxV1,
        now: AT + 50,
      }),
    );
    expect(state.complete).toBe(false);
    expect(state.pendingTypes).toEqual(['tax']);
    // Tenant publish legal v2 hiệu lực sau khi approval ⇒ pin 1 stale,
    // approval không còn được tính (§3.6 coverage rule).
    const legalV2 = expectOk(
      appendLegalProfileVersion(legalV1, {
        tenantId: TENANT,
        legalName: 'Acme Ltd II',
        legalType: 'company',
        jurisdiction: 'VN',
        registrationReference: 'REG-2',
        effectiveFrom: AT + 40,
        recordedAt: AT + 40,
        recordedBy: ACTOR,
      }),
    );
    const stale = expectOk(
      deriveOnboardingState({
        tenantId: TENANT,
        cases: [legalApproved],
        requiredTypes: ['legal-identity', 'tax'],
        profileAxes: AXES,
        legalProfileVersions: legalV2,
        taxProfileVersions: taxV1,
        now: AT + 50,
      }),
    );
    expect(stale.complete).toBe(false);
    expect(stale.pendingTypes).toEqual(['legal-identity', 'tax']);
  });

  it('fails closed when an axis-bound approval has nothing to pin', () => {
    expect(
      expectRejection(
        decideVerification({
          verificationCase: reviewOf(submittedCase('legal-identity')),
          decision: 'approved',
          decidedBy: REVIEWER,
          decidedAt: AT + 30,
          profileAxes: AXES,
          legalProfileVersions: [],
        }),
      ),
    ).toBe('ambiguous_context');
    expect(
      expectRejection(
        decideVerification({
          verificationCase: reviewOf(submittedCase('legal-identity')),
          decision: 'approved',
          decidedBy: REVIEWER,
          decidedAt: AT + 30,
          profileAxes: AXES,
        }),
      ),
    ).toBe('ambiguous_context');
  });

  it('rejects a malformed profileAxes configuration', () => {
    expect(
      expectRejection(
        decideVerification({
          verificationCase: reviewOf(submittedCase('business')),
          decision: 'approved',
          decidedBy: REVIEWER,
          decidedAt: AT + 30,
          profileAxes: [
            { type: 'business', axis: 'legal' },
            { type: 'business', axis: 'tax' },
          ],
        }),
      ),
    ).toBe('ambiguous_context');
    expect(isVerificationProfileAxes(AXES)).toBe(true);
    expect(isVerificationProfileAxes([{ type: 'legal-identity' }])).toBe(false);
  });
});

describe('deriveOnboardingState', () => {
  it('is complete only when every required type has an approved case', () => {
    const state = expectOk(
      deriveOnboardingState({
        tenantId: TENANT,
        cases: [approvedCase('business')],
        requiredTypes: ['business', 'identity'],
        now: AT + 50,
      }),
    );
    expect(state.complete).toBe(false);
    expect(state.pendingTypes).toEqual(['identity']);
  });

  it('reports a rejected required type as an issue', () => {
    const rejected = expectOk(
      decideVerification({
        verificationCase: reviewOf(submittedCase('identity')),
        decision: 'rejected',
        decidedBy: REVIEWER,
        decidedAt: AT + 30,
        publicDecisionReason: 'Expired document.',
      }),
    ).verificationCase;
    const state = expectOk(
      deriveOnboardingState({
        tenantId: TENANT,
        cases: [rejected],
        requiredTypes: ['identity'],
        now: AT + 50,
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
      deriveOnboardingState({
        tenantId: TENANT,
        cases: [expired],
        requiredTypes: ['business'],
        now: AT + 50,
      }),
    );
    expect(state.complete).toBe(false);
    expect(state.pendingTypes).toEqual(['business']);
  });

  it('reports an issue only for the latest case of a type', () => {
    const rejected = expectOk(
      decideVerification({
        verificationCase: reviewOf(submittedCase('identity')),
        decision: 'rejected',
        decidedBy: REVIEWER,
        decidedAt: AT + 30,
        publicDecisionReason: 'Expired document.',
      }),
    ).verificationCase;
    const resubmittedAndSubmitted = expectOk(
      submitVerificationCase({
        verificationCase: expectOk(
          createVerificationCase({
            id: createVerificationCaseId('vc-identity-2'),
            tenantId: TENANT,
            type: 'identity',
            createdAt: AT + 40,
          }),
        ),
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
        now: AT + 60,
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
          now: AT + 50,
        }),
      ),
    ).toBe('inconsistent_context');
  });

  it('rejects a principal-scoped case inside a tenant collection (§3.8)', () => {
    expect(
      expectRejection(
        deriveOnboardingState({
          tenantId: TENANT,
          cases: [principalVerificationCase()],
          requiredTypes: ['legal-identity'],
          now: AT + 50,
        }),
      ),
    ).toBe('inconsistent_context');
  });

  it('rejects a malformed or missing classification', () => {
    expect(
      expectRejection(
        deriveOnboardingState({
          tenantId: TENANT,
          cases: [],
          requiredTypes: ['business'],
          tenantClassification: 'enterprise',
          now: AT + 50,
        }),
      ),
    ).toBe('ambiguous_context');
  });

  it('requires a well-formed principal assessment on the first_party path', () => {
    expect(
      expectRejection(
        deriveOnboardingState({
          tenantId: TENANT,
          cases: [],
          requiredTypes: ['legal-identity'],
          tenantClassification: 'first_party',
          now: AT + 50,
        }),
      ),
    ).toBe('ambiguous_context');
    expect(
      expectRejection(
        deriveOnboardingState({
          tenantId: TENANT,
          cases: [],
          requiredTypes: ['legal-identity'],
          tenantClassification: 'first_party',
          principalAssessment: { bad: true },
          now: AT + 50,
        }),
      ),
    ).toBe('ambiguous_context');
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
        tenantClassification: 'customer',
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
        tenantClassification: 'customer',
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
          tenantClassification: 'customer',
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
        tenantClassification: 'customer',
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
          tenantClassification: 'customer',
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
          tenantClassification: 'customer',
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
            tenantClassification: 'customer',
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
          tenantClassification: 'customer',
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
          tenantClassification: 'customer',
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
          tenantClassification: 'customer',
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
          tenantClassification: 'customer',
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

  it('rejects a missing or malformed classification instead of guessing it', () => {
    const withoutClassification = {
      tenantId: TENANT,
      restrictions: CLEAR,
      cases: [approvedCase()],
      requiredTypes: ['business'],
      legalProfileVersions: legal,
      taxProfileVersions: tax,
      now: AT + 50,
    } as unknown as DeriveOperationalEligibilityInput;
    expect(expectRejection(deriveOperationalEligibility(withoutClassification))).toBe(
      'ambiguous_context',
    );
    expect(
      expectRejection(
        deriveOperationalEligibility({
          tenantId: TENANT,
          tenantClassification: 'enterprise',
          restrictions: CLEAR,
          cases: [approvedCase()],
          requiredTypes: ['business'],
          legalProfileVersions: legal,
          taxProfileVersions: tax,
          now: AT + 50,
        }),
      ),
    ).toBe('ambiguous_context');
  });

  it('never lets a principal assessment shortcut the customer path (§3.6)', () => {
    expect(
      expectOk(
        deriveOperationalEligibility({
          tenantId: TENANT,
          tenantClassification: 'customer',
          principalAssessment: { bad: true },
          restrictions: CLEAR,
          cases: [approvedCase()],
          requiredTypes: ['business'],
          legalProfileVersions: legal,
          taxProfileVersions: tax,
          now: AT + 50,
        }),
      ).blockers,
    ).toEqual(['verification']);
    // `null` mang nghĩa "không có assessment" — không chặn.
    expect(
      expectOk(
        deriveOperationalEligibility({
          tenantId: TENANT,
          tenantClassification: 'customer',
          principalAssessment: null,
          restrictions: CLEAR,
          cases: [approvedCase()],
          requiredTypes: ['business'],
          legalProfileVersions: legal,
          taxProfileVersions: tax,
          now: AT + 50,
        }),
      ),
    ).toEqual({ eligible: true, blockers: [] });
  });

  it('rejects a principal-scoped case inside a tenant collection (§3.8)', () => {
    expect(
      expectRejection(
        deriveOperationalEligibility({
          tenantId: TENANT,
          tenantClassification: 'customer',
          restrictions: CLEAR,
          cases: [principalVerificationCase()],
          requiredTypes: ['business'],
          legalProfileVersions: legal,
          taxProfileVersions: tax,
          now: AT + 50,
        }),
      ),
    ).toBe('inconsistent_context');
  });

  describe('first_party path (§3.8) — fail-closed, single source', () => {
    const base = {
      tenantId: TENANT,
      tenantClassification: 'first_party' as const,
      restrictions: CLEAR,
      cases: [],
      requiredTypes: ['legal-identity', 'tax'],
      profileAxes: AXES,
      now: AT + 50,
    };

    it('blocks on a missing or malformed principal assessment with only the verification blocker', () => {
      expect(expectOk(deriveOperationalEligibility(base)).blockers).toEqual(['verification']);
      expect(
        expectOk(deriveOperationalEligibility({ ...base, principalAssessment: { bad: true } }))
          .blockers,
      ).toEqual(['verification']);
    });

    it('never derives from tenant-local profiles or tenant-scoped axis cases', () => {
      // Hồ sơ tenant đầy đủ + case tenant-scoped approved trên trục — trên
      // đường first_party đây là bất nhất single-source, blocker `verification`
      // duy nhất, không bao giờ `legal_profile`/`tax_profile`.
      expect(
        expectOk(
          deriveOperationalEligibility({
            ...base,
            cases: [approvedCase('legal-identity')],
            legalProfileVersions: legal,
            taxProfileVersions: tax,
          }),
        ).blockers,
      ).toEqual(['verification']);
    });
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
    // Subject XOR: cả hai subject hoặc không subject nào đều là dữ liệu hỏng.
    expect(isVerificationCase({ ...good, principalId: PRINCIPAL_ID })).toBe(false);
    expect(isVerificationCase({ ...good, tenantId: null })).toBe(false);
  });
});
