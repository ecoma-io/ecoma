import { describe, expect, it } from 'vitest';

import {
  DELIVERY_STATUS_VALUES,
  NON_TERMINAL_DELIVERY_STATUS_VALUES,
  PROVIDER_TYPE_VALUES,
  SUBSCRIPTION_STATUS_VALUES,
  TERMINAL_DELIVERY_STATUS_VALUES,
  TRANSPORT_VALUES,
  V1_EXECUTABLE_PROVIDER_TYPE,
  V1_EXECUTABLE_TRANSPORT,
  isDeliveryStatus,
  isNonEmptyString,
  isNonTerminalDeliveryStatus,
  isPlainObject,
  isPositiveInteger,
  isProviderType,
  isRfc3339Timestamp,
  isSubscriptionStatus,
  isTerminalDeliveryStatus,
  isTransport,
  validateV1ExecutionMaterialScope,
  validateV1ExecutionTransport,
  type DeliveryStatus,
} from './shared';

describe('Transport and ProviderType are disjoint unions', () => {
  it('accepts every declared Transport', () => {
    for (const transport of TRANSPORT_VALUES) {
      expect(isTransport(transport)).toBe(true);
    }
  });

  it('rejects provider types and junk as Transport', () => {
    for (const providerType of PROVIDER_TYPE_VALUES) {
      expect(isTransport(providerType)).toBe(false);
    }
    expect(isTransport('web push')).toBe(false);
    expect(isTransport('')).toBe(false);
    expect(isTransport(null)).toBe(false);
    expect(isTransport(undefined)).toBe(false);
    expect(isTransport(1)).toBe(false);
  });

  it('accepts every declared ProviderType', () => {
    for (const providerType of PROVIDER_TYPE_VALUES) {
      expect(isProviderType(providerType)).toBe(true);
    }
  });

  it('rejects transports and junk as ProviderType', () => {
    for (const transport of TRANSPORT_VALUES) {
      expect(isProviderType(transport)).toBe(false);
    }
    expect(isProviderType('web-push ')).toBe(false);
    expect(isProviderType(null)).toBe(false);
  });

  it('declares v1 executable values that are members of their own unions', () => {
    expect(isTransport(V1_EXECUTABLE_TRANSPORT)).toBe(true);
    expect(isProviderType(V1_EXECUTABLE_PROVIDER_TYPE)).toBe(true);
    // `web-push` là provider type — không bao giờ được gán vào một `Transport`.
    expect(isTransport(V1_EXECUTABLE_PROVIDER_TYPE)).toBe(false);
  });
});

describe('delivery state guards (FR-015)', () => {
  it('accepts every declared delivery state', () => {
    for (const status of DELIVERY_STATUS_VALUES) {
      expect(isDeliveryStatus(status)).toBe(true);
    }
  });

  it('accepts exactly the four terminal states', () => {
    expect(TERMINAL_DELIVERY_STATUS_VALUES).toEqual([
      'delivered',
      'failed',
      'expired',
      'cancelled',
    ]);
    for (const status of TERMINAL_DELIVERY_STATUS_VALUES) {
      expect(isTerminalDeliveryStatus(status)).toBe(true);
      expect(isDeliveryStatus(status)).toBe(true);
    }
  });

  it('rejects non-terminal states as terminal', () => {
    for (const status of ['pending', 'queued', 'processing'] as const) {
      expect(isDeliveryStatus(status)).toBe(true);
      expect(isTerminalDeliveryStatus(status)).toBe(false);
    }
  });

  it('rejects junk', () => {
    expect(isDeliveryStatus('succeeded')).toBe(false);
    expect(isDeliveryStatus(null)).toBe(false);
    expect(isTerminalDeliveryStatus('queued')).toBe(false);
    expect(isTerminalDeliveryStatus(null)).toBe(false);
  });

  it('accepts exactly the three non-terminal states', () => {
    // `isNonTerminalDeliveryStatus` đảo ngược kiểm tra terminal **trên tập cha**, nên
    // hai guard không thể trôi lệch: một state mới thêm vào `DELIVERY_STATUS_VALUES` mà
    // quên cập nhật terminal thì guard này vẫn tự đúng theo nghĩa của nó.
    expect(NON_TERMINAL_DELIVERY_STATUS_VALUES).toEqual(['pending', 'queued', 'processing']);
    for (const status of NON_TERMINAL_DELIVERY_STATUS_VALUES) {
      expect(isNonTerminalDeliveryStatus(status)).toBe(true);
      expect(isTerminalDeliveryStatus(status)).toBe(false);
    }
  });

  it('partitions the delivery vocabulary with the terminal guard', () => {
    for (const status of DELIVERY_STATUS_VALUES) {
      // Hai guard phải loại trừ nhau trên **mọi** giá trị: cả hai cùng true hoặc cùng
      // false đều là drift giữa terminal set và non-terminal set.
      expect(isNonTerminalDeliveryStatus(status)).toBe(!isTerminalDeliveryStatus(status));
    }
    const union = [...TERMINAL_DELIVERY_STATUS_VALUES, ...NON_TERMINAL_DELIVERY_STATUS_VALUES];
    expect(new Set(union)).toStrictEqual(new Set(DELIVERY_STATUS_VALUES));
  });

  it('rejects junk and terminal states as non-terminal', () => {
    for (const value of ['succeeded', '', null, undefined, 1, 'PENDING'] as const) {
      expect(isNonTerminalDeliveryStatus(value)).toBe(false);
    }
    for (const status of TERMINAL_DELIVERY_STATUS_VALUES) {
      expect(isNonTerminalDeliveryStatus(status)).toBe(false);
    }
  });
});

describe('subscription state guards (FR-004)', () => {
  it('declares exactly the three lifecycle states', () => {
    expect(SUBSCRIPTION_STATUS_VALUES).toEqual(['active', 'disabled', 'expired']);
    for (const status of SUBSCRIPTION_STATUS_VALUES) {
      expect(isSubscriptionStatus(status)).toBe(true);
    }
  });

  it('rejects the invented "invalidated" value', () => {
    // `invalidated` từng bị dùng lẫn cho ack của `invalidate`; lifecycle FR-004 không có nó,
    // nên nếu nó lọt vào cột `status` thì subscription có state thứ tư ngoài contract.
    expect(isSubscriptionStatus('invalidated')).toBe(false);
    expect(SUBSCRIPTION_STATUS_VALUES).not.toContain('invalidated');
  });

  it('rejects delivery-only states and junk', () => {
    // `expired` có mặt ở *cả* hai vocabulary (delivery state và subscription state) nên không
    // nằm trong danh sách này — chỉ các state thuần delivery mới phải bị từ chối.
    for (const status of [
      'pending',
      'queued',
      'processing',
      'delivered',
      'failed',
      'cancelled',
    ] as const) {
      expect(DELIVERY_STATUS_VALUES).toContain(status);
      expect(isSubscriptionStatus(status)).toBe(false);
    }
    expect(isSubscriptionStatus('expired')).toBe(true);
    expect(isSubscriptionStatus('enabled')).toBe(false);
    expect(isSubscriptionStatus(null)).toBe(false);
  });
});

describe('primitive guards', () => {
  it('isPlainObject accepts only non-array, non-null objects', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject('x')).toBe(false);
  });

  it('isNonEmptyString rejects empty strings and non-strings', () => {
    expect(isNonEmptyString('x')).toBe(true);
    expect(isNonEmptyString('')).toBe(false);
    expect(isNonEmptyString(' ')).toBe(true);
    expect(isNonEmptyString(1)).toBe(false);
  });

  it.each([
    ['one', 1, true],
    ['a large safe integer', Number.MAX_SAFE_INTEGER, true],
    ['zero', 0, false],
    ['a negative value', -1, false],
    ['a fraction', 1.5, false],
    ['NaN', Number.NaN, false],
    ['Infinity', Number.POSITIVE_INFINITY, false],
    ['beyond MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 2, false],
  ] as const)('isPositiveInteger(%o) === %s', (_label, value, expected) => {
    expect(isPositiveInteger(value)).toBe(expected);
  });

  it('isPositiveInteger rejects non-numbers', () => {
    expect(isPositiveInteger('1')).toBe(false);
    expect(isPositiveInteger(null)).toBe(false);
    expect(isPositiveInteger(undefined)).toBe(false);
  });
});

describe('isRfc3339Timestamp', () => {
  it.each([
    ['UTC', '2026-01-01T00:00:00Z'],
    ['an offset', '2026-01-01T07:00:00+07:00'],
    ['fractional seconds', '2026-01-01T00:00:00.123Z'],
    ['a negative offset', '2026-01-01T00:00:00-05:30'],
  ])('accepts %s', (_label, value) => {
    expect(isRfc3339Timestamp(value)).toBe(true);
  });

  it.each([
    ['a bare date', '2026-01-01'],
    ['a space separator', '2026-01-01 00:00:00Z'],
    ['a missing zone', '2026-01-01T00:00:00'],
    ['an engine-accepted oddity', '1'],
    ['an impossible month', '2026-13-01T00:00:00Z'],
    ['an empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(isRfc3339Timestamp(value)).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isRfc3339Timestamp(null)).toBe(false);
    expect(isRfc3339Timestamp(1_700_000_000_000)).toBe(false);
  });

  // `Date.parse` KHÔNG từ chối ngày không tồn tại — nó chuẩn hoá sang tháng sau
  // (`2026-02-30` → 2/3) và nhận `24:00:00` như nửa đêm hôm sau. Nếu validator chỉ
  // dựa vào `Date.parse`, mọi giá trị dưới đây sẽ lọt qua.
  it.each([
    ['February 30th', '2026-02-30T00:00:00Z'],
    ['April 31st', '2026-04-31T00:00:00Z'],
    ['November 31st', '2026-11-31T00:00:00Z'],
    ['February 29th in a non-leap year', '2026-02-29T00:00:00Z'],
    ['hour 24', '2026-01-01T24:00:00Z'],
    ['day zero', '2026-01-00T00:00:00Z'],
    ['minute 60', '2026-01-01T00:60:00Z'],
    ['second 60 (leap second is not RFC3339-valid here)', '2026-01-01T23:59:60Z'],
    ['a non-existent offset hour', '2026-01-01T00:00:00+99:00'],
    ['a non-existent offset minute', '2026-01-01T00:00:00+07:99'],
  ])('rejects the impossible instant %s', (_label, value) => {
    expect(isRfc3339Timestamp(value)).toBe(false);
  });

  it('still accepts a real leap day, so the calendar check is not over-strict', () => {
    expect(isRfc3339Timestamp('2028-02-29T00:00:00Z')).toBe(true);
    expect(isRfc3339Timestamp('2026-01-31T23:59:59Z')).toBe(true);
  });
});

describe('isPlainObject — prototype policy (A1)', () => {
  it('rejects objects whose prototype is neither Object.prototype nor null', () => {
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject(new Map())).toBe(false);
    expect(isPlainObject(new Set())).toBe(false);
    class Custom {
      readonly tag = 'custom';
    }
    expect(isPlainObject(new Custom())).toBe(false);
    expect(isPlainObject(Object.create({ inherited: 1 }))).toBe(false);
  });

  it('accepts null-prototype objects — JSON data without Object.prototype', () => {
    expect(isPlainObject(Object.create(null))).toBe(true);
  });
});

describe('V1 execution-scope guards — schema admits the vocabulary, guards gate the worker', () => {
  it('accepts transport web as the only executable transport', () => {
    expect(validateV1ExecutionTransport('web')).toEqual({ ok: true });
  });

  it.each(['app', 'web-push', 'fcm', 'apns', 'WEB'] as const)(
    'rejects transport %s — outside the v1 execution scope',
    (transport) => {
      const checked = validateV1ExecutionTransport(transport);
      expect(checked).toMatchObject({ ok: false, reason: 'unsupported_transport' });
      if (checked.ok) {
        throw new Error('Expected the transport to be rejected, but it was accepted.');
      }
      // Detail là chuỗi hằng — không bao giờ nối giá trị caller gửi vào.
      expect(checked.detail).not.toContain(transport);
      expect(checked.detail).not.toContain('\n');
    },
  );

  it('accepts the only executable material pair (web, web-push)', () => {
    expect(
      validateV1ExecutionMaterialScope({ transport: 'web', provider_type: 'web-push' }),
    ).toEqual({ ok: true });
  });

  it.each([
    ['web', 'fcm'],
    ['web', 'apns'],
  ] as const)(
    'rejects provider type %s under transport web — not executable by the web-push worker',
    (transport, provider_type) => {
      const checked = validateV1ExecutionMaterialScope({ transport, provider_type });
      expect(checked).toMatchObject({ ok: false, reason: 'unsupported_provider_type' });
      if (checked.ok) {
        throw new Error('Expected the material scope to be rejected, but it was accepted.');
      }
      expect(checked.detail).not.toContain(provider_type);
    },
  );

  it.each([
    ['app', 'web-push'],
    ['app', 'fcm'],
    ['app', 'apns'],
  ] as const)(
    'rejects transport %s before reading provider.type — transport check comes first',
    (transport, provider_type) => {
      const checked = validateV1ExecutionMaterialScope({ transport, provider_type });
      expect(checked).toMatchObject({ ok: false, reason: 'unsupported_transport' });
    },
  );

  it('never echoes caller values in guard details, even hostile ones', () => {
    const junk = 'evil\n{"injected": true}';
    const transportChecked = validateV1ExecutionTransport(junk);
    const materialChecked = validateV1ExecutionMaterialScope({
      transport: junk,
      provider_type: junk,
    });
    for (const checked of [transportChecked, materialChecked]) {
      if (checked.ok) {
        throw new Error('Expected the guard to reject, but it accepted.');
      }
      expect(checked.detail).not.toContain('\n');
      expect(checked.detail).not.toContain('evil');
      expect(checked.detail).not.toContain('injected');
    }
  });
});

describe('compile-time vocabulary bindings (enforced by nx typecheck)', () => {
  it('keeps TERMINAL_DELIVERY_STATUS_VALUES inside DELIVERY_STATUS_VALUES', () => {
    // Gán biến kiểu — trần compile ngay lập tức nếu tập terminal lệch ra ngoài tập
    // delivery; `satisfies` trong shared.ts tự nó không đi qua public type của consumer.
    const terminalSubset: readonly DeliveryStatus[] = TERMINAL_DELIVERY_STATUS_VALUES;
    expect(terminalSubset.length).toBeGreaterThan(0);
    for (const status of terminalSubset) {
      expect(isDeliveryStatus(status)).toBe(true);
    }
    expect(DELIVERY_STATUS_VALUES).not.toEqual(terminalSubset);
  });
});
