import { describe, expect, it } from 'vitest';

import {
  AUDIT_LIST_DEFAULT_LIMIT,
  AUDIT_LIST_MAX_LIMIT,
  AUDIT_OUTCOMES,
  auditListResponse,
  FORBIDDEN_AUDIT_CONTEXT_KEYS,
  FORBIDDEN_AUDIT_FIELDS,
  isAuditOutcome,
  validateAuditEntry,
  validateAuditListResponse,
  validateAuditQueryRequest,
  type AuditContractRejectionReason,
  type AuditEntry,
  type AuditListValidation,
} from './management-audit-contract';

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: '0f0e0d0c-0b0a-4928-8276-001122334455',
    actor_staff_id: 'staff-0042',
    actor_sub: `sub_${'a'.repeat(32)}`,
    target: 'staff-0001',
    action: 'role.assign',
    occurred_at: '2026-01-01T00:00:00Z',
    outcome: 'success',
    reason: null,
    correlation_id: 'corr-123',
    ...overrides,
  };
}

/** Assert payload bị từ chối với `reason` và `detail` chứa `fragment`. */
function expectRejectedBy(
  result:
    | { ok: true; payload: unknown }
    | { ok: false; reason: AuditContractRejectionReason; detail: string },
  reason: AuditContractRejectionReason,
  fragment: string,
): void {
  expect(result).toMatchObject({ ok: false, reason });
  if (result.ok) {
    throw new Error('Expected the payload to be rejected, but it was accepted.');
  }
  expect(result.detail).toContain(fragment);
}

function unwrap(result: AuditListValidation): {
  readonly entries: readonly AuditEntry[];
  readonly next_cursor: string | null;
} {
  if (!result.ok) {
    throw new Error(`Expected a valid audit page, got ${result.reason}: ${result.detail}`);
  }
  return result.payload;
}

describe('validateAuditQueryRequest — accept', () => {
  it('accepts an absent query as match-all', () => {
    expect(validateAuditQueryRequest(undefined)).toEqual({ ok: true, payload: {} });
    expect(validateAuditQueryRequest(null)).toEqual({ ok: true, payload: {} });
  });

  it('accepts every documented filter key', () => {
    const query = {
      actor_staff_id: 'staff-0042',
      actor_sub: `sub_${'a'.repeat(32)}`,
      target: 'staff-0001',
      action: 'role.assign',
      occurred_from: '2026-01-01T00:00:00Z',
      occurred_to: '2026-02-01T00:00:00Z',
      correlation_id: 'corr-123',
      limit: AUDIT_LIST_DEFAULT_LIMIT,
      cursor: null,
    };
    expect(validateAuditQueryRequest(query)).toEqual({ ok: true, payload: query });
  });

  it('accepts an empty query', () => {
    expect(validateAuditQueryRequest({})).toEqual({ ok: true, payload: {} });
  });
});

describe('validateAuditQueryRequest — forbidden filters', () => {
  it('rejects a free-text content search — the oracle risk', () => {
    const result = validateAuditQueryRequest({ q: 'anything' });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', 'q');
  });

  it('rejects querying by context payload', () => {
    const result = validateAuditQueryRequest({ context: { role: 'sys_ops' } });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', 'context');
  });

  it('rejects outcome filtering by an unknown value at query level is not possible — unknown keys are forbidden', () => {
    const result = validateAuditQueryRequest({ verdict: 'denied' });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', 'verdict');
  });
});

describe('validateAuditQueryRequest — invalid values', () => {
  it('rejects an inverted time range', () => {
    const query = { occurred_from: '2026-02-01T00:00:00Z', occurred_to: '2026-01-01T00:00:00Z' };
    const result = validateAuditQueryRequest(query);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'invalid_time_range', 'occurred_to');
  });

  it.each(['2026-01-01T00:00:00', 'not-a-time', 1])('rejects occurred_from %p', (from) => {
    expect(validateAuditQueryRequest({ occurred_from: from })).toMatchObject({
      ok: false,
      reason: 'invalid_time_range',
    });
  });

  it.each([0, AUDIT_LIST_MAX_LIMIT + 1, 1.5])('rejects limit %s', (limit) => {
    expect(validateAuditQueryRequest({ limit })).toMatchObject({
      ok: false,
      reason: 'invalid_time_range',
    });
  });

  it('rejects an empty string filter', () => {
    expect(validateAuditQueryRequest({ actor_staff_id: '' })).toMatchObject({
      ok: false,
      reason: 'invalid_entry',
    });
  });
});

describe('validateAuditEntry — accept', () => {
  it('accepts a full entry', () => {
    const entry = makeEntry();
    expect(validateAuditEntry(entry)).toEqual({ ok: true, payload: entry });
  });

  it('accepts a denied outcome — denies must be observable (SR-018)', () => {
    expect(validateAuditEntry(makeEntry({ outcome: 'denied' })).ok).toBe(true);
  });

  it('accepts a system entry without actor fields', () => {
    const entry = makeEntry({ actor_staff_id: null, actor_sub: null });
    expect(validateAuditEntry(entry).ok).toBe(true);
  });

  it('accepts a scrubbed context payload', () => {
    const entry = makeEntry({ context: { role_id: 'sys_ops' } });
    expect(validateAuditEntry(entry).ok).toBe(true);
  });
});

describe('validateAuditEntry — forbidden fields (SR-014)', () => {
  it.each([...FORBIDDEN_AUDIT_FIELDS])('rejects an entry carrying %s', (field) => {
    const entry = { ...makeEntry(), [field]: 'leak' };
    const result = validateAuditEntry(entry);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', field);
  });

  it('rejects a token even when the value is null', () => {
    const entry = { ...makeEntry(), access_token: null };
    expect(validateAuditEntry(entry)).toMatchObject({ ok: false, reason: 'forbidden_field' });
  });

  it('names the offending field without echoing its value', () => {
    const entry = { ...makeEntry(), password: 'hunter2' };
    const result = validateAuditEntry(entry);
    if (result.ok) {
      throw new Error('Expected rejection.');
    }
    expect(result.detail).not.toContain('hunter2');
    expect(result.detail).toContain('password');
  });

  it.each([...FORBIDDEN_AUDIT_CONTEXT_KEYS])('rejects context carrying top-level %s', (key) => {
    const entry = makeEntry({ context: { [key]: 'leak' } });
    const result = validateAuditEntry(entry);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_context_key', key);
  });

  it('rejects a forbidden key nested one level deep in context', () => {
    const entry = makeEntry({ context: { nested: { secret: 'leak' } } });
    const result = validateAuditEntry(entry);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_context_key', 'secret');
  });

  it('rejects an unknown top-level field', () => {
    const entry = { ...makeEntry(), mystery_field: 1 };
    const result = validateAuditEntry(entry);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', 'mystery_field');
  });
});

describe('validateAuditEntry — invalid shapes', () => {
  it.each([
    ['null', null],
    ['a string', 'audit'],
    ['an array', [makeEntry()]],
  ])('rejects %s as an entry', (_label, entry) => {
    expect(validateAuditEntry(entry)).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });

  it.each([['missing target'], ['missing action'], ['missing occurred_at'], ['missing id']])(
    'rejects an entry with %s',
    (label) => {
      const field = label.replace('missing ', '') as keyof AuditEntry;
      // Rest-spread thay cho `delete` (no-dynamic-delete): entry bị cắt field
      // vẫn mang ý nghĩa "thiếu field" mà không cần xóa key động.
      const { [field]: _removed, ...rest } = makeEntry();
      const entry: Record<string, unknown> = { ...rest };
      expect(validateAuditEntry(entry)).toMatchObject({ ok: false, reason: 'invalid_entry' });
    },
  );

  it.each(['allowed', 'allowed_with_exception', '', 1, null])('rejects outcome %p', (outcome) => {
    const entry = makeEntry({ outcome: outcome as AuditEntry['outcome'] });
    expect(validateAuditEntry(entry)).toMatchObject({ ok: false, reason: 'invalid_outcome' });
  });

  it('rejects a non-object context', () => {
    const entry = makeEntry({ context: 'role.assign' as never });
    expect(validateAuditEntry(entry)).toMatchObject({ ok: false, reason: 'invalid_entry' });
  });

  it('rejects an occurred_at without an explicit offset', () => {
    const entry = makeEntry({ occurred_at: '2026-01-01T00:00:00' });
    expect(validateAuditEntry(entry)).toMatchObject({ ok: false, reason: 'invalid_time_range' });
  });
});

describe('validateAuditListResponse — pagination bounds', () => {
  it('accepts a page with entries and a cursor', () => {
    const response = auditListResponse([makeEntry()], 'tok');
    expect(validateAuditListResponse(response)).toEqual({ ok: true, payload: response });
  });

  it('accepts an empty page', () => {
    expect(unwrap(validateAuditListResponse(auditListResponse([], null)))).toEqual({
      entries: [],
      next_cursor: null,
    });
  });

  it('accepts a page at the ceiling', () => {
    const entries = Array.from({ length: AUDIT_LIST_MAX_LIMIT }, (_, i) =>
      makeEntry({ id: `${String(i).padStart(4, '0')}-0f0e-4928-8276-001122334455` }),
    );
    expect(validateAuditListResponse(auditListResponse(entries, null)).ok).toBe(true);
  });

  it('rejects a page larger than the ceiling', () => {
    const entries = Array.from({ length: AUDIT_LIST_MAX_LIMIT + 1 }, (_, i) =>
      makeEntry({ id: `${String(i).padStart(4, '0')}-0f0e-4928-8276-001122334455` }),
    );
    const result = validateAuditListResponse(auditListResponse(entries, null));
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'oversized_page', String(AUDIT_LIST_MAX_LIMIT));
  });

  it('rejects a field outside the contract', () => {
    const result = validateAuditListResponse({ entries: [], next_cursor: null, total_count: 7 });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'invalid_payload', 'total_count');
  });

  it('rejects a page whose entry fails', () => {
    const entries = [makeEntry(), makeEntry({ outcome: 'maybe' as never })];
    expect(validateAuditListResponse(auditListResponse(entries, null))).toMatchObject({
      ok: false,
      reason: 'invalid_outcome',
    });
  });
});

describe('query-only contract', () => {
  it('exposes no append write shape', () => {
    // SR-015/invariant 12: audit append-only. Contract này CHỈ query — một
    // request append qua wire là đường ghi đè/che dấu vết (T-12).
    const spec = import.meta.glob('./management-audit-contract.ts', {
      eager: true,
      import: 'default',
    });
    const mod = spec['./management-audit-contract.ts'] as Record<string, unknown>;
    const writeNames = Object.keys(mod ?? {}).filter((name) =>
      /^(append|create|write|insert|validateAuditAppend)/iu.test(name),
    );
    expect(writeNames).toEqual([]);
  });
});

describe('isAuditOutcome', () => {
  it.each([...AUDIT_OUTCOMES])('accepts %s', (outcome) => {
    expect(isAuditOutcome(outcome)).toBe(true);
  });

  it.each(['ALLOW', '', null, 1])('rejects %p', (outcome) => {
    expect(isAuditOutcome(outcome)).toBe(false);
  });
});
