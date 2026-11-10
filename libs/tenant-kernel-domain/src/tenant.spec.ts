import { describe, expect, it } from 'vitest';

import { isOwnedTenant, isTenantOwnedBy, type OwnedTenant } from './tenant';

function ownedTenant(overrides: Partial<OwnedTenant> = {}): OwnedTenant {
  return { id: 'tnt_acme', owner: 'sub_alice', ...overrides };
}

describe('isOwnedTenant', () => {
  it('accepts a valid owned tenant record', () => {
    expect(isOwnedTenant(ownedTenant())).toBe(true);
  });

  it('rejects a record missing owner', () => {
    expect(isOwnedTenant({ id: 'tnt_acme' })).toBe(false);
  });

  it('rejects a record missing id', () => {
    expect(isOwnedTenant({ owner: 'sub_alice' })).toBe(false);
  });

  it('rejects null, non-objects and arrays', () => {
    expect(isOwnedTenant(null)).toBe(false);
    expect(isOwnedTenant(undefined)).toBe(false);
    expect(isOwnedTenant('tnt_acme')).toBe(false);
    expect(isOwnedTenant(42)).toBe(false);
    expect(isOwnedTenant(['tnt_acme', 'sub_alice'])).toBe(false);
  });

  it('rejects an empty id or an empty owner', () => {
    expect(isOwnedTenant({ id: '', owner: 'sub_alice' })).toBe(false);
    expect(isOwnedTenant({ id: 'tnt_acme', owner: '' })).toBe(false);
  });

  it('rejects an id or owner with surrounding whitespace', () => {
    expect(isOwnedTenant({ id: ' tnt_acme', owner: 'sub_alice' })).toBe(false);
    expect(isOwnedTenant({ id: 'tnt_acme', owner: 'sub_alice ' })).toBe(false);
  });

  it('rejects an over-long id or owner', () => {
    expect(isOwnedTenant({ id: 'a'.repeat(201), owner: 'sub_alice' })).toBe(false);
    expect(isOwnedTenant({ id: 'tnt_acme', owner: 'a'.repeat(201) })).toBe(false);
  });
});

describe('isTenantOwnedBy', () => {
  it('returns true when the actor is the tenant owner', () => {
    expect(isTenantOwnedBy(ownedTenant(), 'sub_alice')).toBe(true);
  });

  it('returns false for a different actor', () => {
    expect(isTenantOwnedBy(ownedTenant(), 'sub_bob')).toBe(false);
  });

  it('returns false for a malformed tenant even when its owner field equals the actor', () => {
    // Bảo vệ hình dạng chạy trước so sánh: tenant thiếu id không bao giờ là
    // sở hữu, dù trường owner trùng actor.
    expect(isTenantOwnedBy({ owner: 'sub_alice' }, 'sub_alice')).toBe(false);
    expect(isTenantOwnedBy({ id: '', owner: 'sub_alice' }, 'sub_alice')).toBe(false);
    expect(isTenantOwnedBy(null, 'sub_alice')).toBe(false);
  });

  it('never throws on malformed input', () => {
    expect(() => isTenantOwnedBy(null, null)).not.toThrow();
    expect(() => isTenantOwnedBy(undefined, undefined)).not.toThrow();
    expect(() => isTenantOwnedBy({}, 'sub_alice')).not.toThrow();
    expect(() => isTenantOwnedBy(ownedTenant(), null)).not.toThrow();
  });
});
