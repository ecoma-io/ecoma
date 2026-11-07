import { describe, expect, it } from 'vitest';

import {
  ENTITLEMENT_MAX_REVISION,
  ENTITLEMENT_PRODUCTS,
  ENTITLEMENT_READ_MAX_PAGE,
  ENTITLEMENT_STATUSES,
  entitlementReadResponse,
  FORBIDDEN_ENTITLEMENT_FIELDS,
  isEntitlementProduct,
  isEntitlementStatus,
  pickRevisionWinner,
  validateEntitlementEntry,
  validateEntitlementReadResponse,
  type EntitlementReadRejectionReason,
  type StaffEntitlementEntry,
} from './entitlement-read-contract';

function makeEntry(overrides: Partial<StaffEntitlementEntry> = {}): StaffEntitlementEntry {
  return {
    staff_id: 'staff-0001',
    product: 'backoffice',
    status: 'entitled',
    revision: 1,
    occurred_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Assert payload bị từ chối với `reason` và `detail` chứa `fragment`. */
function expectRejectedBy(
  result:
    | { ok: true; payload: unknown }
    | { ok: false; reason: EntitlementReadRejectionReason; detail: string },
  reason: EntitlementReadRejectionReason,
  fragment: string,
): void {
  expect(result).toMatchObject({ ok: false, reason });
  if (result.ok) {
    throw new Error('Expected the payload to be rejected, but it was accepted.');
  }
  expect(result.detail).toContain(fragment);
}

describe('validateEntitlementEntry — accept', () => {
  it.each([...ENTITLEMENT_PRODUCTS])('accepts product %s', (product) => {
    const entry = makeEntry({ product });
    expect(validateEntitlementEntry(entry)).toEqual({ ok: true, payload: entry });
  });

  it.each([...ENTITLEMENT_STATUSES])('accepts status %s', (status) => {
    expect(validateEntitlementEntry(makeEntry({ status })).ok).toBe(true);
  });

  it('accepts a revoked entry — revocation is recorded, not deleted', () => {
    const entry = makeEntry({ status: 'revoked', revision: 3 });
    expect(validateEntitlementEntry(entry)).toEqual({ ok: true, payload: entry });
  });
});

describe('validateEntitlementEntry — the entitlement vs authorization boundary (ADR-0009)', () => {
  it.each([...FORBIDDEN_ENTITLEMENT_FIELDS])('rejects an entry carrying %s', (field) => {
    // Đây là test biên P1.3: entry read model mang verdict/permission/role là
    // biến read model thành authorization-result contract mà ADR-0009 cấm.
    const entry = { ...makeEntry(), [field]: 'leak' };
    const result = validateEntitlementEntry(entry);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', field);
  });

  it('rejects a verdict field even when its value is null', () => {
    const entry = { ...makeEntry(), decision: null };
    expect(validateEntitlementEntry(entry)).toMatchObject({ ok: false, reason: 'forbidden_field' });
  });

  it('names the offending field without echoing its value', () => {
    const entry = { ...makeEntry(), permissions: ['staff.read', 'role.read'] };
    const result = validateEntitlementEntry(entry);
    if (result.ok) {
      throw new Error('Expected rejection.');
    }
    expect(result.detail).not.toContain('staff.read');
    expect(result.detail).toContain('permissions');
  });

  it('rejects an unknown extra field', () => {
    const entry = { ...makeEntry(), mystery_field: true };
    const result = validateEntitlementEntry(entry);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', 'mystery_field');
  });
});

describe('validateEntitlementEntry — invalid shapes', () => {
  it.each([
    ['null', null],
    ['a string', 'entitlement'],
    ['an array', [makeEntry()]],
  ])('rejects %s as an entry', (_label, entry) => {
    expect(validateEntitlementEntry(entry)).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });

  it.each([
    ['missing staff_id'],
    ['missing product'],
    ['missing revision'],
    ['missing occurred_at'],
  ])('rejects an entry with %s', (label) => {
    const field = label.replace('missing ', '') as keyof StaffEntitlementEntry;
    // Rest-spread thay cho `delete` (no-dynamic-delete): entry bị cắt field
    // vẫn mang ý nghĩa "thiếu field" mà không cần xóa key động.
    const { [field]: _removed, ...rest } = makeEntry();
    const entry: Record<string, unknown> = { ...rest };
    expect(validateEntitlementEntry(entry)).toMatchObject({ ok: false, reason: 'invalid_entry' });
  });

  it('rejects an unknown product — consumer adds the product to the registry first', () => {
    const entry = makeEntry({ product: 'unknown-product' as StaffEntitlementEntry['product'] });
    expect(validateEntitlementEntry(entry)).toMatchObject({
      ok: false,
      reason: 'invalid_product',
    });
  });

  it.each(['allowed', 'denied', '', 1, null])('rejects status %p', (status) => {
    const entry = makeEntry({ status: status as StaffEntitlementEntry['status'] });
    expect(validateEntitlementEntry(entry)).toMatchObject({
      ok: false,
      reason: 'invalid_status',
    });
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects revision %s', (revision) => {
    const entry = makeEntry({ revision: revision as number });
    expect(validateEntitlementEntry(entry)).toMatchObject({
      ok: false,
      reason: 'invalid_revision',
    });
  });

  it('rejects a revision beyond the safe integer range', () => {
    const entry = makeEntry({ revision: ENTITLEMENT_MAX_REVISION + 1 });
    expect(validateEntitlementEntry(entry)).toMatchObject({
      ok: false,
      reason: 'invalid_revision',
    });
  });

  it('rejects an empty staff_id', () => {
    const entry = makeEntry({ staff_id: '' });
    expect(validateEntitlementEntry(entry)).toMatchObject({ ok: false, reason: 'invalid_entry' });
  });
});

describe('validateEntitlementReadResponse — pagination bounds', () => {
  it('accepts a page with entries and a cursor', () => {
    const response = entitlementReadResponse([makeEntry()], 'tok');
    expect(validateEntitlementReadResponse(response)).toEqual({ ok: true, payload: response });
  });

  it('accepts an empty page', () => {
    const response = entitlementReadResponse([], null);
    expect(validateEntitlementReadResponse(response)).toEqual({ ok: true, payload: response });
  });

  it('accepts a page at the ceiling', () => {
    const entitlements = Array.from({ length: ENTITLEMENT_READ_MAX_PAGE }, (_, i) =>
      makeEntry({ staff_id: `staff-${i}` }),
    );
    expect(validateEntitlementReadResponse(entitlementReadResponse(entitlements, null)).ok).toBe(
      true,
    );
  });

  it('rejects a page larger than the ceiling', () => {
    const entitlements = Array.from({ length: ENTITLEMENT_READ_MAX_PAGE + 1 }, (_, i) =>
      makeEntry({ staff_id: `staff-${i}` }),
    );
    const result = validateEntitlementReadResponse(entitlementReadResponse(entitlements, null));
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'oversized_page', String(ENTITLEMENT_READ_MAX_PAGE));
  });

  it('rejects a field outside the contract', () => {
    const result = validateEntitlementReadResponse({
      entitlements: [],
      next_cursor: null,
      total_count: 5,
    });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'invalid_payload', 'total_count');
  });

  it('rejects a page whose entry carries a forbidden field', () => {
    const entitlements = [makeEntry(), { ...makeEntry(), verdict: 'allow' }];
    expect(
      validateEntitlementReadResponse(
        entitlementReadResponse(entitlements as StaffEntitlementEntry[], null),
      ),
    ).toMatchObject({ ok: false, reason: 'forbidden_field' });
  });
});

describe('pickRevisionWinner — idempotent consumption (compare-and-drop)', () => {
  it('applies the incoming event when its revision is higher', () => {
    expect(pickRevisionWinner({ revision: 2 }, { revision: 3 })).toBe('incoming');
  });

  it('drops an out-of-order older event', () => {
    expect(pickRevisionWinner({ revision: 3 }, { revision: 2 })).toBe('current');
  });

  it('drops a duplicate event with the same revision', () => {
    expect(pickRevisionWinner({ revision: 3 }, { revision: 3 })).toBe('current');
  });

  it('is monotonic across a replay chain', () => {
    // Chuỗi delivery qua lại là bình thường của kênh bất đồng bộ; consumer
    // replay theo thứ tự bất kỳ vẫn hội tụ về revision lớn nhất.
    const revisions = [5, 1, 4, 2, 6, 3, 6];
    let seen = { revision: 0 };
    for (const revision of revisions) {
      const winner = pickRevisionWinner(seen, { revision });
      if (winner === 'incoming') {
        seen = { revision };
      }
    }
    expect(seen.revision).toBe(6);
  });
});

describe('isEntitlementProduct / isEntitlementStatus', () => {
  it.each([...ENTITLEMENT_PRODUCTS])('accepts product %s', (product) => {
    expect(isEntitlementProduct(product)).toBe(true);
  });

  it.each(['Backoffice', 'slack', '', null, 1])('rejects product %p', (product) => {
    expect(isEntitlementProduct(product)).toBe(false);
  });

  it.each([...ENTITLEMENT_STATUSES])('accepts status %s', (status) => {
    expect(isEntitlementStatus(status)).toBe(true);
  });

  it.each(['ENTITLED', null, 1])('rejects status %p', (status) => {
    expect(isEntitlementStatus(status)).toBe(false);
  });
});
