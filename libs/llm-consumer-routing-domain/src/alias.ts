/**
 * Model alias va lifecycle. Alias la dinh danh logic ma client goi; resolve
 * sang mot routing policy + tap candidate. Alias co the tao, cap nhat (doi
 * policy/tap candidate) va retire. Alias da retire khong con eligible cho
 * request moi; request dang in-flight giu snapshot cu.
 */

import type { DomainOk, DomainRejection } from './shared';
import { isNonEmptyString, isPositiveInteger } from './shared';
import type { RoutingPolicyVersion } from './snapshot';

export type ModelAlias = string & { readonly __brand: unique symbol };

export type AliasStatus = 'active' | 'retired';

export const ALIAS_STATUS = {
  active: 'active',
  retired: 'retired',
} as const;

export type AliasRecord = {
  readonly alias: ModelAlias;
  readonly status: AliasStatus;
  readonly policyId: string;
  readonly policyVersion: RoutingPolicyVersion;
  readonly createdAt: number; // epoch millis
  readonly updatedAt: number; // epoch millis
};

export function isModelAlias(value: unknown): value is ModelAlias {
  return isNonEmptyString(value);
}

export function isAliasStatus(value: unknown): value is AliasStatus {
  return (
    typeof value === 'string' && (value === ALIAS_STATUS.active || value === ALIAS_STATUS.retired)
  );
}

export function isAliasRecord(value: unknown): value is AliasRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    isModelAlias((value as AliasRecord).alias) &&
    isAliasStatus((value as AliasRecord).status) &&
    isNonEmptyString((value as AliasRecord).policyId) &&
    isPositiveInteger((value as AliasRecord).policyVersion) &&
    typeof (value as AliasRecord).createdAt === 'number' &&
    Number.isSafeInteger((value as AliasRecord).createdAt) &&
    typeof (value as AliasRecord).updatedAt === 'number' &&
    Number.isSafeInteger((value as AliasRecord).updatedAt)
  );
}

export type ResolveAliasResult =
  | DomainOk<{
      readonly alias: ModelAlias;
      readonly policyId: string;
      readonly policyVersion: RoutingPolicyVersion;
    }>
  | DomainRejection<'alias_not_found' | 'alias_retired' | 'invalid_alias'>;

export function resolveAlias(alias: unknown, aliases: readonly AliasRecord[]): ResolveAliasResult {
  if (!isModelAlias(alias)) {
    return {
      ok: false,
      reason: 'invalid_alias',
      detail: 'Model alias invalid — must be a non-empty string.',
    };
  }

  const record = aliases.find((a) => a.alias === alias);
  if (!record) {
    return {
      ok: false,
      reason: 'alias_not_found',
      detail: `Model alias '${alias}' not found.`,
    };
  }

  if (record.status === ALIAS_STATUS.retired) {
    return {
      ok: false,
      reason: 'alias_retired',
      detail: `Model alias '${alias}' retired — not eligible for new requests.`,
    };
  }

  return {
    ok: true,
    alias: record.alias,
    policyId: record.policyId,
    policyVersion: record.policyVersion,
  };
}

export type RetireAliasResult =
  | DomainOk<{ readonly alias: ModelAlias; readonly status: AliasStatus }>
  | DomainRejection<'alias_not_found' | 'invalid_alias'>;

export function retireAlias(alias: unknown, aliases: readonly AliasRecord[]): RetireAliasResult {
  if (!isModelAlias(alias)) {
    return {
      ok: false,
      reason: 'invalid_alias',
      detail: 'Model alias invalid — must be a non-empty string.',
    };
  }

  const record = aliases.find((a) => a.alias === alias);
  if (!record) {
    return {
      ok: false,
      reason: 'alias_not_found',
      detail: `Model alias '${alias}' not found.`,
    };
  }

  return { ok: true, alias: record.alias, status: ALIAS_STATUS.retired };
}
