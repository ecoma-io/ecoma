import {
  validatePostMessagesRequest,
  validatePostMessagesResponse,
  isPostMessagesResponse,
  isPostMessagesErrorBody,
  POST_MESSAGES_ERROR_CODE_VALUES,
  POST_MESSAGES_RESPONSE_FIELDS,
} from './public-messages';

const VALID_RESPONSE = {
  id: 'm_1',
  delivery_id: 'dlv_1',
  app: 'web',
  template: 'reset-password',
  template_version: 2,
  status: 'accepted' as const,
  created: true,
  created_at: '2026-10-15T00:00:00.000Z',
};

describe('POST /v1/messages — request', () => {
  it('accepts the minimal request', () => {
    expect(
      validatePostMessagesRequest({ template: 'reset-password', recipient: 'u@example.com' }),
    ).toMatchObject({
      ok: true,
      request: { template: 'reset-password', recipient: 'u@example.com' },
    });
  });

  it('accepts the optional fields and trims string values', () => {
    expect(
      validatePostMessagesRequest({
        template: 'reset-password',
        recipient: '  u@example.com  ',
        locale: '  vi-VN  ',
        variables: { name: 'A' },
        correlation_id: '  c-1  ',
      }),
    ).toMatchObject({
      ok: true,
      request: {
        template: 'reset-password',
        recipient: 'u@example.com',
        locale: 'vi-VN',
        variables: { name: 'A' },
        correlation_id: 'c-1',
      },
    });
  });

  it('accepts app in the body and drops it (FR-001)', () => {
    // `app` đến từ principal, không từ body: gửi kèm không làm request sai, và
    // request đã validate KHÔNG mang `app` — nguồn duy nhất là authenticated principal.
    const result = validatePostMessagesRequest({
      template: 'reset-password',
      recipient: 'u@example.com',
      app: 'web-app',
    });
    expect(result).toMatchObject({
      ok: true,
      request: { template: 'reset-password', recipient: 'u@example.com' },
    });
    if (!result.ok) {
      throw new Error('Expected a valid payload, but it was rejected.');
    }
    expect(Object.keys(result.request)).not.toContain('app');
  });

  it('accepts app of any type without validating it (FR-001: ignored)', () => {
    expect(
      validatePostMessagesRequest({
        template: 'reset-password',
        recipient: 'u@example.com',
        app: '',
      }),
    ).toMatchObject({ ok: true });

    expect(
      validatePostMessagesRequest({
        template: 'reset-password',
        recipient: 'u@example.com',
        app: 42,
      }),
    ).toMatchObject({ ok: true });
  });

  it('rejects a payload missing template', () => {
    expect(validatePostMessagesRequest({ recipient: 'x' })).toMatchObject({
      ok: false,
      reason: 'missing-field',
      detail: 'template',
    });
  });

  it('rejects a payload missing recipient', () => {
    expect(validatePostMessagesRequest({ template: 'reset-password' })).toMatchObject({
      ok: false,
      reason: 'missing-field',
      detail: 'recipient',
    });
  });

  it('accepts an arbitrary logical template name (the set is open, not a closed enum)', () => {
    // Tap template la seed va chua co admin surface (01-architecture.md §10), nen
    // contract khong duoc dong kin danh sach ten template.
    expect(validatePostMessagesRequest({ template: 'receipt', recipient: 'x' })).toMatchObject({
      ok: true,
      request: { template: 'receipt', recipient: 'x' },
    });
  });

  it('rejects a template that is not a non-empty string', () => {
    expect(validatePostMessagesRequest({ template: '', recipient: 'x' })).toMatchObject({
      ok: false,
      reason: 'wrong-type',
      detail: 'template',
    });
    expect(validatePostMessagesRequest({ template: 42, recipient: 'x' })).toMatchObject({
      ok: false,
      reason: 'wrong-type',
      detail: 'template',
    });
  });

  it('rejects a forbidden field', () => {
    expect(
      validatePostMessagesRequest({ template: 'reset-password', recipient: 'x', secret: 's' }),
    ).toMatchObject({
      ok: false,
      reason: 'forbidden-field',
      detail: 'secret',
    });
  });

  it.each([
    ['locale as a number', { locale: 1 }],
    ['variables as an array', { variables: [] }],
    ['correlation_id as a number', { correlation_id: 5 }],
    ['recipient as an empty string', { recipient: '' }],
    ['recipient as a number', { recipient: 42 }],
  ])('rejects %s', (_label, override) => {
    expect(
      validatePostMessagesRequest({ template: 'reset-password', recipient: 'x', ...override }),
    ).toMatchObject({
      ok: false,
    });
  });
});

describe('POST /v1/messages — response', () => {
  it('accepts the documented 201 body', () => {
    expect(validatePostMessagesResponse({ ...VALID_RESPONSE })).toMatchObject({
      ok: true,
      response: VALID_RESPONSE,
    });
  });

  it('emits exactly the eight documented response fields', () => {
    const result = validatePostMessagesResponse({ ...VALID_RESPONSE });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected a valid payload, but it was rejected.');
    }
    const keys = Object.keys(result.response);
    expect(keys).toHaveLength(POST_MESSAGES_RESPONSE_FIELDS.length);
    for (const field of POST_MESSAGES_RESPONSE_FIELDS) {
      expect(keys).toContain(field);
    }
  });

  it('rejects a non-boolean created flag', () => {
    expect(
      validatePostMessagesResponse({ ...VALID_RESPONSE, created: '2026-10-15T00:00:00.000Z' }),
    ).toMatchObject({
      ok: false,
      reason: 'wrong-type',
      detail: 'created',
    });
  });

  it('accepts created = false on an idempotent replay', () => {
    expect(validatePostMessagesResponse({ ...VALID_RESPONSE, created: false })).toMatchObject({
      ok: true,
      response: { created: false },
    });
  });

  it('rejects a status outside the message-status set', () => {
    expect(validatePostMessagesResponse({ ...VALID_RESPONSE, status: 'unknown' })).toMatchObject({
      ok: false,
      reason: 'invalid-value',
      detail: 'status',
    });
  });

  it('rejects a rendered body leaking into the response', () => {
    expect(
      validatePostMessagesResponse({ ...VALID_RESPONSE, body: '<p>rendered</p>' }),
    ).toMatchObject({
      ok: false,
      reason: 'forbidden-field',
      detail: 'body',
    });
  });

  it('rejects a response missing a documented field', () => {
    const { created_at: _omitted, ...rest } = VALID_RESPONSE;
    expect(validatePostMessagesResponse(rest)).toMatchObject({
      ok: false,
      reason: 'missing-field',
      detail: 'created_at',
    });
  });

  it('rejects a non-integer template_version', () => {
    expect(validatePostMessagesResponse({ ...VALID_RESPONSE, template_version: 0 })).toMatchObject({
      ok: false,
      reason: 'wrong-type',
      detail: 'template_version',
    });
  });

  it('keeps isPostMessagesResponse as a permissive shape guard', () => {
    expect(isPostMessagesResponse({ ...VALID_RESPONSE })).toBe(true);
    expect(isPostMessagesResponse({ ...VALID_RESPONSE, body: 'x' })).toBe(true);
    expect(isPostMessagesResponse(null)).toBe(false);
  });
});

describe('POST /v1/messages — error envelope', () => {
  it('accepts every documented error code', () => {
    for (const code of POST_MESSAGES_ERROR_CODE_VALUES) {
      expect(isPostMessagesErrorBody({ error: { code, message: 'x' } })).toBe(true);
    }
  });

  it('rejects an undocumented error code', () => {
    expect(isPostMessagesErrorBody({ error: { code: 'teapot', message: 'x' } })).toBe(false);
  });

  it('rejects a malformed error envelope', () => {
    expect(isPostMessagesErrorBody(null)).toBe(false);
    expect(isPostMessagesErrorBody({ error: 'unauthorized' })).toBe(false);
    expect(isPostMessagesErrorBody({ error: { code: 'unauthorized' } })).toBe(false);
  });

  it('covers exactly the eleven documented codes', () => {
    expect(POST_MESSAGES_ERROR_CODE_VALUES).toEqual([
      'unauthorized',
      'forbidden',
      'invalid_request',
      'invalid_recipient',
      'invalid_locale',
      'idempotency_key_conflict',
      'rate_limited',
      'template_not_found',
      'payload_too_large',
      'internal_error',
      'service_unavailable',
    ]);
  });
});
