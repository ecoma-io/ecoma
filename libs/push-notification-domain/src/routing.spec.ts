import { describe, expect, it } from 'vitest';

import {
  deriveTransportPriorityOrder,
  selectSubscriptionsForDevice,
  TRANSPORT_PRIORITY_ORDER,
  type RoutingSubscriptionFact,
} from './routing';
import { TRANSPORT } from './shared';
import { SUBSCRIPTION_STATUS } from './subscription';

const APP = 'app-a';

function subscription(overrides: Partial<RoutingSubscriptionFact> = {}): RoutingSubscriptionFact {
  return {
    subscriptionId: 'sub-1',
    app: APP,
    deviceId: 'dev-1',
    transport: TRANSPORT.Web,
    status: SUBSCRIPTION_STATUS.Active,
    ...overrides,
  };
}

describe('transport priority order', () => {
  it('puts app ahead of web', () => {
    expect(TRANSPORT_PRIORITY_ORDER).toStrictEqual([TRANSPORT.App, TRANSPORT.Web]);
  });

  it('ranks every transport in the vocabulary exactly once', () => {
    // So với `Object.values(TRANSPORT)` chứ không với một con số viết tay: thêm một
    // transport vào vocabulary mà thứ tự ưu tiên bỏ sót nó là test phải đỏ.
    expect(new Set(TRANSPORT_PRIORITY_ORDER)).toStrictEqual(new Set(Object.values(TRANSPORT)));
    expect(TRANSPORT_PRIORITY_ORDER).toHaveLength(Object.values(TRANSPORT).length);
  });
});

describe('priority derivation survives adversarial rank maps', () => {
  it('sorts by rank regardless of the order ranks are declared in', () => {
    expect(deriveTransportPriorityOrder({ [TRANSPORT.Web]: 0, [TRANSPORT.App]: 1 })).toStrictEqual([
      TRANSPORT.Web,
      TRANSPORT.App,
    ]);
    expect(deriveTransportPriorityOrder({ [TRANSPORT.App]: 1, [TRANSPORT.Web]: 0 })).toStrictEqual([
      TRANSPORT.Web,
      TRANSPORT.App,
    ]);
  });

  it('keeps every transport when two ranks collide', () => {
    // Hạng trùng làm cách ghi theo index (`order[rank] = transport`) xoá mất một
    // transport khỏi thứ tự; subscription thuộc transport đó vĩnh viễn không thắng.
    const order = deriveTransportPriorityOrder({ [TRANSPORT.Web]: 0, [TRANSPORT.App]: 0 });
    expect(new Set(order)).toStrictEqual(new Set(Object.values(TRANSPORT)));
    expect(order).toHaveLength(2);
  });

  it('leaves no hole when ranks are not contiguous', () => {
    // Hạng cách quãng để lại lỗ `undefined` nếu ghi theo index.
    expect(deriveTransportPriorityOrder({ [TRANSPORT.Web]: 0, [TRANSPORT.App]: 5 })).toStrictEqual([
      TRANSPORT.Web,
      TRANSPORT.App,
    ]);
    expect(deriveTransportPriorityOrder({ [TRANSPORT.App]: 5, [TRANSPORT.Web]: 0 })).toStrictEqual([
      TRANSPORT.Web,
      TRANSPORT.App,
    ]);
  });
});

describe('device-scoped transport priority', () => {
  it('prefers the app subscription when both transports are active in one device', () => {
    const result = selectSubscriptionsForDevice(APP, 'dev-1', [
      subscription({ subscriptionId: 'sub-web', transport: TRANSPORT.Web }),
      subscription({ subscriptionId: 'sub-app', transport: TRANSPORT.App }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subscriptions.map((s) => s.subscriptionId)).toStrictEqual(['sub-app']);
  });

  it('falls back to web when there is no app subscription', () => {
    const result = selectSubscriptionsForDevice(APP, 'dev-1', [
      subscription({ subscriptionId: 'sub-web', transport: TRANSPORT.Web }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subscriptions.map((s) => s.subscriptionId)).toStrictEqual(['sub-web']);
  });

  it('falls back to web when the app subscription is not active', () => {
    const result = selectSubscriptionsForDevice(APP, 'dev-1', [
      subscription({
        subscriptionId: 'sub-app',
        transport: TRANSPORT.App,
        status: SUBSCRIPTION_STATUS.Disabled,
      }),
      subscription({ subscriptionId: 'sub-web', transport: TRANSPORT.Web }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subscriptions.map((s) => s.subscriptionId)).toStrictEqual(['sub-web']);
  });

  it('returns every active subscription of the winning transport as a set', () => {
    const result = selectSubscriptionsForDevice(APP, 'dev-1', [
      subscription({ subscriptionId: 'sub-app-1', transport: TRANSPORT.App }),
      subscription({ subscriptionId: 'sub-app-2', transport: TRANSPORT.App }),
      subscription({ subscriptionId: 'sub-web', transport: TRANSPORT.Web }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subscriptions.map((s) => s.subscriptionId)).toStrictEqual([
      'sub-app-1',
      'sub-app-2',
    ]);
  });

  it('never returns an inactive subscription from the winning transport', () => {
    const result = selectSubscriptionsForDevice(APP, 'dev-1', [
      subscription({
        subscriptionId: 'sub-app',
        transport: TRANSPORT.App,
        status: SUBSCRIPTION_STATUS.Expired,
      }),
      subscription({ subscriptionId: 'sub-web', transport: TRANSPORT.Web }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subscriptions.every((s) => s.status === SUBSCRIPTION_STATUS.Active)).toBe(true);
    expect(result.subscriptions.map((s) => s.subscriptionId)).toStrictEqual(['sub-web']);
  });
});

describe('priority never crosses device boundaries', () => {
  it('returns only subscriptions of the requested device', () => {
    const result = selectSubscriptionsForDevice(APP, 'dev-1', [
      subscription({ subscriptionId: 'sub-1', deviceId: 'dev-1', transport: TRANSPORT.Web }),
      subscription({
        subscriptionId: 'sub-2',
        deviceId: 'dev-2',
        transport: TRANSPORT.App,
      }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subscriptions.map((s) => s.subscriptionId)).toStrictEqual(['sub-1']);
  });

  it('produces independent selections for two devices that share a user context', () => {
    const subscriptions: readonly RoutingSubscriptionFact[] = [
      subscription({ subscriptionId: 'sub-a1', deviceId: 'dev-a', transport: TRANSPORT.App }),
      subscription({ subscriptionId: 'sub-b1', deviceId: 'dev-b', transport: TRANSPORT.Web }),
    ];
    const deviceA = selectSubscriptionsForDevice(APP, 'dev-a', subscriptions);
    const deviceB = selectSubscriptionsForDevice(APP, 'dev-b', subscriptions);
    expect(deviceA.ok).toBe(true);
    expect(deviceB.ok).toBe(true);
    if (!deviceA.ok || !deviceB.ok) return;
    expect(deviceA.subscriptions.map((s) => s.subscriptionId)).toStrictEqual(['sub-a1']);
    expect(deviceB.subscriptions.map((s) => s.subscriptionId)).toStrictEqual(['sub-b1']);
  });

  it('does not let a high-priority subscription on one device win another device', () => {
    const subscriptions: readonly RoutingSubscriptionFact[] = [
      subscription({ subscriptionId: 'sub-app', deviceId: 'dev-1', transport: TRANSPORT.App }),
      subscription({ subscriptionId: 'sub-web', deviceId: 'dev-2', transport: TRANSPORT.Web }),
    ];
    const result = selectSubscriptionsForDevice(APP, 'dev-2', subscriptions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subscriptions.map((s) => s.subscriptionId)).toStrictEqual(['sub-web']);
  });
});

describe('priority never crosses App boundaries', () => {
  it('never returns a subscription belonging to another App', () => {
    const result = selectSubscriptionsForDevice(APP, 'dev-1', [
      subscription({ subscriptionId: 'sub-other', app: 'app-b', transport: TRANSPORT.App }),
      subscription({ subscriptionId: 'sub-mine', app: APP, transport: TRANSPORT.Web }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subscriptions.map((s) => s.subscriptionId)).toStrictEqual(['sub-mine']);
  });

  it('ignores a higher-priority transport that belongs to another App', () => {
    const result = selectSubscriptionsForDevice(APP, 'dev-1', [
      subscription({ subscriptionId: 'sub-other-app', app: 'app-b', transport: TRANSPORT.App }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_eligible_subscription');
  });

  it('treats the same device in two Apps as two independent selections', () => {
    const subscriptions: readonly RoutingSubscriptionFact[] = [
      subscription({ subscriptionId: 'sub-a', app: 'app-a', transport: TRANSPORT.App }),
      subscription({ subscriptionId: 'sub-b', app: 'app-b', transport: TRANSPORT.Web }),
    ];
    const forA = selectSubscriptionsForDevice('app-a', 'dev-1', subscriptions);
    const forB = selectSubscriptionsForDevice('app-b', 'dev-1', subscriptions);
    expect(forA.ok).toBe(true);
    expect(forB.ok).toBe(true);
    if (!forA.ok || !forB.ok) return;
    expect(forA.subscriptions.map((s) => s.subscriptionId)).toStrictEqual(['sub-a']);
    expect(forB.subscriptions.map((s) => s.subscriptionId)).toStrictEqual(['sub-b']);
  });

  it('rejects a blank app', () => {
    const result = selectSubscriptionsForDevice('   ', 'dev-1', [subscription()]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Lỗi **tham số caller** (scope không xác định), không phải subscription dị dạng.
    expect(result.reason).toBe('malformed_selector');
  });

  it('rejects a blank deviceId', () => {
    const result = selectSubscriptionsForDevice(APP, '', [subscription()]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_selector');
  });

  // Collection subscription không đọc được là dữ liệu (row DB/input ngoài) sai shape,
  // không phải lỗi cấu hình của caller — nên phải rơi vào `malformed_subscription` và
  // tuyệt đối không ném TypeError ra khỏi domain.
  it('reports malformed_subscription instead of throwing when the collection is unreadable', () => {
    for (const subscriptions of [null, undefined, {}, 'sub']) {
      const result = selectSubscriptionsForDevice(APP, 'dev-1', subscriptions as never);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('malformed_subscription');
    }
  });

  it('drops a subscription carrying a blank app instead of treating it as unscoped', () => {
    const result = selectSubscriptionsForDevice(APP, 'dev-1', [
      subscription({ subscriptionId: 'sub-blank-app', app: '' }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_eligible_subscription');
  });

  // Record thuộc **đúng** `(app, deviceId)` mà sai shape phải được báo là dữ liệu
  // hỏng. Nếu nó bị lọc im lặng thì kết quả là `no_eligible_subscription` — người vận
  // hành đi tìm một device không có subscription, trong khi sự thật là có subscription
  // hỏng: hai lỗi khác nhau, hai cách sửa khác nhau (§6: malformed input không được
  // âm thầm biến thành "không tìm thấy").
  it('reports an in-scope malformed subscription instead of no_eligible_subscription', () => {
    const cases: Partial<RoutingSubscriptionFact>[] = [
      { subscriptionId: '' },
      { subscriptionId: '   ' },
      { transport: 'carrier-pigeon' as never },
      { status: 'ACTIVE' as never },
      { status: undefined as never },
      { transport: undefined as never },
    ];
    for (const overrides of cases) {
      const result = selectSubscriptionsForDevice(APP, 'dev-1', [subscription(overrides)]);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('malformed_subscription');
    }
  });

  // Phần tử không phải record thì **không xác định được** nó thuộc scope nào, nên bỏ qua
  // im lặng là fail-open: `filter` trước đây đọc `.app` trên `null` và ném TypeError ra
  // khỏi domain. Phải trả về rejection.
  it('reports a non-record element instead of throwing or skipping it', () => {
    for (const element of [null, undefined, 'sub-1', 7, true]) {
      const result = selectSubscriptionsForDevice(APP, 'dev-1', [
        element as unknown as RoutingSubscriptionFact,
      ]);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('malformed_subscription');
    }
  });

  // Dị dạng **ngoài** scope thì thuộc quyết định khác — caller chỉ hỏi về một device,
  // nên bỏ qua một cách im lặng là đúng; đây là phía còn lại của ranh giới fail-safe.
  it('still ignores an out-of-scope record that is itself malformed', () => {
    const result = selectSubscriptionsForDevice(APP, 'dev-1', [
      subscription({ subscriptionId: 'other-device', deviceId: 'dev-2', transport: 'x' as never }),
      subscription(),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subscriptions.map((s) => s.subscriptionId)).toStrictEqual(['sub-1']);
  });
});
