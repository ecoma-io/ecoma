import { describe, expect, it } from 'vitest';

import {
  DELIVERY_OUTCOME_VALUES,
  FORBIDDEN_LEASE_FENCED_REJECTION_FIELDS,
  LEASE_FENCED_REJECTION_REASONS,
  isDeliveryOutcomeValue,
  isLeaseFencedRejectionReason,
  leaseFencedRejection,
  outcomeAck,
  releaseAck,
  validateLeaseFencedRejection,
  validateOutcomeAck,
  validateOutcomeRequest,
  validateReleaseAck,
  validateReleaseRequest,
  type DeliveryOutcomeValue,
  type LeaseFencedRejectionReason,
  type LeaseFencedRejectionValidation,
  type OutcomeRequest,
  type OutcomeRequestValidation,
  type OutcomeValidation,
  type ReleaseRequest,
  type ReleaseRequestValidation,
  type ReleaseValidation,
  type WriteRequestRejectionReason,
} from './delivery-write';
import { TERMINAL_DELIVERY_STATUS_VALUES } from './shared';
import { withPrototypeKeys } from './testing/prototype-pollution';

/**
 * Assert một request body bị từ chối với `reason` và `detail` chứa `needle`.
 *
 * Gộp vào một hàm để không phải bọc `expect` trong nhánh `if (!result.ok)`
 * (`no-conditional-expect`); nhánh hợp lệ vẫn fail ngay với giá trị thật.
 */
function expectRequestRejectedBy(
  result: ReleaseRequestValidation | OutcomeRequestValidation,
  reason: WriteRequestRejectionReason,
  needle: string,
): void {
  expect(result).toMatchObject({ ok: false, reason });
  if (result.ok) {
    throw new Error('Expected the request to be rejected, but it was accepted.');
  }
  expect(result.detail).toContain(needle);
}

/** Assert một response body (`200` hoặc `409`) bị từ chối. */
function expectResponseRejectedBy(
  result: ReleaseValidation | OutcomeValidation | LeaseFencedRejectionValidation,
  reason: string,
  needle: string,
): void {
  expect(result).toMatchObject({ ok: false, reason });
  if (result.ok) {
    throw new Error('Expected the response to be rejected, but it was accepted.');
  }
  expect(result.detail).toContain(needle);
}

describe('validateReleaseRequest — only the fencing token', () => {
  it('accepts a positive integer dispatch_generation', () => {
    const result = validateReleaseRequest({ dispatch_generation: 3 });
    expect(result).toEqual({ ok: true, request: { dispatch_generation: 3 } });
  });

  it('rejects a missing dispatch_generation', () => {
    const checked18 = validateReleaseRequest({});
    expect(checked18.ok).toBe(false);
    expectRequestRejectedBy(checked18, 'missing_field', 'dispatch_generation');
  });

  it.each([
    ['zero', 0],
    ['a negative value', -1],
    ['a fractional value', 1.5],
    ['a string', '3'],
    ['null', null],
    ['NaN', Number.NaN],
  ])('rejects %s as dispatch_generation', (_label, value) => {
    const checked17 = validateReleaseRequest({ dispatch_generation: value });
    expect(checked17.ok).toBe(false);
    expectRequestRejectedBy(checked17, 'invalid_field_type', 'dispatch_generation');
  });

  it('rejects outcome on release — that field belongs to the other operation', () => {
    const checked16 = validateReleaseRequest({ dispatch_generation: 1, outcome: 'failed' });
    expect(checked16.ok).toBe(false);
    expectRequestRejectedBy(checked16, 'unexpected_field', 'outcome');
  });

  it.each([
    ['null', null],
    ['a string', 'release'],
    ['an array', []],
  ])('rejects %s as the whole request', (_label, body) => {
    expect(validateReleaseRequest(body)).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });
});

describe('validateOutcomeRequest — fencing token plus a closed outcome', () => {
  it('accepts delivered with a positive integer generation', () => {
    expect(validateOutcomeRequest({ dispatch_generation: 1, outcome: 'delivered' })).toEqual({
      ok: true,
      request: { dispatch_generation: 1, outcome: 'delivered' },
    });
  });

  it('accepts failed with a positive integer generation', () => {
    expect(validateOutcomeRequest({ dispatch_generation: 7, outcome: 'failed' }).ok).toBe(true);
  });

  it('rejects a missing field', () => {
    const checked15 = validateOutcomeRequest({ dispatch_generation: 1 });
    expect(checked15.ok).toBe(false);
    expectRequestRejectedBy(checked15, 'missing_field', 'outcome');
    const checked14 = validateOutcomeRequest({ outcome: 'delivered' });
    expect(checked14.ok).toBe(false);
    expectRequestRejectedBy(checked14, 'missing_field', 'dispatch_generation');
  });

  it.each(['expired', 'cancelled', 'queued', 'processing', 'DELIVERED', ''] as const)(
    'rejects outcome %s — worker writes only delivered/failed',
    (outcome) => {
      const checked13 = validateOutcomeRequest({ dispatch_generation: 1, outcome });
      expect(checked13.ok).toBe(false);
      expectRequestRejectedBy(checked13, 'invalid_field_type', 'outcome');
    },
  );

  it('rejects an out-of-contract field', () => {
    const checked12 = validateOutcomeRequest({
      dispatch_generation: 1,
      outcome: 'failed',
      provider_response: { status: 410 },
    });
    expect(checked12.ok).toBe(false);
    expectRequestRejectedBy(checked12, 'unexpected_field', 'provider_response');
  });

  it('rejects a non-integer generation', () => {
    const checked11 = validateOutcomeRequest({ dispatch_generation: 0, outcome: 'failed' });
    expect(checked11.ok).toBe(false);
    expectRequestRejectedBy(checked11, 'invalid_field_type', 'dispatch_generation');
  });
});

describe('validateReleaseAck — 200 must be queued', () => {
  it('accepts a queued ack', () => {
    expect(
      validateReleaseAck({ delivery_id: 'dlv_1', status: 'queued', dispatch_generation: 2 }),
    ).toEqual({
      ok: true,
      ack: { delivery_id: 'dlv_1', status: 'queued', dispatch_generation: 2 },
    });
  });

  it('accepts an ack built by releaseAck', () => {
    expect(
      validateReleaseAck(releaseAck({ delivery_id: 'dlv_1', dispatch_generation: 2 })).ok,
    ).toBe(true);
  });

  it.each(['processing', 'delivered', 'failed', 'expired', 'cancelled', 'pending'] as const)(
    'rejects status %s — release has no other outcome',
    (status) => {
      const checked10 = validateReleaseAck({
        delivery_id: 'dlv_1',
        status,
        dispatch_generation: 2,
      });
      expect(checked10.ok).toBe(false);
      expectResponseRejectedBy(checked10, 'invalid_field_type', 'status');
    },
  );

  it('rejects a missing field', () => {
    const checked9 = validateReleaseAck({ status: 'queued', dispatch_generation: 2 });
    expect(checked9.ok).toBe(false);
    expectResponseRejectedBy(checked9, 'missing_field', 'delivery_id');
  });

  it('rejects an out-of-contract field', () => {
    const checked8 = validateReleaseAck({
      delivery_id: 'dlv_1',
      status: 'queued',
      dispatch_generation: 2,
      payload: { title: 'x' },
    });
    expect(checked8.ok).toBe(false);
    expectResponseRejectedBy(checked8, 'unexpected_field', 'payload');
  });
});

describe('validateOutcomeAck — 200 status is a closed outcome', () => {
  it.each(DELIVERY_OUTCOME_VALUES)('accepts status %s', (status) => {
    expect(
      validateOutcomeAck({ delivery_id: 'dlv_1', status, dispatch_generation: 1 }),
    ).toMatchObject({ ok: true, ack: { status } });
  });

  it.each(['expired', 'cancelled', 'queued', 'processing'] as const)(
    'rejects status %s — those terminal states belong to the control plane',
    (status) => {
      const checked7 = validateOutcomeAck({ delivery_id: 'dlv_1', status, dispatch_generation: 1 });
      expect(checked7.ok).toBe(false);
      expectResponseRejectedBy(checked7, 'invalid_field_type', 'status');
    },
  );

  it('accepts an ack built by outcomeAck', () => {
    expect(
      validateOutcomeAck(
        outcomeAck({ delivery_id: 'dlv_1', outcome: 'delivered', dispatch_generation: 1 }),
      ).ok,
    ).toBe(true);
  });

  it('rejects a non-integer generation', () => {
    const checked6 = validateOutcomeAck({
      delivery_id: 'dlv_1',
      status: 'delivered',
      dispatch_generation: 1.5,
    });
    expect(checked6.ok).toBe(false);
    expectResponseRejectedBy(checked6, 'invalid_field_type', 'dispatch_generation');
  });
});

describe('validateLeaseFencedRejection — closed 409 body', () => {
  it('accepts stale_write without state', () => {
    expect(validateLeaseFencedRejection({ reason: 'stale_write' })).toEqual({
      ok: true,
      rejection: { reason: 'stale_write' },
    });
  });

  it.each([...TERMINAL_DELIVERY_STATUS_VALUES])('accepts terminal with state %s', (state) => {
    expect(validateLeaseFencedRejection({ reason: 'terminal', state })).toMatchObject({
      ok: true,
      rejection: { reason: 'terminal', state },
    });
  });

  it('accepts a body built by leaseFencedRejection', () => {
    expect(validateLeaseFencedRejection(leaseFencedRejection('stale_write')).ok).toBe(true);
    expect(validateLeaseFencedRejection(leaseFencedRejection('terminal', 'failed')).ok).toBe(true);
  });

  it('rejects a reason outside the closed set', () => {
    const checked5 = validateLeaseFencedRejection({ reason: 'ineligible_subscription' });
    expect(checked5.ok).toBe(false);
    expectResponseRejectedBy(checked5, 'unknown_reason', 'reason');
    if (checked5.ok) {
      throw new Error('Expected the response to be rejected, but it was accepted.');
    }
    // `detail` nêu tên field, không nối giá trị caller gửi vào (có thể bị log).
    expect(checked5.detail).not.toContain('ineligible_subscription');
  });

  it('keeps the write vocabulary disjoint from the claim vocabulary', () => {
    // Claim reasons mô tả quyền vào hàng đợi; write reasons mô tả hàng đang giữ lease.
    // Trộn hai tập lại sẽ mô tả sai quyền của execution đang giữ lease.
    expect(LEASE_FENCED_REJECTION_REASONS).toEqual(['stale_write', 'terminal']);
    for (const claimReason of ['pending', 'lease_held', 'expired', 'ineligible_subscription']) {
      expect(isLeaseFencedRejectionReason(claimReason)).toBe(false);
    }
    for (const writeReason of LEASE_FENCED_REJECTION_REASONS) {
      expect(isLeaseFencedRejectionReason(writeReason)).toBe(true);
    }
  });

  it('requires state when reason is terminal', () => {
    const checked4 = validateLeaseFencedRejection({ reason: 'terminal' });
    expect(checked4.ok).toBe(false);
    expectResponseRejectedBy(checked4, 'state_required', 'terminal');
  });

  it('rejects a non-terminal delivery state as terminal state', () => {
    const checked3 = validateLeaseFencedRejection({ reason: 'terminal', state: 'processing' });
    expect(checked3.ok).toBe(false);
    expectResponseRejectedBy(checked3, 'invalid_field_type', 'state');
  });

  it('rejects state on stale_write', () => {
    const checked2 = validateLeaseFencedRejection({ reason: 'stale_write', state: 'failed' });
    expect(checked2.ok).toBe(false);
    expectResponseRejectedBy(checked2, 'state_not_allowed', 'state');
  });

  it('rejects an unexpected field', () => {
    const checked1 = validateLeaseFencedRejection({
      reason: 'stale_write',
      anything_else: 4,
    });
    expect(checked1.ok).toBe(false);
    expectResponseRejectedBy(checked1, 'unexpected_field', 'anything_else');
  });

  it.each([...FORBIDDEN_LEASE_FENCED_REJECTION_FIELDS])(
    'rejects a 409 carrying %s as runtime material leak',
    (field) => {
      const checked = validateLeaseFencedRejection({ reason: 'stale_write', [field]: 'x' });
      expect(checked.ok).toBe(false);
      expectResponseRejectedBy(checked, 'runtime_material_leak', field);
    },
  );

  // Tên **cứng** chứ không lấy từ hằng: `it.each(LIST)` tự mất case nếu ai đó gỡ entry khỏi
  // `LIST`, nên không chứng minh được nhóm alias secret protocol có thật sự nằm trong danh
  // sách cấm của response hay không (xem ghi chú tương tự trong claim.spec.ts).
  it.each(['authorization', 'secret', 'token', 'access_token'])(
    'classifies the secret alias %s as a runtime material leak, not an unexpected field',
    (field) => {
      const checked = validateLeaseFencedRejection({ reason: 'stale_write', [field]: 'x' });
      expect(checked.ok).toBe(false);
      expectResponseRejectedBy(checked, 'runtime_material_leak', field);
    },
  );

  it.each([
    ['null', null],
    ['a string', 'stale_write'],
    ['an array', []],
  ])('rejects %s as the whole 409', (_label, body) => {
    expect(validateLeaseFencedRejection(body)).toMatchObject({
      ok: false,
      reason: 'invalid_payload',
    });
  });

  it('rejects leaseFencedRejection built with mismatched state', () => {
    expect(() => leaseFencedRejection('terminal')).toThrow(/bắt buộc có state/u);
    expect(() => leaseFencedRejection('stale_write', 'failed')).toThrow(/không được kèm state/u);
  });

  // Regress F4 (cùng lý do với `claimRejection`): nhánh `state !== undefined` nối `reason`
  // vào message, nên phải kiểm tập đóng TRƯỚC để một reason chứa xuống dòng không vào log.
  it('throws the closed-set message instead of echoing an unvalidated reason', () => {
    let thrown: string | undefined;
    try {
      leaseFencedRejection('stale_write\nFAKE LOG LINE' as LeaseFencedRejectionReason, 'failed');
    } catch (error: unknown) {
      thrown = (error as Error).message;
    }

    expect(thrown).toBeDefined();
    expect(thrown).not.toContain('FAKE LOG LINE');
    expect(thrown).toContain('tập đóng');
  });

  it('classifies a missing reason as missing, not as an unknown reason', () => {
    // Cùng cách phân loại với `409` của claim: vắng hẳn / sai kiểu / ngoài tập đóng là ba lỗi
    // khác nhau, dù hai vocabulary `reason` của hai operation là hai tập khác nhau.
    const checked = validateLeaseFencedRejection({});
    expect(checked.ok).toBe(false);
    expectResponseRejectedBy(checked, 'missing_field', 'reason');
  });

  it('classifies a non-string reason as a wrong type, not as an unknown reason', () => {
    const checked = validateLeaseFencedRejection({ reason: 409 });
    expect(checked.ok).toBe(false);
    expectResponseRejectedBy(checked, 'invalid_field_type', 'reason');
  });
});

describe('outcome value guard', () => {
  it.each([
    ['delivered', true],
    ['failed', true],
    ['expired', false],
    ['cancelled', false],
    ['queued', false],
  ] as const)('isDeliveryOutcomeValue(%o) === %s', (value, expected) => {
    expect(isDeliveryOutcomeValue(value)).toBe(expected);
  });
});

/** Guard ngầm: union `LeaseFencedRejectionReason` phải khớp hằng đóng. */
describe('LeaseFencedRejectionReason stays in sync with LEASE_FENCED_REJECTION_REASONS', () => {
  it('accepts every member of the closed set', () => {
    for (const reason of LEASE_FENCED_REJECTION_REASONS) {
      const typedReason: LeaseFencedRejectionReason = reason;
      expect(isLeaseFencedRejectionReason(typedReason)).toBe(true);
    }
  });
});

describe('ack and rejection builders return only what their validators accept (A3)', () => {
  it('releaseAck throws on an empty delivery_id', () => {
    expect(() => releaseAck({ delivery_id: '', dispatch_generation: 1 })).toThrow(
      /invalid_field_type/u,
    );
  });

  it('releaseAck throws on a non-positive dispatch_generation', () => {
    expect(() => releaseAck({ delivery_id: 'dlv_123', dispatch_generation: 0 })).toThrow(
      /invalid_field_type/u,
    );
  });

  it('outcomeAck throws on an outcome outside the closed set', () => {
    const wrongOutcome = 'expired' as string;
    expect(() =>
      outcomeAck({
        delivery_id: 'dlv_123',
        outcome: wrongOutcome as DeliveryOutcomeValue,
        dispatch_generation: 1,
      }),
    ).toThrow(/invalid_field_type/u);
  });

  it('outcomeAck throws on a non-positive dispatch_generation', () => {
    expect(() =>
      outcomeAck({
        delivery_id: 'dlv_123',
        outcome: 'delivered',
        dispatch_generation: -1,
      }),
    ).toThrow(/invalid_field_type/u);
  });

  it('every builder output passes its own canonical validator', () => {
    expect(
      validateReleaseAck(releaseAck({ delivery_id: 'dlv_1', dispatch_generation: 2 })),
    ).toMatchObject({ ok: true });
    expect(
      validateOutcomeAck(
        outcomeAck({ delivery_id: 'dlv_1', outcome: 'failed', dispatch_generation: 2 }),
      ),
    ).toMatchObject({ ok: true });
    expect(validateLeaseFencedRejection(leaseFencedRejection('stale_write'))).toMatchObject({
      ok: true,
    });
    expect(
      validateLeaseFencedRejection(leaseFencedRejection('terminal', 'delivered')),
    ).toMatchObject({ ok: true });
  });
});

describe('request validation results narrow without probing or casts (D)', () => {
  it('gives release results a ReleaseRequest-only success shape', () => {
    const result = validateReleaseRequest({ dispatch_generation: 1 });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) {
      throw new Error('Expected the release request to be accepted, but it was rejected.');
    }
    // Narrowing là kiểu, không cần probe runtime: gán thẳng vào kiểu của operation.
    const request: ReleaseRequest = result.request;
    expect(request.dispatch_generation).toBe(1);
    // @ts-expect-error — ReleaseRequest không có `outcome`; consumer không cần probe/cast.
    const mismatched: OutcomeRequest = result.request;
    expect(mismatched.dispatch_generation).toBe(1);
  });

  it('gives outcome results an OutcomeRequest without union narrowing', () => {
    const result = validateOutcomeRequest({ dispatch_generation: 1, outcome: 'delivered' });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) {
      throw new Error('Expected the outcome request to be accepted, but it was rejected.');
    }
    // Với union trả về cũ, dòng gán này là lỗi type — từng ép consumer phải probe.
    const request: OutcomeRequest = result.request;
    expect(request.outcome).toBe('delivered');
    expect(request.dispatch_generation).toBe(1);
  });
});

describe('write-plane object shape policy (A1)', () => {
  it.each([
    ['a Date', new Date(0)],
    ['a Map', new Map<string, string>()],
  ] as const)('rejects a release request that is %s', (_label, value) => {
    const checked = validateReleaseRequest(value);
    expect(checked.ok).toBe(false);
    expectRequestRejectedBy(checked, 'invalid_payload', 'object JSON');
  });

  it('rejects a getter on an allowed 409 field without invoking it', () => {
    let invoked = 0;
    const record: Record<string, unknown> = { reason: 'stale_write' };
    Object.defineProperty(record, 'state', {
      get() {
        invoked += 1;
        return 'failed';
      },
      enumerable: true,
      configurable: true,
    });
    const checked = validateLeaseFencedRejection(record);
    expectResponseRejectedBy(checked, 'invalid_payload', 'getter');
    expect(invoked).toBe(0);
  });

  it('rejects a non-enumerable 409 field — JSON.stringify would drop it silently', () => {
    const record: Record<string, unknown> = { reason: 'stale_write' };
    Object.defineProperty(record, 'anything_else', {
      value: 1,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    // Field ẩn nằm ngoài contract: membership pass thấy nó trước → `unexpected_field`.
    const checked = validateLeaseFencedRejection(record);
    expect(checked.ok).toBe(false);
    if (checked.ok) {
      throw new Error('Expected the body to be rejected, but it was accepted.');
    }
    expect(checked.reason).toBe('unexpected_field');
  });

  it('rejects a non-enumerable allowed 409 field as a non-JSON object', () => {
    const record: Record<string, unknown> = { reason: 'stale_write' };
    Object.defineProperty(record, 'state', {
      value: 'failed',
      enumerable: false,
      writable: true,
      configurable: true,
    });
    const checked = validateLeaseFencedRejection(record);
    expect(checked.ok).toBe(false);
    expectResponseRejectedBy(checked, 'invalid_payload', 'non-enumerable');
  });
  it('treats Object.prototype keys as not present (own keys only)', () => {
    // `dispatch_generation` (bắt buộc của request) và `status` (bắt buộc của 200): giá trị
    // độc để một định nghĩa "có mặt" bằng `in` sẽ vừa lọt qua closed schema vừa kéo giá trị
    // từ prototype vào kết quả.
    withPrototypeKeys({ dispatch_generation: 1, status: 'queued' }, () => {
      const request = validateReleaseRequest({});
      expect(request.ok).toBe(false);
      expectRequestRejectedBy(request, 'missing_field', 'dispatch_generation');

      const ack = validateReleaseAck({ delivery_id: 'dlv_1' });
      expect(ack.ok).toBe(false);
      expectResponseRejectedBy(ack, 'missing_field', 'status');
    });
  });
});

describe('write-plane diagnostics are safe to log (C1)', () => {
  it('sanitizes control characters out of an unexpected 409 field name', () => {
    const checked = validateLeaseFencedRejection({ reason: 'stale_write', ['evil\nkey']: 1 });
    expectResponseRejectedBy(checked, 'unexpected_field', 'Response 409');
    if (checked.ok) {
      throw new Error('Expected the body to be rejected, but it was accepted.');
    }
    expect(checked.detail).not.toContain('\n');
    expect(checked.detail).toContain('evil?key');
  });

  it('sanitizes control characters out of an unexpected release request field name', () => {
    const checked = validateReleaseRequest({ dispatch_generation: 1, ['evil\nkey']: 1 });
    expectRequestRejectedBy(checked, 'unexpected_field', 'release request');
    if (checked.ok) {
      throw new Error('Expected the request to be rejected, but it was accepted.');
    }
    expect(checked.detail).not.toContain('\n');
    expect(checked.detail).toContain('evil?key');
  });

  it('never echoes an unknown 409 reason value', () => {
    const checked = validateLeaseFencedRejection({ reason: 'leaked-reason-value' });
    expectResponseRejectedBy(checked, 'unknown_reason', 'closed reason set');
    if (checked.ok) {
      throw new Error('Expected the body to be rejected, but it was accepted.');
    }
    expect(checked.detail).not.toContain('leaked-reason-value');
  });
});
