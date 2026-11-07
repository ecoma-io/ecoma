import { describe, expect, it } from 'vitest';

import type { MailMessageRecord, MailOutboxRecord } from './records';
import { runOutboxReconciler } from './outbox-reconciler';
import type {
  MailOutboxReconcilerDeps,
  MailReconcilerAlert,
  RedispatchMailOutboxResult,
  RunOutboxReconcilerConfig,
} from './outbox-reconciler';

/**
 * Test của reconciler với **fake port**, không có D1.
 *
 * Trọng tâm là **quyết định**: candidate nào được re-dispatch, cái nào bị bỏ qua, cái nào
 * chỉ alert. Đó là quyết định của application layer và nó đọc được bằng cách quan sát các
 * lệnh gọi. Tính thực của câu SQL re-dispatch (một `db.batch()` hai bảng, ngân sách A trong
 * `WHERE`) là việc của adapter composition root, không phải của module này.
 */

const NOW = 1_800_000_000_000;
const MAX_AGE_MS = 600_000;

function makeMessage(overrides: Partial<MailMessageRecord> = {}): MailMessageRecord {
  return {
    id: 'msg_01',
    app: 'ecoma',
    principalId: 'svc.account',
    templateId: 'tpl_01',
    templateName: 'receipt',
    templateVersion: 1,
    locale: 'en',
    recipient: 'victim@example.test',
    subjectRendered: 'subject',
    bodyRendered: '<p>body</p>',
    status: 'queued',
    deliveryId: 'dlv_01',
    dispatchGeneration: 1,
    recoveryCycleCount: 0,
    idempotencyKey: 'key-01',
    requestFingerprint: `p1.k1:${'a'.repeat(64)}`,
    correlationId: null,
    failureReason: null,
    terminalAtMs: null,
    createdAtMs: NOW - MAX_AGE_MS - 1_000,
    updatedAtMs: NOW - MAX_AGE_MS - 1_000,
    ...overrides,
  };
}

function makeOutbox(overrides: Partial<MailOutboxRecord> = {}): MailOutboxRecord {
  return {
    id: 'obx_01',
    deliveryId: 'dlv_01',
    dispatchGeneration: 1,
    status: 'published',
    publishAttempts: 1,
    availableAtMs: NOW,
    claimedAtMs: null,
    claimedBy: null,
    publishedAtMs: NOW - MAX_AGE_MS,
    lastError: null,
    createdAtMs: NOW - MAX_AGE_MS - 1_000,
    updatedAtMs: NOW - MAX_AGE_MS - 1_000,
    ...overrides,
  };
}

/** Harness: state hai bảng + call log, đủ để assertion đọc được quyết định của reconciler. */
function makeHarness(
  candidates: readonly { messageId: string; deliveryId: string }[],
  state: {
    readonly message: MailMessageRecord | null;
    readonly outbox: MailOutboxRecord | null;
  },
  redispatchResult: RedispatchMailOutboxResult = {
    kind: 'redispatched',
    recoveryCycleCount: 1,
  },
): {
  readonly deps: MailOutboxReconcilerDeps;
  readonly alerts: MailReconcilerAlert[];
  readonly redispatched: string[];
  readonly scanInputs: { updatedBeforeMs: number; limit: number }[];
} {
  const alerts: MailReconcilerAlert[] = [];
  const redispatched: string[] = [];
  const scanInputs: { updatedBeforeMs: number; limit: number }[] = [];

  const deps: MailOutboxReconcilerDeps = {
    outbox: {
      findByDeliveryId: () => Promise.resolve(state.outbox),
      claim: () => Promise.resolve([]),
      renewLease: () => Promise.resolve(null),
      markPublished: () => Promise.resolve({ outboxPublished: true, messageQueued: true }),
      recordPublishFailure: () => Promise.resolve(null),
    },
    messages: {
      findByDeliveryId: () => Promise.resolve(state.message),
    },
    redispatch: (deliveryId: string) => {
      redispatched.push(deliveryId);
      return Promise.resolve(redispatchResult);
    },
    logAlert: (event: MailReconcilerAlert) => {
      alerts.push(event);
    },
    listDispatchIncomplete: (input) => {
      scanInputs.push(input);
      return Promise.resolve(candidates);
    },
  };

  return { deps, alerts, redispatched, scanInputs };
}

function makeConfig(overrides: Partial<RunOutboxReconcilerConfig> = {}): RunOutboxReconcilerConfig {
  return {
    maxAgeMs: MAX_AGE_MS,
    batchLimit: 10,
    nowMs: NOW,
    leaseMs: 60_000,
    maxPublishAttempts: 3,
    backoffBaseMs: 1_000,
    ...overrides,
  };
}

describe('runOutboxReconciler — dispatch-incomplete delivery', () => {
  it('redispatches a queued message whose outbox row is already published', async () => {
    // `QUEUE.send()` đã thành công (outbox `published`) nhưng không có job nào ở D1 `mail-job`
    // được tạo — Queue retention hoặc worker chưa kịp tạo job row. Đây là nhánh mà guard
    // phải nhận `published`, nếu không delivery treo im lặng ở `queued` vĩnh viễn.
    const harness = makeHarness([{ messageId: 'msg_01', deliveryId: 'dlv_01' }], {
      message: makeMessage({ status: 'queued' }),
      outbox: makeOutbox({ status: 'published' }),
    });

    const result = await runOutboxReconciler(harness.deps, makeConfig());

    expect(result).toEqual({ scanned: 1, redispatched: 1, skipped: 0 });
    expect(harness.redispatched).toEqual(['dlv_01']);
    expect(harness.alerts).toEqual([
      { event: 'reconciler-dispatch-incomplete', deliveryId: 'dlv_01' },
    ]);
  });

  it('passes the run timestamp to the adapter so both statements share one clock', async () => {
    const timestamps: number[] = [];
    const harness = makeHarness([{ messageId: 'msg_01', deliveryId: 'dlv_01' }], {
      message: makeMessage({ status: 'queued' }),
      outbox: makeOutbox({ status: 'published' }),
    });

    await runOutboxReconciler(
      {
        ...harness.deps,
        redispatch: (deliveryId: string, nowMs: number) => {
          timestamps.push(nowMs);
          return Promise.resolve({ kind: 'redispatched', recoveryCycleCount: 1 });
        },
      },
      makeConfig(),
    );

    // `db.batch()` của adapter phải ghi `available_at`/`updated_at` bằng **cùng một** mốc,
    // nếu không một row có thể trở nên claim được trước khi chu kỳ recovery bắt đầu.
    expect(timestamps).toEqual([NOW]);
  });

  it('redispatches from an outbox row that is still publishing', async () => {
    // Nguồn guard của reconciler gồm `pending`/`publishing`/`published` — không chỉ `pending`.
    const harness = makeHarness([{ messageId: 'msg_01', deliveryId: 'dlv_01' }], {
      message: makeMessage({ status: 'queued' }),
      outbox: makeOutbox({ status: 'publishing', claimedAtMs: NOW, claimedBy: 'other' }),
    });

    const result = await runOutboxReconciler(harness.deps, makeConfig());

    expect(result.redispatched).toBe(1);
    expect(harness.redispatched).toEqual(['dlv_01']);
  });
});

describe('runOutboxReconciler — candidates the reconciler must not touch', () => {
  it('leaves an accepted message alone so the publisher finishes its cycle', async () => {
    // Message `accepted` còn outbox `pending`/`publishing` → còn trong chu kỳ publish. Nếu outbox
    // `publishing` quá lease thì chính `claim` của publisher reclaim được; re-dispatch ở đây
    // chỉ tranh cùng một row với publisher.
    const harness = makeHarness([{ messageId: 'msg_01', deliveryId: 'dlv_01' }], {
      message: makeMessage({ status: 'accepted' }),
      outbox: makeOutbox({ status: 'pending', publishedAtMs: null }),
    });

    const result = await runOutboxReconciler(harness.deps, makeConfig());

    expect(result).toEqual({ scanned: 1, redispatched: 0, skipped: 1 });
    expect(harness.redispatched).toEqual([]);
    expect(harness.alerts).toEqual([]);
  });

  it('never redispatches a blocked delivery', async () => {
    // `blocked` tuyệt đối không re-dispatch tự động: re-enqueue cho nó chỉ chạy sau một thao tác
    // redrive **có authorize**, mà caller/permission còn chưa chốt.
    const harness = makeHarness([{ messageId: 'msg_01', deliveryId: 'dlv_01' }], {
      message: makeMessage({ status: 'blocked', failureReason: 'credential' }),
      outbox: makeOutbox({ status: 'published' }),
    });

    const result = await runOutboxReconciler(harness.deps, makeConfig());

    expect(result).toEqual({ scanned: 1, redispatched: 0, skipped: 1 });
    expect(harness.redispatched).toEqual([]);
    expect(harness.alerts).toEqual([]);
  });

  it('never redispatches a terminal delivery', async () => {
    const harness = makeHarness([{ messageId: 'msg_01', deliveryId: 'dlv_01' }], {
      message: makeMessage({ status: 'sent', terminalAtMs: NOW - 1_000 }),
      outbox: makeOutbox({ status: 'published' }),
    });

    const result = await runOutboxReconciler(harness.deps, makeConfig());

    expect(result.redispatched).toBe(0);
    expect(harness.redispatched).toEqual([]);
  });
});

describe('runOutboxReconciler — an exhausted row is a repair, not an automatic reset', () => {
  it('alerts repair-required and leaves a failed outbox row alone', async () => {
    // Nguồn guard của reconciler **không** bao giờ có `failed`: row đã kiệt
    // `maxPublishAttempts` chỉ được mở lại bởi repair có authorize. Tự reset ở đây là lách
    // qua cổng authorize đó.
    const harness = makeHarness([{ messageId: 'msg_01', deliveryId: 'dlv_01' }], {
      message: makeMessage({ status: 'queued' }),
      outbox: makeOutbox({ status: 'failed', lastError: 'Error', publishedAtMs: null }),
    });

    const result = await runOutboxReconciler(harness.deps, makeConfig());

    expect(result).toEqual({ scanned: 1, redispatched: 0, skipped: 1 });
    expect(harness.redispatched).toEqual([]);
    expect(harness.alerts).toEqual([
      { event: 'reconciler-outbox-failed-repair-required', deliveryId: 'dlv_01' },
    ]);
  });

  it('checks the failed row before considering the message status', async () => {
    // Cả hai lớp state không bao giờ ghi lên nhau, nên `failed` phải thắng: một message
    // `queued` kèm outbox `failed` là corner case hai lớp ở trạng thái trái ngược, và
    // `03-operations.md` §5.3 nói rõ reconciler chỉ **phát hiện và alert** cho nó.
    const harness = makeHarness([{ messageId: 'msg_01', deliveryId: 'dlv_01' }], {
      message: makeMessage({ status: 'accepted' }),
      outbox: makeOutbox({ status: 'failed', publishedAtMs: null }),
    });

    await runOutboxReconciler(harness.deps, makeConfig());

    expect(harness.alerts).toEqual([
      { event: 'reconciler-outbox-failed-repair-required', deliveryId: 'dlv_01' },
    ]);
  });
});

describe('runOutboxReconciler — the recovery budget is the hard stop', () => {
  it('alerts budget-exhausted and does not redispatch when the budget is spent', async () => {
    const harness = makeHarness(
      [{ messageId: 'msg_01', deliveryId: 'dlv_01' }],
      { message: makeMessage({ status: 'queued' }), outbox: makeOutbox({ status: 'published' }) },
      { kind: 'budget-exhausted' },
    );

    const result = await runOutboxReconciler(harness.deps, makeConfig());

    // `redispatched` chỉ đếm những lần **thực sự** re-dispatch: adapter đã không ghi được
    // gì, nên đếm nó là nói dối.
    expect(result).toEqual({ scanned: 1, redispatched: 0, skipped: 1 });
    expect(harness.alerts).toEqual([
      { event: 'reconciler-dispatch-incomplete', deliveryId: 'dlv_01' },
      { event: 'reconciler-budget-exhausted', deliveryId: 'dlv_01' },
    ]);
  });

  it('skips quietly when the adapter reports the candidate is no longer eligible', async () => {
    // `not-eligible` là kết quả bình thường: có ai đó đã xử lý message trước (terminal, hoặc
    // `blocked`). Alert ở đây sẽ là tiếng ồn mất hết giá trị cảnh báo.
    const harness = makeHarness(
      [{ messageId: 'msg_01', deliveryId: 'dlv_01' }],
      { message: makeMessage({ status: 'queued' }), outbox: makeOutbox({ status: 'published' }) },
      { kind: 'not-eligible' },
    );

    const result = await runOutboxReconciler(harness.deps, makeConfig());

    expect(result).toEqual({ scanned: 1, redispatched: 0, skipped: 1 });
    expect(harness.alerts).toEqual([
      { event: 'reconciler-dispatch-incomplete', deliveryId: 'dlv_01' },
    ]);
  });

  it('carries no recovery budget in its own config, so it cannot self-authorize one', () => {
    // Ngân sách A là guard của **statement adapter viết**, không phải tham số của vòng quét.
    // Cho phép truyền nó vào đây sẽ tạo cảm giác sai rằng reconciler tự quyết ngân sách.
    //
    // Khẳng định đúng là **giá trị** mà key đó chỉ nhận, không phải sự vắng mặt của key: khai
    // `recoveryBudgetLimit?: never` (thay vì bỏ hẳn) là chọn cố ý để một object literal
    // truyền thừa key đó **không compile** thay vì chỉ bị bỏ qua trong im lặng. Vì vậy
    // `'recoveryBudgetLimit' extends keyof Config` là `true`; thứ phải kiểm là key đó có
    // **không** nhận được một số.
    //
    // Vế phải dùng `number extends Config['…']` chứ không phải `never extends …`: với
    // `?:` optional, kiểu thuộc tính là `undefined`, mà `never extends undefined` là **đúng**
    // (đã đo) — nên phép thử đó cho ra kết quả ngược với điều cần kiểm. `number extends …`
    // mới là câu hỏi đúng: "một số có gán được vào key này không", và câu trả lời phải là
    // không.
    type ConfigKeys = keyof RunOutboxReconcilerConfig;
    type BudgetKeyPresent = 'recoveryBudgetLimit' extends ConfigKeys ? true : false;
    type AcceptsBudget = number extends RunOutboxReconcilerConfig['recoveryBudgetLimit']
      ? true
      : false;

    const budgetKeyPresent: BudgetKeyPresent = true;
    const acceptsBudget: AcceptsBudget = false;

    expect(budgetKeyPresent).toBe(true);
    expect(acceptsBudget).toBe(false);
    expect(makeConfig()).not.toHaveProperty('recoveryBudgetLimit');
  });

  it('never forwards a recovery budget to the redispatch adapter', async () => {
    // Bổ sung runtime cho ca compile-time ở trên. Lập luận ở đây: kể cả khi một caller
    // lách qua kiểu (JS thuần, object literal thừa key), ngân sách A cũng không thể đi vào
    // adapter — không phải vì reconciler "từ chối" nó, mà vì **chữ ký của `redispatch` không
    // có chỗ nào nhận nó**. Khẳng định vào số tham số thật sự nhận được, thay vì vào
    // `Object.keys(config)` — đó là key của *caller*, không phải của lời gọi, nên kiểm nó
    // không nói được điều gì.
    const calls: { deliveryId: string; nowMs: number }[] = [];
    const harness = makeHarness([{ messageId: 'msg_01', deliveryId: 'dlv_01' }], {
      message: makeMessage({ status: 'queued' }),
      outbox: makeOutbox({ status: 'published' }),
    });
    // Đi qua `unknown` là **chủ ý**: cast thẳng `as RunOutboxReconcilerConfig` bị TypeScript
    // từ chối (đo được: TS2352, vì `number` không comparable với `undefined`) — tức chính hệ
    // kiểu đã bảo vệ đúng như mong muốn. Để viết được ca runtime này ta phải lách qua đúng
    // cái lỗi mà đang chứng minh là có, và đó là đường mà JS thuần vẫn đi được.
    const config = {
      ...makeConfig(),
      recoveryBudgetLimit: 3,
    } as unknown as RunOutboxReconcilerConfig;

    const result = await runOutboxReconciler(
      {
        ...harness.deps,
        redispatch: (...args: unknown[]) => {
          calls.push({
            deliveryId: String(args[0]),
            nowMs: Number(args[1]),
          });
          return Promise.resolve({ kind: 'redispatched', recoveryCycleCount: 1 });
        },
      },
      config,
    );

    expect(result.redispatched).toBe(1);
    // `redispatch(deliveryId, nowMs)`: tham số thứ hai là **mốc thời gian** của lần chạy, và
    // không có tham số thứ ba nào để ngân sách A chen vào.
    expect(calls).toEqual([{ deliveryId: 'dlv_01', nowMs: NOW }]);
  });
});

describe('runOutboxReconciler — scanning is bounded and age-gated', () => {
  it('scans with the age cutoff and the batch limit of the run', async () => {
    const harness = makeHarness([], { message: null, outbox: null });

    await runOutboxReconciler(harness.deps, makeConfig({ maxAgeMs: 900_000, batchLimit: 25 }));

    // `updatedBeforeMs = nowMs - maxAgeMs`: một delivery vừa được chạm thì không lọt, nên vòng
    // quét không re-dispatch một delivery đang tiến triển bình thường.
    expect(harness.scanInputs).toEqual([{ updatedBeforeMs: NOW - 900_000, limit: 25 }]);
  });

  it('does nothing at all when the scan returns no candidate', async () => {
    const harness = makeHarness([], { message: null, outbox: null });

    const result = await runOutboxReconciler(harness.deps, makeConfig());

    expect(result).toEqual({ scanned: 0, redispatched: 0, skipped: 0 });
    expect(harness.redispatched).toEqual([]);
    expect(harness.alerts).toEqual([]);
  });

  it('never inspects more candidates than the batch limit, one batch per run', async () => {
    // Một lô có biên là điều kiện để reconciler chết giữa lúc không giữ lại việc chưa làm;
    // lần chạy sau đọc tiếp từ đâu danh sách còn lại dừng.
    const candidates = Array.from({ length: 5 }, (_, index) => ({
      messageId: `msg_${index}`,
      deliveryId: `dlv_${index}`,
    }));
    const harness = makeHarness(candidates.slice(0, 2), {
      message: makeMessage({ status: 'queued' }),
      outbox: makeOutbox({ status: 'published' }),
    });

    const result = await runOutboxReconciler(harness.deps, makeConfig({ batchLimit: 2 }));

    expect(result).toEqual({ scanned: 2, redispatched: 2, skipped: 0 });
    expect(harness.scanInputs).toHaveLength(1);
    expect(harness.redispatched).toEqual(['dlv_0', 'dlv_1']);
  });

  it('skips a candidate whose message or outbox row no longer exists', async () => {
    // Dữ liệu không nhất quán, nhưng đây **không** phải đường để tự sửa — bỏ qua để lần quét sau
    // thấy lại nếu còn.
    const missingOutbox = makeHarness([{ messageId: 'msg_01', deliveryId: 'dlv_01' }], {
      message: makeMessage({ status: 'queued' }),
      outbox: null,
    });
    const missingMessage = makeHarness([{ messageId: 'msg_01', deliveryId: 'dlv_01' }], {
      message: null,
      outbox: makeOutbox({ status: 'published' }),
    });

    expect(await runOutboxReconciler(missingOutbox.deps, makeConfig())).toEqual({
      scanned: 1,
      redispatched: 0,
      skipped: 1,
    });
    expect(await runOutboxReconciler(missingMessage.deps, makeConfig())).toEqual({
      scanned: 1,
      redispatched: 0,
      skipped: 1,
    });
    expect(missingOutbox.redispatched).toEqual([]);
    expect(missingOutbox.alerts).toEqual([]);
  });

  it('redispatches candidates one at a time so each transition has a single owner', async () => {
    // Chạy song song sẽ cho hai lần re-dispatch tranh cùng một outbox row trong D1; adapter là
    // một `db.batch()` hai bảng nên tính đúng đắn đòi thứ tự.
    let inFlight = 0;
    let maxInFlight = 0;
    const harness = makeHarness(
      [
        { messageId: 'msg_01', deliveryId: 'dlv_01' },
        { messageId: 'msg_02', deliveryId: 'dlv_02' },
      ],
      { message: makeMessage({ status: 'queued' }), outbox: makeOutbox({ status: 'published' }) },
    );

    await runOutboxReconciler(
      {
        ...harness.deps,
        redispatch: () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          return Promise.resolve().then(() => {
            inFlight -= 1;
            return { kind: 'redispatched', recoveryCycleCount: 1 };
          });
        },
      },
      makeConfig(),
    );

    expect(maxInFlight).toBe(1);
  });
});
