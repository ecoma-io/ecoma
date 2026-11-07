import { describe, expect, it } from 'vitest';

import { ALIAS_STATUS, resolveAlias, retireAlias } from './alias';
import type { AliasRecord } from './alias';
import type { RoutingPolicyVersion } from './snapshot';

describe('alias lifecycle', () => {
  const base: AliasRecord = {
    alias: 'claude-3-5-sonnet' as unknown as AliasRecord['alias'],
    status: ALIAS_STATUS.active,
    policyId: 'pol-1',
    policyVersion: 1 as unknown as RoutingPolicyVersion,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };

  it('resolves an active alias to its policy and version', () => {
    const result = resolveAlias('claude-3-5-sonnet', [base]);
    expect(result.ok).toBe(true);
    expect(result.ok && result.policyId).toBe('pol-1');
    expect(result.ok && result.policyVersion).toBe(1);
  });

  it('rejects empty/whitespace alias', () => {
    for (const alias of ['', '   ', null, undefined, 123]) {
      const result = resolveAlias(alias, [base]);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toBe('invalid_alias');
    }
  });

  it('rejects unknown alias', () => {
    const result = resolveAlias('no-such-alias', [base]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('alias_not_found');
  });

  it('rejects a retired alias for new requests', () => {
    const retired = { ...base, status: ALIAS_STATUS.retired };
    const result = resolveAlias('claude-3-5-sonnet', [retired]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('alias_retired');
  });

  it('retires an active alias', () => {
    const result = retireAlias('claude-3-5-sonnet', [base]);
    expect(result.ok).toBe(true);
    expect(result.ok && result.status).toBe(ALIAS_STATUS.retired);
  });

  it('rejects retiring a non-existent alias', () => {
    const result = retireAlias('missing', [base]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('alias_not_found');
  });

  it('rejects retiring with invalid alias input', () => {
    const result = retireAlias('', [base]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('invalid_alias');
  });
});
