import { describe, expect, it } from 'vitest';

import {
  buildSnapshot,
  freezeSnapshot,
  isRoutingSnapshot,
  isRoutingPolicyVersion,
  type FallbackConfig,
  type RoutingSnapshot,
} from './snapshot';
import type { Candidate, CandidateId } from './candidate';

function candidateInput(candidateId: string): Candidate {
  return {
    candidateId: candidateId as unknown as CandidateId,
    status: 'active',
    priority: 1,
    capability: { model: 'm', streaming: true },
    endpoints: ['https://e.example.com'],
    offerId: 'offer-1',
  };
}

function snapshotInputs(
  overrides: Partial<{
    alias: string;
    resolvedModel: string;
    policyVersion: number;
    eligibleCandidates: readonly Candidate[];
    strategy: RoutingSnapshot['strategy'];
    fallbackConfig: FallbackConfig;
    boundAt: number;
  }> = {},
): Parameters<typeof buildSnapshot>[0] {
  return {
    alias: 'claude-3-5-sonnet',
    resolvedModel: 'claude-3-5-sonnet-20240620',
    policyVersion: 3,
    eligibleCandidates: [candidateInput('cand-a'), candidateInput('cand-b')],
    strategy: 'priority',
    fallbackConfig: { endpointFallback: true, offerFallback: true, maxAttempts: 3 },
    boundAt: 1_700_000_000_000,
    ...overrides,
  } as unknown as Parameters<typeof buildSnapshot>[0];
}

function okSnapshot(result: ReturnType<typeof buildSnapshot>): RoutingSnapshot {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected ok');
  return result;
}

describe('routing snapshot', () => {
  it('builds an immutable snapshot with decision evidence', () => {
    const result = okSnapshot(buildSnapshot(snapshotInputs()));
    expect(isRoutingSnapshot(result)).toBe(true);
    expect(result.alias).toBe('claude-3-5-sonnet');
    expect(result.policyVersion).toBe(3);
    expect(result.strategy).toBe('priority');
    expect(result.fallbackConfig.maxAttempts).toBe(3);
    expect(result.boundAt).toBe(1_700_000_000_000);
  });

  it('snapshot is frozen (immutable)', () => {
    const snapshot = okSnapshot(buildSnapshot(snapshotInputs()));
    const frozen = freezeSnapshot(snapshot);
    expect(Object.isFrozen(frozen)).toBe(true);
  });

  it('rejects empty alias', () => {
    const result = buildSnapshot(snapshotInputs({ alias: '   ' }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('invalid_snapshot_input');
  });

  it('rejects invalid policy version', () => {
    for (const v of [0, -1, 1.5]) {
      const result = buildSnapshot(snapshotInputs({ policyVersion: v }));
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toBe('invalid_snapshot_input');
    }
  });

  it('rejects empty eligible candidates', () => {
    const result = buildSnapshot(snapshotInputs({ eligibleCandidates: [] }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('invalid_snapshot_input');
  });

  it('rejects invalid fallback config', () => {
    const result = buildSnapshot(
      snapshotInputs({ fallbackConfig: { maxAttempts: 0 } as unknown as FallbackConfig }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('invalid_snapshot_input');
    const result2 = buildSnapshot(
      snapshotInputs({
        fallbackConfig: { maxAttempts: 3 } as FallbackConfig & { endpointFallback: unknown },
      }),
    );
    expect(result2.ok).toBe(false);
    expect(!result2.ok && result2.reason).toBe('invalid_snapshot_input');
  });

  it('isRoutingSnapshot recognizes valid and rejects invalid shapes', () => {
    const result = okSnapshot(buildSnapshot(snapshotInputs()));
    expect(isRoutingSnapshot(result)).toBe(true);
    expect(isRoutingSnapshot(null)).toBe(false);
    expect(isRoutingSnapshot({ alias: '' } as unknown as RoutingSnapshot)).toBe(false);
    expect(
      isRoutingSnapshot({
        alias: 'a',
        resolvedModel: 'm',
        policyVersion: 0,
      } as unknown as RoutingSnapshot),
    ).toBe(false);
  });

  it('isRoutingPolicyVersion validates boundaries', () => {
    expect(isRoutingPolicyVersion(1)).toBe(true);
    expect(isRoutingPolicyVersion(100)).toBe(true);
    expect(isRoutingPolicyVersion(0)).toBe(false);
    expect(isRoutingPolicyVersion(-1)).toBe(false);
    expect(isRoutingPolicyVersion(1.5)).toBe(false);
  });

  it('config change does not mutate existing snapshots', () => {
    const first = okSnapshot(buildSnapshot(snapshotInputs({ policyVersion: 2 })));
    const second = okSnapshot(buildSnapshot(snapshotInputs({ policyVersion: 5 })));
    expect(first.policyVersion).toBe(2);
    expect(second.policyVersion).toBe(5);
    expect(first.alias).toBe(second.alias);
  });
});
