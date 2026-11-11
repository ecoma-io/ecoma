import { describe, expect, it } from 'vitest';

import { createSellerActorId, createSellerTenantId } from '@ecoma-io/llm-seller-tenant-domain';
import { createEvidenceId, createLegalPrincipalId, createVerificationCaseId } from './shared';
import {
  createEvidenceReference,
  createPrincipalEvidenceReference,
  type EvidenceReference,
  type PrincipalEvidenceReference,
} from './evidence';
import {
  appendPrincipalLegalProfileVersion,
  blockLegalPrincipal,
  createFirstPartyLegalPrincipal,
  unblockLegalPrincipal,
  type FirstPartyLegalPrincipal,
} from './principal';
import {
  acceptPrincipalRevision,
  establishFirstPartyPrincipalAssociation,
  isPrincipalAssessment,
  isPrincipalAssociation,
  type PrincipalApprovedCoverage,
  type PrincipalAssessment,
  type PrincipalAssociation,
} from './principal-association';
import type { RestrictionEvaluation } from './restriction';
import {
  createVerificationCase,
  decideVerification,
  deriveOperationalEligibility,
  startVerificationReview,
  submitPrincipalVerificationCase,
  submitVerificationCase,
  type VerificationCase,
  type VerificationDecision,
} from './verification';
import type { VerificationProfileAxes } from './verification-case';

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

const TENANT_A = createSellerTenantId('tenant-a');
const TENANT_B = createSellerTenantId('tenant-b');
const ACTOR = createSellerActorId('member-1');
const REVIEWER = createSellerActorId('reviewer-1');
const AT = 1_700_000_000_000;
const PRINCIPAL_ID = createLegalPrincipalId('principal-1');

const AXES: VerificationProfileAxes = Object.freeze([
  Object.freeze({ type: 'legal-identity', axis: 'legal' as const }),
  Object.freeze({ type: 'tax', axis: 'tax' as const }),
]);

/** Cặp revision mà principal active mặc định được approved coverage phủ. */
const FIRST_COVERAGE: PrincipalApprovedCoverage = Object.freeze({ legal: 1, tax: 1 });

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

function tenantEvidence(id: string): EvidenceReference {
  return expectOk(
    createEvidenceReference({
      id: createEvidenceId(id),
      tenantId: TENANT_A,
      kind: 'business_registration',
      storageRef: `blob://evidence/${id}`,
      contentHash: 'sha256:tenant',
      recordedAt: AT,
      recordedBy: ACTOR,
    }),
  );
}

function createdPrincipal(): FirstPartyLegalPrincipal {
  return expectOk(
    createFirstPartyLegalPrincipal({
      principalId: PRINCIPAL_ID,
      legalName: 'Ecoma-io',
      legalType: 'company',
      jurisdiction: 'VN',
      registrationReference: 'REG-ECOMA-1',
      taxResidency: 'VN',
      taxIdentifier: 'TAX-ECOMA-1',
      declarationReference: 'DECL-ECOMA-1',
      effectiveFrom: AT,
      recordedAt: AT,
      recordedBy: ACTOR,
    }),
  );
}

function reviewedPrincipalCase(
  type: 'legal-identity' | 'tax',
  principal: FirstPartyLegalPrincipal,
  caseId: string,
): VerificationCase {
  const draft = expectOk(
    createVerificationCase({
      id: createVerificationCaseId(caseId),
      principalId: principal.principalId,
      type,
      createdAt: AT + 1,
    }),
  );
  const submitted = expectOk(
    submitPrincipalVerificationCase({
      verificationCase: draft,
      submissionId: `s-${caseId}`,
      evidence: [principalEvidence(`pe-${caseId}`)],
      submittedBy: ACTOR,
      submittedAt: AT + 10,
    }),
  );
  return expectOk(
    startVerificationReview({
      verificationCase: submitted,
      reviewer: REVIEWER,
      reviewedAt: AT + 20,
    }),
  );
}

function approvePrincipalCase(
  type: 'legal-identity' | 'tax',
  principal: FirstPartyLegalPrincipal,
  principalCoverage: { legal?: number | null; tax?: number | null },
  caseId: string,
  decidedAt = AT + 30,
): { verificationCase: VerificationCase; legalPrincipal: FirstPartyLegalPrincipal } {
  const decision: VerificationDecision = expectOk(
    decideVerification({
      verificationCase: reviewedPrincipalCase(type, principal, caseId),
      decision: 'approved',
      decidedBy: REVIEWER,
      decidedAt,
      profileAxes: AXES,
      principal,
      principalCoverage,
    }),
  );
  if (decision.legalPrincipal === null) {
    // Case principal-scoped luôn trả principal trong decision.
    throw new Error('principal-scoped decision returned no principal');
  }
  return { verificationCase: decision.verificationCase, legalPrincipal: decision.legalPrincipal };
}

/** Principal `active`: hai case principal-scoped approved phủ đủ cặp revision. */
function activePrincipal(): FirstPartyLegalPrincipal {
  const legal = approvePrincipalCase('legal-identity', createdPrincipal(), {}, 'pc-legal');
  const tax = approvePrincipalCase('tax', legal.legalPrincipal, { legal: 1 }, 'pc-tax', AT + 31);
  return tax.legalPrincipal;
}

/** Append revision legal 2 rồi được approved lại ⇒ principal `active` với cặp (2, 1). */
function revisedActivePrincipal(principal: FirstPartyLegalPrincipal): FirstPartyLegalPrincipal {
  const revised = expectOk(
    appendPrincipalLegalProfileVersion({
      principal,
      legalName: 'Ecoma-io II',
      legalType: 'company',
      jurisdiction: 'VN',
      registrationReference: 'REG-ECOMA-2',
      effectiveFrom: AT + 100,
      recordedAt: AT + 100,
      recordedBy: ACTOR,
    }),
  );
  return approvePrincipalCase('legal-identity', revised, { tax: 1 }, 'pc-legal-2', AT + 120)
    .legalPrincipal;
}

function establish(
  tenantId: typeof TENANT_A | typeof TENANT_B,
  principal: FirstPartyLegalPrincipal,
  coverage: PrincipalApprovedCoverage = FIRST_COVERAGE,
  establishedAt = AT + 40,
  existing: readonly PrincipalAssociation[] = [],
): PrincipalAssociation {
  return expectOk(
    establishFirstPartyPrincipalAssociation({
      tenantId,
      principal,
      acceptedLegalProfileVersion: coverage.legal,
      acceptedTaxProfileVersion: coverage.tax,
      approvedCoverage: coverage,
      establishedBy: ACTOR,
      establishedAt,
      existing,
    }),
  );
}

function assessment(
  principal: FirstPartyLegalPrincipal,
  association: PrincipalAssociation | null,
  coverage: PrincipalApprovedCoverage,
): PrincipalAssessment {
  return { principal, association, approvedCoverage: coverage, assessedAt: AT + 50 };
}

function tenantRestriction(tenantId: typeof TENANT_A | typeof TENANT_B): RestrictionEvaluation {
  return {
    tenantId,
    target: { kind: 'tenant' },
    blocked: false,
    unevaluable: false,
    blockingRecordIds: [],
    unknownPolicies: [],
  };
}

function deriveFirstParty(
  tenantId: typeof TENANT_A | typeof TENANT_B,
  snapshot: PrincipalAssessment,
  now = AT + 60,
): { eligible: boolean; blockers: readonly string[] } {
  return expectOk(
    deriveOperationalEligibility({
      tenantId,
      tenantClassification: 'first_party',
      principalAssessment: snapshot,
      restrictions: tenantRestriction(tenantId),
      cases: [],
      requiredTypes: ['legal-identity', 'tax'],
      profileAxes: AXES,
      now,
    }),
  );
}

describe('establishFirstPartyPrincipalAssociation', () => {
  it('establishes one association per tenant pinning the covered current pair', () => {
    const principal = activePrincipal();
    const association = establish(TENANT_A, principal);
    expect(association.tenantId).toBe(TENANT_A);
    expect(association.principalId).toBe(principal.principalId);
    expect(association.acceptedLegalProfileVersion).toBe(1);
    expect(association.acceptedTaxProfileVersion).toBe(1);
    expect(association.lastAcceptedAt).toBe(association.establishedAt);
    expect(association.lastAcceptedBy).toBe(ACTOR);
    expect(Object.isFrozen(association)).toBe(true);
    // Tenant khác liên kết cùng principal được — association là per-tenant,
    // principal là per-provider. Collection per-tenant của A không cản B.
    expect(establish(TENANT_B, principal).tenantId).toBe(TENANT_B);
  });

  it('rejects a second association for the same tenant and a foreign entry in the collection', () => {
    const principal = activePrincipal();
    const existing = [establish(TENANT_A, principal)];
    expect(
      expectRejection(
        establishFirstPartyPrincipalAssociation({
          tenantId: TENANT_A,
          principal,
          acceptedLegalProfileVersion: 1,
          acceptedTaxProfileVersion: 1,
          approvedCoverage: FIRST_COVERAGE,
          establishedBy: ACTOR,
          establishedAt: AT + 40,
          existing,
        }),
      ),
    ).toBe('duplicate_principal_association');
    expect(
      expectRejection(
        establishFirstPartyPrincipalAssociation({
          tenantId: TENANT_B,
          principal,
          acceptedLegalProfileVersion: 1,
          acceptedTaxProfileVersion: 1,
          approvedCoverage: FIRST_COVERAGE,
          establishedBy: ACTOR,
          establishedAt: AT + 40,
          existing,
        }),
      ),
    ).toBe('principal_association_not_in_tenant');
  });

  it('rejects a principal that is not active', () => {
    expect(
      expectRejection(
        establishFirstPartyPrincipalAssociation({
          tenantId: TENANT_A,
          principal: createdPrincipal(),
          acceptedLegalProfileVersion: 1,
          acceptedTaxProfileVersion: 1,
          approvedCoverage: FIRST_COVERAGE,
          establishedBy: ACTOR,
          establishedAt: AT + 40,
        }),
      ),
    ).toBe('principal_not_active');
    const blocked = expectOk(
      blockLegalPrincipal({
        principal: activePrincipal(),
        blockedBy: REVIEWER,
        blockedAt: AT + 45,
      }),
    );
    expect(
      expectRejection(
        establishFirstPartyPrincipalAssociation({
          tenantId: TENANT_A,
          principal: blocked,
          acceptedLegalProfileVersion: 1,
          acceptedTaxProfileVersion: 1,
          approvedCoverage: FIRST_COVERAGE,
          establishedBy: ACTOR,
          establishedAt: AT + 40,
        }),
      ),
    ).toBe('principal_not_active');
  });

  it('rejects accepted versions not covered by approval or not current (§3.8)', () => {
    const principal = activePrincipal();
    // Coverage chưa phủ trục legal ⇒ accepted (1, 1) không được chứng minh.
    expect(
      expectRejection(
        establishFirstPartyPrincipalAssociation({
          tenantId: TENANT_A,
          principal,
          acceptedLegalProfileVersion: 1,
          acceptedTaxProfileVersion: 1,
          approvedCoverage: { legal: null, tax: 1 },
          establishedBy: ACTOR,
          establishedAt: AT + 40,
        }),
      ),
    ).toBe('principal_revision_not_verified');
    // Accepted không phải revision hiện hành.
    expect(
      expectRejection(
        establishFirstPartyPrincipalAssociation({
          tenantId: TENANT_A,
          principal,
          acceptedLegalProfileVersion: 2,
          acceptedTaxProfileVersion: 1,
          approvedCoverage: FIRST_COVERAGE,
          establishedBy: ACTOR,
          establishedAt: AT + 40,
        }),
      ),
    ).toBe('principal_revision_not_verified');
  });

  it('rejects invalid tenant, coverage shape, actor and timing regressions', () => {
    const principal = activePrincipal();
    expect(
      expectRejection(
        establishFirstPartyPrincipalAssociation({
          tenantId: '',
          principal,
          acceptedLegalProfileVersion: 1,
          acceptedTaxProfileVersion: 1,
          approvedCoverage: FIRST_COVERAGE,
          establishedBy: ACTOR,
          establishedAt: AT + 40,
        }),
      ),
    ).toBe('invalid_seller_tenant_id');
    expect(
      expectRejection(
        establishFirstPartyPrincipalAssociation({
          tenantId: TENANT_A,
          principal: { bad: true } as never,
          acceptedLegalProfileVersion: 1,
          acceptedTaxProfileVersion: 1,
          approvedCoverage: FIRST_COVERAGE,
          establishedBy: ACTOR,
          establishedAt: AT + 40,
        }),
      ),
    ).toBe('invalid_legal_principal');
    expect(
      expectRejection(
        establishFirstPartyPrincipalAssociation({
          tenantId: TENANT_A,
          principal,
          acceptedLegalProfileVersion: 0,
          acceptedTaxProfileVersion: 1,
          approvedCoverage: FIRST_COVERAGE,
          establishedBy: ACTOR,
          establishedAt: AT + 40,
        }),
      ),
    ).toBe('invalid_profile_version');
    expect(
      expectRejection(
        establishFirstPartyPrincipalAssociation({
          tenantId: TENANT_A,
          principal,
          acceptedLegalProfileVersion: 1,
          acceptedTaxProfileVersion: 1,
          approvedCoverage: { legal: 'x', tax: 1 } as never,
          establishedBy: ACTOR,
          establishedAt: AT + 40,
        }),
      ),
    ).toBe('invalid_principal_association');
    expect(
      expectRejection(
        establishFirstPartyPrincipalAssociation({
          tenantId: TENANT_A,
          principal,
          acceptedLegalProfileVersion: 1,
          acceptedTaxProfileVersion: 1,
          approvedCoverage: FIRST_COVERAGE,
          establishedBy: '',
          establishedAt: AT + 40,
        }),
      ),
    ).toBe('invalid_actor');
    expect(
      expectRejection(
        establishFirstPartyPrincipalAssociation({
          tenantId: TENANT_A,
          principal,
          acceptedLegalProfileVersion: 1,
          acceptedTaxProfileVersion: 1,
          approvedCoverage: FIRST_COVERAGE,
          establishedBy: ACTOR,
          establishedAt: AT - 1,
        }),
      ),
    ).toBe('invalid_principal_association');
    expect(
      expectRejection(
        establishFirstPartyPrincipalAssociation({
          tenantId: TENANT_A,
          principal,
          acceptedLegalProfileVersion: 1,
          acceptedTaxProfileVersion: 1,
          approvedCoverage: FIRST_COVERAGE,
          establishedBy: ACTOR,
          establishedAt: AT + 40,
          existing: [{ bad: true }] as never,
        }),
      ),
    ).toBe('invalid_principal_association');
  });
});

describe('acceptPrincipalRevision', () => {
  it('moves the accepted pair to the current covered revisions and audits the accept', () => {
    const principal = activePrincipal();
    const association = establish(TENANT_A, principal);
    const reactivated = revisedActivePrincipal(principal);
    expect(reactivated.status).toBe('active');
    const accepted = expectOk(
      acceptPrincipalRevision({
        association,
        principal: reactivated,
        approvedCoverage: { legal: 2, tax: 1 },
        acceptedBy: ACTOR,
        acceptedAt: AT + 130,
      }),
    );
    expect(accepted.acceptedLegalProfileVersion).toBe(2);
    expect(accepted.acceptedTaxProfileVersion).toBe(1);
    expect(accepted.lastAcceptedAt).toBe(AT + 130);
    expect(accepted.lastAcceptedBy).toBe(ACTOR);
    // Thiết lập ban đầu không bị ghi đè — audit giữ nguyên giá trị trước đó.
    expect(accepted.establishedAt).toBe(AT + 40);
    expect(accepted.establishedBy).toBe(ACTOR);
  });

  it('rejects coverage that does not match the current revisions', () => {
    const principal = activePrincipal();
    const association = establish(TENANT_A, principal);
    expect(
      expectRejection(
        acceptPrincipalRevision({
          association,
          principal,
          approvedCoverage: { legal: 1, tax: null },
          acceptedBy: ACTOR,
          acceptedAt: AT + 50,
        }),
      ),
    ).toBe('principal_revision_not_verified');
  });

  it('rejects an inactive principal, a foreign principal and time regressions', () => {
    const principal = activePrincipal();
    const association = establish(TENANT_A, principal);
    const blocked = expectOk(
      blockLegalPrincipal({ principal, blockedBy: REVIEWER, blockedAt: AT + 45 }),
    );
    expect(
      expectRejection(
        acceptPrincipalRevision({
          association,
          principal: blocked,
          approvedCoverage: FIRST_COVERAGE,
          acceptedBy: ACTOR,
          acceptedAt: AT + 50,
        }),
      ),
    ).toBe('principal_not_active');
    expect(
      expectRejection(
        acceptPrincipalRevision({
          association,
          principal: { ...principal, principalId: createLegalPrincipalId('principal-other') },
          approvedCoverage: FIRST_COVERAGE,
          acceptedBy: ACTOR,
          acceptedAt: AT + 50,
        }),
      ),
    ).toBe('inconsistent_context');
    expect(
      expectRejection(
        acceptPrincipalRevision({
          association,
          principal,
          approvedCoverage: FIRST_COVERAGE,
          acceptedBy: ACTOR,
          acceptedAt: AT + 39,
        }),
      ),
    ).toBe('invalid_principal_association');
    expect(
      expectRejection(
        acceptPrincipalRevision({
          association: { bad: true } as never,
          principal,
          approvedCoverage: FIRST_COVERAGE,
          acceptedBy: ACTOR,
          acceptedAt: AT + 50,
        }),
      ),
    ).toBe('invalid_principal_association');
    expect(
      expectRejection(
        acceptPrincipalRevision({
          association,
          principal: { bad: true } as never,
          approvedCoverage: FIRST_COVERAGE,
          acceptedBy: ACTOR,
          acceptedAt: AT + 50,
        }),
      ),
    ).toBe('invalid_legal_principal');
  });
});

describe('association shape guards', () => {
  it('validates stored associations and assessments, rejecting broken shapes', () => {
    const principal = activePrincipal();
    const association = establish(TENANT_A, principal);
    expect(isPrincipalAssociation(association)).toBe(true);
    expect(isPrincipalAssociation({ ...association, tenantId: '' })).toBe(false);
    expect(isPrincipalAssociation({ ...association, acceptedLegalProfileVersion: 0 })).toBe(false);
    expect(isPrincipalAssociation({ ...association, lastAcceptedBy: null })).toBe(false);
    expect(isPrincipalAssociation(null)).toBe(false);
    const snapshot = assessment(principal, association, FIRST_COVERAGE);
    expect(isPrincipalAssessment(snapshot)).toBe(true);
    expect(isPrincipalAssessment({ ...snapshot, principal: { bad: true } })).toBe(false);
    expect(isPrincipalAssessment({ ...snapshot, association: { bad: true } })).toBe(false);
    expect(isPrincipalAssessment({ ...snapshot, approvedCoverage: { legal: 'x', tax: 1 } })).toBe(
      false,
    );
    expect(isPrincipalAssessment({ ...snapshot, assessedAt: 'x' })).toBe(false);
    expect(isPrincipalAssessment({ ...snapshot, association: null })).toBe(true);
    expect(isPrincipalAssessment(null)).toBe(false);
  });
});

describe('§5 invariant 10 — principal-wide fail-closed derivation', () => {
  it('case 1a: blocking the principal fans out to every linked tenant', () => {
    const principal = activePrincipal();
    const associationA = establish(TENANT_A, principal);
    const associationB = establish(TENANT_B, principal);
    expect(deriveFirstParty(TENANT_A, assessment(principal, associationA, FIRST_COVERAGE))).toEqual(
      { eligible: true, blockers: [] },
    );
    expect(deriveFirstParty(TENANT_B, assessment(principal, associationB, FIRST_COVERAGE))).toEqual(
      { eligible: true, blockers: [] },
    );
    const blocked = expectOk(
      blockLegalPrincipal({ principal, blockedBy: REVIEWER, blockedAt: AT + 45 }),
    );
    expect(deriveFirstParty(TENANT_A, assessment(blocked, associationA, FIRST_COVERAGE))).toEqual({
      eligible: false,
      blockers: ['verification'],
    });
    expect(deriveFirstParty(TENANT_B, assessment(blocked, associationB, FIRST_COVERAGE))).toEqual({
      eligible: false,
      blockers: ['verification'],
    });
  });

  it('case 1b: tenant-local profiles and tenant-scoped approvals never override a blocked principal', () => {
    const principal = activePrincipal();
    const association = establish(TENANT_A, principal);
    const blocked = expectOk(
      blockLegalPrincipal({ principal, blockedBy: REVIEWER, blockedAt: AT + 45 }),
    );
    const localLegal = [
      {
        tenantId: TENANT_A,
        version: 1,
        legalName: 'Acme Ltd',
        legalType: 'company',
        jurisdiction: 'VN',
        registrationReference: 'REG-1',
        effectiveFrom: AT,
        recordedAt: AT,
        recordedBy: ACTOR,
      },
    ];
    const localTax = [
      {
        tenantId: TENANT_A,
        version: 1,
        taxResidency: 'VN',
        taxIdentifier: 'TAX-1',
        declarationReference: 'DECL-1',
        effectiveFrom: AT,
        recordedAt: AT,
        recordedBy: ACTOR,
      },
    ];
    // Hồ sơ tenant-local trên trục principal là bất nhất — không bao giờ thay thế.
    const withLocalProfiles = expectOk(
      deriveOperationalEligibility({
        tenantId: TENANT_A,
        tenantClassification: 'first_party',
        principalAssessment: assessment(blocked, association, FIRST_COVERAGE),
        restrictions: tenantRestriction(TENANT_A),
        cases: [],
        requiredTypes: ['legal-identity', 'tax'],
        profileAxes: AXES,
        legalProfileVersions: localLegal,
        taxProfileVersions: localTax,
        now: AT + 60,
      }),
    );
    expect(withLocalProfiles).toEqual({ eligible: false, blockers: ['verification'] });
    // Approval tenant-scoped trên trục principal cũng vậy — kể cả case đã approved.
    const tenantDraft = expectOk(
      createVerificationCase({
        id: createVerificationCaseId('vc-t-legal'),
        tenantId: TENANT_A,
        type: 'legal-identity',
        createdAt: AT,
      }),
    );
    const tenantSubmitted = expectOk(
      submitVerificationCase({
        verificationCase: tenantDraft,
        submissionId: 's-t-legal',
        evidence: [tenantEvidence('e-t-legal')],
        submittedBy: ACTOR,
        submittedAt: AT + 10,
      }),
    );
    const tenantReview = expectOk(
      startVerificationReview({
        verificationCase: tenantSubmitted,
        reviewer: REVIEWER,
        reviewedAt: AT + 20,
      }),
    );
    const approvedTenantCase = expectOk(
      decideVerification({
        verificationCase: tenantReview,
        decision: 'approved',
        decidedBy: REVIEWER,
        decidedAt: AT + 30,
        profileAxes: AXES,
        legalProfileVersions: localLegal,
      }),
    ).verificationCase;
    const withTenantCase = expectOk(
      deriveOperationalEligibility({
        tenantId: TENANT_A,
        tenantClassification: 'first_party',
        principalAssessment: assessment(blocked, association, FIRST_COVERAGE),
        restrictions: tenantRestriction(TENANT_A),
        cases: [approvedTenantCase],
        requiredTypes: ['legal-identity', 'tax'],
        profileAxes: AXES,
        now: AT + 60,
      }),
    );
    expect(withTenantCase).toEqual({ eligible: false, blockers: ['verification'] });
  });

  it('case 2: unblock lands at reverification_required — no tenant recovers without a new approval', () => {
    const principal = activePrincipal();
    const associationA = establish(TENANT_A, principal);
    const blocked = expectOk(
      blockLegalPrincipal({ principal, blockedBy: REVIEWER, blockedAt: AT + 45 }),
    );
    const unblocked = expectOk(
      unblockLegalPrincipal({ principal: blocked, unblockedBy: REVIEWER, unblockedAt: AT + 50 }),
    );
    expect(unblocked.status).toBe('reverification_required');
    // Coverage cũ vẫn trỏ đúng cặp revision, association vẫn khớp — nhưng trạng
    // thái chưa qua approval mới ⇒ vẫn ineligible (§7: unblock không trả active).
    expect(deriveFirstParty(TENANT_A, assessment(unblocked, associationA, FIRST_COVERAGE))).toEqual(
      { eligible: false, blockers: ['verification'] },
    );
  });

  it('case 3: a new principal revision disqualifies tenants until it is approved and accepted', () => {
    const principal = activePrincipal();
    const associationA = establish(TENANT_A, principal);
    const revised = expectOk(
      appendPrincipalLegalProfileVersion({
        principal,
        legalName: 'Ecoma-io II',
        legalType: 'company',
        jurisdiction: 'VN',
        registrationReference: 'REG-ECOMA-2',
        effectiveFrom: AT + 100,
        recordedAt: AT + 100,
        recordedBy: ACTOR,
      }),
    );
    // Trước mốc hiệu lực: revision 1 vẫn hiện hành nhưng trạng thái đã rời
    // `active` ⇒ ineligible.
    expect(
      deriveFirstParty(TENANT_A, assessment(revised, associationA, FIRST_COVERAGE), AT + 60),
    ).toEqual({ eligible: false, blockers: ['verification'] });
    // Sau mốc hiệu lực: revision 2 hiện hành, coverage và accepted cũ không còn phủ nó.
    expect(
      deriveFirstParty(TENANT_A, assessment(revised, associationA, FIRST_COVERAGE), AT + 150),
    ).toEqual({ eligible: false, blockers: ['verification'] });
    // Principal được approved lại thành active nhưng tenant chưa accept revision mới.
    const reactivated = approvePrincipalCase(
      'legal-identity',
      revised,
      { tax: 1 },
      'pc-legal-2',
      AT + 120,
    ).legalPrincipal;
    expect(
      deriveFirstParty(
        TENANT_A,
        assessment(reactivated, associationA, { legal: 2, tax: 1 }),
        AT + 150,
      ),
    ).toEqual({ eligible: false, blockers: ['verification'] });
  });

  it('case 4: recovery is per-tenant — accepting the new revision isolates the two tenants', () => {
    const principal = activePrincipal();
    const associationA = establish(TENANT_A, principal);
    const associationB = establish(TENANT_B, principal);
    const reactivated = revisedActivePrincipal(principal);
    const newCoverage: PrincipalApprovedCoverage = { legal: 2, tax: 1 };
    // B accept revision mới ⇒ eligible; A chưa accept ⇒ vẫn ineligible.
    const acceptedB = expectOk(
      acceptPrincipalRevision({
        association: associationB,
        principal: reactivated,
        approvedCoverage: newCoverage,
        acceptedBy: ACTOR,
        acceptedAt: AT + 130,
      }),
    );
    expect(
      deriveFirstParty(TENANT_B, assessment(reactivated, acceptedB, newCoverage), AT + 150),
    ).toEqual({ eligible: true, blockers: [] });
    expect(
      deriveFirstParty(TENANT_A, assessment(reactivated, associationA, newCoverage), AT + 150),
    ).toEqual({ eligible: false, blockers: ['verification'] });
    // A accept theo lượt ⇒ A trở lại eligible, B giữ nguyên.
    const acceptedA = expectOk(
      acceptPrincipalRevision({
        association: associationA,
        principal: reactivated,
        approvedCoverage: newCoverage,
        acceptedBy: ACTOR,
        acceptedAt: AT + 140,
      }),
    );
    expect(
      deriveFirstParty(TENANT_A, assessment(reactivated, acceptedA, newCoverage), AT + 150),
    ).toEqual({ eligible: true, blockers: [] });
    expect(
      deriveFirstParty(TENANT_B, assessment(reactivated, acceptedB, newCoverage), AT + 150),
    ).toEqual({ eligible: true, blockers: [] });
  });

  it('fails closed on a missing, malformed, unlinked, foreign or stale assessment', () => {
    const principal = activePrincipal();
    const association = establish(TENANT_A, principal);
    const base = {
      tenantId: TENANT_A,
      tenantClassification: 'first_party' as const,
      restrictions: tenantRestriction(TENANT_A),
      cases: [],
      requiredTypes: ['legal-identity', 'tax'],
      profileAxes: AXES,
      now: AT + 60,
    };
    // Assessment vắng mặt hoặc hỏng shape.
    expect(
      expectOk(deriveOperationalEligibility({ ...base, principalAssessment: undefined })).blockers,
    ).toEqual(['verification']);
    expect(
      expectOk(deriveOperationalEligibility({ ...base, principalAssessment: { bad: true } }))
        .blockers,
    ).toEqual(['verification']);
    // Tenant chưa được liên kết (association null).
    expect(
      expectOk(
        deriveOperationalEligibility({
          ...base,
          principalAssessment: assessment(principal, null, FIRST_COVERAGE),
        }),
      ).blockers,
    ).toEqual(['verification']);
    // Association của tenant khác trong snapshot.
    expect(
      expectOk(
        deriveOperationalEligibility({
          ...base,
          principalAssessment: assessment(
            principal,
            { ...association, tenantId: TENANT_B },
            FIRST_COVERAGE,
          ),
        }),
      ).blockers,
    ).toEqual(['verification']);
    // Association trỏ principal khác.
    expect(
      expectOk(
        deriveOperationalEligibility({
          ...base,
          principalAssessment: assessment(
            principal,
            { ...association, principalId: createLegalPrincipalId('principal-other') },
            FIRST_COVERAGE,
          ),
        }),
      ).blockers,
    ).toEqual(['verification']);
    // Coverage khai revision chưa tồn tại.
    expect(
      expectOk(
        deriveOperationalEligibility({
          ...base,
          principalAssessment: assessment(principal, association, { legal: 2, tax: 1 }),
        }),
      ).blockers,
    ).toEqual(['verification']);
  });
});
