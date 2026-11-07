import { describe, expect, it } from 'vitest';

import { createSellerTenantId } from '@ecoma-io/llm-seller-tenant-domain';
import { createRestrictionId } from './shared';
import {
  createRestrictionRecord,
  evaluateRestrictions,
  isRestrictionEffective,
  isRestrictionEvaluation,
  isRestrictionRecord,
  liftRestriction,
  toPublicRestriction,
  type RestrictionPolicy,
  type RestrictionRecord,
  type RestrictionScope,
} from './restriction';

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
const AT = 1_700_000_000_000;

const RESTRICTIVE: Readonly<Record<string, RestrictionPolicy>> = Object.freeze({
  compliance: { restrictive: true },
  monitoring: { restrictive: false },
});

function record(
  overrides: Partial<Parameters<typeof createRestrictionRecord>[0]> = {},
  existing: readonly RestrictionRecord[] = [],
): RestrictionRecord {
  return expectOk(
    createRestrictionRecord(
      {
        id: createRestrictionId('r-1'),
        tenantId: TENANT,
        policy: 'compliance',
        publicReason: 'Regulatory review in progress.',
        internalReason: 'Case INV-77: suspected sanctions link.',
        scope: { kind: 'tenant' },
        activatesAt: AT,
        ...overrides,
      },
      existing,
    ),
  );
}

describe('createRestrictionRecord', () => {
  it('creates an independent record with public and internal reasons stored separately', () => {
    const created = record();
    expect(created.publicReason).toBe('Regulatory review in progress.');
    expect(created.internalReason).toContain('INV-77');
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.scope)).toBe(true);
  });

  it('normalizes omitted window fields to null', () => {
    const created = record();
    expect(created.expiresAt).toBeNull();
    expect(created.liftedAt).toBeNull();
    expect(created.appealDeadline).toBeNull();
  });

  it('rejects an empty or inverted window', () => {
    expect(
      expectRejection(
        createRestrictionRecord({
          id: createRestrictionId('r-1'),
          tenantId: TENANT,
          policy: 'compliance',
          publicReason: 'p',
          internalReason: 'i',
          scope: { kind: 'tenant' },
          activatesAt: AT,
          expiresAt: AT,
        }),
      ),
    ).toBe('invalid_restriction_window');
    expect(
      expectRejection(
        createRestrictionRecord({
          id: createRestrictionId('r-1'),
          tenantId: TENANT,
          policy: 'compliance',
          publicReason: 'p',
          internalReason: 'i',
          scope: { kind: 'tenant' },
          activatesAt: AT,
          liftedAt: AT - 1,
        }),
      ),
    ).toBe('invalid_restriction_window');
    expect(
      expectRejection(
        createRestrictionRecord({
          id: createRestrictionId('r-1'),
          tenantId: TENANT,
          policy: 'compliance',
          publicReason: 'p',
          internalReason: 'i',
          scope: { kind: 'tenant' },
          activatesAt: AT,
          appealDeadline: AT - 1,
        }),
      ),
    ).toBe('invalid_restriction_window');
  });

  it('rejects missing reasons, unknown scope shapes and malformed fields', () => {
    expect(
      expectRejection(
        createRestrictionRecord({
          id: createRestrictionId('r-1'),
          tenantId: TENANT,
          policy: 'compliance',
          publicReason: '',
          internalReason: 'i',
          scope: { kind: 'tenant' },
          activatesAt: AT,
        }),
      ),
    ).toBe('invalid_restriction_record');
    expect(
      expectRejection(
        createRestrictionRecord({
          id: createRestrictionId('r-1'),
          tenantId: TENANT,
          policy: 'compliance',
          publicReason: 'p',
          internalReason: 'i',
          scope: { kind: 'capability' },
          activatesAt: AT,
        }),
      ),
    ).toBe('invalid_restriction_record');
    expect(
      expectRejection(
        createRestrictionRecord({
          id: '',
          tenantId: TENANT,
          policy: 'compliance',
          publicReason: 'p',
          internalReason: 'i',
          scope: { kind: 'tenant' },
          activatesAt: AT,
        }),
      ),
    ).toBe('invalid_restriction_id');
  });

  it('rejects a duplicate id within the tenant and a foreign-tenant collection', () => {
    const existing = record();
    expect(
      expectRejection(
        createRestrictionRecord(
          {
            id: createRestrictionId('r-1'),
            tenantId: TENANT,
            policy: 'compliance',
            publicReason: 'p',
            internalReason: 'i',
            scope: { kind: 'tenant' },
            activatesAt: AT,
          },
          [existing],
        ),
      ),
    ).toBe('duplicate_restriction_id');

    const foreign = record({ tenantId: OTHER_TENANT, id: createRestrictionId('r-2') });
    expect(
      expectRejection(
        createRestrictionRecord(
          {
            id: createRestrictionId('r-3'),
            tenantId: TENANT,
            policy: 'compliance',
            publicReason: 'p',
            internalReason: 'i',
            scope: { kind: 'tenant' },
            activatesAt: AT,
          },
          [foreign],
        ),
      ),
    ).toBe('inconsistent_context');
  });
});

describe('isRestrictionEffective', () => {
  it('uses a half-open window', () => {
    const scheduled = record({ activatesAt: AT, expiresAt: AT + 100 });
    expect(isRestrictionEffective(scheduled, AT - 1)).toBe(false);
    expect(isRestrictionEffective(scheduled, AT)).toBe(true);
    expect(isRestrictionEffective(scheduled, AT + 99)).toBe(true);
    expect(isRestrictionEffective(scheduled, AT + 100)).toBe(false);
  });

  it('treats a future lift as not yet effective', () => {
    const scheduledLift = record({ liftedAt: AT + 50 });
    expect(isRestrictionEffective(scheduledLift, AT + 49)).toBe(true);
    expect(isRestrictionEffective(scheduledLift, AT + 50)).toBe(false);
  });

  it('returns false for an invalid time', () => {
    expect(isRestrictionEffective(record(), Number.NaN)).toBe(false);
  });
});

describe('evaluateRestrictions', () => {
  it('blocks on any effective restrictive record regardless of lift of another', () => {
    const first = record({ id: createRestrictionId('r-1'), policy: 'compliance' });
    const second = record({ id: createRestrictionId('r-2'), policy: 'compliance' });
    const liftedFirst = expectOk(liftRestriction({ record: first, liftedAt: AT + 1 }));
    const evaluation = expectOk(
      evaluateRestrictions({
        tenantId: TENANT,
        records: [liftedFirst, second],
        policies: RESTRICTIVE,
        target: { kind: 'tenant' },
        now: AT + 10,
      }),
    );
    expect(evaluation.blocked).toBe(true);
    expect(evaluation.blockingRecordIds).toEqual([second.id]);
    expect(evaluation.unevaluable).toBe(false);
  });

  it('does not block when the only effective record has a non-restrictive policy', () => {
    const evaluation = expectOk(
      evaluateRestrictions({
        tenantId: TENANT,
        records: [record({ policy: 'monitoring' })],
        policies: RESTRICTIVE,
        target: { kind: 'tenant' },
        now: AT + 10,
      }),
    );
    expect(evaluation).toEqual({
      tenantId: TENANT,
      target: { kind: 'tenant' },
      blocked: false,
      unevaluable: false,
      blockingRecordIds: [],
      unknownPolicies: [],
    });
  });

  it('fails closed for an unknown policy: restrictive and unevaluable', () => {
    const evaluation = expectOk(
      evaluateRestrictions({
        tenantId: TENANT,
        records: [record({ policy: 'new_policy' })],
        policies: RESTRICTIVE,
        target: { kind: 'tenant' },
        now: AT + 10,
      }),
    );
    expect(evaluation.blocked).toBe(true);
    expect(evaluation.unevaluable).toBe(true);
    expect(evaluation.unknownPolicies).toEqual(['new_policy']);
  });

  it('ignores a policy key inherited from the prototype', () => {
    const evaluation = expectOk(
      evaluateRestrictions({
        tenantId: TENANT,
        records: [record({ policy: 'toString' })],
        policies: RESTRICTIVE,
        target: { kind: 'tenant' },
        now: AT + 10,
      }),
    );
    expect(evaluation.unevaluable).toBe(true);
  });

  it('applies tenant scope to every target and capability scope only to its capability', () => {
    const tenantWide = record({ id: createRestrictionId('r-1') });
    const offerOnly = record({
      id: createRestrictionId('r-2'),
      scope: { kind: 'capability', capability: 'offer' },
    });
    const records = [tenantWide, offerOnly];
    const offerEval = expectOk(
      evaluateRestrictions({
        tenantId: TENANT,
        records,
        policies: RESTRICTIVE,
        target: { kind: 'capability', capability: 'offer' },
        now: AT + 10,
      }),
    );
    expect(offerEval.blockingRecordIds).toEqual([tenantWide.id, offerOnly.id]);

    const payoutEval = expectOk(
      evaluateRestrictions({
        tenantId: TENANT,
        records: [offerOnly],
        policies: RESTRICTIVE,
        target: { kind: 'capability', capability: 'payout' },
        now: AT + 10,
      }),
    );
    expect(payoutEval.blocked).toBe(false);
  });

  it('rejects cross-tenant records wholesale', () => {
    const foreign = record({ tenantId: OTHER_TENANT });
    expect(
      expectRejection(
        evaluateRestrictions({
          tenantId: TENANT,
          records: [foreign],
          policies: RESTRICTIVE,
          target: { kind: 'tenant' },
          now: AT + 10,
        }),
      ),
    ).toBe('inconsistent_context');
  });

  it('rejects corrupted records rather than skipping them', () => {
    expect(
      expectRejection(
        evaluateRestrictions({
          tenantId: TENANT,
          records: [{ id: 'r-1' } as RestrictionRecord],
          policies: RESTRICTIVE,
          target: { kind: 'tenant' },
          now: AT + 10,
        }),
      ),
    ).toBe('invalid_restriction_record');
  });

  it('does not let a positional prototype key masquerade as a policy', () => {
    const policies = Object.create({ constructor: { restrictive: false } }) as Record<
      string,
      RestrictionPolicy
    >;
    const evaluation = expectOk(
      evaluateRestrictions({
        tenantId: TENANT,
        records: [record({ policy: 'constructor' })],
        policies,
        target: { kind: 'tenant' },
        now: AT + 10,
      }),
    );
    expect(evaluation.unevaluable).toBe(true);
  });
});

describe('liftRestriction', () => {
  it('sets liftedAt without touching other records', () => {
    const first = record({ id: createRestrictionId('r-1') });
    const second = record({ id: createRestrictionId('r-2') });
    const lifted = expectOk(liftRestriction({ record: first, liftedAt: AT + 5 }));
    expect(lifted.liftedAt).toBe(AT + 5);
    expect(second.liftedAt).toBeNull();
  });

  it('rejects a second lift and a lift before activation', () => {
    const lifted = expectOk(liftRestriction({ record: record(), liftedAt: AT + 5 }));
    expect(expectRejection(liftRestriction({ record: lifted, liftedAt: AT + 6 }))).toBe(
      'restriction_already_lifted',
    );
    expect(expectRejection(liftRestriction({ record: record(), liftedAt: AT - 1 }))).toBe(
      'invalid_restriction_window',
    );
  });

  it('rejects a corrupted record instead of throwing', () => {
    expect(
      expectRejection(
        liftRestriction({ record: { ...record(), internalReason: '' }, liftedAt: AT + 5 }),
      ),
    ).toBe('invalid_restriction_record');
    expect(expectRejection(liftRestriction({ record: null as never, liftedAt: AT + 5 }))).toBe(
      'invalid_restriction_record',
    );
  });
});

describe('public projection', () => {
  it('never exposes internalReason', () => {
    const publicRecord = toPublicRestriction(record());
    expect(publicRecord).not.toHaveProperty('internalReason');
    expect(JSON.stringify(publicRecord)).not.toContain('INV-77');
    expect(Object.isFrozen(publicRecord)).toBe(true);
  });

  it('carries the seller-visible reason and window', () => {
    const publicRecord = toPublicRestriction(record({ appealDeadline: AT + 1000 }));
    expect(publicRecord.publicReason).toBe('Regulatory review in progress.');
    expect(publicRecord.appealDeadline).toBe(AT + 1000);
  });

  it('rebuilds scope instead of copying extra keys', () => {
    const publicScopeSource = { kind: 'capability' as const, capability: 'payout' };
    const corrupted = Object.freeze({
      ...record({ scope: publicScopeSource }),
      scope: { ...publicScopeSource, internalReason: 'INV-77' },
    }) as RestrictionRecord;
    const publicRecord = toPublicRestriction(corrupted);
    expect(Object.keys(publicRecord.scope).toSorted()).toEqual(['capability', 'kind']);
    expect(JSON.stringify(publicRecord)).not.toContain('INV-77');

    // Mutation trên scope công khai không được chạm record nội bộ.
    const mutable = publicRecord.scope as { capability?: string };
    expect(() => {
      mutable.capability = 'offer';
    }).toThrow(TypeError);
    expect(publicScopeSource.capability).toBe('payout');
    expect(publicScopeSource.capability).toBe('payout');
  });
});

describe('isRestrictionRecord', () => {
  it('rejects records with missing or mistyped fields', () => {
    const good = record();
    expect(isRestrictionRecord(good)).toBe(true);
    expect(isRestrictionRecord({ ...good, internalReason: '' })).toBe(false);
    expect(isRestrictionRecord({ ...good, scope: { kind: 'tenant', capability: 'x' } })).toBe(
      false,
    );
    expect(isRestrictionRecord({ ...good, expiresAt: undefined })).toBe(false);
  });

  it('accepts a capability scope with a label', () => {
    const scoped: RestrictionScope = { kind: 'capability', capability: 'offer' };
    expect(isRestrictionRecord(record({ scope: scoped }))).toBe(true);
  });

  it('rejects a scope carrying unknown keys', () => {
    const good = record();
    expect(
      isRestrictionRecord({
        ...good,
        scope: { kind: 'capability', capability: 'payout', internalReason: 'INV-77' },
      }),
    ).toBe(false);
    expect(isRestrictionRecord({ ...good, scope: { kind: 'tenant', extra: 1 } })).toBe(false);
  });

  it('does not throw on a corrupted record or a corrupted existing collection', () => {
    expect(isRestrictionEffective(null as never, AT)).toBe(false);
    expect(
      expectRejection(
        createRestrictionRecord(
          {
            id: createRestrictionId('r-new'),
            tenantId: TENANT,
            policy: 'compliance',
            publicReason: 'Reason.',
            internalReason: 'Internal.',
            scope: { kind: 'tenant' },
            activatesAt: AT,
          },
          [null] as never,
        ),
      ),
    ).toBe('invalid_restriction_record');
  });
});

describe('isRestrictionEvaluation', () => {
  it('requires boolean blocked/unevaluable and well-formed collections', () => {
    const good = {
      tenantId: TENANT,
      target: { kind: 'tenant' },
      blocked: false,
      unevaluable: false,
      blockingRecordIds: [],
      unknownPolicies: [],
    };
    expect(isRestrictionEvaluation(good)).toBe(true);
    expect(isRestrictionEvaluation({ tenantId: TENANT, target: { kind: 'tenant' } })).toBe(false);
    expect(isRestrictionEvaluation({ ...good, blocked: 'no' })).toBe(false);
    expect(isRestrictionEvaluation({ ...good, blockingRecordIds: ['r-1'] })).toBe(true);
    expect(isRestrictionEvaluation(null)).toBe(false);
  });
});
