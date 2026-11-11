/**
 * Các guard trong `shared.ts` phải thả quyền cho kernel tenant
 * (`@ecoma-io/tenant-kernel-domain`): cùng ngữ nghĩa, không chồng chéo
 * implementation riêng của bounded context này.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_OPAQUE_ID_LENGTH,
  isEpochMillis,
  isFirstPartySellerTenantNameKey,
  isSellerActorId,
  isSellerTenantId,
} from './shared';

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

describe('isFirstPartySellerTenantNameKey (ADR-0027 §2c key shape)', () => {
  it('accepts the canonical first-party provider name dronie', () => {
    expect(isFirstPartySellerTenantNameKey('dronie')).toBe(true);
  });

  it('accepts lowercase letters, digits and hyphens up to 64 characters', () => {
    expect(isFirstPartySellerTenantNameKey('a')).toBe(true);
    expect(isFirstPartySellerTenantNameKey('provider-2-west')).toBe(true);
    expect(isFirstPartySellerTenantNameKey('a'.repeat(64))).toBe(true);
  });

  it('rejects the empty string', () => {
    expect(isFirstPartySellerTenantNameKey('')).toBe(false);
  });

  it('rejects uppercase anywhere', () => {
    expect(isFirstPartySellerTenantNameKey('Dronie')).toBe(false);
    expect(isFirstPartySellerTenantNameKey('dronieX')).toBe(false);
  });

  it('rejects whitespace inside the key', () => {
    expect(isFirstPartySellerTenantNameKey('d ronie')).toBe(false);
    expect(isFirstPartySellerTenantNameKey(' dronie')).toBe(false);
    expect(isFirstPartySellerTenantNameKey('dronie ')).toBe(false);
  });

  it('rejects characters outside a-z0-9 and hyphen', () => {
    expect(isFirstPartySellerTenantNameKey('dronie_')).toBe(false);
    expect(isFirstPartySellerTenantNameKey('dronie.eu')).toBe(false);
  });

  it('rejects a leading digit and a leading hyphen', () => {
    expect(isFirstPartySellerTenantNameKey('1dronie')).toBe(false);
    expect(isFirstPartySellerTenantNameKey('-dronie')).toBe(false);
  });

  it('rejects a key longer than 64 characters', () => {
    expect(isFirstPartySellerTenantNameKey('a'.repeat(65))).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isFirstPartySellerTenantNameKey(null)).toBe(false);
    expect(isFirstPartySellerTenantNameKey(42)).toBe(false);
    expect(isFirstPartySellerTenantNameKey(undefined)).toBe(false);
  });

  it('does not classify by name: environment lane labels still match the shape', () => {
    // Hình dạng chuỗi không phải bằng chứng classification (ADR-0026 §6); việc
    // từ chối nhãn environment/lane là trách nhiệm của bước bootstrap (§2d).
    expect(isFirstPartySellerTenantNameKey('local')).toBe(true);
    expect(isFirstPartySellerTenantNameKey('production')).toBe(true);
  });
});
