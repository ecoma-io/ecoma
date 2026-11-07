import { describe, expect, it } from 'vitest';

import { createSellerTenantId } from './shared';
import {
  isSameRestrictionTarget,
  isSellerRestrictionTarget,
  isSellerRestrictionVerdict,
} from './restriction-verdict';

const TENANT_ID = createSellerTenantId('tenant-1');
const TENANT_TARGET = Object.freeze({ kind: 'tenant' as const });
const PAYOUT_TARGET = Object.freeze({ kind: 'capability' as const, capability: 'payout' });

const VERDICT = Object.freeze({
  tenantId: TENANT_ID,
  target: TENANT_TARGET,
  blocked: false,
  unevaluable: false,
  blockingRecordIds: [],
  unknownPolicies: [],
});

describe('isSellerRestrictionTarget', () => {
  it('accepts the tenant target and a capability target', () => {
    expect(isSellerRestrictionTarget(TENANT_TARGET)).toBe(true);
    expect(isSellerRestrictionTarget(PAYOUT_TARGET)).toBe(true);
  });

  it('rejects an unknown kind, a blank capability and extra keys', () => {
    expect(isSellerRestrictionTarget({ kind: 'offer' })).toBe(false);
    expect(isSellerRestrictionTarget({ kind: 'capability' })).toBe(false);
    expect(isSellerRestrictionTarget({ kind: 'capability', capability: '' })).toBe(false);
    expect(isSellerRestrictionTarget({ kind: 'capability', capability: ' payout' })).toBe(false);
    expect(isSellerRestrictionTarget({ kind: 'tenant', capability: 'payout' })).toBe(false);
    expect(isSellerRestrictionTarget({ kind: 'tenant', extra: true })).toBe(false);
    expect(isSellerRestrictionTarget(null)).toBe(false);
    expect(isSellerRestrictionTarget('tenant')).toBe(false);
  });
});

describe('isSellerRestrictionVerdict', () => {
  it('accepts an evaluation produced for this boundary', () => {
    expect(isSellerRestrictionVerdict(VERDICT)).toBe(true);
    expect(isSellerRestrictionVerdict({ ...VERDICT, blocked: true })).toBe(true);
  });

  it('rejects a payload that omits blocked or unevaluable', () => {
    // Thiếu boolean đọc ra `undefined` (falsy) — ladder phải từ chối thay vì
    // coi đó là "không bị chặn".
    expect(
      isSellerRestrictionVerdict({
        tenantId: TENANT_ID,
        target: TENANT_TARGET,
        blockingRecordIds: [],
        unknownPolicies: [],
      }),
    ).toBe(false);
    expect(isSellerRestrictionVerdict({ ...VERDICT, blocked: 'false' })).toBe(false);
    expect(isSellerRestrictionVerdict(null)).toBe(false);
    expect(isSellerRestrictionVerdict([])).toBe(false);
  });

  it('rejects an evaluation whose audit arrays are missing or malformed', () => {
    // Payload chưa đi qua `evaluateRestrictions` không phải verdict để tin.
    expect(
      isSellerRestrictionVerdict({
        tenantId: TENANT_ID,
        target: TENANT_TARGET,
        blocked: false,
        unevaluable: false,
      }),
    ).toBe(false);
    expect(isSellerRestrictionVerdict({ ...VERDICT, blockingRecordIds: [''] })).toBe(false);
    expect(isSellerRestrictionVerdict({ ...VERDICT, unknownPolicies: [null] })).toBe(false);
  });
});

describe('isSameRestrictionTarget', () => {
  it('matches equal targets and rejects different ones', () => {
    expect(isSameRestrictionTarget(TENANT_TARGET, { kind: 'tenant' })).toBe(true);
    expect(
      isSameRestrictionTarget(PAYOUT_TARGET, { kind: 'capability', capability: 'payout' }),
    ).toBe(true);
    expect(
      isSameRestrictionTarget(PAYOUT_TARGET, { kind: 'capability', capability: 'offer' }),
    ).toBe(false);
    expect(isSameRestrictionTarget(TENANT_TARGET, PAYOUT_TARGET)).toBe(false);
  });
});
