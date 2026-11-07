/**
 * Regression test cho **đường catch-race** của `createNotification` (FR-008).
 *
 * ⚠️ **Vì sao test này dùng fake repo chứ không phải D1 thật.** Đường cần kiểm chỉ chạy khi
 * `persistNotificationWithDeliveries` **ném sau khi** bước (3) đã đọc `idempotency.find` và
 * thấy `null` — tức bản ghi giành chiến thắng của cuộc đua được commit **giữa hai lần đọc**.
 * Một test tuần tự trên một D1 duy nhất không thể tạo cửa sổ đó: ghi bản ghi trước thì bước
 * (3) đã thấy nó (replay path thường, không qua catch); ghi sau thì `find` trong catch vẫn
 * thấy `null` đúng như kịch bản StorageFailure. Vì vậy "request thắng vừa commit" được mô
 * phỏng bằng fake: `find` trả `null` ở lần gọi đầu và trả record của người thắng ở lần
 * gọi thứ hai.
 *
 * ⚠️ **Ba nhánh của catch là ba câu trả lời HTTP khác nhau** và không được lẫn:
 * - cùng hash → `200` replay (`notification_id` của request thắng);
 * - khác hash → `409` (`idempotency_key_conflict`);
 * - không có record → `503` (`storage_failure`) — lỗi storage thật sự, không phải race.
 *
 * Không có catch-race, nhánh 1 trả `503` cho một request mà FR-008 yêu cầu trả `200` —
 * caller retry và cuối cùng vẫn nhận được kết quả idempotent, nhưng đường đi là "lỗi
 * storage" thay vì "đã xử lý", khiến retry policy và metric của caller sai. Đây là
 * regression test, không phải mở rộng hành vi.
 */

import { describe, expect, it } from 'vitest';

import { createNotification } from './create-notification';
import type { PushNotificationConfig } from './config-port';
import type { CreateNotificationDeps } from './create-notification';
import type { PushNotificationPorts } from './ports';
import type { IdempotencyRecord, PersistNotificationInput } from './records';

/* -------------------------------------------------------------------------------------- */
/* Fixture                                                                                    */
/* -------------------------------------------------------------------------------------- */

const APP = 'ecoma-io';
const PRINCIPAL = 'principal-1';
const KEY = 'race-key-1';
const T0 = 1_800_000_000_000;
const NOTIFICATION_ID_WINNER = 'notif-winner';

/** Hash ổn định cho toàn bộ test — cùng giá trị ở hasher và ở record của người thắng. */
const REQUEST_HASH = 'stable-request-hash';

/**
 * Port không mong đợi được gọi — nếu bị gọi thì test đang đi sai nhánh.
 *
 * ⚠️ Không ném lỗi D1 thật: thông điệp lỗi của D1 có thể mang bind values (payload,
 * endpoint) và đi vào log của Worker. Thông điệp ở đây chỉ chứa **tên port**.
 */
function unused(name: string): never {
  throw new Error(`port không mong đợi đã được gọi: ${name}`);
}

/** Config hợp lệ cho test — sáu SLA là hằng của test, không phải lựa chọn của service. */
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
    pushEndpointHostAllowlist: ['fcm.googleapis.com'],
  };
}

interface RaceFixture {
  readonly deps: CreateNotificationDeps;
  idempotencyFindCalls(): number;
}

/**
 * Dựng deps cho đường persist-throws.
 *
 * `raced` là record mà `idempotency.find` trả về từ **lần gọi thứ hai** (trong catch): `null`
 * nghĩa là không có record nào — lỗi storage thật; khác hash nghĩa là key đã dùng cho request
 * khác; cùng `REQUEST_HASH` nghĩa là vừa thua một cuộc đua cùng request.
 */
function raceFixture(options: {
  readonly raced: IdempotencyRecord | null;
  readonly persistThrows: boolean;
}): RaceFixture {
  let findCalls = 0;
  let idCounter = 0;

  const idempotency: PushNotificationPorts['idempotency'] = {
    find: async (): Promise<IdempotencyRecord | null> => {
      findCalls += 1;
      // Lần đầu (bước 3): chưa có record — request đi tiếp tới persist. Các lần sau (trong
      // catch): record của request thắng đã commit.
      return findCalls === 1 ? null : options.raced;
    },
    deleteEligible: async (): Promise<number> => 0,
  };

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
      listByUser: async () => [{ deviceId: 'device-1', userId: 'user-1', app: APP, createdAt: T0 }],
      insert: async () => unused('devices.insert'),
    },
    subscriptions: {
      findById: async () => unused('subscriptions.findById'),
      findByEndpointHash: async () => unused('subscriptions.findByEndpointHash'),
      listByDevice: async () => [
        {
          subscriptionId: 'sub-1',
          deviceId: 'device-1',
          userId: 'user-1',
          app: APP,
          transport: 'web',
          endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
          endpointHash: 'hash-endpoint',
          p256dh: 'p256dh',
          auth: 'auth',
          vapidKeyId: 'vapid-k1',
          providerId: 'prov-1',
          status: 'active',
          createdAt: T0,
          updatedAt: T0,
        },
      ],
      listByApp: async () => unused('subscriptions.listByApp'),
      countActiveByVapidKeyId: async () => unused('subscriptions.countActiveByVapidKeyId'),
      insert: async () => unused('subscriptions.insert'),
      reactivateWithNewSecret: async () => unused('subscriptions.reactivateWithNewSecret'),
      disableById: async () => unused('subscriptions.disableById'),
    },
    providers: {
      findById: async () => unused('providers.findById'),
      listByScope: async () => [
        {
          providerId: 'prov-1',
          app: APP,
          transport: 'web',
          type: 'web-push',
          status: 'enabled',
          emergencyHold: false,
        },
      ],
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
      persistNotificationWithDeliveries: async (
        _input: PersistNotificationInput,
      ): Promise<void> => {
        if (options.persistThrows) {
          // ⚠️ Lỗi unique constraint thật của D1 mang thông điệp chứa bind values — đúng
          // thứ catch **không** được để lộ ra ngoài (xem comment của catch).
          throw new Error('UNIQUE constraint failed: notification_idempotency.app+...');
        }
        return undefined;
      },
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
    idempotency,
    audit: { append: async () => undefined },
    routingPolicy: { find: async () => null },
  };

  return {
    deps: {
      config: testConfig(),
      ports,
      ids: {
        next: (): string => {
          idCounter += 1;
          return `id-${String(idCounter)}`;
        },
      },
      hasher: { hash: async (): Promise<string> => REQUEST_HASH },
    },
    idempotencyFindCalls: () => findCalls,
  };
}

const command = {
  requestedApp: APP,
  authenticatedApp: APP,
  principalId: PRINCIPAL,
  idempotencyKey: KEY,
  recipients: ['user-1'],
  payload: { title: 'title', body: 'body' },
} as const;

function winnerRecord(requestHash: string): IdempotencyRecord {
  return {
    app: APP,
    principalId: PRINCIPAL,
    idempotencyKey: KEY,
    requestHash,
    notificationId: NOTIFICATION_ID_WINNER,
    createdAt: T0,
  };
}

/* -------------------------------------------------------------------------------------- */
/* Catch-race                                                                                */
/* -------------------------------------------------------------------------------------- */

describe('createNotification — persist race with a concurrent winner (FR-008)', () => {
  it('returns a replay for the losing request when the raced record has the same hash', async () => {
    const fixture = raceFixture({
      raced: winnerRecord(REQUEST_HASH),
      persistThrows: true,
    });
    const result = await createNotification(fixture.deps, command);
    // ⚠️ Cùng `Idempotency-Key` + cùng canonical request hash ⇒ FR-008 đòi kết quả
    // idempotent (`200`, cùng `notification_id` của người thắng) — **không** phải
    // `storage_failure`. Request thua của một cuộc đua không phải là lỗi storage.
    expect(result).toEqual({
      ok: true,
      replayed: true,
      notificationId: NOTIFICATION_ID_WINNER,
    });
    // Find đúng hai lần: bước (3) + đọc lại trong catch.
    expect(fixture.idempotencyFindCalls()).toBe(2);
  });

  it('returns idempotency_key_conflict when the raced record has a different hash', async () => {
    const fixture = raceFixture({
      raced: winnerRecord('hash-of-the-winner'),
      persistThrows: true,
    });
    const result = await createNotification(fixture.deps, command);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('mong đợi một rejection');
    }
    // ⚠️ Cùng key + hash khác ⇒ `409` (FR-008) — và **không** trả `notification_id` của
    // request khác: caller không được học id của một request không phải của nó.
    expect(result.reason).toBe('idempotency_key_conflict');
  });

  it('returns storage_failure when persist threw and no record exists at all', async () => {
    const fixture = raceFixture({ raced: null, persistThrows: true });
    const result = await createNotification(fixture.deps, command);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('mong đợi một rejection');
    }
    // ⚠️ Không có record ⇒ đây là storage thật sự, **không** phải race — và `detail` không
    // chứa thông điệp lỗi của D1 (nó có thể mang bind values).
    expect(result.reason).toBe('storage_failure');
    expect(result.detail).not.toContain('UNIQUE');
    expect(fixture.idempotencyFindCalls()).toBe(2);
  });

  it('does not consult idempotency again when persist succeeds', async () => {
    const fixture = raceFixture({ raced: null, persistThrows: false });
    const result = await createNotification(fixture.deps, command);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('mong đợi kết quả thành công');
    }
    expect(result.replayed).toBe(false);
    expect(result.notificationId).toBe('id-1');
    // ⚠️ Chỉ một lần `find` ở bước (3): persist thành công thì không có "đọc lại trong
    // catch", và một lần đọc thừa là một query không đổi kết quả.
    expect(fixture.idempotencyFindCalls()).toBe(1);
  });
});
