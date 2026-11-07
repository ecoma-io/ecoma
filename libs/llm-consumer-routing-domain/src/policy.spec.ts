import { describe, expect, it } from 'vitest';

import { createPolicy, isRoutingPolicy, type RoutingPolicy } from './policy';
import type { FallbackConfig } from './snapshot';

function policyInputs(
  overrides: Partial<{
    policyId: string;
    candidates: readonly string[];
    currentVersion: number;
    strategy: RoutingPolicy['strategy'];
    fallbackConfig: FallbackConfig;
    updatedAt: number;
  }> = {},
): Parameters<typeof createPolicy>[0] {
  return {
    policyId: 'pol-1',
    candidates: ['cand-a', 'cand-b'],
    currentVersion: 1,
    strategy: 'priority',
    fallbackConfig: {
      endpointFallback: true,
      offerFallback: true,
      maxAttempts: 3,
    },
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('routing policy', () => {
  it('creates a policy with next monotonic version', () => {
    const result = createPolicy(policyInputs({ currentVersion: 5 }));
    expect(result.ok).toBe(true);
    expect(result.ok && result.policy.version).toBe(6);
    expect(result.ok && result.nextVersion).toBe(6);
    expect(result.ok && isRoutingPolicy(result.policy)).toBe(true);
  });

  it('rejects current version less than 1', () => {
    for (const v of [0, -1, NaN, undefined]) {
      const result = createPolicy(policyInputs({ currentVersion: v as unknown as number }));
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toBe('invalid_policy_version');
    }
  });

  it('rejects empty candidates', () => {
    const result = createPolicy(policyInputs({ candidates: [] }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('invalid_candidates');
  });

  it('rejects missing fallback config fields', () => {
    const result = createPolicy(
      policyInputs({ fallbackConfig: { endpointFallback: true } as unknown as FallbackConfig }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('invalid_fallback_config');
  });

  it('rejects invalid strategy', () => {
    const result = createPolicy(
      policyInputs({ strategy: 'weighted' as unknown as RoutingPolicy['strategy'] }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('invalid_strategy');
  });

  it('rejects empty policy id', () => {
    const result = createPolicy(policyInputs({ policyId: '   ' }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('invalid_policy_id');
  });

  it('rejects non-safe-integer updatedAt', () => {
    const result = createPolicy(policyInputs({ updatedAt: NaN as unknown as number }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('invalid_updated_at');
  });

  it('isRoutingPolicy recognizes valid and rejects invalid shapes', () => {
    expect(
      isRoutingPolicy({
        policyId: 'p',
        version: 1,
        candidates: ['c'],
        strategy: 'priority',
        fallbackConfig: { endpointFallback: true, offerFallback: false, maxAttempts: 2 },
        updatedAt: 1_700_000_000_000,
      }),
    ).toBe(true);
    expect(isRoutingPolicy({ version: 1 } as unknown as RoutingPolicy)).toBe(false);
    expect(isRoutingPolicy(null)).toBe(false);
  });
});
