import { describe, expect, it } from 'vitest';

import type {
  ClaimMailOutboxInput,
  MailOutboxRepository,
  MarkMailOutboxPublishedResult,
  RecordMailOutboxPublishFailureInput,
} from './mail-outbox-repository';
import type { MailMessageRepository } from './mail-message-repository';
import type { MailMessageRecord, MailOutboxRecord } from './records';
import { publishOutboxBatch } from './outbox-publisher';
import type {
  MailOutboxAlert,
  MailOutboxPublisherDeps,
  PublishOutboxBatchConfig,
} from './outbox-publisher';

/**
 * Bổ sung unit tier của `publishOutboxBatch` cho những ca mà `outbox-publisher.spec.ts`
 * chưa có bằng chứng — tách file để không đụng suite gốc của PR-B.
 *
 * Ca đầu tiên là alert `outbox-publish-stale-generation`: nhánh `messageQueued = false`
 * có **hai** nguyên nhân gộp lại (message terminal — hợp lệ; generation lệch — bất thường),
 * và phân biệt giữa hai nguyên nhân là một đường đọc `findByDeliveryId` kèm alert, nhưng
 * chưa có ca nào ghim alert đó — kể cả alert **không** được phát cho ca terminal, tức ca
 * mà harness mặc định của suite gốc trả về.
 */

const NOW = 1_800_000_000_000;
const LEASE_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;

/** Một outbox row đầy đủ — sửa từng field cho từng ca test. */
function makeOutboxRecord(overrides: Partial<MailOutboxRecord> = {}): MailOutboxRecord {
  return {
    id: 'obx_01',
    deliveryId: 'dlv_01',
    dispatchGeneration: 1,
    status: 'publishing',
    publishAttempts: 0,
    availableAtMs: NOW,
    claimedAtMs: NOW,
    claimedBy: 'lease-owner-1',
    publishedAtMs: null,
    lastError: null,
    createdAtMs: NOW - 1_000,
    updatedAtMs: NOW,
    ...overrides,
  };
}

/** Message record — default terminal `sent`, generation 1 khớp outbox row. */
function makeMessageRecord(overrides: Partial<MailMessageRecord> = {}): MailMessageRecord {
  return {
    id: 'msg_01',
    app: 'test-app',
    principalId: 'svc.account',
    templateId: 'otp',
    templateName: 'OTP',
    templateVersion: 1,
    locale: 'en',
    recipient: 'user@example.test',
    subjectRendered: 'Subject',
    bodyRendered: 'Body',
    status: 'sent',
    deliveryId: 'dlv_01',
    dispatchGeneration: 1,
    recoveryCycleCount: 0,
    idempotencyKey: 'idem-01',
    requestFingerprint: `p1.k1:${'a'.repeat(64)}`,
    correlationId: null,
    failureReason: null,
    terminalAtMs: NOW,
    createdAtMs: NOW - 1_000,
    updatedAtMs: NOW,
    ...overrides,
  };
}

/** Harness tối giản: markPublished luôn trả `messageQueued = false` — nhánh cần phân tích. */
function makeStaleGenerationHarness(options: {
  readonly storedMessage: MailMessageRecord | null;
}): {
  readonly deps: MailOutboxPublisherDeps;
  readonly alerts: MailOutboxAlert[];
  readonly readDeliveryIds: string[];
} {
  const alerts: MailOutboxAlert[] = [];
  const readDeliveryIds: string[] = [];

  const outbox: MailOutboxRepository = {
    claim(input: ClaimMailOutboxInput): Promise<readonly MailOutboxRecord[]> {
      // Một row đủ điều kiện cho mỗi lần claim — harness này chỉ phục vụ ca một row.
      return Promise.resolve([makeOutboxRecord({ claimedBy: input.leaseOwner })]);
    },
    renewLease(): Promise<MailOutboxRecord | null> {
      return Promise.resolve(null);
    },
    markPublished(): Promise<MarkMailOutboxPublishedResult> {
      // Outbox đóng được nhưng message không kéo về `queued`: đúng hình dạng mà cả hai
      // nguyên nhân của nhánh này sinh ra.
      return Promise.resolve({ outboxPublished: true, messageQueued: false });
    },
    recordPublishFailure(
      input: RecordMailOutboxPublishFailureInput,
    ): Promise<MailOutboxRecord | null> {
      return Promise.resolve(makeOutboxRecord({ id: input.outboxId, status: 'pending' }));
    },
    findByDeliveryId(): Promise<MailOutboxRecord | null> {
      return Promise.resolve(null);
    },
  };

  const messages: Pick<MailMessageRepository, 'findByDeliveryId'> = {
    findByDeliveryId(deliveryId: string): Promise<MailMessageRecord | null> {
      readDeliveryIds.push(deliveryId);
      return Promise.resolve(options.storedMessage);
    },
  };

  return {
    deps: {
      outbox,
      messages: messages as MailMessageRepository,
      queueSend: () => Promise.resolve(),
      generateLeaseOwner: () => 'lease-owner-1',
      logAlert: (event: MailOutboxAlert) => {
        alerts.push(event);
      },
    },
    alerts,
    readDeliveryIds,
  };
}

function makeConfig(overrides: Partial<PublishOutboxBatchConfig> = {}): PublishOutboxBatchConfig {
  return {
    leaseMs: LEASE_MS,
    batchLimit: 10,
    maxPublishAttempts: 3,
    backoffBaseMs: BACKOFF_BASE_MS,
    nowMs: NOW,
    ...overrides,
  };
}

/**
 * Harness cho ca cả lô send đều fail: `markPublished` không bao giờ được chạm tới —
 * ném lỗi để một đường publish trái luật bị phát hiện ngay tại assertion.
 */
function makeHarnessForSendFailure(): {
  readonly deps: MailOutboxPublisherDeps;
  readonly failures: RecordMailOutboxPublishFailureInput[];
} {
  const failures: RecordMailOutboxPublishFailureInput[] = [];
  const outbox: MailOutboxRepository = {
    claim(): Promise<readonly MailOutboxRecord[]> {
      return Promise.resolve([
        makeOutboxRecord({ id: 'obx_01', deliveryId: 'dlv_01' }),
        makeOutboxRecord({ id: 'obx_02', deliveryId: 'dlv_02' }),
      ]);
    },
    renewLease(): Promise<MailOutboxRecord | null> {
      return Promise.resolve(null);
    },
    markPublished(): Promise<MarkMailOutboxPublishedResult> {
      throw new Error('test invariant broken: publish must fail in this scenario');
    },
    recordPublishFailure(
      input: RecordMailOutboxPublishFailureInput,
    ): Promise<MailOutboxRecord | null> {
      failures.push(input);
      return Promise.resolve(makeOutboxRecord({ id: input.outboxId, status: 'pending' }));
    },
    findByDeliveryId(): Promise<MailOutboxRecord | null> {
      return Promise.resolve(null);
    },
  };
  const messages: Pick<MailMessageRepository, 'findByDeliveryId'> = {
    findByDeliveryId(): Promise<MailMessageRecord | null> {
      return Promise.resolve(null);
    },
  };
  return {
    deps: {
      outbox,
      messages: messages as MailMessageRepository,
      queueSend: () => Promise.reject(new Error('queue unavailable')),
      generateLeaseOwner: () => 'lease-owner-1',
      logAlert: () => undefined,
    },
    failures,
  };
}

/**
 * Harness ghim seam của reconciler: đếm số lần `renewLease` và `markPublished` được gọi.
 * Counter trả về qua getter — sao chép số nguyên tại thời điểm return sẽ đóng băng giá trị
 * trước khi `publishOutboxBatch` chạy và làm mất tác dụng của spy.
 */
function makeHarnessWithSpies(rows: readonly MailOutboxRecord[]): {
  readonly deps: MailOutboxPublisherDeps;
  readonly renewCalls: number;
  readonly markCalls: number;
} {
  let renewCalls = 0;
  let markCalls = 0;
  const outbox: MailOutboxRepository = {
    claim(): Promise<readonly MailOutboxRecord[]> {
      return Promise.resolve(rows);
    },
    renewLease(): Promise<MailOutboxRecord | null> {
      renewCalls += 1;
      return Promise.resolve(null);
    },
    markPublished(): Promise<MarkMailOutboxPublishedResult> {
      markCalls += 1;
      return Promise.resolve({ outboxPublished: true, messageQueued: true });
    },
    recordPublishFailure(
      input: RecordMailOutboxPublishFailureInput,
    ): Promise<MailOutboxRecord | null> {
      return Promise.resolve(makeOutboxRecord({ id: input.outboxId, status: 'pending' }));
    },
    findByDeliveryId(): Promise<MailOutboxRecord | null> {
      return Promise.resolve(null);
    },
  };
  const messages: Pick<MailMessageRepository, 'findByDeliveryId'> = {
    findByDeliveryId(): Promise<MailMessageRecord | null> {
      return Promise.resolve(null);
    },
  };
  return {
    deps: {
      outbox,
      messages: messages as MailMessageRepository,
      queueSend: () => Promise.resolve(),
      generateLeaseOwner: () => 'lease-owner-1',
      logAlert: () => undefined,
    },
    get renewCalls(): number {
      return renewCalls;
    },
    get markCalls(): number {
      return markCalls;
    },
  };
}

describe('publishOutboxBatch — stale generation detection on an unqueued message', () => {
  it('alerts outbox-publish-stale-generation when the stored message carries a different generation', async () => {
    // Redrive đã đổi generation của message lên 2, nhưng publisher này claim row ở
    // generation 1: `messageQueued = false` không phải ca terminal — phải alert.
    const harness = makeStaleGenerationHarness({
      storedMessage: makeMessageRecord({ status: 'accepted', dispatchGeneration: 2 }),
    });

    const result = await publishOutboxBatch(harness.deps, makeConfig());

    expect(result).toEqual({ claimed: 1, published: 1, failed: 0, leaseLost: 0 });
    expect(harness.alerts).toEqual([
      { event: 'outbox-publish-stale-generation', deliveryId: 'dlv_01' },
    ]);
    // Phân biệt đi qua đúng một đường đọc lại.
    expect(harness.readDeliveryIds).toEqual(['dlv_01']);
  });

  it('alerts nothing for a terminal stored message and still reads it back once', async () => {
    // Ca ngược lại: message đã terminal — `messageQueued = false` là hợp lệ, KHÔNG được
    // alert. Suite gốc chỉ ghim kết quả đếm của ca này, chưa ghim việc không alert.
    const harness = makeStaleGenerationHarness({
      storedMessage: makeMessageRecord({ status: 'sent', dispatchGeneration: 1 }),
    });

    await publishOutboxBatch(harness.deps, makeConfig());

    expect(harness.alerts).toEqual([]);
    expect(harness.readDeliveryIds).toEqual(['dlv_01']);
  });

  it('alerts nothing when the message row no longer exists', async () => {
    // Row message biến mất (retention xoá content không xoá row, nhưng ca này mô tả bất
    // thường dữ liệu): `null` không phải bằng chứng generation lệch — fail im lặng về
    // phía alert, vẫn là `published`.
    const harness = makeStaleGenerationHarness({ storedMessage: null });

    const result = await publishOutboxBatch(harness.deps, makeConfig());

    expect(result).toEqual({ claimed: 1, published: 1, failed: 0, leaseLost: 0 });
    expect(harness.alerts).toEqual([]);
    expect(harness.readDeliveryIds).toEqual(['dlv_01']);
  });
});

describe('publishOutboxBatch — multiple failures share one batch clock', () => {
  it('schedules every failed row of the batch from the same nowMs with per-row backoff', async () => {
    // Hai row với `publishAttempts` khác nhau thất bại trong CÙNG lô: cả hai cùng mốc
    // `nowMs`, còn `nextAvailableAtMs` khác nhau theo attempts của từng row — ghim rằng
    // clock của lần chạy là một, không phải mỗi row một mốc.
    const sentDeliveries: string[] = [];
    const failures: RecordMailOutboxPublishFailureInput[] = [];
    const alerts: MailOutboxAlert[] = [];

    const outbox: MailOutboxRepository = {
      claim(): Promise<readonly MailOutboxRecord[]> {
        return Promise.resolve([
          makeOutboxRecord({ id: 'obx_fresh', deliveryId: 'dlv_fresh', publishAttempts: 0 }),
          makeOutboxRecord({ id: 'obx_retried', deliveryId: 'dlv_retried', publishAttempts: 2 }),
        ]);
      },
      renewLease(): Promise<MailOutboxRecord | null> {
        return Promise.resolve(null);
      },
      markPublished(): Promise<MarkMailOutboxPublishedResult> {
        throw new Error('test invariant broken: publish must fail in this scenario');
      },
      recordPublishFailure(
        input: RecordMailOutboxPublishFailureInput,
      ): Promise<MailOutboxRecord | null> {
        failures.push(input);
        return Promise.resolve(makeOutboxRecord({ id: input.outboxId, status: 'pending' }));
      },
      findByDeliveryId(): Promise<MailOutboxRecord | null> {
        return Promise.resolve(null);
      },
    };

    const messages: Pick<MailMessageRepository, 'findByDeliveryId'> = {
      findByDeliveryId(): Promise<MailMessageRecord | null> {
        return Promise.resolve(null);
      },
    };

    await publishOutboxBatch(
      {
        outbox,
        messages: messages as MailMessageRepository,
        queueSend: (command) => {
          sentDeliveries.push(command.delivery_id);
          return Promise.reject(new Error('queue unavailable'));
        },
        generateLeaseOwner: () => 'lease-owner-1',
        logAlert: (event) => {
          alerts.push(event);
        },
      },
      makeConfig({ backoffBaseMs: 500 }),
    );

    // Cả hai row đều bị ghi thất bại tại cùng mốc `nowMs` của lô...
    expect(sentDeliveries.toSorted()).toEqual(['dlv_fresh', 'dlv_retried']);
    expect(failures.map((failure) => failure.nowMs)).toEqual([NOW, NOW]);
    // ...với backoff theo attempts riêng của từng row: 0 → 500ms, 2 → 2000ms.
    const byDelivery = new Map(failures.map((failure) => [failure.deliveryId, failure]));
    expect(byDelivery.get('dlv_fresh')?.nextAvailableAtMs).toBe(NOW + 500);
    expect(byDelivery.get('dlv_retried')?.nextAvailableAtMs).toBe(NOW + 2_000);
    // Không row nào chạm max attempts nên không alert exhausted nào.
    expect(alerts).toEqual([]);
  });
});

describe('publishOutboxBatch — send failure path', () => {
  it('keeps the published counter at zero for a batch where every send fails', async () => {
    const harness = makeHarnessForSendFailure();

    const result = await publishOutboxBatch(harness.deps, makeConfig());

    expect(result).toEqual({ claimed: 2, published: 0, failed: 0, leaseLost: 0 });
    expect(harness.failures).toHaveLength(2);
  });
});

describe('publishOutboxBatch — reconciler contract seams', () => {
  it('never touches renewLease during a normal batch', async () => {
    // `renewLease` là seam của worker reliability wave sau; publish loop hiện tại không
    // gọi nó — ghim để một đường renew vô tình chèn vào giữa claim và markPublished bị bắt.
    const harness = makeHarnessWithSpies([makeOutboxRecord()]);

    await publishOutboxBatch(harness.deps, makeConfig());

    expect(harness.renewCalls).toBe(0);
    expect(harness.markCalls).toBe(1);
  });
});
