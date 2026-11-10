import { describe, expect, it } from 'vitest';

import {
  ensureTenantScopedMembershipRefs,
  isTenantMembershipRef,
  type TenantMembershipRef,
} from './membership-ref';

const ALICE: TenantMembershipRef = { tenantId: 'tnt_acme', actor: 'sub_alice' };
const BOB: TenantMembershipRef = { tenantId: 'tnt_acme', actor: 'sub_bob' };

describe('isTenantMembershipRef', () => {
  it('accepts a valid membership ref', () => {
    expect(isTenantMembershipRef(ALICE)).toBe(true);
  });

  it('rejects a ref missing tenantId or actor', () => {
    expect(isTenantMembershipRef({ actor: 'sub_alice' })).toBe(false);
    expect(isTenantMembershipRef({ tenantId: 'tnt_acme' })).toBe(false);
  });

  it('rejects null, non-objects and arrays', () => {
    expect(isTenantMembershipRef(null)).toBe(false);
    expect(isTenantMembershipRef(undefined)).toBe(false);
    expect(isTenantMembershipRef('tnt_acme')).toBe(false);
    expect(isTenantMembershipRef(42)).toBe(false);
    expect(isTenantMembershipRef(['tnt_acme', 'sub_alice'])).toBe(false);
  });

  it('rejects wrong types and empty values', () => {
    expect(isTenantMembershipRef({ tenantId: 42, actor: 'sub_alice' })).toBe(false);
    expect(isTenantMembershipRef({ tenantId: 'tnt_acme', actor: null })).toBe(false);
    expect(isTenantMembershipRef({ tenantId: '', actor: 'sub_alice' })).toBe(false);
    expect(isTenantMembershipRef({ tenantId: 'tnt_acme', actor: '' })).toBe(false);
  });

  it('rejects an over-long tenantId or actor', () => {
    expect(isTenantMembershipRef({ tenantId: 'a'.repeat(201), actor: 'sub_alice' })).toBe(false);
    expect(isTenantMembershipRef({ tenantId: 'tnt_acme', actor: 'a'.repeat(201) })).toBe(false);
  });
});

describe('ensureTenantScopedMembershipRefs', () => {
  it('accepts an empty collection with empty refs', () => {
    expect(ensureTenantScopedMembershipRefs('tnt_acme', [])).toEqual({
      ok: true,
      refs: [],
    });
  });

  it('accepts a collection whose every ref belongs to the tenant', () => {
    expect(ensureTenantScopedMembershipRefs('tnt_acme', [ALICE, BOB])).toEqual({
      ok: true,
      refs: [ALICE, BOB],
    });
  });

  it('rejects the whole collection when one element targets another tenant', () => {
    expect(
      ensureTenantScopedMembershipRefs('tnt_acme', [
        ALICE,
        { tenantId: 'tnt_other', actor: 'sub_alice' },
      ]),
    ).toEqual({ ok: false, reason: 'inconsistent_context' });
  });

  it('rejects the whole collection when one element is null', () => {
    expect(ensureTenantScopedMembershipRefs('tnt_acme', [ALICE, null])).toEqual({
      ok: false,
      reason: 'inconsistent_context',
    });
  });

  it('rejects the whole collection when one element is a non-object', () => {
    expect(ensureTenantScopedMembershipRefs('tnt_acme', [ALICE, 42])).toEqual({
      ok: false,
      reason: 'inconsistent_context',
    });
  });

  it('rejects the whole collection when one element misses a field', () => {
    expect(ensureTenantScopedMembershipRefs('tnt_acme', [ALICE, { tenantId: 'tnt_acme' }])).toEqual(
      { ok: false, reason: 'inconsistent_context' },
    );
  });

  it('rejects the whole collection when one element is an invalid opaque id', () => {
    expect(
      ensureTenantScopedMembershipRefs('tnt_acme', [ALICE, { tenantId: 'tnt_acme', actor: '' }]),
    ).toEqual({ ok: false, reason: 'inconsistent_context' });
  });

  it('does not silently filter bad elements', () => {
    const result = ensureTenantScopedMembershipRefs('tnt_acme', [
      ALICE,
      { tenantId: 'tnt_other', actor: 'sub_bob' },
    ]);
    expect(result.ok).toBe(false);
    expect((result as { ok: boolean }).ok).toBe(false);
  });

  it('rejects an invalid tenant context with an empty collection', () => {
    const emptyItems: readonly unknown[] = [];
    for (const tenantId of ['', '   ', 'a'.repeat(201)]) {
      const result = ensureTenantScopedMembershipRefs(tenantId, emptyItems);
      expect(result).toEqual({ ok: false, reason: 'inconsistent_context' });
      expect('refs' in result).toBe(false);
    }
  });

  it('rejects an invalid tenant context even with a non-empty collection', () => {
    const validRefs = [ALICE, BOB];
    for (const tenantId of ['', '   ', 'a'.repeat(201)]) {
      const result = ensureTenantScopedMembershipRefs(tenantId, validRefs as unknown[]);
      expect(result).toEqual({ ok: false, reason: 'inconsistent_context' });
      expect('refs' in result).toBe(false);
    }
  });

  it('rejects a non-array collection without throwing', () => {
    expect(() =>
      ensureTenantScopedMembershipRefs('tnt_acme', null as unknown as never),
    ).not.toThrow();
    expect(() =>
      ensureTenantScopedMembershipRefs('tnt_acme', 'tnt_acme' as unknown as never),
    ).not.toThrow();
    expect(() =>
      ensureTenantScopedMembershipRefs('tnt_acme', {
        tenantId: 'tnt_acme',
        actor: 'sub_alice',
      } as unknown as never),
    ).not.toThrow();

    expect(ensureTenantScopedMembershipRefs('tnt_acme', null as unknown as never)).toEqual({
      ok: false,
      reason: 'inconsistent_context',
    });
    expect(ensureTenantScopedMembershipRefs('tnt_acme', 'tnt_acme' as unknown as never)).toEqual({
      ok: false,
      reason: 'inconsistent_context',
    });
  });
});
