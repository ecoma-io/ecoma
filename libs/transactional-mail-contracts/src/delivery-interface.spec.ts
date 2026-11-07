import {
  isDeliveryMessage,
  validateDeliveryMessage,
  validateGetDeliveryResponse,
  validatePostDeliveryOutcomeRequest,
  validatePostDeliveryOutcomeResponse,
  DELIVERY_MESSAGE_FIELDS,
  POST_DELIVERY_OUTCOME_RESPONSE_FIELDS,
  POST_DELIVERY_OUTCOME_RESPONSE_STALE_FIELDS,
} from './delivery-interface';

const MSG = {
  delivery_id: 'dlv_123',
  message_id: 'msg_456',
  app: 'app-1',
  status: 'queued' as const,
  recipient: 'u@example.com',
  subject: 'Hello',
  body: '<p>Hi</p>',
  content_type: 'text/html' as const,
};

describe('delivery-interface — DeliveryMessage', () => {
  it('accepts a well-formed DeliveryMessage', () => {
    expect(validateDeliveryMessage(MSG)).toMatchObject({
      ok: true,
      value: {
        delivery_id: 'dlv_123',
        message_id: 'msg_456',
        app: 'app-1',
        status: 'queued',
        recipient: 'u@example.com',
        subject: 'Hello',
        body: '<p>Hi</p>',
        content_type: 'text/html',
      },
    });
  });

  it('accepts an empty subject or body (the docs constrain neither)', () => {
    // §7.2/FR-005 liệt kê field của `message` nhưng không đặt luật "khác rỗng" cho
    // nội dung đã render; contract không được tự thêm luật đó.
    expect(validateDeliveryMessage({ ...MSG, subject: '', body: '' })).toMatchObject({
      ok: true,
      value: { subject: '', body: '' },
    });
  });

  it('rejects a non-string subject', () => {
    expect(validateDeliveryMessage({ ...MSG, subject: 42 } as unknown)).toMatchObject({
      ok: false,
      reason: 'wrong-type',
      detail: 'subject',
    });
  });

  it('produces a message carrying exactly the contract fields', () => {
    const result = validateDeliveryMessage(MSG);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected a valid payload, but it was rejected.');
    }
    const keys = Object.keys(result.value);
    expect(keys).toHaveLength(DELIVERY_MESSAGE_FIELDS.length);
    for (const field of DELIVERY_MESSAGE_FIELDS) {
      expect(keys).toContain(field);
    }
  });

  it('rejects an unknown field in DeliveryMessage', () => {
    expect(validateDeliveryMessage({ ...MSG, secret: 'x' })).toMatchObject({
      ok: false,
      reason: 'forbidden-field',
      detail: 'secret',
    });
  });

  it('rejects a message where content_type is not text/html', () => {
    expect(
      validateDeliveryMessage({ ...MSG, content_type: 'text/plain' } as unknown),
    ).toMatchObject({
      ok: false,
      reason: 'invalid-value',
      detail: 'content_type',
    });
  });

  it('rejects when status is not in MAIL_MESSAGE_STATUS_VALUES', () => {
    expect(validateDeliveryMessage({ ...MSG, status: 'processing' } as unknown)).toMatchObject({
      ok: false,
      reason: 'invalid-value',
      detail: 'status',
    });
  });

  it('rejects an empty recipient', () => {
    expect(validateDeliveryMessage({ ...MSG, recipient: '' })).toMatchObject({
      ok: false,
      reason: 'wrong-type',
      detail: 'recipient',
    });
  });
});

// Guard nhóm `is*` đi cùng validator: hai API phải đồng ý về cùng một payload.
// Nếu guard chặt hơn validator (hay ngược lại) thì consumer gọi nhầm API sẽ
// xử lý khác nhau một message mà tài liệu coi là hợp lệ.
describe('delivery-interface — isDeliveryMessage', () => {
  it('accepts the same payload as validateDeliveryMessage', () => {
    expect(isDeliveryMessage(MSG)).toBe(true);
  });

  it('accepts an empty subject, matching validateDeliveryMessage', () => {
    expect(isDeliveryMessage({ ...MSG, subject: '' })).toBe(true);
  });

  it('accepts an empty body, matching validateDeliveryMessage', () => {
    expect(isDeliveryMessage({ ...MSG, body: '' })).toBe(true);
  });

  it('rejects a non-string subject, matching validateDeliveryMessage', () => {
    expect(isDeliveryMessage({ ...MSG, subject: 42 } as unknown)).toBe(false);
  });
});

describe('delivery-interface — GetDeliveryResponse', () => {
  it('accepts a well-formed GetDeliveryResponse', () => {
    expect(validateGetDeliveryResponse({ message: MSG, dispatch_generation: 1 })).toMatchObject({
      ok: true,
      value: { message: MSG, dispatch_generation: 1 },
    });
  });

  it('rejects GetDeliveryResponse with an extra field', () => {
    expect(
      validateGetDeliveryResponse({ message: MSG, dispatch_generation: 1, extra: 1 }),
    ).toMatchObject({
      ok: false,
      reason: 'forbidden-field',
      detail: 'extra',
    });
  });

  it('rejects when dispatch_generation is not a positive safe integer', () => {
    expect(validateGetDeliveryResponse({ message: MSG, dispatch_generation: 0 })).toMatchObject({
      ok: false,
      reason: 'wrong-type',
      detail: 'dispatch_generation',
    });
    expect(validateGetDeliveryResponse({ message: MSG, dispatch_generation: 1.5 })).toMatchObject({
      ok: false,
      reason: 'wrong-type',
      detail: 'dispatch_generation',
    });
  });
});

describe('delivery-interface — PostDeliveryOutcomeRequest', () => {
  it('accepts a request with error_class', () => {
    expect(
      validatePostDeliveryOutcomeRequest({
        outcome: 'failed',
        error_class: 'retryable',
        dispatch_generation: 3,
      }),
    ).toMatchObject({
      ok: true,
      value: { outcome: 'failed', error_class: 'retryable', dispatch_generation: 3 },
    });
  });

  it('accepts a request without error_class', () => {
    expect(
      validatePostDeliveryOutcomeRequest({ outcome: 'sent', dispatch_generation: 2 }),
    ).toMatchObject({
      ok: true,
      value: { outcome: 'sent', dispatch_generation: 2 },
    });
  });

  it('rejects an unknown outcome', () => {
    expect(
      validatePostDeliveryOutcomeRequest({
        outcome: 'rejected',
        dispatch_generation: 1,
      } as unknown),
    ).toMatchObject({ ok: false, reason: 'invalid-value', detail: 'outcome' });
  });

  it('rejects an unknown error_class', () => {
    expect(
      validatePostDeliveryOutcomeRequest({
        outcome: 'failed',
        error_class: 'timeout',
        dispatch_generation: 1,
      } as unknown),
    ).toMatchObject({ ok: false, reason: 'invalid-value', detail: 'error_class' });
  });

  it('rejects an extra field in the outcome request', () => {
    expect(
      validatePostDeliveryOutcomeRequest({ outcome: 'sent', dispatch_generation: 2, hmac: 'bad' }),
    ).toMatchObject({ ok: false, reason: 'forbidden-field', detail: 'hmac' });
  });

  it('rejects outcome request that is missing dispatch_generation', () => {
    expect(validatePostDeliveryOutcomeRequest({ outcome: 'sent' } as unknown)).toMatchObject({
      ok: false,
      reason: 'missing-field',
      detail: 'dispatch_generation',
    });
  });
});

describe('delivery-interface — PostDeliveryOutcomeResponse', () => {
  it('accepts applied/duplicate', () => {
    expect(
      validatePostDeliveryOutcomeResponse({ result: 'applied', status: 'sent' }),
    ).toMatchObject({
      ok: true,
      value: { result: 'applied', status: 'sent' },
    });
    expect(
      validatePostDeliveryOutcomeResponse({ result: 'duplicate', status: 'sent' }),
    ).toMatchObject({
      ok: true,
      value: { result: 'duplicate', status: 'sent' },
    });
  });

  it('accepts stale with current_dispatch_generation', () => {
    expect(
      validatePostDeliveryOutcomeResponse({
        result: 'stale',
        status: 'blocked',
        current_dispatch_generation: 5,
      }),
    ).toMatchObject({
      ok: true,
      value: { result: 'stale', status: 'blocked', current_dispatch_generation: 5 },
    });
  });

  it('emits exactly the documented fields for applied/duplicate', () => {
    const result = validatePostDeliveryOutcomeResponse({ result: 'applied', status: 'sent' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected a valid payload, but it was rejected.');
    }
    const keys = Object.keys(result.value);
    expect(keys).toHaveLength(POST_DELIVERY_OUTCOME_RESPONSE_FIELDS.length);
    for (const field of POST_DELIVERY_OUTCOME_RESPONSE_FIELDS) {
      expect(keys).toContain(field);
    }
  });

  it('emits exactly the documented fields for stale', () => {
    const result = validatePostDeliveryOutcomeResponse({
      result: 'stale',
      status: 'queued',
      current_dispatch_generation: 3,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected a valid payload, but it was rejected.');
    }
    const keys = Object.keys(result.value);
    expect(keys).toHaveLength(POST_DELIVERY_OUTCOME_RESPONSE_STALE_FIELDS.length);
    for (const field of POST_DELIVERY_OUTCOME_RESPONSE_STALE_FIELDS) {
      expect(keys).toContain(field);
    }
  });

  it('rejects a response missing status', () => {
    expect(validatePostDeliveryOutcomeResponse({ result: 'applied' })).toMatchObject({
      ok: false,
      reason: 'missing-field',
      detail: 'status',
    });
  });

  it('rejects a status outside the message-status set', () => {
    expect(
      validatePostDeliveryOutcomeResponse({ result: 'applied', status: 'processing' }),
    ).toMatchObject({ ok: false, reason: 'invalid-value', detail: 'status' });
  });

  it('rejects stale without current_dispatch_generation', () => {
    expect(
      validatePostDeliveryOutcomeResponse({ result: 'stale', status: 'queued' }),
    ).toMatchObject({
      ok: false,
      reason: 'missing-field',
      detail: 'current_dispatch_generation',
    });
  });

  it('rejects stale with an extra field', () => {
    expect(
      validatePostDeliveryOutcomeResponse({
        result: 'stale',
        status: 'queued',
        current_dispatch_generation: 5,
        extra: 1,
      }),
    ).toMatchObject({ ok: false, reason: 'forbidden-field', detail: 'extra' });
  });

  it('rejects applied with an extra field', () => {
    expect(
      validatePostDeliveryOutcomeResponse({ result: 'applied', status: 'sent', extra: 1 }),
    ).toMatchObject({
      ok: false,
      reason: 'forbidden-field',
      detail: 'extra',
    });
  });

  it('rejects when result is outside the allowed set', () => {
    expect(
      validatePostDeliveryOutcomeResponse({ result: 'superseded', status: 'sent' } as unknown),
    ).toMatchObject({
      ok: false,
      reason: 'invalid-value',
      detail: 'result',
    });
  });

  it('rejects stale with a non-positive dispatch_generation', () => {
    expect(
      validatePostDeliveryOutcomeResponse({
        result: 'stale',
        status: 'queued',
        current_dispatch_generation: 0,
      }),
    ).toMatchObject({ ok: false, reason: 'wrong-type', detail: 'current_dispatch_generation' });
  });
});
