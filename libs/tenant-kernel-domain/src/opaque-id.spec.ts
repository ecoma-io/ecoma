import { describe, expect, it } from 'vitest';

import { MAX_OPAQUE_ID_LENGTH, isOpaqueId } from './opaque-id';

describe('MAX_OPAQUE_ID_LENGTH', () => {
  it('equals 200', () => {
    expect(MAX_OPAQUE_ID_LENGTH).toBe(200);
  });
});

describe('isOpaqueId', () => {
  it('accepts a non-empty trimmed opaque id within the limit', () => {
    expect(isOpaqueId('tnt_acme')).toBe(true);
    expect(isOpaqueId('sub_alice')).toBe(true);
  });

  it('accepts an id exactly at the limit', () => {
    expect(isOpaqueId('a'.repeat(200))).toBe(true);
  });

  it('rejects the empty string', () => {
    expect(isOpaqueId('')).toBe(false);
  });

  it('rejects whitespace-only strings', () => {
    expect(isOpaqueId('   ')).toBe(false);
    expect(isOpaqueId('\t\n')).toBe(false);
  });

  it('rejects an id longer than the limit', () => {
    expect(isOpaqueId('a'.repeat(201))).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isOpaqueId(null)).toBe(false);
    expect(isOpaqueId(undefined)).toBe(false);
    expect(isOpaqueId(42)).toBe(false);
    expect(isOpaqueId({})).toBe(false);
    expect(isOpaqueId(['tnt_acme'])).toBe(false);
  });

  it('rejects padded strings although the core is a valid id (trim rule)', () => {
    expect(isOpaqueId(' tnt_acme')).toBe(false);
    expect(isOpaqueId('tnt_acme ')).toBe(false);
    expect(isOpaqueId('  tnt_acme  ')).toBe(false);
  });
});
