import { describe, expect, it } from 'vitest';

import {
  selectByPriority,
  selectRoundRobin,
  selectLowestPrice,
  selectCandidate,
  ROUTING_STRATEGY,
  isRoutingStrategy,
  isRoundRobinCursor,
  isPriceFact,
} from './strategy';
import type { RoundRobinCursor, PriceFact, RoutingStrategy } from './strategy';
import type { Candidate, CandidateId } from './candidate';

function candidate(
  overrides: Partial<Omit<Candidate, 'candidateId'>> & { candidateId?: string } = {},
): Candidate {
  return {
    priority: 1,
    capability: { model: 'm', streaming: true },
    endpoints: ['https://e.example.com'],
    offerId: 'offer-1',
    ...overrides,
    candidateId: (overrides.candidateId ?? 'cand-a') as unknown as CandidateId,
  } as Candidate;
}

function priceFact(candidateId: string, amount: number, currency: string): PriceFact {
  return { candidateId: candidateId as unknown as CandidateId, amount, currency };
}

describe('priority strategy', () => {
  it('selects the highest priority (lowest number)', () => {
    const eligible = [
      candidate({ candidateId: 'low', priority: 5 }),
      candidate({ candidateId: 'high', priority: 1 }),
      candidate({ candidateId: 'mid', priority: 3 }),
    ];
    const result = selectByPriority(eligible);
    expect(result.ok).toBe(true);
    expect(result.ok && result.candidateId).toBe('high');
  });

  it('returns no_eligible_candidate for empty set', () => {
    const result = selectByPriority([]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('no_eligible_candidate');
  });

  it('uses input order as deterministic tie-break for equal priority', () => {
    const eligible = [
      candidate({ candidateId: 'first', priority: 1 }),
      candidate({ candidateId: 'second', priority: 1 }),
    ];
    const r1 = selectByPriority(eligible);
    const r2 = selectByPriority(eligible);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.ok && r1.candidateId).toBe('first');
    expect(r2.ok && r2.candidateId).toBe('first');
  });
});

describe('round-robin strategy', () => {
  const eligible = [
    candidate({ candidateId: 'a' }),
    candidate({ candidateId: 'b' }),
    candidate({ candidateId: 'c' }),
  ];

  it('cycles through candidates in order', () => {
    const r1 = selectRoundRobin(eligible, 0 as unknown as RoundRobinCursor);
    const r2 = selectRoundRobin(eligible, 1 as unknown as RoundRobinCursor);
    const r3 = selectRoundRobin(eligible, 2 as unknown as RoundRobinCursor);
    const r4 = selectRoundRobin(eligible, 3 as unknown as RoundRobinCursor);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);
    expect(r4.ok).toBe(true);
    expect(r1.ok && r1.candidateId).toBe('a');
    expect(r2.ok && r2.candidateId).toBe('b');
    expect(r3.ok && r3.candidateId).toBe('c');
    expect(r4.ok && r4.candidateId).toBe('a');
    expect(r1.ok && r1.nextCursor).toBe(1);
    expect(r4.ok && r4.nextCursor).toBe(1);
  });

  it('returns next cursor that advances deterministically', () => {
    const result = selectRoundRobin(eligible, 0 as unknown as RoundRobinCursor);
    expect(result.ok).toBe(true);
    expect(result.ok && result.nextCursor).toBe(1);
  });

  it('rejects empty eligible set', () => {
    const result = selectRoundRobin([], 0 as unknown as RoundRobinCursor);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('no_eligible_candidate');
  });

  it('rejects invalid cursor', () => {
    const result = selectRoundRobin(eligible, -1 as unknown as RoundRobinCursor);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('invalid_strategy_input');
  });

  it('isRoundRobinCursor validates boundaries', () => {
    expect(isRoundRobinCursor(0)).toBe(true);
    expect(isRoundRobinCursor(5)).toBe(true);
    expect(isRoundRobinCursor(-1)).toBe(false);
    expect(isRoundRobinCursor(1.5)).toBe(false);
    expect(isRoundRobinCursor('0')).toBe(false);
  });
});

describe('lowest price strategy', () => {
  const eligible = [
    candidate({ candidateId: 'a' }),
    candidate({ candidateId: 'b' }),
    candidate({ candidateId: 'c' }),
  ];

  const prices: PriceFact[] = [
    priceFact('a', 1200, 'VND'),
    priceFact('b', 900, 'VND'),
    priceFact('c', 900, 'VND'),
  ];

  it('selects the lowest price candidate', () => {
    const result = selectLowestPrice(eligible, prices, 'VND');
    expect(result.ok).toBe(true);
    expect(result.ok && result.candidateId).toBe('b');
  });

  it('uses input order as deterministic tie-break for equal price', () => {
    const result = selectLowestPrice(eligible, prices, 'VND');
    expect(result.ok).toBe(true);
    expect(result.ok && result.candidateId).toBe('b');
  });

  it('excludes candidates missing a price in the given currency', () => {
    const result = selectLowestPrice(eligible, prices, 'USD');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('no_eligible_candidate');
  });

  it('rejects empty eligible set', () => {
    const result = selectLowestPrice([], prices, 'VND');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('no_eligible_candidate');
  });

  it('rejects invalid currency', () => {
    const result = selectLowestPrice(eligible, prices, '');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('invalid_strategy_input');
  });

  it('never compares across currencies', () => {
    const usdPrices: PriceFact[] = [priceFact('a', 10, 'USD'), priceFact('b', 5, 'USD')];
    const result = selectLowestPrice(eligible, usdPrices, 'USD');
    expect(result.ok).toBe(true);
    expect(result.ok && result.candidateId).toBe('b');
  });
});

describe('selectCandidate dispatcher', () => {
  const eligible = [candidate({ candidateId: 'a', priority: 1 })];

  it('dispatches priority', () => {
    const result = selectCandidate(ROUTING_STRATEGY.priority, eligible, {});
    expect(result.ok).toBe(true);
  });

  it('dispatches round-robin with cursor', () => {
    const result = selectCandidate(ROUTING_STRATEGY.round_robin, eligible, {
      cursor: 0 as unknown as RoundRobinCursor,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects round-robin without cursor', () => {
    const result = selectCandidate(ROUTING_STRATEGY.round_robin, eligible, {});
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('invalid_strategy_input');
  });

  it('dispatches lowest price with facts', () => {
    const result = selectCandidate(ROUTING_STRATEGY.lowest_price, eligible, {
      priceFacts: [priceFact('a', 1, 'VND')],
      currency: 'VND',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects unknown strategy', () => {
    const result = selectCandidate('weighted' as unknown as RoutingStrategy, eligible, {});
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('invalid_strategy_input');
  });

  it('isRoutingStrategy validates vocabulary', () => {
    expect(isRoutingStrategy('priority')).toBe(true);
    expect(isRoutingStrategy('round_robin')).toBe(true);
    expect(isRoutingStrategy('lowest_price')).toBe(true);
    expect(isRoutingStrategy('weighted')).toBe(false);
    expect(isRoutingStrategy('')).toBe(false);
  });

  it('isPriceFact validates', () => {
    expect(isPriceFact(priceFact('x', 1, 'VND'))).toBe(true);
    expect(isPriceFact(priceFact('x', -1, 'VND'))).toBe(false);
    expect(isPriceFact({} as PriceFact)).toBe(false);
  });
});
