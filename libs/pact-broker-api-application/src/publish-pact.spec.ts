/**
 * Unit test cho `validatePactStructure` — các nhánh structural check trước
 * đây chỉ được chạm qua route. Message rejection giữ nguyên văn của route.
 */
import { describe, it, expect } from 'vitest';
import { validatePactStructure, MAX_PACT_INTERACTIONS } from './publish-pact';

const validPact = {
  consumer: { name: 'order-service' },
  provider: { name: 'payment-service' },
  interactions: [{ description: 'a request' }],
};

describe('validatePactStructure', () => {
  it('accepts a pact with consumer, provider and interactions', () => {
    const decision = validatePactStructure(validPact);
    expect(decision).toEqual({ outcome: 'accepted', pact: validPact });
  });

  it('rejects a pact without consumer', () => {
    const decision = validatePactStructure({
      ...validPact,
      consumer: undefined,
    });
    expect(decision).toEqual({
      outcome: 'rejected',
      message: 'Pact must contain consumer, provider, and interactions',
    });
  });

  it('rejects a pact without provider', () => {
    const decision = validatePactStructure({
      ...validPact,
      provider: undefined,
    });
    expect(decision).toEqual({
      outcome: 'rejected',
      message: 'Pact must contain consumer, provider, and interactions',
    });
  });

  it('rejects a pact without interactions', () => {
    const decision = validatePactStructure({
      ...validPact,
      interactions: undefined,
    });
    expect(decision).toEqual({
      outcome: 'rejected',
      message: 'Pact must contain consumer, provider, and interactions',
    });
  });

  it('rejects non-array interactions', () => {
    const decision = validatePactStructure({ ...validPact, interactions: 'not-an-array' });
    expect(decision).toEqual({
      outcome: 'rejected',
      message: 'interactions must be an array',
    });
  });

  it('rejects interactions above the cap with the count in the message', () => {
    const decision = validatePactStructure({
      ...validPact,
      interactions: Array.from({ length: MAX_PACT_INTERACTIONS + 1 }, (_, i) => ({ i })),
    });
    expect(decision).toEqual({
      outcome: 'rejected',
      message: `Pact contains ${MAX_PACT_INTERACTIONS + 1} interactions; the maximum is ${MAX_PACT_INTERACTIONS}`,
    });
  });

  it('accepts interactions at exactly the cap (boundary is inclusive)', () => {
    const decision = validatePactStructure({
      ...validPact,
      interactions: Array.from({ length: MAX_PACT_INTERACTIONS }, (_, i) => ({ i })),
    });
    expect(decision.outcome).toBe('accepted');
  });
});
