/**
 * Các guard trong `shared.ts` phải thả quyền cho kernel tenant
 * (`@ecoma-io/tenant-kernel-domain`): cùng ngữ nghĩa, không chồng chéo
 * implementation riêng của bounded context này.
 */

import { describe, expect, it } from 'vitest';

import { MAX_OPAQUE_ID_LENGTH, isEpochMillis, isSellerActorId, isSellerTenantId } from './shared';

describe('shared guards delegate to @ecoma-io/tenant-kernel-domain', () => {
  it('MAX_OPAQUE_ID_LENGTH stays 200', () => {
    expect(MAX_OPAQUE_ID_LENGTH).toBe(200);
  });

  it('rejects an opaque id over the limit, padded or empty', () => {
    const overLong = 'a'.repeat(201);
    expect(isSellerTenantId(overLong)).toBe(false);
    expect(isSellerActorId(overLong)).toBe(false);
    expect(isSellerTenantId(' tenant-1')).toBe(false);
    expect(isSellerActorId(' owner-1 ')).toBe(false);
    expect(isSellerTenantId('')).toBe(false);
    expect(isSellerActorId('')).toBe(false);
  });

  it('accepts valid opaque ids', () => {
    expect(isSellerTenantId('tenant-1')).toBe(true);
    expect(isSellerActorId('owner-1')).toBe(true);
  });

  it('isEpochMillis rejects strings and unsafe numbers', () => {
    expect(isEpochMillis('1700000000000')).toBe(false);
    expect(isEpochMillis(Number.NaN)).toBe(false);
    expect(isEpochMillis(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isEpochMillis(2 ** 53)).toBe(false);
    expect(isEpochMillis(1.5)).toBe(false);
    expect(isEpochMillis(null)).toBe(false);
    expect(isEpochMillis(1_700_000_000_000)).toBe(true);
  });
});
