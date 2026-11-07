/**
 * Routing policy — cau hinh xac dinh tap candidate eligible, strategy chon
 * candidate, va fallback config. Moi thay doi tao version moi (monotonic).
 *
 * Version tang strictly; khong cho phep downgrade/skip version de bypass audit
 * (`docs/domains/llm-consumer-routing/domain-model.md` §8).
 */

import { isPositiveInteger, type DomainOk, type DomainRejection } from './shared';
import type { RoutingStrategy } from './strategy';
import { isRoutingStrategy } from './strategy';
import type { FallbackConfig } from './snapshot';

export type RoutingPolicy = {
  readonly policyId: string;
  readonly version: number; // monotonic
  readonly candidates: readonly string[]; // candidate IDs
  readonly strategy: RoutingStrategy;
  readonly fallbackConfig: FallbackConfig;
  readonly updatedAt: number; // epoch millis
};

export function isRoutingPolicy(value: unknown): value is RoutingPolicy {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RoutingPolicy).policyId === 'string' &&
    (value as RoutingPolicy).policyId.trim().length > 0 &&
    isPositiveInteger((value as RoutingPolicy).version) &&
    Array.isArray((value as RoutingPolicy).candidates) &&
    (value as RoutingPolicy).candidates.every(
      (c: unknown) => typeof c === 'string' && c.trim().length > 0,
    ) &&
    isRoutingStrategy((value as RoutingPolicy).strategy) &&
    typeof (value as RoutingPolicy).fallbackConfig === 'object' &&
    (value as RoutingPolicy).fallbackConfig !== null &&
    typeof (value as RoutingPolicy).fallbackConfig.endpointFallback === 'boolean' &&
    typeof (value as RoutingPolicy).fallbackConfig.offerFallback === 'boolean' &&
    Number.isSafeInteger((value as RoutingPolicy).fallbackConfig.maxAttempts) &&
    (value as RoutingPolicy).fallbackConfig.maxAttempts > 0 &&
    typeof (value as RoutingPolicy).updatedAt === 'number' &&
    Number.isSafeInteger((value as RoutingPolicy).updatedAt)
  );
}

export type CreatePolicyResult =
  | DomainOk<{ readonly policy: RoutingPolicy; readonly nextVersion: number }>
  | DomainRejection<
      | 'invalid_policy_id'
      | 'invalid_policy_version'
      | 'invalid_candidates'
      | 'invalid_strategy'
      | 'invalid_fallback_config'
      | 'invalid_updated_at'
    >;

export function createPolicy(inputs: {
  readonly policyId: string;
  readonly candidates: readonly string[];
  readonly strategy: RoutingStrategy;
  readonly fallbackConfig: FallbackConfig;
  readonly currentVersion: number;
  readonly updatedAt: number;
}): CreatePolicyResult {
  if (typeof inputs.policyId !== 'string' || inputs.policyId.trim().length === 0) {
    return {
      ok: false,
      reason: 'invalid_policy_id',
      detail: 'Policy id invalid — must be a non-empty string.',
    };
  }
  if (!Number.isSafeInteger(inputs.currentVersion) || inputs.currentVersion < 1) {
    return {
      ok: false,
      reason: 'invalid_policy_version',
      detail: 'Policy version invalid — must be a positive integer.',
    };
  }
  if (!Array.isArray(inputs.candidates) || inputs.candidates.length === 0) {
    return {
      ok: false,
      reason: 'invalid_candidates',
      detail: 'Policy must have at least one candidate.',
    };
  }
  if (!inputs.strategy || !isRoutingStrategy(inputs.strategy)) {
    return {
      ok: false,
      reason: 'invalid_strategy',
      detail: 'Routing strategy not supported.',
    };
  }
  if (
    !inputs.fallbackConfig ||
    typeof inputs.fallbackConfig.endpointFallback !== 'boolean' ||
    typeof inputs.fallbackConfig.offerFallback !== 'boolean' ||
    !Number.isSafeInteger(inputs.fallbackConfig.maxAttempts) ||
    inputs.fallbackConfig.maxAttempts <= 0
  ) {
    return {
      ok: false,
      reason: 'invalid_fallback_config',
      detail: 'Fallback config invalid.',
    };
  }
  if (!Number.isSafeInteger(inputs.updatedAt)) {
    return {
      ok: false,
      reason: 'invalid_updated_at',
      detail: 'updatedAt invalid.',
    };
  }

  const nextVersion = inputs.currentVersion + 1;
  const policy: RoutingPolicy = {
    policyId: inputs.policyId,
    version: nextVersion,
    candidates: [...inputs.candidates],
    strategy: inputs.strategy,
    fallbackConfig: { ...inputs.fallbackConfig },
    updatedAt: inputs.updatedAt,
  };

  return { ok: true, policy, nextVersion };
}
