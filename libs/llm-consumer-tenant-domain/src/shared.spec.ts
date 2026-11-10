/**
 * Các guard trong `shared.ts` phải thả quyền cho kernel tenant
 * (`@ecoma-io/tenant-kernel-domain`): cùng ngữ nghĩa, không chồng chéo
 * implementation riêng của bounded context này.
 */

import { describe, expect, it } from 'vitest';

import { MAX_OPAQUE_ID_LENGTH, isEpochMillis, isTenantActorId, isTenantId } from './shared';

describe('shared guards delegate to @ecoma-io/tenant-kernel-domain', () => {
  it('MAX_OPAQUE_ID_LENGTH stays 200', () => {
    expect(MAX_OPAQUE_ID_LENGTH).toBe(200);
  });

  it('rejects an opaque id over the limit, padded or empty', () => {
    const overLong = 'a'.repeat(201);
    expect(isTenantId(overLong)).toBe(false);
    expect(isTenantActorId(overLong)).toBe(false);
    expect(isTenantId(' tnt_acme')).toBe(false);
    expect(isTenantActorId(' sub_alice')).toBe(false);
    expect(isTenantId('')).toBe(false);
    expect(isTenantActorId('')).toBe(false);
  });

  it('accepts valid opaque ids', () => {
    expect(isTenantId('tnt_acme')).toBe(true);
    expect(isTenantActorId('sub_alice')).toBe(true);
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
