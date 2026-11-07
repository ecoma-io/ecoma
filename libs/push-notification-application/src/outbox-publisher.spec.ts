/**
 * Unit test tầng unit (fake ports) cho `publishOutbox` — §6.2, FR-015.
 *
 * ⚠️ **Vì sao test này dùng fake outbox/delivery repository.** Bốn nhóm bất biến của
 * publisher nằm ở *lệnh gọi* chứ không ở SQL: no-op thuần khi không có gì claim được (không
 * `Queue.send()`), phân loại record hỏng thành ba `SkipReason` (không đốt attempts của
 * Queue), nhãn lỗi hoá (`envelope_not_built` / `queue_send_failed` — `last_error` KHÔNG nhận
 * response body của provider), và đếm `sendCalls` ≠ `published` (một publish thắng mà lease
 * mất là duplicate đã chấp nhận, không phải thành công). Tầng integration đã phủ đường
 * happy-path; những nhánh này chỉ dựng được khi repository trả đúng record theo kịch bản.
 *
 * ⚠️ **`sendCalls` là con số mà §6.2 khẳng định bằng test** ("(i) handler no-op thuần khi
 * không có gì để publish — bắt buộc, kiểm chứng bằng test"): một `send()` đi lạc là một
 * message vào Queue mà không ai claim — message mồ côi.
 */

import { describe, expect, it } from 'vitest';

import { buildDeliveryCommand, publishOutbox } from './outbox-publisher';
import type { PushNotificationConfig } from './config-port';
import type { PushNotificationPorts } from './ports';
import type { DeliveryRecord, OutboxRecord } from './records';

const T0 = 1_800_000_000_000;
const CLAIMED_BY = 'publisher-run-1';

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
      applicationPrincipal: 'ecoma-io',
    },
    credentialKeyring: { currentVersion: 'K1', servingVersions: ['K1'] },
    pushEndpointHostAllowlist: ['fcm.googleapis.com'],
  };
}

function outboxRecord(input: {
  readonly outboxId: string;
  readonly deliveryId: string;
}): OutboxRecord {
  return {
    outboxId: input.outboxId,
    deliveryId: input.deliveryId,
    status: 'publishing',
    attempts: 0,
    availableAt: T0,
    leaseExpiresAt: T0 + 30_000,
    claimedBy: CLAIMED_BY,
    lastError: null,
    createdAt: T0,
  };
}

function deliveryRecord(input: {
  readonly deliveryId: string;
  readonly status: DeliveryRecord['status'];
}): DeliveryRecord {
  return {
    deliveryId: input.deliveryId,
    notificationId: `notif-${input.deliveryId}`,
    subscriptionId: `sub-${input.deliveryId}`,
    providerId: 'prov-1',
    userId: 'user-1',
    deviceId: 'device-1',
    app: 'ecoma-io',
    transport: 'web',
    status: input.status,
    dispatchGeneration: 0,
    leaseExpiresAt: null,
    expiresAt: T0 + 86_400_000,
    createdAt: T0,
    updatedAt: T0,
  };
}

/** Payload đúng schema FR-013 — `buildDeliveryCommand` nhận và dựng được envelope. */
const VALID_PAYLOAD_JSON = JSON.stringify({ title: 'title', body: 'body' });

/** Cấu hình các nhánh của publisher — mỗi field `null` nghĩa là "trả null / không có gì". */
interface PublisherScenario {
  readonly claimed: { readonly record: OutboxRecord; readonly leaseExpiresAt: number }[];
  readonly delivery: DeliveryRecord | null;
  readonly notificationPayloadJson: string | null;
  /** `throw` = Queue.send ném; `false` = trả false; `true` = thắng. */
  readonly queueSends: boolean | 'throw';
  readonly applySuccessReturns: OutboxRecord | null;
  readonly failureReturns: OutboxRecord | null;
}

interface PublisherFixture {
  readonly deps: Parameters<typeof publishOutbox>[0];
  readonly sentCommands: unknown[];
  readonly successInputs: { outboxId: string; deliveryWrite: string; claimedBy: string }[];
  readonly failureInputs: { outboxId: string; sanitizedError: string; claimedBy: string }[];
}

function publisherFixture(scenario: PublisherScenario): PublisherFixture {
  const sentCommands: unknown[] = [];
  const successInputs: PublisherFixture['successInputs'] = [];
  const failureInputs: PublisherFixture['failureInputs'] = [];
  const claimedRecord = scenario.claimed[0]?.record ?? null;
  const ports: PushNotificationPorts = {
    clock: { now: () => T0 },
    queue: {
      send: async (message) => {
        sentCommands.push(message);
        if (scenario.queueSends === 'throw') {
          throw new Error('queue unavailable: INTERNAL_ERROR details');
        }
        return scenario.queueSends;
      },
    },
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
      findById: async () => scenario.delivery,
      listAgedNonTerminal: async () => unused('deliveries.listAgedNonTerminal'),
      findNotificationPayload: async () =>
        scenario.notificationPayloadJson === null
          ? null
          : {
              notificationId: scenario.delivery?.notificationId ?? 'notif-x',
              app: 'ecoma-io',
              principalId: 'principal-1',
              payloadJson: scenario.notificationPayloadJson,
              payloadBytes: scenario.notificationPayloadJson.length,
              expiresAt: T0 + 86_400_000,
              createdAt: T0,
            },
      listByApp: async () => unused('deliveries.listByApp'),
    },
    outbox: {
      claimDue: async () => scenario.claimed,
      findById: async () => claimedRecord,
      applyPublisherSuccess: async (input) => {
        successInputs.push({
          outboxId: input.outboxId,
          deliveryWrite: input.deliveryWrite.kind,
          claimedBy: input.claimedBy,
        });
        return scenario.applySuccessReturns;
      },
      recordPublishFailure: async (input) => {
        failureInputs.push({
          outboxId: input.outboxId,
          sanitizedError: input.sanitizedError,
          claimedBy: input.claimedBy,
        });
        return scenario.failureReturns;
      },
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
  return {
    deps: {
      config: testConfig(),
      ports,
      ids: { next: (): string => 'publisher-id-1' },
    },
    sentCommands,
    successInputs,
    failureInputs,
  };
}

describe('publishOutbox — the no-op guarantee and the result ledger (§6.2)', () => {
  it('sends nothing when the claim comes back empty', async () => {
    const fixtureBuilt = publisherFixture({
      claimed: [],
      delivery: null,
      notificationPayloadJson: null,
      queueSends: false,
      applySuccessReturns: null,
      failureReturns: null,
    });
    const result = await publishOutbox(fixtureBuilt.deps, CLAIMED_BY, T0);

    // (i) của §6.2: lượt rỗng là no-op thuần — `sendCalls: 0` là con số mà docs đòi test
    // khẳng định. Một `send()` đi lạc ở đây là message mồ côi trong Queue.
    expect(result).toEqual({
      claimed: 0,
      sendCalls: 0,
      published: 0,
      exhausted: 0,
      deferred: 0,
      skipped: [],
      leaseLost: 0,
    });
    expect(fixtureBuilt.sentCommands).toHaveLength(0);
  });

  it('publishes a healthy record: one send, delivery advanced to queued, outbox closed', async () => {
    const record = outboxRecord({ outboxId: 'ob-1', deliveryId: 'deliv-1' });
    const fixtureBuilt = publisherFixture({
      claimed: [{ record, leaseExpiresAt: T0 + 30_000 }],
      delivery: deliveryRecord({ deliveryId: 'deliv-1', status: 'pending' }),
      notificationPayloadJson: VALID_PAYLOAD_JSON,
      queueSends: true,
      applySuccessReturns: record,
      failureReturns: null,
    });
    const result = await publishOutbox(fixtureBuilt.deps, CLAIMED_BY, T0);

    expect(result).toMatchObject({ claimed: 1, sendCalls: 1, published: 1 });
    // Envelope tới Queue đúng delivery: một lẫn lộn subscription/recipient là SR-002.
    const command = fixtureBuilt.sentCommands[0] as { delivery_id?: string };
    expect(command.delivery_id).toBe('deliv-1');
    // Delivery còn `pending` → publisher mới là chủ của `pending → queued` (FR-015).
    expect(fixtureBuilt.successInputs[0]?.deliveryWrite).toBe('advance_to_queued');
    expect(fixtureBuilt.successInputs[0]?.claimedBy).toBe(CLAIMED_BY);
  });

  it('marks delivery_missing as a skip with a sanitized envelope failure, not a Queue error', async () => {
    const record = outboxRecord({ outboxId: 'ob-2', deliveryId: 'deliv-orphan' });
    const fixtureBuilt = publisherFixture({
      claimed: [{ record, leaseExpiresAt: T0 + 30_000 }],
      delivery: null,
      notificationPayloadJson: null,
      queueSends: true,
      applySuccessReturns: null,
      failureReturns: record,
    });
    const result = await publishOutbox(fixtureBuilt.deps, CLAIMED_BY, T0);

    // Dữ liệu hỏng: KHÔNG network call, KHÔNG đốt attempts của Queue — `sendCalls` phải 0
    // dù record được xử lý.
    expect(result.sendCalls).toBe(0);
    expect(result.skipped).toEqual(['delivery_missing']);
    expect(fixtureBuilt.sentCommands).toHaveLength(0);
    expect(fixtureBuilt.failureInputs[0]?.sanitizedError).toBe('envelope_not_built');
  });

  it('reports notification_missing without touching the queue', async () => {
    const record = outboxRecord({ outboxId: 'ob-3', deliveryId: 'deliv-3' });
    const fixtureBuilt = publisherFixture({
      claimed: [{ record, leaseExpiresAt: T0 + 30_000 }],
      delivery: deliveryRecord({ deliveryId: 'deliv-3', status: 'pending' }),
      notificationPayloadJson: null,
      queueSends: true,
      applySuccessReturns: null,
      failureReturns: record,
    });
    const result = await publishOutbox(fixtureBuilt.deps, CLAIMED_BY, T0);

    expect(result.skipped).toEqual(['notification_missing']);
    expect(result.sendCalls).toBe(0);
    expect(fixtureBuilt.failureInputs[0]?.sanitizedError).toBe('envelope_not_built');
  });

  it('classifies an unparsable payload as payload_invalid and still fails the record with a constant label', async () => {
    const record = outboxRecord({ outboxId: 'ob-4', deliveryId: 'deliv-4' });
    const fixtureBuilt = publisherFixture({
      claimed: [{ record, leaseExpiresAt: T0 + 30_000 }],
      delivery: deliveryRecord({ deliveryId: 'deliv-4', status: 'pending' }),
      notificationPayloadJson: '{"title": 42}',
      queueSends: true,
      applySuccessReturns: null,
      failureReturns: record,
    });
    const result = await publishOutbox(fixtureBuilt.deps, CLAIMED_BY, T0);

    // Payload sai schema FR-013: builder ném trong `resolveCommand` → skip `payload_invalid`,
    // và record ghi failed với nhãn hằng. Nhãn này là hợp đồng của cột `last_error` — nó
    // không nhận message thật vì message có thể mang payload (log injection).
    expect(result.skipped).toEqual(['payload_invalid']);
    expect(fixtureBuilt.sentCommands).toHaveLength(0);
    expect(fixtureBuilt.failureInputs[0]?.sanitizedError).toBe('envelope_not_built');
  });

  it('records a queue send failure with the queue label and counts the defer path', async () => {
    const record = outboxRecord({ outboxId: 'ob-5', deliveryId: 'deliv-5' });
    const fixtureBuilt = publisherFixture({
      claimed: [{ record, leaseExpiresAt: T0 + 30_000 }],
      delivery: deliveryRecord({ deliveryId: 'deliv-5', status: 'pending' }),
      notificationPayloadJson: VALID_PAYLOAD_JSON,
      queueSends: false,
      applySuccessReturns: null,
      failureReturns: record,
    });
    const result = await publishOutbox(fixtureBuilt.deps, CLAIMED_BY, T0);

    expect(result.sendCalls).toBe(1);
    expect(result.published).toBe(0);
    expect(result.deferred).toBe(1);
    expect(fixtureBuilt.failureInputs[0]?.sanitizedError).toBe('queue_send_failed');
  });

  it('never lets a thrown queue error escape the loop or reach the failure label', async () => {
    const record = outboxRecord({ outboxId: 'ob-6', deliveryId: 'deliv-6' });
    const fixtureBuilt = publisherFixture({
      claimed: [{ record, leaseExpiresAt: T0 + 30_000 }],
      delivery: deliveryRecord({ deliveryId: 'deliv-6', status: 'pending' }),
      notificationPayloadJson: VALID_PAYLOAD_JSON,
      queueSends: 'throw',
      applySuccessReturns: null,
      failureReturns: record,
    });

    // Exception của Queue được nuốt thành một kết quả publish lỗi bình thường: cả lô không
    // được chết theo một record, và message lỗi (có thể mang payload/secret) không được nối
    // vào `last_error`.
    const result = await publishOutbox(fixtureBuilt.deps, CLAIMED_BY, T0);
    expect(result.deferred).toBe(1);
    expect(fixtureBuilt.failureInputs[0]?.sanitizedError).toBe('queue_send_failed');
  });

  it('counts a lost lease after a successful send as leaseLost, not published', async () => {
    const record = outboxRecord({ outboxId: 'ob-7', deliveryId: 'deliv-7' });
    const fixtureBuilt = publisherFixture({
      claimed: [{ record, leaseExpiresAt: T0 + 30_000 }],
      delivery: deliveryRecord({ deliveryId: 'deliv-7', status: 'pending' }),
      notificationPayloadJson: VALID_PAYLOAD_JSON,
      queueSends: true,
      applySuccessReturns: null, // lease đã mất — applyPublisherSuccess trả null
      failureReturns: null,
    });
    const result = await publishOutbox(fixtureBuilt.deps, CLAIMED_BY, T0);

    // Publish ĐÃ xảy ra: duplicate là thứ thiết kế chấp nhận, nhưng đếm nó "published" là
    // ledger nói dối — `leaseLost` là con số đúng cho alert "publish có thể trùng".
    expect(result.sendCalls).toBe(1);
    expect(result.published).toBe(0);
    expect(result.leaseLost).toBe(1);
  });

  it('counts an exhausted record when the failure write reports failed', async () => {
    const record = outboxRecord({ outboxId: 'ob-8', deliveryId: 'deliv-8' });
    const failedRecord: OutboxRecord = { ...record, status: 'failed', attempts: 5 };
    const fixtureBuilt = publisherFixture({
      claimed: [{ record, leaseExpiresAt: T0 + 30_000 }],
      delivery: deliveryRecord({ deliveryId: 'deliv-8', status: 'pending' }),
      notificationPayloadJson: VALID_PAYLOAD_JSON,
      queueSends: false,
      applySuccessReturns: null,
      failureReturns: failedRecord,
    });
    const result = await publishOutbox(fixtureBuilt.deps, CLAIMED_BY, T0);

    // Vượt `outboxMaxPublishAttempts`: về `failed` — chờ operator, không tự xoá (§4.1).
    expect(result.exhausted).toBe(1);
    expect(result.deferred).toBe(0);
  });
});

describe('buildDeliveryCommand — envelope boundary of §6.3', () => {
  it('builds a command carrying the canonical payload fields', () => {
    const command = buildDeliveryCommand({
      deliveryId: 'deliv-9',
      notificationId: 'notif-9',
      subscriptionId: 'sub-9',
      providerId: 'prov-1',
      transport: 'web',
      payloadJson: VALID_PAYLOAD_JSON,
    });
    expect(command.delivery_id).toBe('deliv-9');
    expect(command.subscription_id).toBe('sub-9');
    expect(command.payload).toEqual({ title: 'title', body: 'body' });
  });

  it('throws on a payload that fails the FR-013 schema instead of queueing a broken message', () => {
    // Ném thay vì trả envelope hỏng: một message sai schema vào Queue là một attempt chết ở
    // worker với lý do không ai giải thích được.
    expect(() =>
      buildDeliveryCommand({
        deliveryId: 'deliv-10',
        notificationId: 'notif-10',
        subscriptionId: 'sub-10',
        providerId: 'prov-1',
        transport: 'web',
        payloadJson: 'not json at all',
      }),
    ).toThrowError('payload_json không hợp lệ theo schema FR-013');
  });
});
