import { describe, expect, it } from 'vitest';

import { createSellerActorId, createSellerTenantId } from '@ecoma-io/llm-seller-tenant-domain';
import { createEvidenceId, createLegalPrincipalId, createVerificationCaseId } from './shared';
import {
  assertEvidenceInPrincipal,
  assertEvidenceInTenant,
  createEvidenceReference,
  createPrincipalEvidenceReference,
  type PrincipalEvidenceReference,
} from './evidence';
import {
  appendPrincipalLegalProfileVersion,
  appendPrincipalTaxProfileVersion,
  blockLegalPrincipal,
  createFirstPartyLegalPrincipal,
  isFirstPartyLegalPrincipal,
  isPrincipalLegalProfileVersion,
  isPrincipalTaxProfileVersion,
  principalLegalProfileVersionAt,
  principalTaxProfileVersionAt,
  unblockLegalPrincipal,
  type FirstPartyLegalPrincipal,
} from './principal';
import {
  createVerificationCase,
  decideVerification,
  startVerificationReview,
  submitPrincipalVerificationCase,
  submitVerificationCase,
  type VerificationCase,
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

const TENANT = createSellerTenantId('tenant-1');
const ACTOR = createSellerActorId('member-1');
const REVIEWER = createSellerActorId('reviewer-1');
const AT = 1_700_000_000_000;
const PRINCIPAL_ID = createLegalPrincipalId('principal-1');
const OTHER_PRINCIPAL_ID = createLegalPrincipalId('principal-2');

const AXES: VerificationProfileAxes = Object.freeze([
  Object.freeze({ type: 'legal-identity', axis: 'legal' as const }),
  Object.freeze({ type: 'tax', axis: 'tax' as const }),
]);

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

function otherCreatedPrincipal(): FirstPartyLegalPrincipal {
  return expectOk(
    createFirstPartyLegalPrincipal({
      principalId: OTHER_PRINCIPAL_ID,
      legalName: 'Other Org',
      legalType: 'company',
      jurisdiction: 'SG',
      registrationReference: 'REG-OTHER-1',
      taxResidency: 'SG',
      taxIdentifier: 'TAX-OTHER-1',
      declarationReference: 'DECL-OTHER-1',
      effectiveFrom: AT,
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

/**
 * Duyệt một case principal-scoped đến `approved` với pin trục của type — quay
 * lại case sau quyết định và principal sau (có thể) activation.
 */
function approvePrincipalCase(
  type: 'legal-identity' | 'tax',
  principal: FirstPartyLegalPrincipal,
  principalCoverage: { legal?: number | null; tax?: number | null } = {},
  decidedAt = AT + 30,
): { verificationCase: VerificationCase; legalPrincipal: FirstPartyLegalPrincipal } {
  const draft = expectOk(
    createVerificationCase({
      id: createVerificationCaseId(`pc-${type}`),
      principalId: principal.principalId,
      type,
      createdAt: AT + 1,
    }),
  );
  const submitted = expectOk(
    submitPrincipalVerificationCase({
      verificationCase: draft,
      submissionId: `s-pc-${type}`,
      evidence: [principalEvidence()],
      submittedBy: ACTOR,
      submittedAt: AT + 10,
    }),
  );
  const review = expectOk(
    startVerificationReview({
      verificationCase: submitted,
      reviewer: REVIEWER,
      reviewedAt: AT + 20,
    }),
  );
  const decision = expectOk(
    decideVerification({
      verificationCase: review,
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

/** Principal ở trạng thái `active`: cả hai trục được approved coverage phủ. */
function activePrincipal(): FirstPartyLegalPrincipal {
  const legal = approvePrincipalCase('legal-identity', createdPrincipal(), {});
  const tax = approvePrincipalCase('tax', legal.legalPrincipal, { legal: 1 });
  return tax.legalPrincipal;
}

describe('createFirstPartyLegalPrincipal', () => {
  it('creates the record at reverification_required with the first revision of both axes', () => {
    const principal = createdPrincipal();
    expect(principal.status).toBe('reverification_required');
    expect(principal.legalProfileVersions).toHaveLength(1);
    expect(principal.taxProfileVersions).toHaveLength(1);
    expect(principal.legalProfileVersions[0]?.version).toBe(1);
    expect(principal.taxProfileVersions[0]?.version).toBe(1);
    expect(principal.statusChangedAt).toBeNull();
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(principal.legalProfileVersions)).toBe(true);
    expect(Object.isFrozen(principal.legalProfileVersions[0])).toBe(true);
  });

  it('rejects a duplicate principal id and a malformed existing collection', () => {
    expect(
      expectRejection(
        createFirstPartyLegalPrincipal({
          ...createdPrincipalInput(),
          existing: [createdPrincipal()],
        }),
      ),
    ).toBe('duplicate_legal_principal_id');
    expect(
      expectRejection(
        createFirstPartyLegalPrincipal({
          ...createdPrincipalInput(),
          existing: [{ bad: true }] as never,
        }),
      ),
    ).toBe('invalid_legal_principal');
    expect(
      expectRejection(
        createFirstPartyLegalPrincipal({ ...createdPrincipalInput(), existing: 'nope' as never }),
      ),
    ).toBe('ambiguous_context');
  });

  it('rejects invalid input per field kind', () => {
    expect(
      expectRejection(
        createFirstPartyLegalPrincipal({ ...createdPrincipalInput(), principalId: '' }),
      ),
    ).toBe('invalid_legal_principal_id');
    expect(
      expectRejection(
        createFirstPartyLegalPrincipal({ ...createdPrincipalInput(), legalName: '' }),
      ),
    ).toBe('invalid_profile_field');
    expect(
      expectRejection(
        createFirstPartyLegalPrincipal({ ...createdPrincipalInput(), taxResidency: '' }),
      ),
    ).toBe('invalid_profile_field');
    expect(
      expectRejection(
        createFirstPartyLegalPrincipal({ ...createdPrincipalInput(), effectiveFrom: 'x' }),
      ),
    ).toBe('invalid_effective_from');
    expect(
      expectRejection(
        createFirstPartyLegalPrincipal({ ...createdPrincipalInput(), recordedAt: 1.5 }),
      ),
    ).toBe('invalid_timestamp');
    expect(
      expectRejection(
        createFirstPartyLegalPrincipal({ ...createdPrincipalInput(), recordedBy: '' }),
      ),
    ).toBe('invalid_actor');
  });
});

function createdPrincipalInput() {
  return {
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
  };
}

describe('principal revisions — append-only, reverification_required in the same operation', () => {
  it('appends a legal revision with the next version and flips status synchronously', () => {
    const principal = activePrincipal();
    const appended = expectOk(
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
    expect(appended.status).toBe('reverification_required');
    expect(appended.legalProfileVersions).toHaveLength(2);
    expect(appended.legalProfileVersions[1]?.version).toBe(2);
    expect(appended.taxProfileVersions).toHaveLength(1);
    expect(appended.statusChangedAt).toBe(AT + 100);
    expect(appended.statusChangedBy).toBe(ACTOR);
    expect(principal.status).toBe('active');
  });

  it('appends a tax revision with independent versioning per axis', () => {
    const principal = activePrincipal();
    const appended = expectOk(
      appendPrincipalTaxProfileVersion({
        principal,
        taxResidency: 'SG',
        taxIdentifier: 'TAX-ECOMA-SG',
        declarationReference: 'DECL-ECOMA-SG',
        effectiveFrom: AT + 100,
        recordedAt: AT + 100,
        recordedBy: ACTOR,
      }),
    );
    expect(appended.status).toBe('reverification_required');
    expect(appended.taxProfileVersions[1]?.version).toBe(2);
    expect(appended.legalProfileVersions).toHaveLength(1);
  });

  it('keeps allowing a second append while already at reverification_required', () => {
    // Publish có thể sửa cả hai trục trước khi có approval: append từ
    // `reverification_required` không phải transition mới — trạng thái đã là đích.
    const first = expectOk(
      appendPrincipalLegalProfileVersion({
        principal: createdPrincipal(),
        legalName: 'Ecoma-io II',
        legalType: 'company',
        jurisdiction: 'VN',
        registrationReference: 'REG-ECOMA-2',
        effectiveFrom: AT + 100,
        recordedAt: AT + 100,
        recordedBy: ACTOR,
      }),
    );
    const second = expectOk(
      appendPrincipalTaxProfileVersion({
        principal: first,
        taxResidency: 'SG',
        taxIdentifier: 'TAX-ECOMA-SG',
        declarationReference: 'DECL-ECOMA-SG',
        effectiveFrom: AT + 200,
        recordedAt: AT + 200,
        recordedBy: ACTOR,
      }),
    );
    expect(second.status).toBe('reverification_required');
    expect(second.legalProfileVersions).toHaveLength(2);
    expect(second.taxProfileVersions).toHaveLength(2);
  });

  it('rejects a non-increasing effectiveFrom', () => {
    const principal = createdPrincipal();
    expect(
      expectRejection(
        appendPrincipalLegalProfileVersion({
          principal,
          legalName: 'Ecoma-io II',
          legalType: 'company',
          jurisdiction: 'VN',
          registrationReference: 'REG-ECOMA-2',
          effectiveFrom: AT,
          recordedAt: AT + 1,
          recordedBy: ACTOR,
        }),
      ),
    ).toBe('effective_from_not_increasing');
  });

  it('rejects appending while blocked — unblock is the only way out', () => {
    const blocked = expectOk(
      blockLegalPrincipal({
        principal: createdPrincipal(),
        blockedBy: REVIEWER,
        blockedAt: AT + 10,
      }),
    );
    expect(
      expectRejection(
        appendPrincipalLegalProfileVersion({
          principal: blocked,
          legalName: 'Ecoma-io II',
          legalType: 'company',
          jurisdiction: 'VN',
          registrationReference: 'REG-ECOMA-2',
          effectiveFrom: AT + 100,
          recordedAt: AT + 100,
          recordedBy: ACTOR,
        }),
      ),
    ).toBe('invalid_principal_status_transition');
    expect(
      expectRejection(
        appendPrincipalTaxProfileVersion({
          principal: blocked,
          taxResidency: 'SG',
          taxIdentifier: 'TAX-SG',
          declarationReference: 'DECL-SG',
          effectiveFrom: AT + 100,
          recordedAt: AT + 100,
          recordedBy: ACTOR,
        }),
      ),
    ).toBe('invalid_principal_status_transition');
  });

  it('returns the current revision at a time, or undefined before any is effective', () => {
    const principal = createdPrincipal();
    expect(principalLegalProfileVersionAt(principal, AT)?.version).toBe(1);
    expect(principalLegalProfileVersionAt(principal, AT - 1)).toBeUndefined();
    expect(principalTaxProfileVersionAt(principal, AT + 1000)?.version).toBe(1);
    const appended = expectOk(
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
    expect(principalLegalProfileVersionAt(appended, AT + 99)?.version).toBe(1);
    expect(principalLegalProfileVersionAt(appended, AT + 100)?.version).toBe(2);
  });

  it('rejects invalid input and corrupted records', () => {
    const principal = createdPrincipal();
    expect(
      expectRejection(
        appendPrincipalLegalProfileVersion({
          principal: { bad: true } as never,
          legalName: 'x',
          legalType: 'company',
          jurisdiction: 'VN',
          registrationReference: 'R',
          effectiveFrom: AT + 1,
          recordedAt: AT + 1,
          recordedBy: ACTOR,
        }),
      ),
    ).toBe('invalid_legal_principal');
    expect(
      expectRejection(
        appendPrincipalLegalProfileVersion({
          principal,
          legalName: '',
          legalType: 'company',
          jurisdiction: 'VN',
          registrationReference: 'R',
          effectiveFrom: AT + 1,
          recordedAt: AT + 1,
          recordedBy: ACTOR,
        }),
      ),
    ).toBe('invalid_profile_field');
    expect(
      expectRejection(
        appendPrincipalTaxProfileVersion({
          principal,
          taxResidency: 'VN',
          taxIdentifier: '',
          declarationReference: 'D',
          effectiveFrom: AT + 1,
          recordedAt: AT + 1,
          recordedBy: ACTOR,
        }),
      ),
    ).toBe('invalid_profile_field');
  });
});

describe('principal status transitions (§7)', () => {
  it('blocks from active and from reverification_required, never twice', () => {
    const active = activePrincipal();
    const blocked = expectOk(
      blockLegalPrincipal({ principal: active, blockedBy: REVIEWER, blockedAt: AT + 40 }),
    );
    expect(blocked.status).toBe('blocked');
    expect(blocked.statusChangedAt).toBe(AT + 40);
    expect(blocked.statusChangedBy).toBe(REVIEWER);
    const reverifying = expectOk(
      appendPrincipalTaxProfileVersion({
        principal: active,
        taxResidency: 'SG',
        taxIdentifier: 'TAX-SG',
        declarationReference: 'DECL-SG',
        effectiveFrom: AT + 100,
        recordedAt: AT + 100,
        recordedBy: ACTOR,
      }),
    );
    expect(
      expectOk(
        blockLegalPrincipal({ principal: reverifying, blockedBy: REVIEWER, blockedAt: AT + 110 }),
      ).status,
    ).toBe('blocked');
    expect(
      expectRejection(
        blockLegalPrincipal({ principal: blocked, blockedBy: REVIEWER, blockedAt: AT + 50 }),
      ),
    ).toBe('invalid_principal_status_transition');
  });

  it('unblocks only from blocked and lands at reverification_required, never active', () => {
    const blocked = expectOk(
      blockLegalPrincipal({
        principal: createdPrincipal(),
        blockedBy: REVIEWER,
        blockedAt: AT + 10,
      }),
    );
    const unblocked = expectOk(
      unblockLegalPrincipal({ principal: blocked, unblockedBy: REVIEWER, unblockedAt: AT + 20 }),
    );
    expect(unblocked.status).toBe('reverification_required');
    expect(unblocked.statusChangedAt).toBe(AT + 20);
    expect(
      expectRejection(
        unblockLegalPrincipal({
          principal: unblocked,
          unblockedBy: REVIEWER,
          unblockedAt: AT + 30,
        }),
      ),
    ).toBe('invalid_principal_status_transition');
    expect(
      expectRejection(
        unblockLegalPrincipal({
          principal: activePrincipal(),
          unblockedBy: REVIEWER,
          unblockedAt: AT + 30,
        }),
      ),
    ).toBe('invalid_principal_status_transition');
  });

  it('rejects block and unblock timestamps before creation', () => {
    const principal = createdPrincipal();
    expect(
      expectRejection(blockLegalPrincipal({ principal, blockedBy: REVIEWER, blockedAt: AT - 1 })),
    ).toBe('invalid_principal_status_transition');
    const blocked = expectOk(
      blockLegalPrincipal({ principal, blockedBy: REVIEWER, blockedAt: AT + 10 }),
    );
    expect(
      expectRejection(
        unblockLegalPrincipal({ principal: blocked, unblockedBy: REVIEWER, unblockedAt: AT - 1 }),
      ),
    ).toBe('invalid_principal_status_transition');
  });

  it('rejects invalid actor, timestamp or record', () => {
    const principal = createdPrincipal();
    expect(expectRejection(blockLegalPrincipal({ principal, blockedBy: '', blockedAt: AT }))).toBe(
      'invalid_actor',
    );
    expect(
      expectRejection(
        blockLegalPrincipal({ principal, blockedBy: REVIEWER, blockedAt: 'x' as never }),
      ),
    ).toBe('invalid_timestamp');
    expect(
      expectRejection(
        blockLegalPrincipal({ principal: null as never, blockedBy: REVIEWER, blockedAt: AT }),
      ),
    ).toBe('invalid_legal_principal');
  });
});

describe('decideVerification on principal-scoped cases (§3.8, §7)', () => {
  it('pins the current principal revision and activates only when the pair is covered', () => {
    const principal = createdPrincipal();
    // Trục legal được phê duyệt nhưng trục tax chưa có coverage nào ⇒ chưa active.
    const legalDecision = approvePrincipalCase('legal-identity', principal, {});
    expect(legalDecision.verificationCase.status).toBe('approved');
    expect(legalDecision.verificationCase.verifiedProfileVersions).toEqual([
      { axis: 'legal', version: 1 },
    ]);
    expect(legalDecision.legalPrincipal?.status).toBe('reverification_required');
    // Trục tax được phê duyệt kèm coverage { legal: 1 } ⇒ phủ đủ cặp ⇒ active.
    const taxDecision = approvePrincipalCase('tax', legalDecision.legalPrincipal, { legal: 1 });
    expect(taxDecision.verificationCase.verifiedProfileVersions).toEqual([
      { axis: 'tax', version: 1 },
    ]);
    expect(taxDecision.legalPrincipal?.status).toBe('active');
    expect(taxDecision.legalPrincipal?.statusChangedAt).toBe(AT + 30);
    expect(taxDecision.legalPrincipal?.statusChangedBy).toBe(REVIEWER);
  });

  it('never activates a blocked principal through approval — unblock first', () => {
    const principal = expectOk(
      blockLegalPrincipal({
        principal: createdPrincipal(),
        blockedBy: REVIEWER,
        blockedAt: AT + 5,
      }),
    );
    const decision = approvePrincipalCase('legal-identity', principal, { tax: 1 });
    expect(decision.verificationCase.status).toBe('approved');
    expect(decision.legalPrincipal?.status).toBe('blocked');
  });

  it('keeps an already active principal active on a re-approval', () => {
    const active = activePrincipal();
    const decision = approvePrincipalCase('legal-identity', active, {}, AT + 40);
    expect(decision.legalPrincipal?.status).toBe('active');
    // Không đổi audit khi không có transition.
    expect(decision.legalPrincipal?.statusChangedAt).toBe(AT + 30);
  });

  it('pins the revision effective at decidedAt, not a later one', () => {
    const principal = createdPrincipal();
    const futureRevision = expectOk(
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
    const decision = approvePrincipalCase('legal-identity', futureRevision, {}, AT + 30);
    expect(decision.verificationCase.verifiedProfileVersions).toEqual([
      { axis: 'legal', version: 1 },
    ]);
    expect(decision.legalPrincipal?.status).toBe('reverification_required');
  });

  it('requires the principal record and rejects a mismatched one', () => {
    const draft = expectOk(
      createVerificationCase({
        id: createVerificationCaseId('pc-x'),
        principalId: PRINCIPAL_ID,
        type: 'legal-identity',
        createdAt: AT + 1,
      }),
    );
    const submitted = expectOk(
      submitPrincipalVerificationCase({
        verificationCase: draft,
        submissionId: 's-pc-x',
        evidence: [principalEvidence()],
        submittedBy: ACTOR,
        submittedAt: AT + 10,
      }),
    );
    const review = expectOk(
      startVerificationReview({
        verificationCase: submitted,
        reviewer: REVIEWER,
        reviewedAt: AT + 20,
      }),
    );
    expect(
      expectRejection(
        decideVerification({
          verificationCase: review,
          decision: 'approved',
          decidedBy: REVIEWER,
          decidedAt: AT + 30,
          profileAxes: AXES,
        }),
      ),
    ).toBe('ambiguous_context');
    expect(
      expectRejection(
        decideVerification({
          verificationCase: review,
          decision: 'approved',
          decidedBy: REVIEWER,
          decidedAt: AT + 30,
          profileAxes: AXES,
          principal: otherCreatedPrincipal(),
        }),
      ),
    ).toBe('inconsistent_context');
  });

  it('rejects a principal-scoped case on the tenant submission path', () => {
    const principalCase = expectOk(
      createVerificationCase({
        id: createVerificationCaseId('pc-y'),
        principalId: PRINCIPAL_ID,
        type: 'legal-identity',
        createdAt: AT + 1,
      }),
    );
    const tenantEvidence = expectOk(
      createEvidenceReference({
        id: createEvidenceId('e-t'),
        tenantId: TENANT,
        kind: 'business_registration',
        storageRef: 'blob://evidence/e-t',
        contentHash: 'sha256:abc',
        recordedAt: AT,
        recordedBy: ACTOR,
      }),
    );
    expect(
      expectRejection(
        submitVerificationCase({
          verificationCase: principalCase,
          submissionId: 's-1',
          evidence: [tenantEvidence],
          submittedBy: ACTOR,
          submittedAt: AT + 10,
        }),
      ),
    ).toBe('inconsistent_context');
  });
});

describe('evidence on the principal axis', () => {
  it('keeps the two axes structurally separate — assertEvidenceInTenant cannot accept principal evidence', () => {
    const evidence = principalEvidence();
    expect(expectRejection(assertEvidenceInTenant(evidence as never, TENANT))).toBe(
      'invalid_evidence_reference',
    );
  });

  it('asserts the evidence belongs to the principal and rejects a foreign principal', () => {
    expect(expectOk(assertEvidenceInPrincipal(principalEvidence(), PRINCIPAL_ID)).id).toBe('pe-1');
    expect(
      expectRejection(assertEvidenceInPrincipal(principalEvidence(), OTHER_PRINCIPAL_ID)),
    ).toBe('inconsistent_context');
    expect(expectRejection(assertEvidenceInPrincipal({ bad: true } as never, PRINCIPAL_ID))).toBe(
      'invalid_evidence_reference',
    );
    expect(expectRejection(assertEvidenceInPrincipal(principalEvidence(), '' as never))).toBe(
      'invalid_legal_principal_id',
    );
  });

  it('rejects duplicate ids and foreign entries in the principal evidence collection', () => {
    expect(
      expectRejection(
        createPrincipalEvidenceReference({
          id: createEvidenceId('pe-1'),
          principalId: PRINCIPAL_ID,
          kind: 'business_registration',
          storageRef: 'external://x',
          contentHash: 'sha256:x',
          recordedAt: AT,
          recordedBy: ACTOR,
          existing: [principalEvidence()],
        }),
      ),
    ).toBe('duplicate_evidence_reference_id');
    const foreignEvidence = expectOk(
      createPrincipalEvidenceReference({
        id: createEvidenceId('pe-foreign'),
        principalId: OTHER_PRINCIPAL_ID,
        kind: 'business_registration',
        storageRef: 'external://y',
        contentHash: 'sha256:y',
        recordedAt: AT,
        recordedBy: ACTOR,
      }),
    );
    expect(
      expectRejection(
        createPrincipalEvidenceReference({
          id: createEvidenceId('pe-2'),
          principalId: PRINCIPAL_ID,
          kind: 'business_registration',
          storageRef: 'external://z',
          contentHash: 'sha256:z',
          recordedAt: AT,
          recordedBy: ACTOR,
          existing: [foreignEvidence],
        }),
      ),
    ).toBe('inconsistent_context');
  });
});

describe('principal shape guards', () => {
  it('validates stored records and rejects broken shapes', () => {
    const principal = createdPrincipal();
    expect(isFirstPartyLegalPrincipal(principal)).toBe(true);
    expect(isFirstPartyLegalPrincipal({ ...principal, status: 'unknown' })).toBe(false);
    expect(isFirstPartyLegalPrincipal({ ...principal, principalId: '' })).toBe(false);
    expect(
      isFirstPartyLegalPrincipal({ ...principal, legalProfileVersions: [{ bad: true }] }),
    ).toBe(false);
    expect(isFirstPartyLegalPrincipal({ ...principal, taxProfileVersions: 'nope' })).toBe(false);
    expect(isFirstPartyLegalPrincipal(null)).toBe(false);
    expect(isPrincipalLegalProfileVersion(principal.legalProfileVersions[0])).toBe(true);
    expect(
      isPrincipalLegalProfileVersion({ ...principal.legalProfileVersions[0], version: 0 }),
    ).toBe(false);
    expect(isPrincipalTaxProfileVersion(principal.taxProfileVersions[0])).toBe(true);
    expect(
      isPrincipalTaxProfileVersion({ ...principal.taxProfileVersions[0], principalId: null }),
    ).toBe(false);
  });
});
