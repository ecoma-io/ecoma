/**
 * Routing snapshot — ban chua bat bien cua routing policy + candidate set tai
 * thoi diem bind voi logical request. Logical request dung snapshot nay cho
 * moi attempt. Config/pricing thay doi sau admission KHONG tac dong snapshot da bind.
 */

import type { RoutingStrategy } from './strategy';
import type { Candidate } from './candidate';
import { isNonEmptyString, type DomainOk, type DomainRejection } from './shared';
import { isRoutingStrategy } from './strategy';

export type RoutingPolicyVersion = number & { readonly __brand: unique symbol };

export function isRoutingPolicyVersion(value: unknown): value is RoutingPolicyVersion {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export type FallbackConfig = {
  readonly endpointFallback: boolean;
  readonly offerFallback: boolean;
  readonly maxAttempts: number;
};

export type RoutingSnapshot = {
  readonly alias: string;
  readonly resolvedModel: string;
  readonly policyVersion: RoutingPolicyVersion;
  readonly eligibleCandidates: readonly Candidate[];
  readonly strategy: RoutingStrategy;
  readonly fallbackConfig: FallbackConfig;
  readonly boundAt: number; // epoch millis
};

export function isRoutingSnapshot(value: unknown): value is RoutingSnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RoutingSnapshot).alias === 'string' &&
    (value as RoutingSnapshot).alias.trim().length > 0 &&
    typeof (value as RoutingSnapshot).resolvedModel === 'string' &&
    (value as RoutingSnapshot).resolvedModel.trim().length > 0 &&
    isRoutingPolicyVersion((value as RoutingSnapshot).policyVersion) &&
    Array.isArray((value as RoutingSnapshot).eligibleCandidates) &&
    (value as RoutingSnapshot).eligibleCandidates.every((c: unknown) => {
      // tránh import circular: kiểm tra shapes cơ bản
      return (
        typeof c === 'object' && c !== null && typeof (c as Candidate).candidateId === 'string'
      );
    }) &&
    isRoutingStrategy((value as RoutingSnapshot).strategy) &&
    typeof (value as RoutingSnapshot).fallbackConfig === 'object' &&
    (value as RoutingSnapshot).fallbackConfig !== null &&
    typeof (value as RoutingSnapshot).fallbackConfig.endpointFallback === 'boolean' &&
    typeof (value as RoutingSnapshot).fallbackConfig.offerFallback === 'boolean' &&
    typeof (value as RoutingSnapshot).fallbackConfig.maxAttempts === 'number' &&
    Number.isSafeInteger((value as RoutingSnapshot).fallbackConfig.maxAttempts) &&
    (value as RoutingSnapshot).fallbackConfig.maxAttempts > 0 &&
    typeof (value as RoutingSnapshot).boundAt === 'number' &&
    Number.isSafeInteger((value as RoutingSnapshot).boundAt)
  );
}

export function buildSnapshot(inputs: {
  readonly alias: string;
  readonly resolvedModel: string;
  readonly policyVersion: RoutingPolicyVersion;
  readonly eligibleCandidates: readonly Candidate[];
  readonly strategy: RoutingStrategy;
  readonly fallbackConfig: FallbackConfig;
  readonly boundAt: number;
}): DomainOk<RoutingSnapshot> | DomainRejection<'invalid_snapshot_input'> {
  if (!isNonEmptyString(inputs.alias)) {
    return {
      ok: false,
      reason: 'invalid_snapshot_input',
      detail: 'Invalid alias — must be a non-empty string.',
    };
  }
  if (!isNonEmptyString(inputs.resolvedModel)) {
    return {
      ok: false,
      reason: 'invalid_snapshot_input',
      detail: 'Invalid resolved model — must be a non-empty string.',
    };
  }
  if (!isRoutingPolicyVersion(inputs.policyVersion)) {
    return {
      ok: false,
      reason: 'invalid_snapshot_input',
      detail: 'Invalid policy version — must be a positive safe integer.',
    };
  }
  if (!Array.isArray(inputs.eligibleCandidates) || inputs.eligibleCandidates.length === 0) {
    return {
      ok: false,
      reason: 'invalid_snapshot_input',
      detail: 'Eligible candidates must be non-empty.',
    };
  }
  for (const c of inputs.eligibleCandidates) {
    if (
      typeof c !== 'object' ||
      c === null ||
      typeof (c as Candidate).candidateId !== 'string' ||
      (c as Candidate).candidateId.trim().length === 0 ||
      typeof (c as Candidate).status !== 'string'
    ) {
      return {
        ok: false,
        reason: 'invalid_snapshot_input',
        detail: 'Invalid candidate in eligible candidates.',
      };
    }
  }
  if (!inputs.strategy || !isRoutingStrategy(inputs.strategy)) {
    return {
      ok: false,
      reason: 'invalid_snapshot_input',
      detail: 'Invalid strategy.',
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
      reason: 'invalid_snapshot_input',
      detail: 'Invalid fallback config.',
    };
  }
  if (!Number.isSafeInteger(inputs.boundAt)) {
    return {
      ok: false,
      reason: 'invalid_snapshot_input',
      detail: 'Invalid boundAt — must be a safe integer.',
    };
  }

  return {
    ok: true,
    alias: inputs.alias,
    resolvedModel: inputs.resolvedModel,
    policyVersion: inputs.policyVersion,
    eligibleCandidates: [...inputs.eligibleCandidates],
    strategy: inputs.strategy,
    fallbackConfig: { ...inputs.fallbackConfig },
    boundAt: inputs.boundAt,
  };
}

/** Frozen view cua snapshot — dam bao immutability khi tra ve consumer. */
export function freezeSnapshot(snapshot: RoutingSnapshot): Readonly<RoutingSnapshot> {
  return deepFreeze(snapshot);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null) {
    return value as Readonly<T>;
  }
  Object.freeze(value);
  for (const prop of Object.getOwnPropertyNames(value)) {
    const child = (value as Record<string, unknown>)[prop];
    if (typeof child === 'object' && child !== null && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value as Readonly<T>;
}
