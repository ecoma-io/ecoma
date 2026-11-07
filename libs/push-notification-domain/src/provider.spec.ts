import { describe, expect, it } from 'vitest';

import {
  canRetireEncryptionKey,
  evaluateProviderRoutingEligibility,
  isProviderStatus,
  isProviderType,
  PROVIDER_STATUS,
  PROVIDER_STATUS_VALUES,
  PROVIDER_TYPE,
  PROVIDER_TYPE_VALUES,
  resolveSubscriptionSigningKeyId,
  selectPrimaryProvider,
  V1_EXECUTABLE_PROVIDER_TYPE,
  V1_EXECUTABLE_TRANSPORT,
  type AppVapidKeyRef,
  type ProviderRoutingFact,
  type ProviderStatus,
  type ProviderType,
} from './provider';
import { TRANSPORT, TRANSPORT_VALUES } from './shared';

const APP = 'app-a';

/** Một key pair VAPID mà `app` đang phục vụ (chỉ định danh, không secret). */
function key(app: string, vapidKeyId: string): AppVapidKeyRef {
  return { app, vapidKeyId };
}

function provider(overrides: Partial<ProviderRoutingFact> = {}): ProviderRoutingFact {
  return {
    providerId: 'prov-1',
    app: 'app-a',
    transport: TRANSPORT.Web,
    type: PROVIDER_TYPE.WebPush,
    status: PROVIDER_STATUS.Enabled,
    emergencyHold: false,
    ...overrides,
  };
}

describe('ProviderType is a vocabulary separate from Transport', () => {
  it('declares web-push, fcm, apns', () => {
    expect(PROVIDER_TYPE_VALUES).toStrictEqual([
      PROVIDER_TYPE.WebPush,
      PROVIDER_TYPE.Fcm,
      PROVIDER_TYPE.Apns,
    ]);
  });

  it('rejects transports as a ProviderType', () => {
    for (const transport of TRANSPORT_VALUES) {
      expect(isProviderType(transport)).toBe(false);
    }
  });

  it('declares v1 executable values that belong to their own unions', () => {
    expect(isProviderType(V1_EXECUTABLE_PROVIDER_TYPE)).toBe(true);
    expect(V1_EXECUTABLE_TRANSPORT).toBe(TRANSPORT.Web);
  });

  it('accepts declared statuses and rejects others', () => {
    for (const status of PROVIDER_STATUS_VALUES) {
      expect(isProviderStatus(status)).toBe(true);
    }
    for (const value of ['Enabled', 'held', '', null, 1]) {
      expect(isProviderStatus(value)).toBe(false);
    }
  });
});

describe('provider routing eligibility', () => {
  it('accepts an enabled, in-scope, unheld provider', () => {
    const result = evaluateProviderRoutingEligibility(provider(), 'app-a', TRANSPORT.Web);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.providerId).toBe('prov-1');
  });

  it('rejects a disabled provider', () => {
    const result = evaluateProviderRoutingEligibility(
      provider({ status: PROVIDER_STATUS.Disabled }),
      'app-a',
      TRANSPORT.Web,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('provider_disabled');
  });

  it('rejects a provider on emergency hold even when enabled', () => {
    const result = evaluateProviderRoutingEligibility(
      provider({ emergencyHold: true }),
      'app-a',
      TRANSPORT.Web,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('provider_hold');
  });

  it('reports hold rather than disabled when both apply', () => {
    const result = evaluateProviderRoutingEligibility(
      provider({ status: PROVIDER_STATUS.Disabled, emergencyHold: true }),
      'app-a',
      TRANSPORT.Web,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('provider_hold');
  });

  it('rejects a provider scoped to another app', () => {
    const result = evaluateProviderRoutingEligibility(
      provider({ app: 'app-b' }),
      'app-a',
      TRANSPORT.Web,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('app_mismatch');
  });

  it('rejects a provider for another transport', () => {
    const result = evaluateProviderRoutingEligibility(
      provider({ transport: TRANSPORT.App }),
      'app-a',
      TRANSPORT.Web,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('transport_mismatch');
  });

  it('rejects a missing provider rather than throwing', () => {
    const result = evaluateProviderRoutingEligibility(undefined, 'app-a', TRANSPORT.Web);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_provider');
  });

  it('rejects a provider whose emergencyHold flag is not a boolean', () => {
    const result = evaluateProviderRoutingEligibility(
      provider({ emergencyHold: undefined as unknown as boolean }),
      'app-a',
      TRANSPORT.Web,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_provider');
  });

  // Mỗi field trong shape guard phải tự ghim: `status`/`type` ngoài vocabulary mà lọt
  // qua guard thì provider đó thành **eligible** (nhánh nghiệp vụ chỉ so sánh
  // `status === disabled`), tức một row hỏng vẫn nhận routing delivery mới.
  it('rejects a provider whose status is outside the vocabulary', () => {
    const result = evaluateProviderRoutingEligibility(
      provider({ status: 'paused' as unknown as ProviderStatus }),
      'app-a',
      TRANSPORT.Web,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_provider');
  });

  it('rejects a provider whose type is outside the vocabulary', () => {
    const result = evaluateProviderRoutingEligibility(
      provider({ type: 'banana' as unknown as ProviderType }),
      'app-a',
      TRANSPORT.Web,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_provider');
  });

  // Hai loại mismatch cùng đúng thì scope sai của `app` mới là điều kiện đứng trước
  // trong thứ tự kiểm tra — ghim để lần đảo thứ tự sau không âm thầm đổi reason.
  it('reports app_mismatch before transport_mismatch when both are wrong', () => {
    const result = evaluateProviderRoutingEligibility(
      provider({ app: 'app-b', transport: TRANSPORT.App }),
      'app-a',
      TRANSPORT.Web,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('app_mismatch');
  });

  it('never returns an ineligible provider as ok', () => {
    const cases: ProviderRoutingFact[] = [
      provider({ status: PROVIDER_STATUS.Disabled }),
      provider({ emergencyHold: true }),
      provider({ app: 'app-b' }),
      provider({ transport: TRANSPORT.App }),
    ];
    for (const candidate of cases) {
      const result = evaluateProviderRoutingEligibility(candidate, 'app-a', TRANSPORT.Web);
      expect(result.ok).toBe(false);
    }
  });
});

describe('primary provider selection fails safely on ambiguity', () => {
  it('returns the single eligible provider', () => {
    const result = selectPrimaryProvider([provider()], 'app-a', TRANSPORT.Web);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provider.providerId).toBe('prov-1');
  });

  it('returns no_provider when the only candidate is ineligible', () => {
    const result = selectPrimaryProvider(
      [provider({ status: PROVIDER_STATUS.Disabled })],
      'app-a',
      TRANSPORT.Web,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_provider');
  });

  it('returns no_provider for an empty list', () => {
    const result = selectPrimaryProvider([], 'app-a', TRANSPORT.Web);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_provider');
  });

  // Selector hợp lệ nhưng collection không đọc được: không phải lỗi tham số caller
  // (`malformed_selector`) mà là dữ liệu provider sai shape, nên reason phải nằm trong
  // nhóm `malformed_provider` — và phải là `ok: false`, không phải TypeError.
  it('reports malformed_provider instead of throwing when the collection is unreadable', () => {
    for (const providers of [null, undefined, {}, 'prov']) {
      const result = selectPrimaryProvider(providers as never, 'app-a', TRANSPORT.Web);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('malformed_provider');
    }
  });

  it('returns ambiguous when two providers are eligible for the same app and transport', () => {
    const result = selectPrimaryProvider(
      [provider({ providerId: 'prov-1' }), provider({ providerId: 'prov-2' })],
      'app-a',
      TRANSPORT.Web,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ambiguous');
  });

  it('does not resolve ambiguity by database order', () => {
    const forward = selectPrimaryProvider(
      [provider({ providerId: 'prov-1' }), provider({ providerId: 'prov-2' })],
      'app-a',
      TRANSPORT.Web,
    );
    const reversed = selectPrimaryProvider(
      [provider({ providerId: 'prov-2' }), provider({ providerId: 'prov-1' })],
      'app-a',
      TRANSPORT.Web,
    );
    expect(forward.ok).toBe(false);
    expect(reversed.ok).toBe(false);
    if (forward.ok || reversed.ok) return;
    expect(forward.reason).toBe('ambiguous');
    expect(reversed.reason).toBe('ambiguous');
    // Không có provider nào được chọn: cả hai lần đều từ chối.
    expect(forward.reason).toStrictEqual(reversed.reason);
  });

  it('picks the one eligible provider when other providers are ineligible', () => {
    const result = selectPrimaryProvider(
      [
        provider({ providerId: 'prov-1', status: PROVIDER_STATUS.Disabled }),
        provider({ providerId: 'prov-2' }),
        provider({ providerId: 'prov-3', emergencyHold: true }),
        provider({ providerId: 'prov-4', app: 'app-b' }),
      ],
      'app-a',
      TRANSPORT.Web,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provider.providerId).toBe('prov-2');
  });

  it('does not count providers for a different app as ambiguous', () => {
    const result = selectPrimaryProvider(
      [provider({ providerId: 'prov-1' }), provider({ providerId: 'prov-2', app: 'app-b' })],
      'app-a',
      TRANSPORT.Web,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provider.providerId).toBe('prov-1');
  });

  it('does not count providers for a different transport as ambiguous', () => {
    const result = selectPrimaryProvider(
      [
        provider({ providerId: 'prov-1' }),
        provider({ providerId: 'prov-2', transport: TRANSPORT.App }),
      ],
      'app-a',
      TRANSPORT.Web,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provider.providerId).toBe('prov-1');
  });

  it('rejects invalid selector arguments', () => {
    for (const [app, transport] of [
      ['', TRANSPORT.Web],
      ['app-a', 'web-push' as never],
    ] as const) {
      const result = selectPrimaryProvider([provider()], app, transport);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      // Lỗi **tham số caller**, không phải dữ liệu provider dị dạng: reason riêng để
      // lỗi cấu hình ở tầng gọi không bị đọc như row DB hỏng.
      expect(result.reason).toBe('malformed_selector');
    }
  });
});

describe('VAPID key binding follows the subscription, not the app', () => {
  it('returns the subscription key id when the app still serves it', () => {
    expect(resolveSubscriptionSigningKeyId(APP, 'vapid-1', [key(APP, 'vapid-1')])).toBe('vapid-1');
  });

  it('still serves a subscription whose key is being retired', () => {
    // 03-operations.md §7.2: trong rotation, key đang retire vẫn phải resolve được để
    // subscription cũ không mất khả năng gửi; key mới đã phục vụ subscription mới.
    expect(
      resolveSubscriptionSigningKeyId(APP, 'vapid-old', [
        key(APP, 'vapid-new'),
        key(APP, 'vapid-old'),
      ]),
    ).toBe('vapid-old');
  });

  it('refuses a subscription pointing at a key the app no longer serves', () => {
    expect(
      resolveSubscriptionSigningKeyId(APP, 'vapid-retired', [key(APP, 'vapid-current')]),
    ).toBeNull();
    expect(resolveSubscriptionSigningKeyId(APP, 'vapid-1', [])).toBeNull();
  });

  it('never falls back to the current key when the subscription key is gone', () => {
    // Không có fallback sang key hiện tại: ký bằng key khác key subscription đã cam
    // kết là hỏng delivery âm thầm (FR-006).
    expect(resolveSubscriptionSigningKeyId(APP, 'vapid-1', [key(APP, 'vapid-2')])).toBeNull();
  });

  it('refuses a key id that belongs to another App', () => {
    // 01-architecture.md §5.3, §9: VAPID key pair là credential **theo từng App**;
    // §8.2: namespace các App cô lập. Cùng một `vapid_key_id` do `App` khác phục vụ
    // KHÔNG được dùng để ký cho subscription của App này.
    expect(resolveSubscriptionSigningKeyId(APP, 'vapid-1', [key('app-b', 'vapid-1')])).toBeNull();
    // Và key đúng của App vẫn phải thắng khi danh sách có lẫn key của App khác.
    expect(
      resolveSubscriptionSigningKeyId(APP, 'vapid-1', [
        key('app-b', 'vapid-1'),
        key(APP, 'vapid-1'),
      ]),
    ).toBe('vapid-1');
  });

  it('refuses an app-scoped key fact whose app or key id is blank', () => {
    expect(resolveSubscriptionSigningKeyId(APP, 'vapid-1', [key('', 'vapid-1')])).toBeNull();
    expect(resolveSubscriptionSigningKeyId(APP, 'vapid-1', [key(APP, '')])).toBeNull();
    expect(resolveSubscriptionSigningKeyId('', 'vapid-1', [key(APP, 'vapid-1')])).toBeNull();
    expect(resolveSubscriptionSigningKeyId('   ', 'vapid-1', [key(APP, 'vapid-1')])).toBeNull();
  });

  it('refuses rather than guessing when a key id is blank', () => {
    expect(resolveSubscriptionSigningKeyId(APP, '', [key(APP, 'vapid-1')])).toBeNull();
    expect(resolveSubscriptionSigningKeyId(APP, 'vapid-1', [key(APP, '   ')])).toBeNull();
  });

  it('accepts the same id across a rotation that keeps serving it', () => {
    expect(
      resolveSubscriptionSigningKeyId(APP, 'vapid-1', [key(APP, 'vapid-1'), key(APP, 'vapid-2')]),
    ).toBe('vapid-1');
  });
});

describe('encryption key retirement waits for every record to be reencrypted', () => {
  it('refuses while a record still uses the key', () => {
    expect(canRetireEncryptionKey('K1', ['K1', 'K2'])).toBe(false);
    expect(canRetireEncryptionKey('K1', ['K1'])).toBe(false);
  });

  it('allows retirement once no record references the key', () => {
    expect(canRetireEncryptionKey('K1', ['K2'])).toBe(true);
    expect(canRetireEncryptionKey('K1', [])).toBe(true);
  });

  it('refuses rather than allowing retirement for an invalid key id', () => {
    expect(canRetireEncryptionKey('', ['K1'])).toBe(false);
    expect(canRetireEncryptionKey('K1', ['K1'])).toBe(false);
  });

  // Cửa chặn này phải fail-closed trên **mọi** input hỏng, kể cả khi không đọc được
  // danh sách usage: ném TypeError ở đây là vỡ contract "không ném cho dữ liệu hỏng"
  // của lib, và một exception trong quyết định rotate còn tệ hơn một lần chặn nhầm.
  it('refuses rather than throwing when the usage list is not a list', () => {
    expect(canRetireEncryptionKey('K1', null as never)).toBe(false);
    expect(canRetireEncryptionKey('K1', undefined as never)).toBe(false);
    expect(canRetireEncryptionKey('K1', 'K1' as never)).toBe(false);
    expect(canRetireEncryptionKey('K1', [null] as never)).toBe(false);
    expect(canRetireEncryptionKey('K1', { length: 1 } as never)).toBe(false);
  });
});
