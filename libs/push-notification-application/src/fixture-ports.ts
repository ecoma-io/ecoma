/**
 * Fixture ports cho các unit test tầng unit của use case admin / delivery runtime.
 *
 * ⚠️ **Vì sao file này tồn tại.** `admin-provider.ts`, `admin-delivery.ts`,
 * `admin-subscription.ts`, `delivery-runtime.ts` đều nhận cả bundle `PushNotificationPorts`
 * hoặc `AdminDeps`, và mỗi test chỉ cần **vài** method trả giá trị có chủ đích. Dựng ports
 * theo kiểu `create-notification.spec.ts` ("mọi method không dùng ném lỗi kèm tên port")
 * lặp lại ở mỗi file là hàng trăm dòng nhân bản — bundle ở đây cho phép test override **đúng**
 * đúng method nó quan tâm bằng `overrides`.
 *
 * ⚠️ Cùng nguyên tắc với `create-notification.spec.ts`: một port không mong đợi được gọi thì
 * test đang đi sai nhánh, và lỗi ném ra chỉ chứa **tên port** — không bao giờ mang bind value
 * (payload, endpoint, secret) vì message của lỗi có thể đi vào log của test runner.
 */

import type { PushNotificationConfig } from './config-port';
import type { IdGenerator } from './create-notification';
import type { AuditRecordInput, PushNotificationPorts, ProviderMappingRecord } from './ports';
import type {
  SubscriptionRecord,
  ProviderRecord,
  DeliveryRecord,
  OutboxRecord,
  ProviderCredentialRecord,
  NotificationRecord,
  DeviceRecord,
} from './records';

export const APP = 'ecoma-io';
export const T0 = 1_800_000_000_000;

export function unused(name: string): never {
  throw new Error(`port không mong đợi đã được gọi: ${name}`);
}

export function testConfig(): PushNotificationConfig {
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
    pushEndpointHostAllowlist: ['fcm.googleapis.com'],
  };
}

export function subscriptionRecord(input: {
  readonly subscriptionId: string;
  readonly status: SubscriptionRecord['status'];
  readonly app?: string;
  readonly transport?: SubscriptionRecord['transport'];
  readonly vapidKeyId?: string;
}): SubscriptionRecord {
  return {
    subscriptionId: input.subscriptionId,
    deviceId: `device-${input.subscriptionId}`,
    userId: 'user-1',
    app: input.app ?? APP,
    transport: input.transport ?? 'web',
    endpoint: `https://fcm.googleapis.com/fcm/send/${input.subscriptionId}`,
    endpointHash: `hash-${input.subscriptionId}`,
    p256dh: 'p256dh',
    auth: 'auth',
    vapidKeyId: input.vapidKeyId ?? 'vapid-k1',
    providerId: 'prov-1',
    status: input.status,
    createdAt: T0,
    updatedAt: T0,
  };
}

export function providerRecord(input: {
  readonly providerId?: string;
  readonly app?: string;
  readonly status?: ProviderRecord['status'];
  readonly emergencyHold?: boolean;
  readonly transport?: ProviderRecord['transport'];
  readonly type?: ProviderRecord['type'];
  readonly configuration?: Readonly<Record<string, unknown>>;
}): ProviderRecord {
  return {
    providerId: input.providerId ?? 'prov-1',
    app: input.app ?? APP,
    transport: input.transport ?? 'web',
    type: input.type ?? 'web-push',
    name: 'provider-1',
    status: input.status ?? 'enabled',
    emergencyHold: input.emergencyHold ?? false,
    isPrimary: false,
    configuration: input.configuration ?? { vapidSubject: 'mailto:ops@ecoma.io' },
    createdAt: T0,
    updatedAt: T0,
  };
}

export function deliveryRecord(input: {
  readonly deliveryId?: string;
  readonly app?: string;
  readonly status: DeliveryRecord['status'];
  readonly dispatchGeneration?: number;
  readonly expiresAt?: number;
  readonly subscriptionId?: string;
  readonly providerId?: string;
}): DeliveryRecord {
  return {
    deliveryId: input.deliveryId ?? 'deliv-1',
    notificationId: `notif-${input.deliveryId ?? '1'}`,
    subscriptionId: input.subscriptionId ?? 'sub-1',
    providerId: input.providerId ?? 'prov-1',
    userId: 'user-1',
    deviceId: 'device-1',
    app: input.app ?? APP,
    transport: 'web',
    status: input.status,
    dispatchGeneration: input.dispatchGeneration ?? 0,
    leaseExpiresAt: null,
    expiresAt: input.expiresAt ?? T0 + 86_400_000,
    createdAt: T0,
    updatedAt: T0,
  };
}

export function outboxRecord(input: {
  readonly outboxId: string;
  readonly deliveryId: string;
  readonly status?: OutboxRecord['status'];
}): OutboxRecord {
  return {
    outboxId: input.outboxId,
    deliveryId: input.deliveryId,
    status: input.status ?? 'pending',
    attempts: 0,
    availableAt: T0,
    leaseExpiresAt: null,
    claimedBy: null,
    lastError: null,
    createdAt: T0,
  };
}

export function credentialRecord(input: {
  readonly vapidKeyId?: string;
  readonly status?: ProviderCredentialRecord['status'];
}): ProviderCredentialRecord {
  return {
    credentialId: `cred-${input.vapidKeyId ?? 'vapid-k1'}`,
    providerId: 'prov-1',
    app: APP,
    vapidKeyId: input.vapidKeyId ?? 'vapid-k1',
    publicKey: 'public-key-material',
    credentialCiphertext: new Uint8Array([1, 2, 3]),
    credentialEncryptionVersion: 'K1',
    status: input.status ?? 'active',
    createdAt: T0,
    updatedAt: T0,
  };
}

export function notificationRecord(input: { readonly notificationId: string }): NotificationRecord {
  return {
    notificationId: input.notificationId,
    app: APP,
    principalId: 'principal-1',
    payloadJson: JSON.stringify({ title: 'title', body: 'body' }),
    payloadBytes: 30,
    expiresAt: T0 + 86_400_000,
    createdAt: T0,
  };
}

export function deviceRecord(input: { readonly deviceId: string }): DeviceRecord {
  return {
    deviceId: input.deviceId,
    userId: 'user-1',
    app: APP,
    createdAt: T0,
  };
}

export function mappingRecord(input: { readonly providerId: string }): ProviderMappingRecord {
  return {
    mappingId: 'mapping-1',
    app: APP,
    transport: 'web',
    providerId: input.providerId,
    isPrimary: true,
  };
}

/** Audit nhận được trong test — mỗi record là một assert có thể khẳng định event + detail. */
export interface AuditSpy {
  readonly records: AuditRecordInput[];
  last(): AuditRecordInput | undefined;
}

/** Bundle đủ dùng: `ports` + `ids` + audit spy, override theo method. */
export interface AdminFixture {
  readonly config: PushNotificationConfig;
  readonly ports: PushNotificationPorts;
  readonly ids: IdGenerator;
  readonly audit: AuditSpy;
  idCalls(): number;
}

/**
 * Dựng fixture admin. `overrides` thay nguyên một repository — override một method đơn dùng
 * spread (`{ ...f.ports.providers, findById: ... }`) trong test.
 */
export function adminFixture(
  overrides?: (ports: PushNotificationPorts) => Partial<PushNotificationPorts>,
): AdminFixture {
  const auditRecords: AuditRecordInput[] = [];
  const audit: AuditSpy = {
    records: auditRecords,
    last: () => auditRecords.at(-1),
  };

  const base: PushNotificationPorts = {
    clock: { now: () => T0 },
    queue: { send: async () => unused('queue.send') },
    credentialCipher: {
      encrypt: async (plaintext) => ({
        ciphertext: new TextEncoder().encode(plaintext),
        version: 'K1',
      }),
      decrypt: async () => 'decrypted-private-key',
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
      listByApp: async () => unused('subscriptions.listByApp'),
      countActiveByVapidKeyId: async () => unused('subscriptions.countActiveByVapidKeyId'),
      insert: async () => unused('subscriptions.insert'),
      reactivateWithNewSecret: async () => unused('subscriptions.reactivateWithNewSecret'),
      disableById: async () => unused('subscriptions.disableById'),
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
    audit: {
      append: async (record) => {
        auditRecords.push(record);
      },
    },
    routingPolicy: { find: async () => null },
  };

  const ports = overrides !== undefined ? { ...base, ...overrides(base) } : base;
  let idCounter = 0;
  return {
    config: testConfig(),
    ports,
    ids: {
      next: (): string => {
        idCounter += 1;
        return `id-${String(idCounter)}`;
      },
    },
    audit,
    idCalls: () => idCounter,
  };
}
