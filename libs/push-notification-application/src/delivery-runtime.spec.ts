/**
 * Unit test tầng unit (fake ports) cho bốn operation runtime của §8.1:
 * `claimDelivery` · `releaseDelivery` · `recordOutcome` · `invalidateSubscription`.
 *
 * ⚠️ **Nguyên tắc "quyết định nằm trong statement" được kiểm bằng thứ tự gọi.** Use case đọc
 * chẩn đoán **một lần** sau khi claim thua, với **cùng** mốc `now` của predicate; credential
 * được resolve **sau** khi claim thắng. Fixture ở đây đếm từng lời gọi và khớp giá trị, nên một
 * lần đọc thừa hay một credential resolve trước claim đều là đỏ.
 *
 * ⚠️ **Contract thật trên đường thắng.** Body `200` của claim đi qua `deliveryClaim` của
 * contracts (validator đóng) — tức test này cũng khẳng định shape field RFC3339, `status` là
 * hằng `'processing'` và material subscription/provider đủ cho worker. Một field sai shape là
 * một lỗi throw từ validator, không phải một assert xanh giả.
 */

import { describe, expect, it } from 'vitest';

import {
  claimDelivery,
  invalidateSubscription,
  recordOutcome,
  releaseDelivery,
  type DeliveryRuntimeDeps,
} from './delivery-runtime';
import {
  APP,
  T0,
  adminFixture,
  deliveryRecord,
  providerRecord,
  subscriptionRecord,
  unused,
  type AdminFixture,
} from './fixture-ports';
import type { PushNotificationPorts } from './ports';
import type { DecryptedProviderCredential, DeliveryRecord } from './records';

const CREDENTIAL: DecryptedProviderCredential = {
  privateKey: 'private-key',
  publicKey: 'public-key',
};

/** Fixture runtime: như admin fixture nhưng thêm `resolveCredential` theo dõi được. */
type RuntimeFixture = DeliveryRuntimeDeps & {
  readonly audit: AdminFixture['audit'];
  readonly resolveCredentialCalls: { app: string; providerId: string; vapidKeyId: string }[];
};

function runtimeFixture(
  overrides?: (ports: PushNotificationPorts) => Partial<PushNotificationPorts>,
): RuntimeFixture {
  const base = adminFixture(overrides);
  const resolveCredentialCalls: { app: string; providerId: string; vapidKeyId: string }[] = [];
  return {
    config: base.config,
    ports: base.ports,
    audit: base.audit,
    resolveCredentialCalls,
    resolveCredential: async (app, providerId, vapidKeyId) => {
      resolveCredentialCalls.push({ app, providerId, vapidKeyId });
      return CREDENTIAL;
    },
  };
}

/** Claim thắng: statement trả hàng `processing` mang lease. */
function claimWins(f: { ports: PushNotificationPorts }, target: DeliveryRecord): void {
  f.ports.deliveries.claimDelivery = async (input) => ({
    ...target,
    status: 'processing',
    leaseExpiresAt: input.now + 60_000,
  });
  f.ports.subscriptions.findById = async () =>
    subscriptionRecord({ subscriptionId: target.subscriptionId, status: 'active' });
  f.ports.providers.findById = async () => providerRecord({ providerId: target.providerId });
}

describe('claimDelivery — the single guarded statement of §8.1', () => {
  it('wins the claim, resolves the credential after winning, and returns a valid contract body', async () => {
    const f = runtimeFixture();
    const target = deliveryRecord({
      deliveryId: 'deliv-1',
      status: 'queued',
      dispatchGeneration: 2,
    });
    claimWins(f, target);

    const outcome = await claimDelivery(f, 'deliv-1');

    expect(outcome.kind).toBe('won');
    if (outcome.kind !== 'won') {
      throw new Error('mong đợi outcome.kind là won');
    }
    expect(outcome.body.status).toBe('processing');
    expect(outcome.body.delivery_id).toBe('deliv-1');
    expect(outcome.body.expires_at).toBe(new Date(target.expiresAt).toISOString());
    expect(outcome.body.lease_expires_at).toBe(new Date(T0 + 60_000).toISOString());
    expect(outcome.body.dispatch_generation).toBe(2);
    expect(outcome.body.subscription).toMatchObject({
      endpoint: expect.stringContaining('fcm'),
      p256dh: 'p256dh',
      auth: 'auth',
      vapid_key_id: 'vapid-k1',
    });
    expect(outcome.body.provider).toMatchObject({
      type: 'web-push',
      credential: { privateKey: 'private-key', publicKey: 'public-key' },
    });
    // FR-006/§8.1: credential chỉ trả cho execution vừa thắng — resolver được gọi đúng một
    // lần, sau khi claim thắng, với `vapid_key_id` của subscription.
    expect(f.resolveCredentialCalls).toEqual([
      { app: APP, providerId: 'prov-1', vapidKeyId: 'vapid-k1' },
    ]);
  });

  it('reads the clock once and reuses the same now for predicate and diagnostics', async () => {
    // Clock tăng 100 mỗi lần đọc — nếu use case đọc lần thứ hai cho diagnostics thì now
    // sẽ lệch và assert dưới đây đỏ.
    let nowCalls = 0;
    const f = runtimeFixture((_ports) => ({
      clock: {
        now: () => {
          nowCalls += 1;
          return T0 + nowCalls * 100;
        },
      },
    }));
    let predicateNow = 0;
    let diagnosticsNow = 0;
    f.ports.deliveries.claimDelivery = async (input) => {
      predicateNow = input.now;
      return null;
    };
    f.ports.deliveries.findClaimDiagnostics = async (_deliveryId, diagnosedAt) => {
      diagnosticsNow = diagnosedAt;
      return null;
    };

    const outcome = await claimDelivery(f, 'deliv-1');

    expect(outcome).toMatchObject({
      kind: 'lost',
      body: { reason: 'terminal', state: 'cancelled' },
    });
    // §8.1: control plane xác định `now` MỘT lần — predicate và diagnostics dùng chung mốc.
    expect(predicateNow).toBe(diagnosticsNow);
    expect(nowCalls).toBe(1);
  });

  it('returns terminal/cancelled for an unknown delivery without resolving anything', async () => {
    const f = runtimeFixture();
    f.ports.deliveries.claimDelivery = async () => null;
    f.ports.deliveries.findClaimDiagnostics = async () => null;
    f.ports.subscriptions.findById = async () => unused('subscriptions.findById');

    const outcome = await claimDelivery(f, 'deliv-1');

    // Contract không có reason `not_found` — 409 terminal khiến worker ACK an toàn.
    expect(outcome).toEqual({
      kind: 'lost',
      body: { reason: 'terminal', state: 'cancelled' },
    });
    expect(f.resolveCredentialCalls).toHaveLength(0);
  });

  it('names lease_held from the diagnostics read when another execution still holds the lease', async () => {
    const f = runtimeFixture();
    const held: DeliveryRecord = {
      ...deliveryRecord({
        deliveryId: 'deliv-1',
        status: 'processing',
        dispatchGeneration: 5,
      }),
      leaseExpiresAt: T0 + 30_000,
    };
    f.ports.deliveries.claimDelivery = async () => null;
    f.ports.deliveries.findClaimDiagnostics = async () => ({
      delivery: held,
      subscriptionStatus: 'active',
      providerStatus: 'enabled',
      providerEmergencyHold: false,
    });

    const outcome = await claimDelivery(f, 'deliv-1');

    expect(outcome).toEqual({ kind: 'lost', body: { reason: 'lease_held' } });
  });

  it('returns terminal with the real state for a delivered delivery', async () => {
    const f = runtimeFixture();
    f.ports.deliveries.claimDelivery = async () => null;
    f.ports.deliveries.findClaimDiagnostics = async () => ({
      delivery: deliveryRecord({ deliveryId: 'deliv-1', status: 'delivered' }),
      subscriptionStatus: 'active',
      providerStatus: 'enabled',
      providerEmergencyHold: false,
    });

    const outcome = await claimDelivery(f, 'deliv-1');

    expect(outcome).toEqual({ kind: 'lost', body: { reason: 'terminal', state: 'delivered' } });
  });

  it('returns ineligible_subscription from the domain-ordered diagnostics', async () => {
    const f = runtimeFixture();
    f.ports.deliveries.claimDelivery = async () => null;
    f.ports.deliveries.findClaimDiagnostics = async () => ({
      delivery: deliveryRecord({ deliveryId: 'deliv-1', status: 'queued' }),
      subscriptionStatus: 'disabled',
      providerStatus: 'enabled',
      providerEmergencyHold: false,
    });

    const outcome = await claimDelivery(f, 'deliv-1');

    expect(outcome).toEqual({ kind: 'lost', body: { reason: 'ineligible_subscription' } });
  });

  it('returns terminal/cancelled when the subscription or provider vanished after the claim won', async () => {
    const f = runtimeFixture();
    const target = deliveryRecord({ deliveryId: 'deliv-1', status: 'queued' });
    f.ports.deliveries.claimDelivery = async () => ({ ...target, status: 'processing' });
    f.ports.subscriptions.findById = async () => null;
    f.ports.providers.findById = async () => providerRecord({});
    f.ports.audit.append = async () => unused('audit.append');
    f.ports.deliveries.releaseLease = async () => unused('deliveries.releaseLease');

    const outcome = await claimDelivery(f, 'deliv-1');

    // Lease không hoàn tác (release là một write không guard); 409 terminal là fail-closed.
    expect(outcome).toEqual({ kind: 'lost', body: { reason: 'terminal', state: 'cancelled' } });
    expect(f.resolveCredentialCalls).toHaveLength(0);
  });

  it('returns terminal/cancelled when the credential cannot be resolved', async () => {
    const f = runtimeFixture();
    const target = deliveryRecord({ deliveryId: 'deliv-1', status: 'queued' });
    f.ports.deliveries.claimDelivery = async () => ({ ...target, status: 'processing' });
    f.ports.subscriptions.findById = async () =>
      subscriptionRecord({ subscriptionId: 'sub-1', status: 'active' });
    f.ports.providers.findById = async () => providerRecord({});

    const failing: DeliveryRuntimeDeps = {
      config: f.config,
      ports: f.ports,
      resolveCredential: async () => null,
    };

    const outcome = await claimDelivery(failing, 'deliv-1');

    // FR-006: không fallback sang key khác — permanent failure của attempt, không có reason
    // nào trong tập đóng cho nó, nên 409 terminal là lựa chọn fail-closed duy nhất.
    expect(outcome).toEqual({ kind: 'lost', body: { reason: 'terminal', state: 'cancelled' } });
  });

  it('omits payload_digest when the configured algorithm is none', async () => {
    const f = runtimeFixture();
    // Contract đòi `dispatch_generation` là số nguyên dương — generation 0 (chưa publish lần
    // nào) chưa từng đi qua claim thắng, nên dùng generation 2 cho đường thắng ở đây.
    const target = deliveryRecord({
      deliveryId: 'deliv-1',
      status: 'queued',
      dispatchGeneration: 2,
    });
    claimWins(f, target);
    f.ports.notifications.findById = async () => unused('notifications.findById');
    f.ports.payloadDigester.digest = async () => unused('payloadDigester.digest');

    const outcome = await claimDelivery(f, 'deliv-1');

    if (outcome.kind !== 'won') {
      throw new Error('mong đợi outcome.kind là won');
    }
    expect(Object.hasOwn(outcome.body, 'payload_digest')).toBe(false);
  });
});

describe('releaseDelivery and recordOutcome — fenced writes with two guard layers', () => {
  it('releases a processing delivery keeping the same generation and returns a queued ack', async () => {
    const f = runtimeFixture();
    f.ports.deliveries.findById = async () =>
      deliveryRecord({ deliveryId: 'deliv-1', status: 'processing', dispatchGeneration: 4 });
    f.ports.deliveries.releaseLease = async (input) => {
      // Generation worker gửi là một phần của guard — không được thay bằng generation đọc lại.
      expect(input.dispatchGeneration).toBe(4);
      return deliveryRecord({
        deliveryId: 'deliv-1',
        status: 'queued',
        dispatchGeneration: input.dispatchGeneration,
      });
    };

    const outcome = await releaseDelivery(f, 'deliv-1', 4);

    expect(outcome).toEqual({
      kind: 'ok',
      ack: { delivery_id: 'deliv-1', status: 'queued', dispatch_generation: 4 },
    });
  });

  it('reports stale_write without a write when the generation no longer matches', async () => {
    const f = runtimeFixture();
    f.ports.deliveries.findById = async () =>
      deliveryRecord({ deliveryId: 'deliv-1', status: 'processing', dispatchGeneration: 6 });
    f.ports.deliveries.releaseLease = async () => unused('deliveries.releaseLease');

    const outcome = await releaseDelivery(f, 'deliv-1', 4);

    expect(outcome).toEqual({ kind: 'conflict', reason: 'stale_write' });
  });

  it('reports terminal with the real terminal state on recordOutcome', async () => {
    const f = runtimeFixture();
    f.ports.deliveries.findById = async () =>
      deliveryRecord({ deliveryId: 'deliv-1', status: 'expired', dispatchGeneration: 4 });
    f.ports.deliveries.recordOutcome = async () => unused('deliveries.recordOutcome');

    const outcome = await recordOutcome(f, 'deliv-1', 4, 'delivered');

    expect(outcome).toEqual({ kind: 'conflict', reason: 'terminal', terminalState: 'expired' });
  });

  it('reports stale_write when decideFencedWrite sees a non-processing status for outcome', async () => {
    const f = runtimeFixture();
    // Generation khớp nhưng delivery đã `queued` (đã release) — outcome không ghi được nữa.
    f.ports.deliveries.findById = async () =>
      deliveryRecord({ deliveryId: 'deliv-1', status: 'queued', dispatchGeneration: 4 });
    f.ports.deliveries.recordOutcome = async () => unused('deliveries.recordOutcome');

    const outcome = await recordOutcome(f, 'deliv-1', 4, 'delivered');

    expect(outcome).toEqual({ kind: 'conflict', reason: 'stale_write' });
  });

  it('records a delivered outcome with the worker-supplied generation', async () => {
    const f = runtimeFixture();
    f.ports.deliveries.findById = async () =>
      deliveryRecord({ deliveryId: 'deliv-1', status: 'processing', dispatchGeneration: 9 });
    f.ports.deliveries.recordOutcome = async (input) => {
      expect(input.outcome).toBe('delivered');
      expect(input.dispatchGeneration).toBe(9);
      return deliveryRecord({
        deliveryId: 'deliv-1',
        status: 'delivered',
        dispatchGeneration: input.dispatchGeneration,
      });
    };

    const outcome = await recordOutcome(f, 'deliv-1', 9, 'delivered');

    expect(outcome).toEqual({
      kind: 'ok',
      ack: { delivery_id: 'deliv-1', status: 'delivered', dispatch_generation: 9 },
    });
  });

  it('reports stale_write when the guarded statement returns null after the fence cleared', async () => {
    const f = runtimeFixture();
    // Lớp guard thứ hai: state đổi giữa lúc fence và lúc ghi — statement trả `null`.
    f.ports.deliveries.findById = async () =>
      deliveryRecord({ deliveryId: 'deliv-1', status: 'processing', dispatchGeneration: 9 });
    f.ports.deliveries.recordOutcome = async () => null;

    const outcome = await recordOutcome(f, 'deliv-1', 9, 'delivered');

    expect(outcome).toEqual({ kind: 'conflict', reason: 'stale_write' });
  });
});

describe('invalidateSubscription — result-idempotent with audit only on change', () => {
  it('disables an active subscription and writes exactly one audit record', async () => {
    const f = runtimeFixture();
    const target = subscriptionRecord({ subscriptionId: 'sub-1', status: 'active' });
    f.ports.subscriptions.findById = async () => target;
    f.ports.subscriptions.disableById = async (input) => {
      expect(input.cause).toBe('provider_invalidation');
      return { ...target, status: 'disabled' };
    };

    const outcome = await invalidateSubscription(f, 'sub-1');

    expect(outcome).toEqual({
      kind: 'ok',
      body: { subscription_id: 'sub-1', status: 'disabled' },
    });
    const audit = f.audit.last();
    expect(audit?.event).toBe('subscription_disabled');
    expect(audit?.auditId).toBe(`sub-1:invalidate:${T0}`);
    expect(audit?.detail).toEqual({ app: APP, cause: 'provider_invalidation' });
  });

  it('returns the same ack for an already disabled subscription without any write or audit', async () => {
    const f = runtimeFixture();
    // Idempotent theo KẾT QUẢ: lần gọi lặp trả cùng 200, nhưng một audit record cho một
    // thay đổi không xảy ra là bằng chứng sai — audit chỉ ghi khi `changed: true`.
    f.ports.subscriptions.findById = async () =>
      subscriptionRecord({ subscriptionId: 'sub-1', status: 'disabled' });
    f.ports.subscriptions.disableById = async () => unused('subscriptions.disableById');
    f.ports.audit.append = async () => unused('audit.append');

    const outcome = await invalidateSubscription(f, 'sub-1');

    expect(outcome).toEqual({ kind: 'ok', body: { subscription_id: 'sub-1', status: 'disabled' } });
    expect(f.audit.records).toHaveLength(0);
  });

  it('returns the same ack for an expired subscription (no transition exists) without auditing', async () => {
    const f = runtimeFixture();
    f.ports.subscriptions.findById = async () =>
      subscriptionRecord({ subscriptionId: 'sub-1', status: 'expired' });
    f.ports.subscriptions.disableById = async () => unused('subscriptions.disableById');
    f.ports.audit.append = async () => unused('audit.append');

    const outcome = await invalidateSubscription(f, 'sub-1');

    expect(outcome).toEqual({ kind: 'ok', body: { subscription_id: 'sub-1', status: 'disabled' } });
    expect(f.audit.records).toHaveLength(0);
  });

  it('returns not_found for an unknown subscription', async () => {
    const f = runtimeFixture();
    f.ports.subscriptions.findById = async () => null;

    const outcome = await invalidateSubscription(f, 'sub-1');

    expect(outcome).toEqual({ kind: 'not_found' });
    expect(f.audit.records).toHaveLength(0);
  });
});
