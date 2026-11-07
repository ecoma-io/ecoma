/**
 * Unit test tầng unit (fake ports) cho `revalidateSubscriptionEndpoints` — FR-003.
 *
 * ⚠️ **Vì sao test này dùng fake subscription repository.** Ba nhánh cần kiểm nằm ở *số học
 * đếm* và *quyết định disable* của use case, không ở SQL: `disableById` thắng (đếm disabled),
 * `disableById` thua race (trả `null` — đếm valid), và row hỏng (`skippedCorrupt`, không gọi
 * disable). Một D1 thật cho cùng kết quả nhưng mỗi case cần một fixture bảng riêng và cửa sổ
 * race không dựng được tuần tự — xem `create-notification.spec.ts` (cùng lý do cho catch-race).
 *
 * ⚠️ **Kết quả một lượt quét là hợp đồng cho metric/alert**: `disabled` qua ngưỡng là một
 * alert (allowlist bị siết nhầm), `skippedCorrupt > 0` là một alert khác (dữ liệu hỏng). Sai
 * một nhãn là alert sai ngữ nghĩa — đúng loại hồi quy mà test tier này giữ.
 */

import { describe, expect, it } from 'vitest';

import { revalidateSubscriptionEndpoints } from './endpoint-revalidation';
import type { PushNotificationConfig } from './config-port';
import type { PushNotificationPorts } from './ports';
import type { SubscriptionRecord } from './records';

const APP = 'ecoma-io';
const T0 = 1_800_000_000_000;
const ALLOWLIST = ['fcm.googleapis.com'];

function unused(name: string): never {
  throw new Error(`port không mong đợi đã được gọi: ${name}`);
}

function testConfig(): PushNotificationConfig {
  return {
    sla: {
      idempotencyRetentionMs: 24 * 3_600_000,
      callerRetryWindowMs: 3_600_000,
      maxNotificationTtlMs: 86_400_000,
      payloadDigestAlgorithm: 'none',
      outboxRecoverySlaMs: 15 * 60_000,
      deliveryReconciliationAgeMs: 30 * 60_000,
    },
    engineering: {
      deliveryLeaseDurationMs: 60_000,
      notificationRateLimit: 600,
      notificationRateLimitWindowMs: 60_000,
      outboxBatchSize: 50,
      outboxLeaseDurationMs: 30_000,
      outboxMaxPublishAttempts: 5,
      outboxPublishBackoffMs: 5_000,
      reconciliationBatchSize: 100,
      outboxReconciliationBatchSize: 100,
      defaultMaxDeliveriesPerNotification: 100,
      maxIdempotencyKeyLength: 128,
      providerTestTimeoutMs: 5_000,
    },
    runtime: { service: 'push-notification', environment: 'test', logLevel: 'error' },
    runtimeAuth: {
      expectedPrincipal: 'svc.web-push-notification-job',
      sharedSecret: 'runtime-secret',
    },
    controlPlaneAuth: {
      adminToken: 'admin-token',
      adminPrincipal: 'backoffice',
      applicationToken: 'application-token',
      applicationPrincipal: APP,
    },
    credentialKeyring: { currentVersion: 'K1', servingVersions: ['K1'] },
    pushEndpointHostAllowlist: ALLOWLIST,
  };
}

/** Subscription active với endpoint thuộc allowlist — hợp lệ theo policy hiện hành. */
function activeSubscription(input: {
  readonly subscriptionId: string;
  readonly endpoint: string;
}): SubscriptionRecord {
  return {
    subscriptionId: input.subscriptionId,
    deviceId: 'device-1',
    userId: 'user-1',
    app: APP,
    transport: 'web',
    endpoint: input.endpoint,
    endpointHash: `hash-${input.subscriptionId}`,
    p256dh: 'p256dh',
    auth: 'auth',
    vapidKeyId: 'vapid-k1',
    providerId: 'prov-1',
    status: 'active',
    createdAt: T0,
    updatedAt: T0,
  };
}

interface Fixture {
  readonly deps: { readonly config: PushNotificationConfig; readonly ports: PushNotificationPorts };
  readonly disableInputs: { app: string; subscriptionId: string; cause: string; now: number }[];
}

/**
 * Dựng ports cho một lượt quét: `listByApp` trả `subscriptions`, `disableById` trả giá trị
 * theo **subscription id** (`null` = thua race) và ghi lại mọi input để test khẳng định
 * cause + `now` đúng như hợp đồng của `DisableSubscriptionInput`.
 */
function fixture(options: {
  readonly subscriptions: readonly SubscriptionRecord[];
  /** `null` = race thua cho subscription đó; mặc định thắng. */
  readonly raceLostFor?: readonly string[];
}): Fixture {
  const disableInputs: Fixture['disableInputs'] = [];
  const ports: PushNotificationPorts = {
    clock: { now: () => T0 },
    queue: { send: async () => unused('queue.send') },
    credentialCipher: {
      encrypt: async () => unused('credentialCipher.encrypt'),
      decrypt: async () => unused('credentialCipher.decrypt'),
    },
    payloadDigester: { digest: async () => null },
    rateLimit: { consume: async () => ({ allowed: true, retryAfterMs: null }) },
    devices: {
      findById: async () => unused('devices.findById'),
      listByUser: async () => unused('devices.listByUser'),
      insert: async () => unused('devices.insert'),
    },
    subscriptions: {
      findById: async () => unused('subscriptions.findById'),
      findByEndpointHash: async () => unused('subscriptions.findByEndpointHash'),
      listByDevice: async () => unused('subscriptions.listByDevice'),
      listByApp: async () => options.subscriptions,
      countActiveByVapidKeyId: async () => unused('subscriptions.countActiveByVapidKeyId'),
      insert: async () => unused('subscriptions.insert'),
      reactivateWithNewSecret: async () => unused('subscriptions.reactivateWithNewSecret'),
      disableById: async (input) => {
        disableInputs.push({ ...input });
        return options.raceLostFor?.includes(input.subscriptionId)
          ? null
          : (options.subscriptions.find(
              (subscription) => subscription.subscriptionId === input.subscriptionId,
            ) ?? null);
      },
    },
    providers: {
      findById: async () => unused('providers.findById'),
      listByScope: async () => unused('providers.listByScope'),
      listByApp: async () => unused('providers.listByApp'),
      listHeld: async () => unused('providers.listHeld'),
      insert: async () => unused('providers.insert'),
      updateConfiguration: async () => unused('providers.updateConfiguration'),
      setStatus: async () => unused('providers.setStatus'),
      setEmergencyHold: async () => unused('providers.setEmergencyHold'),
      setPrimaryMapping: async () => unused('providers.setPrimaryMapping'),
      findPrimaryMapping: async () => unused('providers.findPrimaryMapping'),
      listAppVapidKeys: async () => unused('providers.listAppVapidKeys'),
    },
    providerCredentials: {
      findByVapidKeyId: async () => unused('providerCredentials.findByVapidKeyId'),
      listByProvider: async () => unused('providerCredentials.listByProvider'),
      listEncryptionVersionsInUse: async () =>
        unused('providerCredentials.listEncryptionVersionsInUse'),
      countActiveSubscriptionReferences: async () =>
        unused('providerCredentials.countActiveSubscriptionReferences'),
      insert: async () => unused('providerCredentials.insert'),
      setStatus: async () => unused('providerCredentials.setStatus'),
    },
    notifications: {
      persistNotificationWithDeliveries: async () => unused('notifications.persist'),
      findById: async () => unused('notifications.findById'),
      listByApp: async () => unused('notifications.listByApp'),
    },
    deliveries: {
      claimDelivery: async () => unused('deliveries.claimDelivery'),
      findClaimDiagnostics: async () => unused('deliveries.findClaimDiagnostics'),
      releaseLease: async () => unused('deliveries.releaseLease'),
      recordOutcome: async () => unused('deliveries.recordOutcome'),
      markExpired: async () => unused('deliveries.markExpired'),
      retryFailed: async () => unused('deliveries.retryFailed'),
      findById: async () => unused('deliveries.findById'),
      listAgedNonTerminal: async () => unused('deliveries.listAgedNonTerminal'),
      findNotificationPayload: async () => unused('deliveries.findNotificationPayload'),
      listByApp: async () => unused('deliveries.listByApp'),
    },
    outbox: {
      claimDue: async () => unused('outbox.claimDue'),
      findById: async () => unused('outbox.findById'),
      applyPublisherSuccess: async () => unused('outbox.applyPublisherSuccess'),
      recordPublishFailure: async () => unused('outbox.recordPublishFailure'),
      createIntent: async () => unused('outbox.createIntent'),
      hasOpenIntent: async () => unused('outbox.hasOpenIntent'),
      countOpenIntents: async () => unused('outbox.countOpenIntents'),
      listAgedOpen: async () => unused('outbox.listAgedOpen'),
      listFailed: async () => unused('outbox.listFailed'),
    },
    idempotency: {
      find: async () => unused('idempotency.find'),
      deleteEligible: async () => unused('idempotency.deleteEligible'),
    },
    audit: { append: async () => undefined },
    routingPolicy: { find: async () => null },
  };
  return { deps: { config: testConfig(), ports }, disableInputs };
}

describe('revalidateSubscriptionEndpoints — counting and disable decisions (FR-003)', () => {
  it('disables a subscription whose endpoint left the allowlist with the revalidation cause', async () => {
    const fixtureBuilt = fixture({
      subscriptions: [
        activeSubscription({
          subscriptionId: 'sub-reject',
          endpoint: 'https://attacker.example.com/push/abc',
        }),
      ],
    });
    const result = await revalidateSubscriptionEndpoints(fixtureBuilt.deps, { app: APP });

    // Disable đúng cause — cause này quyết định cột `disabled_reason` trong D1 và là thứ
    // phân biệt một disable do policy với một disable do user.
    expect(result.disabled).toBe(1);
    expect(result.disabledSubscriptionIds).toEqual(['sub-reject']);
    expect(fixtureBuilt.disableInputs).toHaveLength(1);
    expect(fixtureBuilt.disableInputs[0]?.cause).toBe('endpoint_revalidation_failed');
    expect(fixtureBuilt.disableInputs[0]?.app).toBe(APP);
    expect(fixtureBuilt.disableInputs[0]?.now).toBe(T0);
  });

  it('counts a valid endpoint without any disable write', async () => {
    const fixtureBuilt = fixture({
      subscriptions: [
        activeSubscription({
          subscriptionId: 'sub-valid',
          endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
        }),
      ],
    });
    const result = await revalidateSubscriptionEndpoints(fixtureBuilt.deps, { app: APP });

    expect(result).toMatchObject({ scanned: 1, disabled: 0, valid: 1, skippedCorrupt: 0 });
    expect(fixtureBuilt.disableInputs).toHaveLength(0);
  });

  it('skips a corrupt row without disabling it', async () => {
    // Endpoint không phải string — row hỏng trong storage, không phải endpoint vi phạm
    // policy. Disable row này là khoá vĩnh viễn một subscription mà nguyên nhân không nằm
    // ở endpoint.
    const corrupt = {
      ...activeSubscription({ subscriptionId: 'sub-corrupt', endpoint: 'https://x' }),
      endpoint: 42 as unknown as string,
    };
    const fixtureBuilt = fixture({ subscriptions: [corrupt] });
    const result = await revalidateSubscriptionEndpoints(fixtureBuilt.deps, { app: APP });

    expect(result.skippedCorrupt).toBe(1);
    expect(result.disabled).toBe(0);
    expect(fixtureBuilt.disableInputs).toHaveLength(0);
  });

  it('counts a lost disable race as valid instead of disabled', async () => {
    // `disableById` về `null` = user/admin vừa disable giữa lúc đọc và lúc ghi. Lượt quét
    // không thắng — nhưng subscription đã disabled, nên đếm nó "disabled do quét" là một
    // metric nói dối.
    const fixtureBuilt = fixture({
      subscriptions: [
        activeSubscription({
          subscriptionId: 'sub-race',
          endpoint: 'https://attacker.example.com/push/abc',
        }),
      ],
      raceLostFor: ['sub-race'],
    });
    const result = await revalidateSubscriptionEndpoints(fixtureBuilt.deps, { app: APP });

    expect(result.disabled).toBe(0);
    expect(result.valid).toBe(1);
    expect(result.disabledSubscriptionIds).toEqual([]);
  });

  it('applies the batch-size limit of reconciliation when listing active subscriptions', async () => {
    let capturedFilter: { status?: string; limit?: number } | null = null;
    const ports = fixture({ subscriptions: [] }).deps.ports;
    const limited: PushNotificationPorts = {
      ...ports,
      subscriptions: {
        ...ports.subscriptions,
        listByApp: async (_app, filter) => {
          capturedFilter = filter;
          return [];
        },
      },
    };
    await revalidateSubscriptionEndpoints({ config: testConfig(), ports: limited }, { app: APP });

    // Quét toàn bảng không giới hạn trên một app lớn là một lượt quét giữ D1 mở — lượt quét
    // này PHẢI mang limit của config, không phải quét tự do.
    expect(capturedFilter).toEqual({ status: 'active', limit: 100 });
  });

  it('mixes all three outcomes in one scan without letting one corrupt row stop the sweep', async () => {
    const fixtureBuilt = fixture({
      subscriptions: [
        activeSubscription({
          subscriptionId: 'sub-a',
          endpoint: 'https://fcm.googleapis.com/fcm/send/ok',
        }),
        activeSubscription({
          subscriptionId: 'sub-b',
          endpoint: 'https://attacker.example.com/push/abc',
        }),
        {
          ...activeSubscription({ subscriptionId: 'sub-c', endpoint: 'https://x' }),
          endpoint: null as unknown as string,
        },
        activeSubscription({
          subscriptionId: 'sub-d',
          endpoint: 'http://fcm.googleapis.com/fcm/send/insecure',
        }),
      ],
    });
    const result = await revalidateSubscriptionEndpoints(fixtureBuilt.deps, { app: APP });

    // `sub-d` http (không https) cũng là endpoint_rejected — cùng cause với allowlist miss,
    // đi qua cùng đường disable. Một row hỏng (`sub-c`) không được chặn hai row còn lại.
    expect(result.scanned).toBe(4);
    expect(result.valid).toBe(1);
    expect(result.disabled).toBe(2);
    expect(result.disabledSubscriptionIds).toEqual(['sub-b', 'sub-d']);
    expect(result.skippedCorrupt).toBe(1);
  });
});
