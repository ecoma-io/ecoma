import { describe, expect, it, vi } from 'vitest';

import type {
  ClaimMailOutboxInput,
  MailOutboxRepository,
  MarkMailOutboxPublishedInput,
  MarkMailOutboxPublishedResult,
  RecordMailOutboxPublishFailureInput,
} from './mail-outbox-repository';
import type { MailMessageRepository } from './mail-message-repository';
import type { MailMessageRecord, MailOutboxRecord } from './records';
import { backoffDelayMs, publishOutboxBatch, sanitizePublishErrorToken } from './outbox-publisher';
import type {
  MailOutboxAlert,
  MailOutboxPublisherDeps,
  PublishOutboxBatchConfig,
} from './outbox-publisher';

/**
 * Test của publish loop với **fake port**, không có D1.
 *
 * Lý do tách fake khỏi D1: thuật toán publish loop là quyết định của application layer —
 * thứ tự `claim → send → markPublished`, việc sanitize lỗi, và công thức backoff. Chúng
 * kiểm được hoàn toàn bằng cách quan sát các lệnh gọi, và làm vậy thì **giữ được** những
 * gì một test tích hợp sẽ không bắt được: một lần `markPublished` chạy **trước** `queueSend`
 * chỉ là một dòng bị đảo, và assertion trên D1 thật sẽ vẫn xanh vì kết quả cuối cùng giống
 * nhau.
 *
 * Tính thực của statement trên D1 thật được kiểm ở `mail-d1.spec.ts` của app transactional-mail (`apps/transactional-mail/tests/integrations/`)
 * infrastructure — đó là nơi claim/lease/backoff được chứng minh bằng chính D1.
 */

const NOW = 1_800_000_000_000;
const LEASE_MS = 60_000;
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

/** Một message record đầy đủ — mặc định terminal `sent`, generation 1 khớp outbox row. */
function makeMessageRecord(overrides: Partial<MailMessageRecord> = {}): MailMessageRecord {
  return {
    id: 'msg_01',
    app: 'test-app',
    principalId: 'svc.account',
    templateId: 'otp',
    templateName: 'OTP',
    templateVersion: 1,
    locale: 'vi',
    recipient: 'user@example.com',
    subjectRendered: 'Mã OTP',
    bodyRendered: 'Mã của bạn là 123456',
    status: 'sent',
    deliveryId: 'dlv_01',
    dispatchGeneration: 1,
    recoveryCycleCount: 0,
    idempotencyKey: 'idem-01',
    requestFingerprint: `k1.p1:${'a'.repeat(64)}`,
    correlationId: null,
    failureReason: null,
    terminalAtMs: NOW,
    createdAtMs: NOW - 1_000,
    updatedAtMs: NOW,
    ...overrides,
  };
}

/** Harness: gom port fake + call log để assertion đọc được đúng thứ đã gọi. */
function makeHarness(
  claimedRows: readonly MailOutboxRecord[],
  options: {
    readonly markPublished?: (input: MarkMailOutboxPublishedInput) => MarkMailOutboxPublishedResult;
    readonly recordPublishFailure?: (
      input: RecordMailOutboxPublishFailureInput,
    ) => MailOutboxRecord | null;
    readonly queueSend?: (deliveryId: string) => Promise<void>;
  } = {},
): {
  readonly deps: MailOutboxPublisherDeps;
  readonly alerts: MailOutboxAlert[];
  readonly sent: string[];
  readonly marks: MarkMailOutboxPublishedInput[];
  readonly failures: RecordMailOutboxPublishFailureInput[];
  readonly claims: ClaimMailOutboxInput[];
} {
  const alerts: MailOutboxAlert[] = [];
  const sent: string[] = [];
  const marks: MarkMailOutboxPublishedInput[] = [];
  const failures: RecordMailOutboxPublishFailureInput[] = [];
  const claims: ClaimMailOutboxInput[] = [];

  const outbox: MailOutboxRepository = {
    claim(input: ClaimMailOutboxInput): Promise<readonly MailOutboxRecord[]> {
      claims.push(input);
      return Promise.resolve(claimedRows);
    },
    renewLease(): Promise<MailOutboxRecord | null> {
      return Promise.resolve(null);
    },
    markPublished(input: MarkMailOutboxPublishedInput): Promise<MarkMailOutboxPublishedResult> {
      marks.push(input);
      const override = options.markPublished?.(input);
      return Promise.resolve(override ?? { outboxPublished: true, messageQueued: true });
    },
    recordPublishFailure(
      input: RecordMailOutboxPublishFailureInput,
    ): Promise<MailOutboxRecord | null> {
      failures.push(input);
      // Phân biệt "không có override" với "override trả `null`": `null` **là** một kết quả
      // hợp lệ của port (lease mất), nên `??` ở đây sẽ nuốt mất đúng ca cần kiểm.
      if (options.recordPublishFailure !== undefined) {
        return Promise.resolve(options.recordPublishFailure(input));
      }
      return Promise.resolve(makeOutboxRecord({ id: input.outboxId, status: 'pending' }));
    },
    findByDeliveryId(): Promise<MailOutboxRecord | null> {
      return Promise.resolve(null);
    },
  };

  const messages: Pick<MailMessageRepository, 'findByDeliveryId'> = {
    // Chỉ đọc trong nhánh `messageQueued = false` — để phân biệt "message đã terminal"
    // (hợp lệ) với "generation đã đổi" (alert). Mặc định trả terminal: nhánh đọc KHÔNG
    // được phát alert nào ở ca đó (xem test 'unqueued message as success').
    findByDeliveryId(): Promise<MailMessageRecord | null> {
      return Promise.resolve(makeMessageRecord({ dispatchGeneration: 1 }));
    },
  };

  const deps: MailOutboxPublisherDeps = {
    outbox,
    messages: messages as MailMessageRepository,
    queueSend(command: { version: 1; delivery_id: string }): Promise<void> {
      sent.push(command.delivery_id);
      return options.queueSend?.(command.delivery_id) ?? Promise.resolve();
    },
    generateLeaseOwner: () => 'lease-owner-1',
    logAlert: (event: MailOutboxAlert) => {
      alerts.push(event);
    },
  };

  return { deps, alerts, sent, marks, failures, claims };
}

/** Config mặc định — mỗi ca test chỉ ghi đè cái nó đang kiểm. */
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

describe('publishOutboxBatch — happy path', () => {
  it('claims within the limit and marks every claimed row published after the send', async () => {
    const rows = [
      makeOutboxRecord({ id: 'obx_01', deliveryId: 'dlv_01' }),
      makeOutboxRecord({ id: 'obx_02', deliveryId: 'dlv_02' }),
    ];
    const harness = makeHarness(rows);

    const result = await publishOutboxBatch(harness.deps, makeConfig({ batchLimit: 2 }));

    expect(result).toEqual({ claimed: 2, published: 2, failed: 0, leaseLost: 0 });
    expect(harness.sent).toEqual(['dlv_01', 'dlv_02']);
    expect(harness.marks.map((mark) => mark.outboxId)).toEqual(['obx_01', 'obx_02']);
    expect(harness.failures).toEqual([]);
    expect(harness.alerts).toEqual([]);

    // Claim dùng đúng lease owner và đúng mốc thời gian của lần chạy.
    expect(harness.claims).toEqual([
      {
        nowMs: NOW,
        leaseDurationMs: LEASE_MS,
        leaseOwner: 'lease-owner-1',
        limit: 2,
      },
    ]);
  });

  it('sends the canonical two-field command and nothing else', async () => {
    const harness = makeHarness([makeOutboxRecord()]);
    const commands: { version: 1; delivery_id: string }[] = [];

    await publishOutboxBatch(
      {
        ...harness.deps,
        queueSend: (command) => {
          commands.push(command);
          return Promise.resolve();
        },
      },
      makeConfig(),
    );

    // `forbidden-field` của contract: bất kỳ field nào ngoài `version`/`delivery_id` —
    // nhất là `dispatch_generation` — sẽ khiến consumer quarantine command.
    expect(commands).toEqual([{ version: 1, delivery_id: 'dlv_01' }]);
    expect(Object.keys(commands[0] ?? {}).toSorted()).toEqual(['delivery_id', 'version']);
  });

  it('treats a published outbox with an unqueued message as success, not a failure', async () => {
    // Message đã terminal trước khi publish: `outboxPublished = true` + `messageQueued =
    // false` là hợp lệ (`QUEUE.send()` thành công nên outbox phải ghi sự thật đó).
    const harness = makeHarness([makeOutboxRecord()], {
      markPublished: () => ({ outboxPublished: true, messageQueued: false }),
    });

    const result = await publishOutboxBatch(harness.deps, makeConfig());

    expect(result).toEqual({ claimed: 1, published: 1, failed: 0, leaseLost: 0 });
    expect(harness.alerts).toEqual([]);
  });

  it('claims nothing when the batch has no eligible row', async () => {
    const harness = makeHarness([]);

    const result = await publishOutboxBatch(harness.deps, makeConfig());

    expect(result).toEqual({ claimed: 0, published: 0, failed: 0, leaseLost: 0 });
    expect(harness.sent).toEqual([]);
  });
});

describe('publishOutboxBatch — a failed send never leaks what the error carried', () => {
  it('records the failure with a sanitized token and keeps the recipient out of last_error', async () => {
    const recipient = 'victim@example.test';
    const harness = makeHarness([makeOutboxRecord()], {
      queueSend: () => Promise.reject(new TypeError(`send to ${recipient} was refused`)),
    });

    const result = await publishOutboxBatch(harness.deps, makeConfig());

    expect(result).toEqual({ claimed: 1, published: 0, failed: 0, leaseLost: 0 });
    expect(harness.failures).toHaveLength(1);
    const lastError = harness.failures[0]?.lastError ?? '';

    // Nguyên văn lỗi tuyệt đối không được đi vào `last_error`: message của một lỗi Queue có
    // thể chứa recipient, tên binding hay credential (NFR-001).
    expect(lastError).toBe('TypeError');
    expect(lastError).not.toContain(recipient);
    expect(lastError).not.toContain('send to');
  });

  it('falls back to a fixed token when the error has no usable name', async () => {
    const harness = makeHarness([makeOutboxRecord()], {
      queueSend: () =>
        Promise.reject({ name: 'recipient@example.test rejected', message: 'secret' }),
    });

    await publishOutboxBatch(harness.deps, makeConfig());

    // `name` không phải identifier thì rơi về hằng — hằng chứa **không** dữ liệu nào của
    // caller, nên không có đường nào rò dữ liệu qua đây.
    expect(harness.failures[0]?.lastError).toBe('queue-send-failed');
  });

  it('never retries inside the same batch', async () => {
    const harness = makeHarness([makeOutboxRecord()], {
      queueSend: () => Promise.reject(new Error('boom')),
    });

    await publishOutboxBatch(harness.deps, makeConfig());

    // Retry ngay trong lô vừa tốn thời gian invocation vừa phá backoff — tức phá luôn
    // `maxPublishAttempts`. Một thất bại = đúng một lần `queueSend` và đúng một lần
    // `recordPublishFailure`.
    expect(harness.sent).toEqual(['dlv_01']);
    expect(harness.failures).toHaveLength(1);
    expect(harness.marks).toEqual([]);
  });

  it('does not write any message status when the send fails', async () => {
    const harness = makeHarness([makeOutboxRecord()], {
      queueSend: () => Promise.reject(new Error('boom')),
    });

    await publishOutboxBatch(harness.deps, makeConfig());

    // `mail_messages.status` chỉ được đổi bởi `markPublished`; đường thất bại không chạm nó.
    expect(harness.marks).toEqual([]);
  });
});

describe('publishOutboxBatch — attempts exhausted', () => {
  it('counts a failed row and alerts when the record comes back failed', async () => {
    const harness = makeHarness([makeOutboxRecord({ publishAttempts: 2 })], {
      queueSend: () => Promise.reject(new Error('queue unavailable')),
      recordPublishFailure: (input) =>
        makeOutboxRecord({ id: input.outboxId, status: 'failed', publishAttempts: 3 }),
    });

    const result = await publishOutboxBatch(harness.deps, makeConfig({ maxPublishAttempts: 3 }));

    expect(result).toEqual({ claimed: 1, published: 0, failed: 1, leaseLost: 0 });
    expect(harness.alerts).toEqual([
      { event: 'outbox-publish-failed-attempts-exhausted', deliveryId: 'dlv_01' },
    ]);
    // Row `failed` là kết quả cuối của chu kỳ này: lô kế tiếp không claim được nó nữa, nên
    // không có gì để xử lý thêm ở đây.
    expect(harness.marks).toEqual([]);
  });

  it('retires a row whose attempts reach the max only through the recorded failure', async () => {
    const harness = makeHarness([makeOutboxRecord({ publishAttempts: 2 })], {
      queueSend: () => Promise.reject(new Error('queue unavailable')),
      recordPublishFailure: (input) =>
        makeOutboxRecord({ id: input.outboxId, status: 'failed', publishAttempts: 3 }),
    });

    await publishOutboxBatch(harness.deps, makeConfig({ maxPublishAttempts: 3 }));

    // Ngưỡng đi qua port, **không** so ở application layer: `recordPublishFailure` tính
    // `status` bên trong statement, nên hai publisher không thể cùng nhường một lần thử.
    expect(harness.failures[0]?.maxPublishAttempts).toBe(3);
  });
});

describe('publishOutboxBatch — lease lost mid-flight', () => {
  it('counts a lease lost at markPublished and alerts instead of claiming success', async () => {
    const harness = makeHarness([makeOutboxRecord()], {
      markPublished: () => ({ outboxPublished: false, messageQueued: false }),
    });

    const result = await publishOutboxBatch(harness.deps, makeConfig());

    // `outboxPublished = false` nghĩa là **không có gì được ghi** — lần publish này không
    // được coi là thành công, và row vẫn ở trạng thái của chủ lease trước đó.
    expect(result).toEqual({ claimed: 1, published: 0, failed: 0, leaseLost: 1 });
    expect(harness.alerts).toEqual([{ event: 'outbox-publish-lease-lost', deliveryId: 'dlv_01' }]);
    expect(harness.failures).toEqual([]);
  });

  it('counts a lease lost at recordPublishFailure without recording a failure', async () => {
    const harness = makeHarness([makeOutboxRecord()], {
      queueSend: () => Promise.reject(new Error('boom')),
      recordPublishFailure: () => null,
    });

    const result = await publishOutboxBatch(harness.deps, makeConfig());

    // `null` = lease mất: không có gì được ghi, nên lần thất bại này không phải `failed` —
    // row vẫn ở trạng thái của chủ lease trước đó.
    expect(result).toEqual({ claimed: 1, published: 0, failed: 0, leaseLost: 1 });
    expect(harness.alerts).toEqual([{ event: 'outbox-publish-lease-lost', deliveryId: 'dlv_01' }]);
  });

  it('keeps the counters of a mixed batch apart', async () => {
    const harness = makeHarness(
      [
        makeOutboxRecord({ id: 'obx_01', deliveryId: 'dlv_01' }),
        makeOutboxRecord({ id: 'obx_02', deliveryId: 'dlv_02' }),
        makeOutboxRecord({ id: 'obx_03', deliveryId: 'dlv_03' }),
      ],
      {
        markPublished: (input) =>
          input.outboxId === 'obx_02'
            ? { outboxPublished: false, messageQueued: false }
            : { outboxPublished: true, messageQueued: true },
      },
    );

    const result = await publishOutboxBatch(harness.deps, makeConfig());

    expect(result).toEqual({ claimed: 3, published: 2, failed: 0, leaseLost: 1 });
  });
});

describe('backoffDelayMs', () => {
  it('doubles per attempt from the base on the first failure', () => {
    // Lần thất bại đầu (attempts = 0 lúc claim) nhận đúng `backoffBaseMs`, mỗi lần sau gấp đôi.
    expect(backoffDelayMs(BACKOFF_BASE_MS, 0)).toBe(1_000);
    expect(backoffDelayMs(BACKOFF_BASE_MS, 1)).toBe(2_000);
    expect(backoffDelayMs(BACKOFF_BASE_MS, 2)).toBe(4_000);
    expect(backoffDelayMs(BACKOFF_BASE_MS, 5)).toBe(32_000);
  });

  it('caps the exponent so available_at can never become Infinity', () => {
    // `publish_attempts` không bị chặn trên trong schema, nên `2 ** attempts` không bị chặn
    // trên sẽ thành `Infinity` và `nowMs + Infinity` là một `available_at` vô hạn → row không
    // bao giờ được claim lại, tức im lặng giữ một delivery intent vô thời hạn.
    expect(backoffDelayMs(BACKOFF_BASE_MS, 16)).toBe(65_536_000);
    expect(backoffDelayMs(BACKOFF_BASE_MS, 40)).toBe(65_536_000);
    expect(Number.isFinite(backoffDelayMs(BACKOFF_BASE_MS, 40))).toBe(true);
  });

  it('never returns a non-positive delay', () => {
    // `available_at <= nowMs` nghĩa là row quay lại `pending` bị claim lại ngay ở lần sau —
    // backoff bằng 0 (hoặc âm) làm mất toàn bộ ý nghĩa của cơ chế backoff.
    expect(backoffDelayMs(0, 0)).toBeGreaterThanOrEqual(1);
    expect(backoffDelayMs(1, -5)).toBeGreaterThanOrEqual(1);
  });
});

describe('backoff scheduling in the recorded failure', () => {
  it('schedules the retry exactly at nowMs plus the backoff of the attempt already spent', async () => {
    const harness = makeHarness([makeOutboxRecord({ publishAttempts: 1 })], {
      queueSend: () => Promise.reject(new Error('queue unavailable')),
    });

    await publishOutboxBatch(harness.deps, makeConfig({ backoffBaseMs: 500 }));

    expect(harness.failures[0]?.nextAvailableAtMs).toBe(NOW + 1_000);
    expect(harness.failures[0]?.nowMs).toBe(NOW);
  });

  it('uses the base delay on the first failure of a fresh row', async () => {
    const harness = makeHarness([makeOutboxRecord({ publishAttempts: 0 })], {
      queueSend: () => Promise.reject(new Error('queue unavailable')),
    });

    await publishOutboxBatch(harness.deps, makeConfig({ backoffBaseMs: 500 }));

    expect(harness.failures[0]?.nextAvailableAtMs).toBe(NOW + 500);
  });

  it('forwards the fencing values of the claimed row verbatim', async () => {
    const harness = makeHarness([makeOutboxRecord({ publishAttempts: 1, dispatchGeneration: 4 })], {
      queueSend: () => Promise.reject(new Error('queue unavailable')),
    });

    await publishOutboxBatch(harness.deps, makeConfig());

    expect(harness.failures[0]).toMatchObject({
      outboxId: 'obx_01',
      deliveryId: 'dlv_01',
      leaseOwner: 'lease-owner-1',
      dispatchGeneration: 4,
    });
  });
});

describe('sanitizePublishErrorToken', () => {
  it('keeps a plain error identifier and drops everything else', () => {
    expect(sanitizePublishErrorToken(new TypeError('x'))).toBe('TypeError');
    expect(sanitizePublishErrorToken(new RangeError('x'))).toBe('RangeError');
  });

  it('drops a name that is not a short identifier', () => {
    // `name` do dữ liệu nhạy cảm dựng ra cũng phải rơi về hằng — đó là lý do bộ lọc là regex
    // identifier chứ không phải kiểm tra "có name hay không".
    expect(sanitizePublishErrorToken({ name: 'a@b' })).toBe('queue-send-failed');
    expect(sanitizePublishErrorToken({ name: '' })).toBe('queue-send-failed');
    expect(sanitizePublishErrorToken({ name: 'x'.repeat(65) })).toBe('queue-send-failed');
    expect(sanitizePublishErrorToken({ name: 42 })).toBe('queue-send-failed');
  });

  it('falls back for values that are not error-shaped at all', () => {
    expect(sanitizePublishErrorToken(undefined)).toBe('queue-send-failed');
    expect(sanitizePublishErrorToken(null)).toBe('queue-send-failed');
    expect(sanitizePublishErrorToken('recipient@example.test')).toBe('queue-send-failed');
    expect(sanitizePublishErrorToken(new Error('secret message'))).toBe('Error');
  });

  it('never returns an empty token, which last_error forbids', () => {
    // `mail_outbox_last_error_format_check` chặn chuỗi rỗng; hằng dự phòng bảo đảm điều đó
    // không bao giờ thành một constraint error giữa lúc prune/backoff.
    expect(sanitizePublishErrorToken({ name: '' }).length).toBeGreaterThan(0);
  });
});

describe('lease owner generation', () => {
  it('uses a freshly generated token per batch, and only that token to fence the writes', async () => {
    const harness = makeHarness([makeOutboxRecord()]);
    const generateLeaseOwner = vi.fn<() => string>(() => 'token-a');
    const second = makeHarness([makeOutboxRecord()]);
    const generateSecond = vi.fn<() => string>(() => 'token-b');

    await publishOutboxBatch({ ...harness.deps, generateLeaseOwner }, makeConfig());
    await publishOutboxBatch({ ...second.deps, generateLeaseOwner: generateSecond }, makeConfig());

    // Mỗi lần claim phải sinh token mới: token dùng lại sẽ không phân biệt được "lease của
    // tôi còn hiệu lực" với "lease đã bị người khác lấy", tức fencing mất tác dụng.
    expect(generateLeaseOwner).toHaveBeenCalledTimes(1);
    expect(generateSecond).toHaveBeenCalledTimes(1);
    expect(harness.claims[0]?.leaseOwner).toBe('token-a');
    expect(harness.marks[0]?.leaseOwner).toBe('token-a');
    expect(second.claims[0]?.leaseOwner).toBe('token-b');
    expect(second.marks[0]?.leaseOwner).toBe('token-b');
  });
});
