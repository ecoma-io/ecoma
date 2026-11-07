import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_PROFILES_DISPLAY_NAME_MAX_LENGTH,
  ACCOUNT_PROFILES_MAX_SUBS,
  accountProfilesResponse,
  dedupeProfileSubs,
  isAccountProfileEntry,
  validateAccountProfilesResponse,
  type AccountProfilesRejectionReason,
  type AccountProfilesResponse,
  type AccountProfilesValidation,
} from './account-profiles-contract';

/** `sub_` + 32 ký tự base32 viết thường — cùng hình dạng thật của `Subject`. */
function makeSub(seed: string): string {
  return `sub_${seed.padEnd(32, 'a').slice(0, 32)}`;
}

/**
 * Assert response bị từ chối với `reason` và `detail` chứa `fragment`.
 *
 * Gộp vào một hàm để không bọc `expect` trong nhánh `if (!result.ok)`
 * (`no-conditional-expect`); nhánh hợp lệ vẫn fail ngay với giá trị thật.
 */
function expectRejectedBy(
  result: AccountProfilesValidation,
  reason: AccountProfilesRejectionReason,
  fragment: string,
): void {
  expect(result).toMatchObject({ ok: false, reason });
  if (result.ok) {
    throw new Error('Expected the response to be rejected, but it was accepted.');
  }
  expect(result.detail).toContain(fragment);
}

/**
 * Bóc response khi hợp lệ, ném lỗi khi bị từ chối.
 *
 * Giữ `expect` ngoài nhánh điều kiện (`no-conditional-expect`) và bảo đảm nhánh
 * từ chối fail với thông báo rõ ràng thay vì bỏ qua assertion.
 */
function unwrap(result: AccountProfilesValidation): AccountProfilesResponse {
  if (!result.ok) {
    throw new Error(`Expected a valid profiles response, got ${result.reason}: ${result.detail}`);
  }
  return result.payload;
}

describe('validateAccountProfilesResponse — accept', () => {
  it('accepts a batch of entries with display names', () => {
    const payload = {
      profiles: [
        { sub: makeSub('01'), displayName: 'Nguyễn Văn A' },
        { sub: makeSub('02'), displayName: 'Trần B' },
      ],
    };
    expect(unwrap(validateAccountProfilesResponse(payload))).toEqual(payload);
  });

  it('accepts displayName null as a valid value meaning not set', () => {
    const result = validateAccountProfilesResponse({
      profiles: [{ sub: makeSub('03'), displayName: null }],
    });
    expect(result).toEqual({
      ok: true,
      payload: { profiles: [{ sub: makeSub('03'), displayName: null }] },
    });
  });

  it('accepts an empty batch', () => {
    expect(unwrap(validateAccountProfilesResponse({ profiles: [] }))).toEqual({ profiles: [] });
  });

  it('accepts a batch at the ceiling of 100 entries', () => {
    const profiles = Array.from({ length: ACCOUNT_PROFILES_MAX_SUBS }, (_, i) => ({
      sub: makeSub(String(i).padStart(2, '0')),
      displayName: null,
    }));
    const result = validateAccountProfilesResponse({ profiles });
    expect(result.ok).toBe(true);
  });

  it('accepts a response produced by accountProfilesResponse', () => {
    const response = accountProfilesResponse([
      { sub: makeSub('04'), displayName: 'Name' },
      { sub: makeSub('05'), displayName: null },
    ]);
    expect(validateAccountProfilesResponse(response)).toEqual({ ok: true, payload: response });
  });
});

describe('validateAccountProfilesResponse — forbidden fields', () => {
  it.each(['email', 'avatar_url', 'status', 'created_at'])(
    'rejects an entry carrying %s',
    (field) => {
      const entry = { sub: makeSub('06'), displayName: 'Name', [field]: 'x' };
      const result = validateAccountProfilesResponse({ profiles: [entry] });
      expect(result).toMatchObject({ ok: false, reason: 'invalid_entry' });
      expectRejectedBy(result, 'invalid_entry', field);
    },
  );

  it('rejects a forbidden field even when its value is null', () => {
    const entry = { sub: makeSub('07'), displayName: null, email: null };
    expect(validateAccountProfilesResponse({ profiles: [entry] })).toMatchObject({
      ok: false,
      reason: 'invalid_entry',
    });
  });

  it('reports a forbidden field before the entry shape check', () => {
    const entry = { sub: makeSub('08'), displayName: 42, email: 'x@y.z' };
    expect(validateAccountProfilesResponse({ profiles: [entry] })).toMatchObject({
      ok: false,
      reason: 'invalid_entry',
    });
  });
});

describe('validateAccountProfilesResponse — invalid shapes', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'profiles'],
    ['a number', 1],
    ['an array', [{ sub: 'sub_x' }]],
  ])('rejects %s as the response', (_label, payload) => {
    expect(validateAccountProfilesResponse(payload)).toMatchObject({
      ok: false,
      reason: 'invalid_payload',
    });
  });

  it('rejects a response with a field outside the contract', () => {
    expect(
      validateAccountProfilesResponse({ profiles: [], generated_at: '2026-01-01' }),
    ).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });

  it('rejects a non-array profiles field', () => {
    expect(validateAccountProfilesResponse({ profiles: { sub: 'x' } })).toMatchObject({
      ok: false,
      reason: 'invalid_payload',
    });
  });

  it.each([
    ['a bare string', 'sub_x'],
    ['null', null],
    ['an array', [makeSub('09')]],
    ['an entry missing displayName', { sub: makeSub('10') }],
    ['an entry missing sub', { displayName: 'Name' }],
    ['an entry with a non-string sub', { sub: 1, displayName: 'Name' }],
    ['an entry with a numeric displayName', { sub: makeSub('11'), displayName: 42 }],
    ['an entry with an object displayName', { sub: makeSub('12'), displayName: {} }],
  ])('rejects %s as an entry', (_label, entry) => {
    expect(validateAccountProfilesResponse({ profiles: [entry as unknown] })).toMatchObject({
      ok: false,
      reason: 'invalid_entry',
    });
  });

  it('rejects an empty displayName string', () => {
    const entry = { sub: makeSub('13'), displayName: '' };
    expect(validateAccountProfilesResponse({ profiles: [entry] })).toMatchObject({
      ok: false,
      reason: 'invalid_entry',
    });
  });

  it('rejects a displayName longer than the contract ceiling', () => {
    const entry = {
      sub: makeSub('14'),
      displayName: 'x'.repeat(ACCOUNT_PROFILES_DISPLAY_NAME_MAX_LENGTH + 1),
    };
    expect(validateAccountProfilesResponse({ profiles: [entry] })).toMatchObject({
      ok: false,
      reason: 'invalid_entry',
    });
  });
});

describe('validateAccountProfilesResponse — batch ceiling', () => {
  it('rejects a batch larger than 100 entries', () => {
    const profiles = Array.from({ length: ACCOUNT_PROFILES_MAX_SUBS + 1 }, (_, i) => ({
      sub: makeSub(String(i).padStart(2, '0')),
      displayName: null,
    }));
    expect(validateAccountProfilesResponse({ profiles })).toMatchObject({
      ok: false,
      reason: 'oversized_batch',
    });
    expectRejectedBy(validateAccountProfilesResponse({ profiles }), 'oversized_batch', '100');
  });
});

describe('isAccountProfileEntry', () => {
  it('accepts a well-formed entry with a null displayName', () => {
    expect(isAccountProfileEntry({ sub: makeSub('15'), displayName: null })).toBe(true);
  });

  it('accepts a well-formed entry with a displayName at the ceiling length', () => {
    expect(isAccountProfileEntry({ sub: makeSub('16'), displayName: 'y'.repeat(200) })).toBe(true);
  });

  it('rejects an entry with extra fields', () => {
    expect(isAccountProfileEntry({ sub: makeSub('17'), displayName: 'n', email: 'x' })).toBe(false);
  });
});

describe('dedupeProfileSubs', () => {
  it('removes duplicates while keeping first-occurrence order', () => {
    expect(dedupeProfileSubs([makeSub('01'), makeSub('02'), makeSub('01')])).toEqual([
      makeSub('01'),
      makeSub('02'),
    ]);
  });

  it('returns an empty array for an empty input', () => {
    expect(dedupeProfileSubs([])).toEqual([]);
  });

  it('keeps up to the batch ceiling after dedupe', () => {
    const subs = Array.from({ length: ACCOUNT_PROFILES_MAX_SUBS }, (_, i) => makeSub(String(i)));
    expect(dedupeProfileSubs([...subs, ...subs])).toHaveLength(ACCOUNT_PROFILES_MAX_SUBS);
  });
});
