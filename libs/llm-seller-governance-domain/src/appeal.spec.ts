import { describe, expect, it } from 'vitest';

import { createAppealId, createRestrictionId } from './shared';
import {
  createMembershipId,
  createSellerActorId,
  createSellerTenantId,
  createSellerTenant,
  provisionMembership,
  type SellerMembership,
  type SellerTenant,
} from '@ecoma-io/llm-seller-tenant-domain';
import { createRestrictionRecord, liftRestriction, type RestrictionRecord } from './restriction';
import {
  decideAppeal,
  isAppeal,
  startAppealReview,
  submitAppeal,
  toPublicAppeal,
  withdrawAppeal,
  type Appeal,
} from './appeal';

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

const TENANT_ID = createSellerTenantId('tenant-1');
const OWNER = createSellerActorId('owner-1');
const MEMBER = createSellerActorId('member-1');
const STRANGER = createSellerActorId('stranger-1');
const REVIEWER = createSellerActorId('reviewer-1');
const AT = 1_700_000_000_000;

function tenant(): SellerTenant {
  return expectOk(
    createSellerTenant({ id: TENANT_ID, name: 'Acme Seller', owner: OWNER, createdAt: AT }),
  );
}

function membership(actor = MEMBER): SellerMembership {
  return expectOk(
    provisionMembership(
      { id: createMembershipId(`m-${actor}`), tenantId: TENANT_ID, actor, createdAt: AT },
      [],
    ),
  );
}

function restriction(
  overrides: Partial<Parameters<typeof createRestrictionRecord>[0]> = {},
): RestrictionRecord {
  return expectOk(
    createRestrictionRecord({
      id: createRestrictionId('r-1'),
      tenantId: TENANT_ID,
      policy: 'compliance',
      publicReason: 'Regulatory review in progress.',
      internalReason: 'Internal case INV-77.',
      scope: { kind: 'tenant' },
      activatesAt: AT,
      ...overrides,
    }),
  );
}

function submitted(
  record = restriction(),
  memberships: readonly SellerMembership[] = [membership()],
  submittedAt = AT + 10,
): Appeal {
  return expectOk(
    submitAppeal({
      id: createAppealId('a-1'),
      restriction: record,
      tenant: tenant(),
      memberships,
      submittedBy: MEMBER,
      submittedAt,
    }),
  );
}

describe('submitAppeal', () => {
  it('creates a submitted appeal for an active member', () => {
    const appeal = submitted();
    expect(appeal.status).toBe('submitted');
    expect(appeal.restrictionId).toBe(createRestrictionId('r-1'));
    expect(appeal.decisionReason).toBeNull();
    expect(Object.isFrozen(appeal)).toBe(true);
  });

  it('accepts the owner as an eligible actor without membership', () => {
    const appeal = expectOk(
      submitAppeal({
        id: createAppealId('a-1'),
        restriction: restriction(),
        tenant: tenant(),
        memberships: [],
        submittedBy: OWNER,
        submittedAt: AT + 10,
      }),
    );
    expect(appeal.submittedBy).toBe(OWNER);
  });

  it('rejects a stranger with no active membership', () => {
    expect(
      expectRejection(
        submitAppeal({
          id: createAppealId('a-1'),
          restriction: restriction(),
          tenant: tenant(),
          memberships: [membership()],
          submittedBy: STRANGER,
          submittedAt: AT + 10,
        }),
      ),
    ).toBe('appeal_actor_not_eligible');
  });

  it('rejects a revoked member', () => {
    const revoked = Object.freeze({
      ...membership(),
      status: 'revoked' as const,
      revokedAt: AT + 1,
    });
    expect(
      expectRejection(
        submitAppeal({
          id: createAppealId('a-1'),
          restriction: restriction(),
          tenant: tenant(),
          memberships: [revoked],
          submittedBy: MEMBER,
          submittedAt: AT + 10,
        }),
      ),
    ).toBe('appeal_actor_not_eligible');
  });

  it('rejects a restriction from another tenant', () => {
    const foreign = restriction({ tenantId: createSellerTenantId('tenant-2') });
    expect(
      expectRejection(
        submitAppeal({
          id: createAppealId('a-1'),
          restriction: foreign,
          tenant: tenant(),
          memberships: [membership()],
          submittedBy: MEMBER,
          submittedAt: AT + 10,
        }),
      ),
    ).toBe('restriction_not_in_tenant');
  });

  it('rejects a corrupted restriction record instead of trusting it', () => {
    expect(
      expectRejection(
        submitAppeal({
          id: createAppealId('a-1'),
          restriction: { ...restriction(), internalReason: '' },
          tenant: tenant(),
          memberships: [membership()],
          submittedBy: MEMBER,
          submittedAt: AT + 10,
        }),
      ),
    ).toBe('invalid_restriction_record');
  });

  it('rejects an already lifted restriction', () => {
    const lifted = expectOk(liftRestriction({ record: restriction(), liftedAt: AT + 5 }));
    expect(
      expectRejection(
        submitAppeal({
          id: createAppealId('a-1'),
          restriction: lifted,
          tenant: tenant(),
          memberships: [membership()],
          submittedBy: MEMBER,
          submittedAt: AT + 10,
        }),
      ),
    ).toBe('restriction_already_lifted');
  });

  it('rejects a restriction that is not effective at submission time', () => {
    expect(
      expectRejection(
        submitAppeal({
          id: createAppealId('a-1'),
          restriction: restriction({ activatesAt: AT + 100 }),
          tenant: tenant(),
          memberships: [membership()],
          submittedBy: MEMBER,
          submittedAt: AT + 10,
        }),
      ),
    ).toBe('restriction_not_effective');
  });

  it('accepts a submission exactly at the appeal deadline and rejects one millisecond later', () => {
    const record = restriction({ appealDeadline: AT + 100 });
    expect(submitted(record, [membership()], AT + 100).status).toBe('submitted');
    expect(
      expectRejection(
        submitAppeal({
          id: createAppealId('a-2'),
          restriction: record,
          tenant: tenant(),
          memberships: [membership()],
          submittedBy: MEMBER,
          submittedAt: AT + 101,
        }),
      ),
    ).toBe('appeal_deadline_passed');
  });

  it('does not invent a deadline when the restriction has none', () => {
    expect(submitted(restriction(), [membership()], AT + 10_000_000).status).toBe('submitted');
  });

  it('rejects duplicate appeal ids and cross-tenant collections', () => {
    const existing = submitted(restriction(), [membership()], AT + 10);
    expect(
      expectRejection(
        submitAppeal({
          id: createAppealId('a-1'),
          restriction: restriction(),
          tenant: tenant(),
          memberships: [membership()],
          submittedBy: MEMBER,
          submittedAt: AT + 10,
          existing: [existing],
        }),
      ),
    ).toBe('duplicate_appeal_id');

    const foreign = Object.freeze({ ...existing, tenantId: createSellerTenantId('tenant-2') });
    expect(
      expectRejection(
        submitAppeal({
          id: createAppealId('a-2'),
          restriction: restriction(),
          tenant: tenant(),
          memberships: [membership()],
          submittedBy: MEMBER,
          submittedAt: AT + 10,
          existing: [foreign],
        }),
      ),
    ).toBe('inconsistent_context');
  });

  it('returns domain errors rather than throwing on corrupted records', () => {
    expect(
      expectRejection(
        submitAppeal({
          id: createAppealId('a-1'),
          restriction: restriction(),
          tenant: tenant(),
          memberships: [membership()],
          submittedBy: MEMBER,
          submittedAt: AT + 10,
          existing: [null] as never,
        }),
      ),
    ).toBe('invalid_appeal_record');
    expect(
      expectRejection(
        startAppealReview({
          appeal: { id: 'a-1' } as never,
          reviewer: REVIEWER,
          reviewedAt: AT + 20,
        }),
      ),
    ).toBe('invalid_appeal_record');
    expect(
      expectRejection(
        decideAppeal({
          appeal: null as never,
          decision: 'accepted',
          decidedBy: REVIEWER,
          decidedAt: AT + 30,
        }),
      ),
    ).toBe('invalid_appeal_record');
    expect(expectRejection(withdrawAppeal({ appeal: null as never, withdrawnAt: AT + 30 }))).toBe(
      'invalid_appeal_record',
    );
  });

  it('rejects malformed ids and timestamps', () => {
    expect(
      expectRejection(
        submitAppeal({
          id: '',
          restriction: restriction(),
          tenant: tenant(),
          memberships: [membership()],
          submittedBy: MEMBER,
          submittedAt: AT + 10,
        }),
      ),
    ).toBe('invalid_appeal_id');
    expect(
      expectRejection(
        submitAppeal({
          id: createAppealId('a-1'),
          restriction: restriction(),
          tenant: tenant(),
          memberships: [membership()],
          submittedBy: '',
          submittedAt: AT + 10,
        }),
      ),
    ).toBe('invalid_actor');
    expect(
      expectRejection(
        submitAppeal({
          id: createAppealId('a-1'),
          restriction: restriction(),
          tenant: tenant(),
          memberships: [membership()],
          submittedBy: MEMBER,
          submittedAt: AT + 0.5,
        }),
      ),
    ).toBe('invalid_timestamp');
  });
});

describe('appeal lifecycle', () => {
  it('runs submitted -> under_review -> rejected with public and internal reasons', () => {
    const review = expectOk(
      startAppealReview({ appeal: submitted(), reviewer: REVIEWER, reviewedAt: AT + 20 }),
    );
    expect(review.status).toBe('under_review');
    expect(review.reviewedBy).toBe(REVIEWER);

    const decided = expectOk(
      decideAppeal({
        appeal: review,
        decision: 'rejected',
        decidedBy: REVIEWER,
        decidedAt: AT + 30,
        decisionReason: 'Sanctions link confirmed.',
        publicDecisionReason: 'Evidence did not support release.',
      }),
    );
    expect(decided.status).toBe('rejected');
    expect(decided.decisionReason).toBe('Sanctions link confirmed.');
    expect(decided.publicDecisionReason).toBe('Evidence did not support release.');
  });

  it('requires a public reason when rejecting', () => {
    const review = expectOk(
      startAppealReview({ appeal: submitted(), reviewer: REVIEWER, reviewedAt: AT + 20 }),
    );
    expect(
      expectRejection(
        decideAppeal({
          appeal: review,
          decision: 'rejected',
          decidedBy: REVIEWER,
          decidedAt: AT + 30,
        }),
      ),
    ).toBe('missing_public_decision_reason');
  });

  it('accepts a decision without a public reason', () => {
    const review = expectOk(
      startAppealReview({ appeal: submitted(), reviewer: REVIEWER, reviewedAt: AT + 20 }),
    );
    const decided = expectOk(
      decideAppeal({
        appeal: review,
        decision: 'accepted',
        decidedBy: REVIEWER,
        decidedAt: AT + 30,
      }),
    );
    expect(decided.status).toBe('accepted');
    expect(decided.publicDecisionReason).toBeNull();
  });

  it('does not lift the restriction as a side effect of an accepted decision', () => {
    const record = restriction();
    const appeal = submitted(record, [membership()], AT + 10);
    const review = expectOk(startAppealReview({ appeal, reviewer: REVIEWER, reviewedAt: AT + 20 }));
    expectOk(
      decideAppeal({
        appeal: review,
        decision: 'accepted',
        decidedBy: REVIEWER,
        decidedAt: AT + 30,
      }),
    );
    expect(record.liftedAt).toBeNull();
  });

  it('rejects a decision that skips review', () => {
    expect(
      expectRejection(
        decideAppeal({
          appeal: submitted(),
          decision: 'accepted',
          decidedBy: REVIEWER,
          decidedAt: AT + 30,
        }),
      ),
    ).toBe('invalid_appeal_transition');
  });

  it('rejects a second decision and any transition out of a terminal state', () => {
    const review = expectOk(
      startAppealReview({ appeal: submitted(), reviewer: REVIEWER, reviewedAt: AT + 20 }),
    );
    const decided = expectOk(
      decideAppeal({
        appeal: review,
        decision: 'rejected',
        decidedBy: REVIEWER,
        decidedAt: AT + 30,
        publicDecisionReason: 'Not accepted.',
      }),
    );
    expect(
      expectRejection(
        decideAppeal({
          appeal: decided,
          decision: 'accepted',
          decidedBy: REVIEWER,
          decidedAt: AT + 40,
        }),
      ),
    ).toBe('invalid_appeal_transition');
    expect(expectRejection(withdrawAppeal({ appeal: decided, withdrawnAt: AT + 40 }))).toBe(
      'invalid_appeal_transition',
    );
    expect(
      expectRejection(
        startAppealReview({ appeal: decided, reviewer: REVIEWER, reviewedAt: AT + 40 }),
      ),
    ).toBe('invalid_appeal_transition');
  });

  it('allows withdrawing a submitted or reviewed appeal only', () => {
    const withdrawn = expectOk(withdrawAppeal({ appeal: submitted(), withdrawnAt: AT + 15 }));
    expect(withdrawn.status).toBe('withdrawn');
    expect(withdrawn.withdrawnAt).toBe(AT + 15);

    const review = expectOk(
      startAppealReview({ appeal: submitted(), reviewer: REVIEWER, reviewedAt: AT + 20 }),
    );
    expect(expectOk(withdrawAppeal({ appeal: review, withdrawnAt: AT + 25 })).status).toBe(
      'withdrawn',
    );
  });

  it('rejects unknown decisions and invalid actors', () => {
    const review = expectOk(
      startAppealReview({ appeal: submitted(), reviewer: REVIEWER, reviewedAt: AT + 20 }),
    );
    expect(
      expectRejection(
        decideAppeal({
          appeal: review,
          decision: 'maybe',
          decidedBy: REVIEWER,
          decidedAt: AT + 30,
        }),
      ),
    ).toBe('invalid_decision');
    expect(
      expectRejection(
        decideAppeal({
          appeal: review,
          decision: 'accepted',
          decidedBy: '',
          decidedAt: AT + 30,
        }),
      ),
    ).toBe('invalid_actor');
    expect(
      expectRejection(
        startAppealReview({
          appeal: submitted(),
          reviewer: null,
          reviewedAt: AT + 20,
        }),
      ),
    ).toBe('invalid_actor');
  });
});

describe('appeal record guards', () => {
  it('reports a corrupted record before validating primitive arguments', () => {
    const corrupted = { ...submitted(), status: 'unknown' } as unknown as Appeal;
    expect(
      expectRejection(
        startAppealReview({ appeal: corrupted, reviewer: '', reviewedAt: 'nope' as never }),
      ),
    ).toBe('invalid_appeal_record');
    expect(
      expectRejection(
        decideAppeal({
          appeal: corrupted,
          decision: 'maybe',
          decidedBy: '',
          decidedAt: 'nope' as never,
        }),
      ),
    ).toBe('invalid_appeal_record');
    expect(
      expectRejection(withdrawAppeal({ appeal: corrupted, withdrawnAt: 'nope' as never })),
    ).toBe('invalid_appeal_record');
  });
});

describe('public projection', () => {
  it('never exposes the internal decision reason or reviewer identity', () => {
    const review = expectOk(
      startAppealReview({ appeal: submitted(), reviewer: REVIEWER, reviewedAt: AT + 20 }),
    );
    const decided = expectOk(
      decideAppeal({
        appeal: review,
        decision: 'rejected',
        decidedBy: REVIEWER,
        decidedAt: AT + 30,
        decisionReason: 'Sanctions link confirmed.',
        publicDecisionReason: 'Evidence did not support release.',
      }),
    );
    const publicAppeal = toPublicAppeal(decided);
    expect(publicAppeal).not.toHaveProperty('decisionReason');
    expect(publicAppeal).not.toHaveProperty('reviewedBy');
    expect(JSON.stringify(publicAppeal)).not.toContain('Sanctions link');
    expect(publicAppeal.publicDecisionReason).toBe('Evidence did not support release.');
    expect(Object.isFrozen(publicAppeal)).toBe(true);
  });
});

describe('isAppeal', () => {
  it('rejects inconsistent shapes', () => {
    const good = submitted();
    expect(isAppeal(good)).toBe(true);
    expect(isAppeal({ ...good, status: 'unknown' })).toBe(false);
    expect(isAppeal({ ...good, decidedAt: 'later' })).toBe(false);
    expect(isAppeal({ ...good, decisionReason: '' })).toBe(false);
    expect(isAppeal([])).toBe(false);
  });
});
