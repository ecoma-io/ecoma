import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_STAFF_PROFILE_FIELDS,
  isStaffStatus,
  isStaffSubFormat,
  STAFF_DISPLAY_NAME_MAX_LENGTH,
  STAFF_LIST_DEFAULT_LIMIT,
  STAFF_LIST_MAX_LIMIT,
  STAFF_STATUSES,
  staffListResponse,
  validateStaffListRequest,
  validateStaffListResponse,
  validateStaffMember,
  type StaffContractRejectionReason,
  type StaffMember,
} from './management-staff-contract';

/**
 * `sub_` + 32 ký tự base32 viết thường — cùng hình thật của Account ID.
 *
 * Seed phải nằm trọn trong alphabet base32 (`a-z2-7`): chữ số `0`/`1` nằm
 * ngoài alphabet, nên một seed giữ nguyên sẽ sinh `sub` mà chính validator
 * phải từ chối. Helper **ném lỗi thay vì tự sửa** — tự lọc seed sẽ lặng lẽ
 * biến một test case âm tính (vd. seed viết hoa) thành case hợp lệ.
 */
function makeSub(seed: string): string {
  if (!/^[a-z2-7]{32}$/u.test(seed)) {
    throw new Error(`makeSub seed must be exactly 32 base32 (a-z2-7) chars, got: ${seed}`);
  }
  return `sub_${seed}`;
}

function makeStaff(overrides: Partial<StaffMember> = {}): StaffMember {
  return {
    id: 'staff-0001',
    sub: makeSub('ab'.padEnd(32, 'a')),
    status: 'active',
    display_name: 'Nguyen Van A',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

/** Assert payload bị từ chối với `reason` và `detail` chứa `fragment`. */
function expectRejectedBy<T>(
  result: { ok: boolean; reason?: string; detail?: string } & (
    | { ok: true; payload: T }
    | { ok: false; reason: StaffContractRejectionReason; detail: string }
  ),
  reason: StaffContractRejectionReason,
  fragment: string,
): void {
  expect(result).toMatchObject({ ok: false, reason });
  if (result.ok) {
    throw new Error('Expected the payload to be rejected, but it was accepted.');
  }
  expect(result.detail).toContain(fragment);
}

describe('validateStaffMember — accept', () => {
  it.each([...STAFF_STATUSES])('accepts status %s', (status) => {
    const entry = makeStaff({ status });
    expect(validateStaffMember(entry)).toEqual({ ok: true, payload: entry });
  });

  it('accepts a sub at the exact Account ID shape', () => {
    expect(validateStaffMember(makeStaff()).ok).toBe(true);
  });

  it('accepts display_name at the ceiling length', () => {
    const entry = makeStaff({ display_name: 'x'.repeat(STAFF_DISPLAY_NAME_MAX_LENGTH) });
    expect(validateStaffMember(entry).ok).toBe(true);
  });
});

describe('validateStaffMember — forbidden identity fields', () => {
  it.each([...FORBIDDEN_STAFF_PROFILE_FIELDS])('rejects an entry carrying %s', (field) => {
    const entry = { ...makeStaff(), [field]: 'leak' };
    const result = validateStaffMember(entry);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', field);
  });

  it('rejects an identity field even when its value is null', () => {
    const entry = { ...makeStaff(), email: null };
    expect(validateStaffMember(entry)).toMatchObject({ ok: false, reason: 'forbidden_field' });
  });

  it('rejects an unknown extra field, not just a known forbidden one', () => {
    const entry = { ...makeStaff(), mystery_field: 1 };
    const result = validateStaffMember(entry);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', 'mystery_field');
  });

  it('names the offending field without echoing its value', () => {
    const entry = { ...makeStaff(), email: 'victim@example.com' };
    const result = validateStaffMember(entry);
    expect(result).toMatchObject({ ok: false, reason: 'forbidden_field' });
    if (result.ok) {
      throw new Error('Expected rejection.');
    }
    expect(result.detail).not.toContain('victim@example.com');
    expect(result.detail).toContain('email');
  });
});

describe('validateStaffMember — invalid shapes', () => {
  it.each([
    ['null', null],
    ['a string', 'staff'],
    ['a number', 1],
    ['an array', [makeStaff()]],
  ])('rejects %s as an entry', (_label, entry) => {
    expect(validateStaffMember(entry)).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });

  it.each([
    ['missing id', (s: StaffMember) => ({ ...s, id: undefined })],
    ['missing sub', (s: StaffMember) => ({ ...s, sub: undefined })],
    ['missing status', (s: StaffMember) => ({ ...s, status: undefined })],
  ])('rejects %s', (_label, mutate) => {
    const entry = mutate(makeStaff());
    expect(validateStaffMember(entry)).toMatchObject({ ok: false, reason: 'invalid_entry' });
  });

  it.each([
    ['uppercase status', 'ACTIVE'],
    ['unknown status', 'pending'],
    ['empty status', ''],
    ['numeric status', 1],
  ])('rejects %s', (_label, status) => {
    const entry = makeStaff({ status: status as StaffMember['status'] });
    expect(validateStaffMember(entry)).toMatchObject({ ok: false, reason: 'invalid_status' });
  });

  it.each([
    ['a 52-char sub', `sub_${'a'.repeat(52)}`],
    ['an uppercase sub', `sub_${'A'.repeat(32)}`],
    ['a missing prefix', 'a'.repeat(32)],
    ['an email as sub', 'person@example.com'],
    ['a numeric sub', 1],
  ])('rejects %s as sub', (_label, sub) => {
    const entry = makeStaff({ sub: sub as string });
    expect(validateStaffMember(entry)).toMatchObject({ ok: false, reason: 'invalid_sub' });
  });

  it('rejects an empty display_name', () => {
    const entry = makeStaff({ display_name: '' });
    expect(validateStaffMember(entry)).toMatchObject({ ok: false, reason: 'invalid_entry' });
  });

  it('rejects a display_name longer than the ceiling', () => {
    const entry = makeStaff({ display_name: 'x'.repeat(STAFF_DISPLAY_NAME_MAX_LENGTH + 1) });
    expect(validateStaffMember(entry)).toMatchObject({ ok: false, reason: 'invalid_entry' });
  });
});

describe('validateStaffListResponse — accept', () => {
  it('accepts a page with entries and a cursor', () => {
    const response = staffListResponse([makeStaff()], 'next-token');
    expect(validateStaffListResponse(response)).toEqual({ ok: true, payload: response });
  });

  it('accepts an empty page with a null cursor', () => {
    const response = staffListResponse([], null);
    expect(validateStaffListResponse(response)).toEqual({ ok: true, payload: response });
  });

  it('accepts a page at the ceiling', () => {
    const staff = Array.from({ length: STAFF_LIST_MAX_LIMIT }, (_, i) =>
      makeStaff({ id: `staff-${i}` }),
    );
    expect(validateStaffListResponse(staffListResponse(staff, null)).ok).toBe(true);
  });
});

describe('validateStaffListResponse — pagination bounds', () => {
  it('rejects a page larger than the ceiling', () => {
    const staff = Array.from({ length: STAFF_LIST_MAX_LIMIT + 1 }, (_, i) =>
      makeStaff({ id: `staff-${i}` }),
    );
    const result = validateStaffListResponse(staffListResponse(staff, null));
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'oversized_page', String(STAFF_LIST_MAX_LIMIT));
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'staff'],
    ['a number', 1],
  ])('rejects %s as the response', (_label, payload) => {
    expect(validateStaffListResponse(payload)).toMatchObject({
      ok: false,
      reason: 'invalid_payload',
    });
  });

  it('rejects a field outside the contract', () => {
    const result = validateStaffListResponse({ staff: [], next_cursor: null, total_count: 3 });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'invalid_payload', 'total_count');
  });

  it.each([
    ['an empty string', ''],
    ['a number', 1],
    ['an object', {}],
  ])('rejects %s as next_cursor', (_label, cursor) => {
    const payload = { staff: [], next_cursor: cursor };
    expect(validateStaffListResponse(payload)).toMatchObject({
      ok: false,
      reason: 'invalid_pagination',
    });
  });

  it('rejects a page whose entry is invalid, reporting the entry failure', () => {
    const staff: unknown[] = [makeStaff(), { ...makeStaff(), email: 'leak@example.com' }];
    expect(
      validateStaffListResponse(staffListResponse(staff as StaffMember[], null)),
    ).toMatchObject({ ok: false, reason: 'forbidden_field' });
  });
});

describe('validateStaffListRequest — pagination bounds', () => {
  it('defaults the limit and nulls an empty cursor', () => {
    expect(validateStaffListRequest({})).toEqual({
      ok: true,
      payload: { limit: STAFF_LIST_DEFAULT_LIMIT, cursor: null },
    });
    expect(validateStaffListRequest({ cursor: '' })).toEqual({
      ok: true,
      payload: { limit: STAFF_LIST_DEFAULT_LIMIT, cursor: null },
    });
  });

  it('accepts a limit at the ceiling and a non-empty cursor', () => {
    expect(validateStaffListRequest({ limit: STAFF_LIST_MAX_LIMIT, cursor: 'tok' })).toEqual({
      ok: true,
      payload: { limit: STAFF_LIST_MAX_LIMIT, cursor: 'tok' },
    });
  });

  it.each([0, -1, 1.5, STAFF_LIST_MAX_LIMIT + 1, Number.NaN])('rejects limit %s', (limit) => {
    expect(validateStaffListRequest({ limit })).toMatchObject({
      ok: false,
      reason: 'invalid_pagination',
    });
  });

  it.each([123, {}])('rejects cursor %p', (cursor) => {
    expect(validateStaffListRequest({ cursor })).toMatchObject({
      ok: false,
      reason: 'invalid_pagination',
    });
  });
});

describe('isStaffStatus', () => {
  it.each([...STAFF_STATUSES])('accepts %s', (status) => {
    expect(isStaffStatus(status)).toBe(true);
  });

  it.each(['ACTIVE', 'pending', '', null, undefined, 1, {}])('rejects %p', (status) => {
    expect(isStaffStatus(status)).toBe(false);
  });
});

describe('isStaffSubFormat', () => {
  it('accepts a sub matching the producer shape (sub_ + 32 base32)', () => {
    expect(isStaffSubFormat(makeSub('zz'.padEnd(32, 'a')))).toBe(true);
  });

  it.each([
    ['wrong entropy length', `sub_${'a'.repeat(31)}`],
    ['wrong alphabet', `sub_${'8'.repeat(32)}`],
    ['no prefix', `${'a'.repeat(32)}`],
  ])('rejects %s', (_label, sub) => {
    expect(isStaffSubFormat(sub)).toBe(false);
  });

  it.each([null, 1, ['sub_a']])('rejects %p', (sub) => {
    expect(isStaffSubFormat(sub)).toBe(false);
  });
});
