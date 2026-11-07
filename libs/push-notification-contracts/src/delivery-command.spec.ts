import { describe, expect, it } from 'vitest';

import {
  DELIVERY_COMMAND_FIELDS,
  DELIVERY_COMMAND_VERSION,
  FORBIDDEN_DELIVERY_COMMAND_FIELDS,
  deliveryCommandV1,
  isSupportedDeliveryCommandVersion,
  validateDeliveryCommand,
  type DeliveryCommandRejectionReason,
  type DeliveryCommandV1,
  type DeliveryCommandValidation,
} from './delivery-command';
import { PROVIDER_TYPE_VALUES, TRANSPORT_VALUES, type Transport } from './shared';
import { withPrototypeKeys } from './testing/prototype-pollution';

/** Envelope hợp lệ tối thiểu — mọi test âm bản sao từ đây rồi phá đúng một điểm. */
const VALID: DeliveryCommandV1 = {
  version: 1,
  delivery_id: 'dlv_123',
  notification_id: 'ntf_123',
  subscription_id: 'sub_123',
  provider_id: 'prv_123',
  transport: 'web',
  payload: { title: 'Tiêu đề', body: 'Nội dung' },
};

/** Field bắt buộc trừ `version` — `version` có cổng kiểm riêng (xem describe bên dưới). */
const REQUIRED_NON_VERSION_FIELDS = DELIVERY_COMMAND_FIELDS.filter((field) => field !== 'version');

/** Nhóm leak thật: tên field → giá trị không bao giờ được xuất hiện trong envelope. */
const REALISTIC_LEAKS: ReadonlyArray<readonly [string, string]> = [
  ['auth', 'dGVzdC1hdXRo'],
  ['p256dh', 'BNcRflwZu0Z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0'],
  ['vapid_private_key', '-----BEGIN PRIVATE KEY-----'],
  ['authorization', 'WebPush eyJ0eXAiOiJKV1QifQ'],
  ['secret', 'provider-shared-secret'],
];

/** Field có kiểu sai (giá trị không phải chuỗi không rỗng). */
const WRONG_TYPED_FIELDS: ReadonlyArray<readonly [string, unknown]> = [
  ['delivery_id', ''],
  ['notification_id', ''],
  ['subscription_id', ''],
  ['provider_id', ''],
  ['delivery_id', 1],
  ['notification_id', null],
  ['subscription_id', {}],
  ['provider_id', ['x']],
];

/**
 * Assert validation thất bại với `reason` và `detail` chứa `needle`.
 *
 * Gộp vào một hàm để không phải bọc `expect` trong nhánh `if (!result.ok)`
 * (`no-conditional-expect`); nhánh hợp lệ vẫn fail ngay với giá trị thật.
 */
function expectRejectedBy(
  result: DeliveryCommandValidation,
  reason: DeliveryCommandRejectionReason,
  needle: string,
): void {
  expect(result).toMatchObject({ ok: false, reason });
  if (result.ok) {
    throw new Error('Expected the envelope to be rejected, but it was accepted.');
  }
  expect(result.detail).toContain(needle);
}

/** Bóc envelope khi hợp lệ, ném lỗi khi bị từ chối. */
function unwrap(result: DeliveryCommandValidation): DeliveryCommandV1 {
  if (!result.ok) {
    throw new Error(`Expected a valid delivery command, got ${result.reason}: ${result.detail}`);
  }
  return result.command;
}

describe('validateDeliveryCommand — accept (FR-013)', () => {
  it('accepts a well-formed v1 envelope', () => {
    expect(unwrap(validateDeliveryCommand({ ...VALID }))).toEqual(VALID);
  });

  it('accepts an envelope produced by deliveryCommandV1', () => {
    const built = deliveryCommandV1({
      delivery_id: VALID.delivery_id,
      notification_id: VALID.notification_id,
      subscription_id: VALID.subscription_id,
      provider_id: VALID.provider_id,
      transport: 'web',
      payload: VALID.payload,
    });
    expect(validateDeliveryCommand(built).ok).toBe(true);
  });

  it('accepts every declared Transport value in the envelope field', () => {
    for (const transport of TRANSPORT_VALUES) {
      expect(validateDeliveryCommand({ ...VALID, transport }).ok).toBe(true);
    }
  });

  it('returns exactly the seven contract fields', () => {
    // So bằng membership chứ không sort: `unicorn/no-array-sort` cấm `sort()` còn
    // `lib` của tsconfig.base là es2022 nên không có `toSorted()`.
    const keys = Object.keys(unwrap(validateDeliveryCommand({ ...VALID })));
    expect(keys).toHaveLength(DELIVERY_COMMAND_FIELDS.length);
    for (const field of DELIVERY_COMMAND_FIELDS) {
      expect(keys).toContain(field);
    }
  });
});

describe('validateDeliveryCommand — version is a closed gate (FR-013)', () => {
  it('pins the accepted version to the constant', () => {
    expect(isSupportedDeliveryCommandVersion(DELIVERY_COMMAND_VERSION)).toBe(true);
    expect(DELIVERY_COMMAND_VERSION).toBe(1);
  });

  it('treats 1.0 as the supported version, per the wire-format limit', () => {
    // Sau JSON.parse, `1.0` và `1` là **cùng một số** IEEE 754, nên validator không thể
    // phân biệt chúng. FR-013 ghi rõ giới hạn này để không có test nào cố chứng minh điều
    // không thể đạt được.
    expect(Number.isInteger(1.0)).toBe(true);
    expect(isSupportedDeliveryCommandVersion(1.0)).toBe(true);
    expect(validateDeliveryCommand({ ...VALID, version: 1.0 })).toMatchObject({ ok: true });
  });

  it.each([
    ['a higher integer version', 2],
    ['zero', 0],
    ['a negative version', -1],
    ['a fractional version', 1.5],
    ['a string version', '1'],
    ['a prefixed string version', 'v1'],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s as the version', (_label, version) => {
    expect(validateDeliveryCommand({ ...VALID, version })).toMatchObject({
      ok: false,
      reason: 'unsupported_version',
    });
  });

  it('rejects an envelope with the version field removed', () => {
    const payload: Record<string, unknown> = { ...VALID };
    Reflect.deleteProperty(payload, 'version');
    expect(validateDeliveryCommand(payload)).toMatchObject({
      ok: false,
      reason: 'unsupported_version',
    });
  });

  it('reports unsupported_version before any other field problem', () => {
    // Version quyết định cách đọc mọi field còn lại, nên nó phải chặn trước cả field bị cấm.
    const result = validateDeliveryCommand({ ...VALID, version: 2, auth: 'secret' });
    expect(result).toMatchObject({ ok: false, reason: 'unsupported_version' });
  });
});

describe('validateDeliveryCommand — secrets and runtime material are rejected (FR-013, SR-002)', () => {
  it.each([...FORBIDDEN_DELIVERY_COMMAND_FIELDS])('rejects an envelope carrying %s', (field) => {
    const checked2 = validateDeliveryCommand({ ...VALID, [field]: 'x' });
    expect(checked2.ok).toBe(false);
    expectRejectedBy(checked2, 'forbidden_field', field);
  });

  it.each(REALISTIC_LEAKS)('rejects a realistic leak of %s', (field, value) => {
    expect(validateDeliveryCommand({ ...VALID, [field]: value })).toMatchObject({
      ok: false,
      reason: 'forbidden_field',
    });
  });

  it('rejects a forbidden field even when its value is null', () => {
    expect(validateDeliveryCommand({ ...VALID, auth: null })).toMatchObject({
      ok: false,
      reason: 'forbidden_field',
    });
  });

  it('reports forbidden_field before unexpected_field', () => {
    const result = validateDeliveryCommand({ ...VALID, auth: 'x', whatever: 1 });
    expect(result).toMatchObject({ ok: false, reason: 'forbidden_field' });
  });
});

describe('validateDeliveryCommand — unknown fields are rejected, not ignored', () => {
  it('rejects an envelope with a field outside the seven', () => {
    const checked1 = validateDeliveryCommand({ ...VALID, extra: 1 });
    expect(checked1.ok).toBe(false);
    expectRejectedBy(checked1, 'unexpected_field', 'extra');
  });

  it.each(['app', 'status', 'expires_at', 'payload_digest', 'lease_expires_at'] as const)(
    'rejects %s, which belongs to claim runtime material, not the envelope',
    (field) => {
      // Các field này hợp lệ trên claim 200, nhưng presence của chúng trên envelope
      // nghĩa là control plane đã nhầm hai contract với nhau.
      expect(validateDeliveryCommand({ ...VALID, [field]: 'x' }).ok).toBe(false);
    },
  );
});

describe('validateDeliveryCommand — required fields and types', () => {
  it.each(REQUIRED_NON_VERSION_FIELDS)('rejects an envelope missing %s', (field) => {
    const payload: Record<string, unknown> = { ...VALID };
    Reflect.deleteProperty(payload, field);
    const checked = validateDeliveryCommand(payload);
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'missing_field', field);
  });

  it.each(WRONG_TYPED_FIELDS)('rejects an invalid type for %s', (field, value) => {
    expect(validateDeliveryCommand({ ...VALID, [field]: value })).toMatchObject({
      ok: false,
      reason: 'invalid_field_type',
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'dlv_123'],
    ['a number', 1],
    ['an array', [{ ...VALID }]],
  ])('rejects %s as the whole envelope', (_label, payload) => {
    expect(validateDeliveryCommand(payload)).toMatchObject({
      ok: false,
      reason: 'invalid_payload',
    });
  });

  it.each([
    ['null', null],
    ['a string', 'title'],
    ['a number', 1],
    ['an array', []],
  ])('rejects %s as the payload', (_label, payload) => {
    expect(validateDeliveryCommand({ ...VALID, payload })).toMatchObject({
      ok: false,
      reason: 'invalid_field_type',
    });
  });
});

describe('validateDeliveryCommand — transport is Transport, not provider type (FR-013, §4.2)', () => {
  it.each([...PROVIDER_TYPE_VALUES])(
    'rejects provider type %s used as transport',
    (providerType) => {
      expect(validateDeliveryCommand({ ...VALID, transport: providerType })).toMatchObject({
        ok: false,
        reason: 'invalid_field_type',
      });
    },
  );

  it('does not let web-push stand in for web', () => {
    // Đây là mismatch gốc mà contract tồn tại để chặn: `web-push` là provider type.
    const result = validateDeliveryCommand({ ...VALID, transport: 'web-push' });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'invalid_field_type', 'transport');
  });

  it('accepts web as transport regardless of which provider type is in play', () => {
    expect(validateDeliveryCommand({ ...VALID, transport: 'web' }).ok).toBe(true);
  });

  it('keeps Transport and ProviderType disjoint', () => {
    for (const providerType of PROVIDER_TYPE_VALUES) {
      expect(TRANSPORT_VALUES).not.toContain(providerType);
    }
  });
});

describe('detail never leaks payload values', () => {
  it('names the offending field without echoing its value', () => {
    const result = validateDeliveryCommand({ ...VALID, auth: 'super-secret-auth-value' });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', 'auth');
    if (result.ok) {
      throw new Error('Expected the envelope to be rejected, but it was accepted.');
    }
    expect(result.detail).not.toContain('super-secret-auth-value');
  });

  it('does not echo payload content when the payload has the wrong shape', () => {
    const result = validateDeliveryCommand({ ...VALID, payload: 'private body text' });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'invalid_field_type', 'payload');
    if (result.ok) {
      throw new Error('Expected the envelope to be rejected, but it was accepted.');
    }
    expect(result.detail).not.toContain('private body text');
  });
});

// Khối 3b của validator — khoá **lồng** trong `payload`. Không đường nào đi qua được:
// envelope "hợp lệ" về hình dạng, secret nằm lồng bên trong vẫn phải bị báo đúng
// `forbidden_field` (cùng ngữ nghĩa với secret top-level), còn khoá lạ thuần tuý là
// `unexpected_field` và khoá thiếu là `missing_field` — ba lỗi phải tách nhau để metric
// phân biệt được leak, drift schema và cấu hình sai. `payload` phải được đóng bằng schema
// canonical FR-013 ngay trong envelope validator, không phải trông vào việc caller nhớ gọi
// thêm một hàm khác.
describe('payload is closed inside the envelope validator (FR-013, requirements §FR-013)', () => {
  it.each(REALISTIC_LEAKS)('rejects a secret nested in payload under key %s', (field, value) => {
    const result = validateDeliveryCommand({
      ...VALID,
      payload: { title: 'Tiêu đề', body: 'Nội dung', [field]: value },
    });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', 'payload');
    if (result.ok) {
      throw new Error('Expected the envelope to be rejected, but it was accepted.');
    }
    expect(result.detail).not.toContain(value);
  });

  it('rejects a payload key outside the canonical four keys even when it is not a known secret name', () => {
    const result = validateDeliveryCommand({
      ...VALID,
      payload: { title: 'Tiêu đề', body: 'Nội dung', anything_else: 1 },
    });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'unexpected_field', 'payload');
  });

  it('rejects a payload missing a required key', () => {
    const result = validateDeliveryCommand({ ...VALID, payload: { title: 'Tiêu đề' } });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'missing_field', 'payload');
  });

  it('rejects a payload whose data is an array', () => {
    const result = validateDeliveryCommand({
      ...VALID,
      payload: { title: 'Tiêu đề', body: 'Nội dung', data: [] },
    });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'invalid_field_type', 'payload');
  });

  it('accepts the canonical four-key payload, with optional url and data', () => {
    const result = validateDeliveryCommand({
      ...VALID,
      payload: {
        title: 'Tiêu đề',
        body: 'Nội dung',
        url: 'https://ecoma.io/orders/1',
        data: { order_id: '1' },
      },
    });
    expect(result.ok).toBe(true);
  });

  it('drops nothing from an accepted payload but returns the checked canonical shape', () => {
    // `url`/`data` vắng mặt phải **vắng** trong kết quả, không phải có mặt với `undefined`:
    // một field hiện diện nhưng rỗng là envelope khác với envelope không có field đó.
    const result = validateDeliveryCommand({ ...VALID, payload: { title: 't', body: 'b' } });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected the envelope to be accepted, but it was rejected.');
    }
    expect(Object.keys(result.command.payload)).toEqual(['title', 'body']);
    expect('url' in result.command.payload).toBe(false);
    expect('data' in result.command.payload).toBe(false);
  });
});

describe('deliveryCommandV1 returns only what validateDeliveryCommand accepts (A3)', () => {
  it('throws when the payload carries a forbidden key', () => {
    const leakyPayload = { title: 'T', body: 'B', auth: 'dGVzdC1hdXRo' };
    expect(() =>
      deliveryCommandV1({
        delivery_id: VALID.delivery_id,
        notification_id: VALID.notification_id,
        subscription_id: VALID.subscription_id,
        provider_id: VALID.provider_id,
        transport: 'web',
        payload: leakyPayload,
      }),
    ).toThrow(/forbidden_field/u);
  });

  it('throws when an id is empty instead of returning a rejected envelope', () => {
    expect(() =>
      deliveryCommandV1({
        delivery_id: '',
        notification_id: VALID.notification_id,
        subscription_id: VALID.subscription_id,
        provider_id: VALID.provider_id,
        transport: 'web',
        payload: VALID.payload,
      }),
    ).toThrow(/invalid_field_type/u);
  });

  it('throws when payload data is not JSON-compatible', () => {
    expect(() =>
      deliveryCommandV1({
        delivery_id: VALID.delivery_id,
        notification_id: VALID.notification_id,
        subscription_id: VALID.subscription_id,
        provider_id: VALID.provider_id,
        transport: 'web',
        payload: { title: 'T', body: 'B', data: { at: new Date(0) } },
      }),
    ).toThrow(/invalid_field_type/u);
  });

  it('throws when the transport is a provider type', () => {
    expect(() =>
      deliveryCommandV1({
        delivery_id: VALID.delivery_id,
        notification_id: VALID.notification_id,
        subscription_id: VALID.subscription_id,
        provider_id: VALID.provider_id,
        transport: 'web-push' as unknown as Transport,
        payload: VALID.payload,
      }),
    ).toThrow(/invalid_field_type/u);
  });

  it('returns an envelope that its own validator accepts', () => {
    const built = deliveryCommandV1({
      delivery_id: VALID.delivery_id,
      notification_id: VALID.notification_id,
      subscription_id: VALID.subscription_id,
      provider_id: VALID.provider_id,
      transport: 'web',
      payload: VALID.payload,
    });
    expect(validateDeliveryCommand(built)).toMatchObject({ ok: true });
  });

  it('detaches the payload from the builder input (A4)', () => {
    // Envelope là bất biến trong Queue: sửa object nguồn **sau** khi dựng không được đổi
    // envelope đã dựng. `data` lồng là chỗ dễ rò tham chiếu nhất, và `title` là scalar.
    const source = { title: 'T', body: 'B', data: { count: 1 } };
    const built = deliveryCommandV1({
      delivery_id: VALID.delivery_id,
      notification_id: VALID.notification_id,
      subscription_id: VALID.subscription_id,
      provider_id: VALID.provider_id,
      transport: 'web',
      payload: source,
    });
    source.title = 'CHANGED';
    source.data.count = 2;
    expect(built.payload.title).toBe('T');
    expect(built.payload.data).toEqual({ count: 1 });
  });
});

describe('envelope object shape policy (A1)', () => {
  it.each([
    ['a Date', new Date(0)],
    ['a Map', new Map<string, string>()],
    ['a Set', new Set<string>()],
  ] as const)('rejects an envelope that is %s', (_label, value) => {
    const checked = validateDeliveryCommand(value);
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_payload', 'object JSON');
  });

  it('rejects a class instance envelope', () => {
    class FakeEnvelope {
      version = 1;
    }
    const checked = validateDeliveryCommand(new FakeEnvelope());
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_payload', 'object JSON');
  });

  it('rejects an envelope created over a custom prototype — inherited keys are not JSON own keys', () => {
    const checked = validateDeliveryCommand(Object.create(VALID));
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_payload', 'object JSON');
  });

  it('rejects a getter on an allowed envelope key without invoking it', () => {
    let invoked = 0;
    const record: Record<string, unknown> = { ...VALID };
    Object.defineProperty(record, 'provider_id', {
      get() {
        invoked += 1;
        return 'prv_123';
      },
      enumerable: true,
      configurable: true,
    });
    expectRejectedBy(validateDeliveryCommand(record), 'invalid_payload', 'getter');
    expect(invoked).toBe(0);
  });

  it('rejects a getter on `version` without invoking it', () => {
    // `version` là field **duy nhất** phải được đọc trước bước quét descriptor (nó quyết định
    // cách đọc mọi field còn lại), nên nó là chỗ một phép đọc thẳng sẽ kích hoạt getter của
    // caller — getter ném lỗi thì exception sẽ thoát ra ngoài boundary thay vì thành từ chối.
    let invoked = 0;
    const record: Record<string, unknown> = { ...VALID };
    Object.defineProperty(record, 'version', {
      get() {
        invoked += 1;
        return DELIVERY_COMMAND_VERSION;
      },
      enumerable: true,
      configurable: true,
    });
    expectRejectedBy(validateDeliveryCommand(record), 'invalid_payload', 'getter');
    expect(invoked).toBe(0);
  });

  it('rejects a getter on `payload` without invoking it', () => {
    // `payload` được đọc trước bước quét bởi nhánh chặn secret **lồng** trong nó, nên nó cũng
    // là một chỗ đọc-sớm: accessor ở đây không được kích hoạt và vẫn phải bị phân loại là
    // `invalid_payload` (không phải `missing_field` hay lỗi kiểu).
    let invoked = 0;
    const record: Record<string, unknown> = { ...VALID };
    Object.defineProperty(record, 'payload', {
      get() {
        invoked += 1;
        return { title: 'T', body: 'B' };
      },
      enumerable: true,
      configurable: true,
    });
    expectRejectedBy(validateDeliveryCommand(record), 'invalid_payload', 'getter');
    expect(invoked).toBe(0);
  });

  it('never lets a throwing getter escape as an exception', () => {
    // Boundary của Queue chỉ được trả về discriminated union: một getter ném lỗi mà làm
    // validator ném lỗi theo là mất khả năng phân loại lỗi ở consumer.
    const record: Record<string, unknown> = { ...VALID };
    Object.defineProperty(record, 'payload', {
      get() {
        throw new Error('getter was triggered');
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => validateDeliveryCommand(record)).not.toThrow();
    const checked = validateDeliveryCommand(record);
    expect(checked.ok).toBe(false);
    expectRejectedBy(checked, 'invalid_payload', 'getter');
  });

  it('rejects a non-enumerable envelope field — JSON.stringify would drop it silently', () => {
    const record: Record<string, unknown> = { ...VALID };
    Object.defineProperty(record, 'notification_id', {
      value: 'ntf_123',
      enumerable: false,
      writable: true,
      configurable: true,
    });
    const nonEnumerableChecked = validateDeliveryCommand(record);
    expect(nonEnumerableChecked.ok).toBe(false);
    expectRejectedBy(nonEnumerableChecked, 'invalid_payload', 'non-enumerable');
  });

  it('rejects a symbol key on the envelope — symbols are not JSON keys', () => {
    const record: Record<string | symbol, unknown> = { ...VALID };
    record[Symbol('extra')] = 1;
    const symbolChecked = validateDeliveryCommand(record);
    expect(symbolChecked.ok).toBe(false);
    expectRejectedBy(symbolChecked, 'invalid_payload', 'symbol');
  });

  it('treats Object.prototype keys as not present (own keys only)', () => {
    // `payload` (bắt buộc) và `transport` (bắt buộc, sai kiểu): giá trị độc để một định nghĩa
    // "có mặt" bằng `in` sẽ vừa lọt qua closed schema vừa kéo giá trị từ prototype.
    withPrototypeKeys({ payload: 'polluted', transport: 0 }, () => {
      const { payload: _dropped, ...withoutPayload } = VALID;
      const checked = validateDeliveryCommand(withoutPayload);
      expect(checked.ok).toBe(false);
      expectRejectedBy(checked, 'missing_field', 'payload');
    });
  });
});

describe('detail strings are safe to log (C1)', () => {
  it('sanitizes control characters out of an envelope field name', () => {
    const checked = validateDeliveryCommand({ ...VALID, ['evil\nInjected: yes']: 1 });
    expectRejectedBy(checked, 'unexpected_field', 'Envelope');
    if (checked.ok) {
      throw new Error('Expected the envelope to be rejected, but it was accepted.');
    }
    expect(checked.detail).not.toContain('\n');
    expect(checked.detail).toContain('evil?Injected');
  });

  it('sanitizes control characters out of a nested payload field name', () => {
    const checked = validateDeliveryCommand({
      ...VALID,
      payload: { title: 'T', body: 'B', ['bad\nkey']: 1 },
    });
    expectRejectedBy(checked, 'unexpected_field', 'payload');
    if (checked.ok) {
      throw new Error('Expected the envelope to be rejected, but it was accepted.');
    }
    expect(checked.detail).not.toContain('\n');
    expect(checked.detail).toContain('bad?key');
  });

  it('caps a huge field name instead of echoing it whole', () => {
    const huge = 'k'.repeat(10_000);
    const checked = validateDeliveryCommand({ ...VALID, [huge]: 1 });
    expectRejectedBy(checked, 'unexpected_field', 'Envelope');
    if (checked.ok) {
      throw new Error('Expected the envelope to be rejected, but it was accepted.');
    }
    expect(checked.detail).not.toContain('k'.repeat(300));
    expect(checked.detail.length).toBeLessThan(400);
  });

  it('never echoes a forbidden value into detail', () => {
    const secret = 'fake-secret-test-value';
    const checked = validateDeliveryCommand({ ...VALID, credential: secret });
    expectRejectedBy(checked, 'forbidden_field', 'credential');
    if (checked.ok) {
      throw new Error('Expected the envelope to be rejected, but it was accepted.');
    }
    expect(checked.detail).not.toContain(secret);
  });

  it('never echoes a secret nested in payload into detail', () => {
    const secret = 'fake-auth-secret';
    const checked = validateDeliveryCommand({
      ...VALID,
      payload: { title: 'T', body: 'B', credential: secret },
    });
    expectRejectedBy(checked, 'forbidden_field', 'payload');
    if (checked.ok) {
      throw new Error('Expected the envelope to be rejected, but it was accepted.');
    }
    expect(checked.detail).not.toContain(secret);
  });
});
