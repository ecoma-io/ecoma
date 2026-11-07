import { describe, expect, it } from 'vitest';

import {
  MAX_CAPABILITY_LENGTH,
  createCapabilitySet,
  hasCapability,
  isCapability,
  isCapabilitySet,
  satisfiesCapabilities,
} from './index';

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

describe('isCapability', () => {
  it('accepts lowercase snake_case labels', () => {
    expect(isCapability('text_generation')).toBe(true);
    expect(isCapability('vision')).toBe(true);
    expect(isCapability('function_calling')).toBe(true);
    expect(isCapability(`a${'b'.repeat(MAX_CAPABILITY_LENGTH - 1)}`)).toBe(true);
  });

  it('rejects empty, padded, uppercase, dotted, over-limit and non-string values', () => {
    expect(isCapability('')).toBe(false);
    expect(isCapability(' text')).toBe(false);
    expect(isCapability('Text')).toBe(false);
    expect(isCapability('text generation')).toBe(false);
    expect(isCapability('text.generation')).toBe(false);
    expect(isCapability('1text')).toBe(false);
    expect(isCapability('a'.repeat(MAX_CAPABILITY_LENGTH + 1))).toBe(false);
    expect(isCapability(1)).toBe(false);
    expect(isCapability(null)).toBe(false);
  });
});

describe('createCapabilitySet', () => {
  it('returns a canonical, sorted, frozen set without mutating input', () => {
    const input = ['vision', 'text_generation', 'embedding'];
    const set = expectOk(createCapabilitySet(input));
    expect(set.capabilities).toEqual(['embedding', 'text_generation', 'vision']);
    expect(Object.isFrozen(set)).toBe(true);
    expect(Object.isFrozen(set.capabilities)).toBe(true);
    expect(input).toEqual(['vision', 'text_generation', 'embedding']);
  });

  it('sorting is deterministic regardless of caller order', () => {
    const a = expectOk(createCapabilitySet(['b', 'a']));
    const b = expectOk(createCapabilitySet(['a', 'b']));
    expect(a).toEqual(b);
  });

  it('rejects an empty set', () => {
    expect(expectRejection(createCapabilitySet([]))).toBe('invalid_capability_set');
  });

  it('rejects a duplicate capability', () => {
    expect(expectRejection(createCapabilitySet(['vision', 'vision']))).toBe(
      'invalid_capability_set',
    );
  });

  it('rejects an invalid capability', () => {
    expect(expectRejection(createCapabilitySet(['vision', 'bad one']))).toBe('invalid_capability');
  });

  it('rejects a non-array input', () => {
    expect(expectRejection(createCapabilitySet('vision'))).toBe('invalid_capability_set');
    expect(expectRejection(createCapabilitySet(null))).toBe('invalid_capability_set');
    expect(expectRejection(createCapabilitySet(undefined))).toBe('invalid_capability_set');
  });
});

describe('isCapabilitySet', () => {
  it('accepts a canonical frozen set', () => {
    expect(isCapabilitySet(expectOk(createCapabilitySet(['vision'])))).toBe(true);
  });

  it('rejects a set that is not in canonical order', () => {
    expect(isCapabilitySet({ capabilities: ['vision', 'embedding'] })).toBe(false);
  });

  it('rejects empty, duplicated, invalid and malformed sets', () => {
    expect(isCapabilitySet({ capabilities: [] })).toBe(false);
    expect(isCapabilitySet({ capabilities: ['vision', 'vision'] })).toBe(false);
    expect(isCapabilitySet({ capabilities: ['vision', 'bad one'] })).toBe(false);
    expect(isCapabilitySet({ capabilities: 'vision' })).toBe(false);
    expect(isCapabilitySet(null)).toBe(false);
  });
});

describe('hasCapability', () => {
  const set = expectOk(createCapabilitySet(['vision', 'embedding']));

  it('reports membership', () => {
    expect(hasCapability(set, 'vision')).toBe(true);
    expect(hasCapability(set, 'text_generation')).toBe(false);
  });

  it('fails closed on an invalid capability or set', () => {
    expect(hasCapability(set, 'Vision')).toBe(false);
    expect(hasCapability({ capabilities: [] }, 'vision')).toBe(false);
  });
});

describe('satisfiesCapabilities', () => {
  const set = expectOk(createCapabilitySet(['vision', 'embedding', 'text_generation']));

  it('requires every requested capability', () => {
    expect(satisfiesCapabilities(set, ['vision'])).toBe(true);
    expect(satisfiesCapabilities(set, ['vision', 'embedding'])).toBe(true);
    expect(satisfiesCapabilities(set, ['vision', 'function_calling'])).toBe(false);
  });

  it('treats an empty requirement as no filter', () => {
    expect(satisfiesCapabilities(set, [])).toBe(true);
  });

  it('fails closed when the requirement or the set is invalid', () => {
    expect(satisfiesCapabilities(set, ['Vision'])).toBe(false);
    expect(satisfiesCapabilities(set, 'vision')).toBe(false);
    expect(satisfiesCapabilities({ capabilities: [] }, ['vision'])).toBe(false);
  });
});
