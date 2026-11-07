import { describe, expect, it } from 'vitest';

import {
  MAX_OPAQUE_ID_LENGTH,
  createEndpointPoolId,
  createModelOfferId,
  createProviderCredentialId,
  createSellerActorId,
  createSellerTenantId,
  createUpstreamEndpointId,
  isEpochMillis,
  isModelOfferId,
  isOpaqueLabel,
  isSellerActorId,
  isSellerTenantId,
} from './index';

describe('opaque identity guards', () => {
  it('accepts bounded, trimmed, non-empty ids', () => {
    expect(isSellerTenantId('tenant-1')).toBe(true);
    expect(isModelOfferId('offer-1')).toBe(true);
    expect(isOpaqueLabel('restriction')).toBe(true);
  });

  it('rejects empty, padded, non-string and over-limit ids', () => {
    expect(isSellerTenantId('')).toBe(false);
    expect(isSellerTenantId(' tenant')).toBe(false);
    expect(isSellerTenantId('tenant ')).toBe(false);
    expect(isSellerTenantId(1)).toBe(false);
    expect(isSellerTenantId(null)).toBe(false);
    expect(isSellerTenantId('x'.repeat(MAX_OPAQUE_ID_LENGTH + 1))).toBe(false);
  });

  it('accepts an id exactly at the length limit', () => {
    expect(isSellerTenantId('x'.repeat(MAX_OPAQUE_ID_LENGTH))).toBe(true);
  });

  it('create* throws TypeError on invalid values and returns the branded value otherwise', () => {
    expect(createSellerTenantId('tenant-1')).toBe('tenant-1');
    expect(createModelOfferId('offer-1')).toBe('offer-1');
    expect(createSellerActorId('sub-1')).toBe('sub-1');
    expect(createUpstreamEndpointId('ep-1')).toBe('ep-1');
    expect(createEndpointPoolId('pool-1')).toBe('pool-1');
    expect(createProviderCredentialId('cred-1')).toBe('cred-1');
    for (const create of [
      createSellerTenantId,
      createModelOfferId,
      createSellerActorId,
      createUpstreamEndpointId,
      createEndpointPoolId,
      createProviderCredentialId,
    ]) {
      expect(() => create('')).toThrow(TypeError);
      expect(() => create(' bad')).toThrow(TypeError);
    }
  });

  it('type guards distinguish the branded ids', () => {
    expect(isSellerActorId('x')).toBe(true);
    expect(isModelOfferId('x')).toBe(true);
    expect(createEndpointPoolId('pool-1')).toBe('pool-1');
  });
});

describe('isEpochMillis', () => {
  it('accepts safe integers including zero and rejects the rest', () => {
    expect(isEpochMillis(0)).toBe(true);
    expect(isEpochMillis(1_700_000_000_000)).toBe(true);
    expect(isEpochMillis(-1)).toBe(false);
    expect(isEpochMillis(1.5)).toBe(false);
    expect(isEpochMillis(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isEpochMillis('1700000000000')).toBe(false);
    expect(isEpochMillis(null)).toBe(false);
    expect(isEpochMillis(undefined)).toBe(false);
  });
});
