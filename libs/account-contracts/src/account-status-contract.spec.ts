import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_STATUS_RESPONSE_VALUES,
  accountStatusResponse,
  FORBIDDEN_ACCOUNT_STATUS_FIELDS,
  isAccountStatusResponseValue,
  validateAccountStatusResponse,
  type AccountStatusRejectionReason,
  type AccountStatusResponse,
  type AccountStatusValidation,
} from './account-status-contract';

/**
 * Assert response bị từ chối với `reason` và `detail` chứa `field`.
 *
 * Gộp vào một hàm để không bọc `expect` trong nhánh `if (!result.ok)`
 * (`no-conditional-expect`); nhánh hợp lệ vẫn fail ngay với giá trị thật.
 */
function expectRejectedBy(
  result: AccountStatusValidation,
  reason: AccountStatusRejectionReason,
  field: string,
): void {
  expect(result).toMatchObject({ ok: false, reason });
  if (result.ok) {
    throw new Error('Expected the response to be rejected, but it was accepted.');
  }
  expect(result.detail).toContain(field);
}

/**
 * Bóc response khi hợp lệ, ném lỗi khi bị từ chối.
 *
 * Giữ `expect` ngoài nhánh điều kiện (`no-conditional-expect`) và bảo đảm nhánh từ chối
 * fail với thông báo rõ ràng thay vì bỏ qua assertion.
 */
function unwrap(result: AccountStatusValidation): AccountStatusResponse {
  if (!result.ok) {
    throw new Error(`Expected a valid status response, got ${result.reason}: ${result.detail}`);
  }
  return result.payload;
}

describe('validateAccountStatusResponse — accept (FR-011b)', () => {
  it.each([...ACCOUNT_STATUS_RESPONSE_VALUES])('accepts status %s', (status) => {
    expect(unwrap(validateAccountStatusResponse({ status }))).toEqual({ status });
  });

  it('accepts a response produced by accountStatusResponse', () => {
    for (const status of ACCOUNT_STATUS_RESPONSE_VALUES) {
      expect(validateAccountStatusResponse(accountStatusResponse(status)).ok).toBe(true);
    }
  });

  it('returns exactly one field, so the response carries nothing else', () => {
    const response = unwrap(validateAccountStatusResponse({ status: 'active' }));
    expect(Object.keys(response)).toEqual(['status']);
  });

  it('treats not_found as a status value, not an error shape', () => {
    // Khác biệt hành vi quan trọng: `not_found` là trạng thái hợp lệ mang trong body,
    // không phải HTTP 404. Trả lỗi riêng sẽ tạo thêm một oracle đo danh tính.
    const result = validateAccountStatusResponse({ status: 'not_found' });
    expect(result).toEqual({ ok: true, payload: { status: 'not_found' } });
  });
});

describe('validateAccountStatusResponse — identity fields rejected (FR-011b)', () => {
  it.each([...FORBIDDEN_ACCOUNT_STATUS_FIELDS])('rejects a response carrying %s', (field) => {
    const result = validateAccountStatusResponse({ status: 'active', [field]: 'x' });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', field);
  });

  it.each([
    ['email', 'user@example.com'],
    ['display_name', 'Nguyễn Văn A'],
    ['avatar_url', 'https://cdn.example/a.png'],
    ['roles', ['admin']],
  ])('rejects a realistic leak of %s', (field, value) => {
    const result = validateAccountStatusResponse({ status: 'active', [field]: value });
    expect(result).toMatchObject({ ok: false, reason: 'forbidden_field' });
  });

  it('rejects an unknown extra field, not just a known forbidden one', () => {
    const result = validateAccountStatusResponse({ status: 'active', mystery_field: 1 });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', 'mystery_field');
  });

  it('rejects an identity field even when its value is null', () => {
    expect(validateAccountStatusResponse({ status: 'active', email: null })).toMatchObject({
      ok: false,
      reason: 'forbidden_field',
    });
  });

  it('reports forbidden_field before unknown_status', () => {
    // Phải chặn trường định danh trước: nếu status cũng sai thì lỗi vẫn phải nói về
    // việc rò dữ liệu, vì đó là vấn đề nghiêm trọng hơn.
    const result = validateAccountStatusResponse({ status: 'bogus', email: 'x@y.z' });
    expect(result).toMatchObject({ ok: false, reason: 'forbidden_field' });
  });
});

describe('validateAccountStatusResponse — invalid shapes', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'active'],
    ['a number', 1],
    ['an array', [{ status: 'active' }]],
  ])('rejects %s', (_label, payload) => {
    expect(validateAccountStatusResponse(payload)).toMatchObject({
      ok: false,
      reason: 'invalid_payload',
    });
  });

  it.each([
    ['missing status', {}],
    ['unknown status', { status: 'pending' }],
    ['uppercase status', { status: 'ACTIVE' }],
    ['empty status', { status: '' }],
    ['null status', { status: null }],
    ['numeric status', { status: 1 }],
  ])('rejects %s', (_label, payload) => {
    expect(validateAccountStatusResponse(payload)).toMatchObject({
      ok: false,
      reason: 'unknown_status',
    });
  });
});

describe('isAccountStatusResponseValue', () => {
  it.each([...ACCOUNT_STATUS_RESPONSE_VALUES])('accepts %s', (value) => {
    expect(isAccountStatusResponseValue(value)).toBe(true);
  });

  it.each([['pending'], ['ACTIVE'], [''], [null], [undefined], [1], [{}]])(
    'rejects %s',
    (value) => {
      expect(isAccountStatusResponseValue(value)).toBe(false);
    },
  );
});

describe('detail never leaks payload values', () => {
  it('names the offending field without echoing its value', () => {
    const result = validateAccountStatusResponse({
      status: 'active',
      email: 'victim@example.com',
    });
    expect(result).toMatchObject({ ok: false, reason: 'forbidden_field' });
    if (result.ok) {
      throw new Error('Expected the response to be rejected, but it was accepted.');
    }
    expect(result.detail).not.toContain('victim@example.com');
    expect(result.detail).toContain('email');
  });
});
