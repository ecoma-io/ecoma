import {
  validateMailSendCommand,
  MAIL_COMMAND_VERSION,
  ALLOWED_MAIL_SEND_COMMAND_FIELDS,
} from './mail-command';

describe('validateMailSendCommand — accept', () => {
  it('accepts valid command with version 1', () => {
    expect(validateMailSendCommand({ version: 1, delivery_id: 'dlv_abc123' })).toEqual({
      ok: true,
      command: { version: 1, delivery_id: 'dlv_abc123' },
    });
  });

  it('trims delivery_id', () => {
    const result = validateMailSendCommand({ version: 1, delivery_id: '  dlv_x  ' });
    expect(result).toEqual({ ok: true, command: { version: 1, delivery_id: 'dlv_x' } });
  });

  it('produces a command carrying exactly the two contract fields', () => {
    const result = validateMailSendCommand({ version: 1, delivery_id: 'dlv_x' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected a valid payload, but it was rejected.');
    }
    const keys = Object.keys(result.command);
    expect(keys).toHaveLength(ALLOWED_MAIL_SEND_COMMAND_FIELDS.length);
    for (const field of ALLOWED_MAIL_SEND_COMMAND_FIELDS) {
      expect(keys).toContain(field);
    }
  });
});

describe('validateMailSendCommand — unparseable payload', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', '{"version":1}'],
    ['a number', 42],
    ['an array', [{ version: 1, delivery_id: 'd' }]],
    ['a boolean', true],
  ])('rejects %s', (_label, payload) => {
    expect(validateMailSendCommand(payload)).toMatchObject({ ok: false, reason: 'unparseable' });
  });
});

describe('validateMailSendCommand — forbidden fields (closed schema)', () => {
  it('rejects an unknown key and names it', () => {
    expect(validateMailSendCommand({ version: 1, delivery_id: 'd', extra: true })).toMatchObject({
      ok: false,
      reason: 'forbidden-field',
      detail: 'extra',
    });
  });

  it('rejects a payload that is only an unknown key', () => {
    expect(validateMailSendCommand({ metadata: { x: 1 } })).toMatchObject({
      ok: false,
      reason: 'forbidden-field',
      detail: 'metadata',
    });
  });

  it('prefers forbidden-field over missing-field', () => {
    // Nếu báo missing-field thì code có thể "sửa" bằng cách điền thêm trường thay vì
    // gỡ trường lạ — chặn nhầm chỗ chỉ dẫn sai hành động.
    expect(validateMailSendCommand({ extra: 1 })).toMatchObject({
      ok: false,
      reason: 'forbidden-field',
      detail: 'extra',
    });
  });

  it.each([
    ['dispatch_generation', 'dispatch_generation'],
    ['recipient', 'recipient'],
    ['subject', 'subject'],
    ['body', 'body'],
    ['api_key', 'api_key'],
    ['secret', 'secret'],
    ['token', 'token'],
  ])('rejects the sensitive/forbidden key %s', (_label, key) => {
    const payload: Record<string, unknown> = { version: 1, delivery_id: 'd', [key]: 'anything' };
    expect(validateMailSendCommand(payload)).toMatchObject({
      ok: false,
      reason: 'forbidden-field',
      detail: key,
    });
  });

  it('names the offending key without echoing its value', () => {
    const result = validateMailSendCommand({
      version: 1,
      delivery_id: 'd',
      token: 'super-secret-value',
    });
    expect(result).toMatchObject({ ok: false, reason: 'forbidden-field', detail: 'token' });
    if (result.ok) {
      throw new Error('Expected the payload to be rejected, but it was accepted.');
    }
    expect(result.detail).not.toContain('super-secret-value');
  });
});

describe('validateMailSendCommand — required fields', () => {
  it.each(['version', 'delivery_id'])('rejects a payload missing %s', (field) => {
    const payload: Record<string, unknown> = { version: 1, delivery_id: 'd' };
    Reflect.deleteProperty(payload, field);
    expect(validateMailSendCommand(payload)).toMatchObject({
      ok: false,
      reason: 'missing-field',
      detail: field,
    });
  });

  it('rejects an empty object', () => {
    expect(validateMailSendCommand({})).toMatchObject({ ok: false, reason: 'missing-field' });
  });
});

describe('validateMailSendCommand — field types', () => {
  it.each([
    ['version as the string "1"', { version: '1' }],
    ['version as null', { version: null }],
    ['version as a boolean', { version: true }],
  ])('rejects %s as wrong-type', (_label, override) => {
    expect(validateMailSendCommand({ ...override, delivery_id: 'd' })).toMatchObject({
      ok: false,
      reason: 'wrong-type',
      detail: 'version',
    });
  });

  it.each([
    ['a number', 123],
    ['null', null],
    ['an object', { id: 'd' }],
  ])('rejects delivery_id as %s', (_label, delivery_id) => {
    expect(validateMailSendCommand({ version: 1, delivery_id })).toMatchObject({
      ok: false,
      reason: 'wrong-type',
      detail: 'delivery_id',
    });
  });

  it('rejects an empty or whitespace-only delivery_id', () => {
    expect(validateMailSendCommand({ version: 1, delivery_id: '' })).toMatchObject({
      ok: false,
      reason: 'missing-field',
      detail: 'delivery_id',
    });
    expect(validateMailSendCommand({ version: 1, delivery_id: '   ' })).toMatchObject({
      ok: false,
      reason: 'missing-field',
      detail: 'delivery_id',
    });
  });
});

describe('validateMailSendCommand — version compatibility', () => {
  it('accepts version 1', () => {
    expect(validateMailSendCommand({ version: 1, delivery_id: 'dlv_x' }).ok).toBe(true);
  });

  it.each([
    ['a future version', 2],
    ['zero', 0],
    ['a negative version', -1],
    ['a fractional version', 1.5],
  ])('rejects %s as unsupported-version', (_label, version) => {
    expect(validateMailSendCommand({ version, delivery_id: 'dlv_x' })).toMatchObject({
      ok: false,
      reason: 'unsupported-version',
      detail: 'version',
    });
  });

  it('names the contract version as 1', () => {
    expect(MAIL_COMMAND_VERSION).toBe(1);
  });

  it('allows exactly version and delivery_id — no third field', () => {
    expect(ALLOWED_MAIL_SEND_COMMAND_FIELDS).toEqual(['version', 'delivery_id']);
  });
});
