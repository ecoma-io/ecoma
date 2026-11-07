import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_INVALIDATE_ACK_FIELDS,
  INVALIDATE_RESULT_SUBSCRIPTION_STATUS,
  invalidateAck,
  validateInvalidateAck,
  validateInvalidateRequest,
  type InvalidateResponseRejectionReason,
  type InvalidateValidation,
} from './invalidate';
import { SUBSCRIPTION_STATUS_VALUES } from './shared';
import { withPrototypeKeys } from './testing/prototype-pollution';

/** Body `200` hợp lệ. */
const VALID = { subscription_id: 'sub_123', status: 'disabled' } as const;

/**
 * Assert validation thất bại với `reason` và `detail` chứa `needle`.
 *
 * Gộp vào một hàm để không phải bọc `expect` trong nhánh `if (!result.ok)`
 * (`no-conditional-expect`); nhánh hợp lệ vẫn fail ngay với giá trị thật.
 */
function expectRejectedBy(
  result: InvalidateValidation,
  reason: InvalidateResponseRejectionReason,
  needle: string,
): void {
  expect(result).toMatchObject({ ok: false, reason });
  if (result.ok) {
    throw new Error('Expected the body to be rejected, but it was accepted.');
  }
  expect(result.detail).toContain(needle);
}

describe('validateInvalidateRequest — empty body, no evidence crosses the API', () => {
  it('accepts an empty object', () => {
    expect(validateInvalidateRequest({})).toEqual({ ok: true });
  });

  it.each([
    ['provider evidence', { evidence: { status: 404 } }],
    ['an endpoint', { endpoint: 'https://push.example.com/gone' }],
    ['a delivery id', { delivery_id: 'dlv_1' }],
  ])('rejects a body carrying %s', (_label, body) => {
    expect(validateInvalidateRequest(body)).toMatchObject({
      ok: false,
      reason: 'unexpected_field',
    });
  });

  it.each([
    ['null', null],
    ['a string', ''],
    ['an array', []],
  ])('rejects %s as the whole request', (_label, body) => {
    expect(validateInvalidateRequest(body)).toMatchObject({
      ok: false,
      reason: 'invalid_payload',
    });
  });
});

describe('validateInvalidateAck — closed 200 body', () => {
  it('accepts the two-field ack', () => {
    expect(validateInvalidateAck({ ...VALID })).toEqual({
      ok: true,
      ack: { subscription_id: 'sub_123', status: 'disabled' },
    });
  });

  it('accepts an ack built by invalidateAck', () => {
    expect(validateInvalidateAck(invalidateAck('sub_123')).ok).toBe(true);
  });

  it('pins the status to the single valid value, inside the FR-004 lifecycle', () => {
    expect(INVALIDATE_RESULT_SUBSCRIPTION_STATUS).toBe('disabled');
    expect(SUBSCRIPTION_STATUS_VALUES).toContain(INVALIDATE_RESULT_SUBSCRIPTION_STATUS);
  });

  it.each(['invalidated', 'revoked', 'INVALIDATED', 'INVALIDATED_SUBSCRIPTION', ''] as const)(
    'rejects status %s — not a subscription state',
    (status) => {
      const checked4 = validateInvalidateAck({ ...VALID, status });
      expect(checked4.ok).toBe(false);
      expectRejectedBy(checked4, 'invalid_field_type', 'status');
    },
  );

  it.each(['active', 'expired'] as const)(
    'rejects status %s — a valid lifecycle state, but not what this operation returns',
    (status) => {
      const checked5 = validateInvalidateAck({ ...VALID, status });
      expect(checked5.ok).toBe(false);
      expectRejectedBy(checked5, 'invalid_field_type', 'status');
    },
  );

  it('rejects a missing subscription_id', () => {
    const checked3 = validateInvalidateAck({ status: 'disabled' });
    expect(checked3.ok).toBe(false);
    expectRejectedBy(checked3, 'missing_field', 'subscription_id');
  });

  it('rejects a missing status as missing, not as a wrong type', () => {
    // Vắng `status` và `status` sai giá trị là hai lỗi khác nhau: một cái là body thiếu
    // field, cái kia là body mang giá trị ngoài hợp đồng. Gộp chúng lại che mất chẩn đoán.
    const checked = validateInvalidateAck({ subscription_id: 'sub_123' });
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'missing_field', 'status');
  });

  it('rejects an empty subscription_id', () => {
    const checked2 = validateInvalidateAck({ subscription_id: '', status: 'disabled' });
    expect(checked2.ok).toBe(false);
    expectRejectedBy(checked2, 'invalid_field_type', 'subscription_id');
  });

  it.each([...FORBIDDEN_INVALIDATE_ACK_FIELDS])(
    'rejects an ack carrying %s as runtime material leak',
    (field) => {
      const checked1 = validateInvalidateAck({ ...VALID, [field]: 'x' });
      expect(checked1.ok).toBe(false);
      expectRejectedBy(checked1, 'runtime_material_leak', field);
    },
  );

  // Tên **cứng** chứ không lấy từ hằng: `it.each(LIST)` tự mất case nếu ai đó gỡ entry khỏi
  // `LIST`, nên không chứng minh được nhóm alias secret protocol có thật sự nằm trong danh
  // sách cấm của response (xem ghi chú tương tự trong claim.spec.ts).
  it.each(['authorization', 'secret', 'token', 'access_token'])(
    'classifies the secret alias %s as a runtime material leak, not an unexpected field',
    (field) => {
      const checked1 = validateInvalidateAck({ ...VALID, [field]: 'x' });
      expect(checked1.ok).toBe(false);
      expectRejectedBy(checked1, 'runtime_material_leak', field);
    },
  );

  it('rejects an out-of-contract field', () => {
    const checked = validateInvalidateAck({ ...VALID, invalidated_at: '2026-01-01T00:00:00Z' });
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'unexpected_field', 'invalidated_at');
  });

  it.each([
    ['null', null],
    ['a string', 'invalidated'],
    ['an array', [VALID]],
  ])('rejects %s as the whole body', (_label, body) => {
    expect(validateInvalidateAck(body)).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });
});

describe('invalidateAck returns only what validateInvalidateAck accepts (A3)', () => {
  it('throws on an empty subscription_id instead of returning a rejected body', () => {
    expect(() => invalidateAck('')).toThrow(/invalid_field_type/u);
  });

  it('returns an ack that its own validator accepts', () => {
    expect(validateInvalidateAck(invalidateAck('sub_123'))).toMatchObject({ ok: true });
  });
});

describe('invalidate object shape policy (A1)', () => {
  it.each([
    ['a Date', new Date(0)],
    ['a Map', new Map<string, string>()],
  ] as const)('rejects a 200 body that is %s', (_label, value) => {
    const checked = validateInvalidateAck(value);
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_payload', 'object JSON');
  });

  it('rejects a getter on subscription_id without invoking it', () => {
    let invoked = 0;
    const record: Record<string, unknown> = { status: 'disabled' };
    Object.defineProperty(record, 'subscription_id', {
      get() {
        invoked += 1;
        return 'sub_123';
      },
      enumerable: true,
      configurable: true,
    });
    const checked = validateInvalidateAck(record);
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_payload', 'getter');
    expect(invoked).toBe(0);
  });

  it('rejects a non-enumerable allowed field — JSON.stringify would drop it silently', () => {
    const record: Record<string, unknown> = { subscription_id: 'sub_123' };
    Object.defineProperty(record, 'status', {
      value: 'disabled',
      enumerable: false,
      writable: true,
      configurable: true,
    });
    const checked = validateInvalidateAck(record);
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_payload', 'non-enumerable');
  });

  it('rejects a request field hidden behind a getter without invoking it', () => {
    let invoked = 0;
    const record: Record<string, unknown> = {};
    Object.defineProperty(record, 'evidence', {
      get() {
        invoked += 1;
        return 'provider-response';
      },
      enumerable: true,
      configurable: true,
    });
    const checked = validateInvalidateRequest(record);
    expect(checked.ok).toBe(false);
    if (checked.ok) {
      throw new Error('Expected the request to be rejected, but it was accepted.');
    }
    expect(checked.reason).toBe('unexpected_field');
    expect(invoked).toBe(0);
  });
  it('treats Object.prototype keys as not present (own keys only)', () => {
    // `subscription_id` (bắt buộc) và `status` (bắt buộc): giá trị độc để một định nghĩa
    // "có mặt" bằng `in` sẽ vừa lọt qua closed schema vừa kéo giá trị từ prototype.
    withPrototypeKeys({ subscription_id: 1, status: 'active' }, () => {
      const emptyBody = validateInvalidateAck({});
      expect(emptyBody.ok).toBe(false);
      expectRejectedBy(emptyBody, 'missing_field', 'subscription_id');

      const missingStatus = validateInvalidateAck({ subscription_id: 'sub_123' });
      expect(missingStatus.ok).toBe(false);
      expectRejectedBy(missingStatus, 'missing_field', 'status');
    });
  });
});

describe('invalidate diagnostics are safe to log (C1)', () => {
  it('sanitizes control characters out of an unexpected 200 field name', () => {
    const checked = validateInvalidateAck({ ...VALID, ['evil\nkey']: 1 });
    expectRejectedBy(checked, 'unexpected_field', 'Invalidate 200');
    if (checked.ok) {
      throw new Error('Expected the body to be rejected, but it was accepted.');
    }
    expect(checked.detail).not.toContain('\n');
    expect(checked.detail).toContain('evil?key');
  });

  it('sanitizes control characters out of a request field name', () => {
    const checked = validateInvalidateRequest({ ['evil\nkey']: 1 });
    expect(checked.ok).toBe(false);
    if (checked.ok) {
      throw new Error('Expected the request to be rejected, but it was accepted.');
    }
    expect(checked.reason).toBe('unexpected_field');
    expect(checked.detail).not.toContain('\n');
    expect(checked.detail).toContain('evil?key');
  });
});
