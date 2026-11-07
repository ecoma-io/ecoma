/**
 * Test của **job reconciliation** (FR-022) — cơ chế (b).
 *
 * ⚠️ Suite này khẳng định **quyền hạn**, không khẳng định "đã gọi producer". Ba ranh giới mà
 * một cơ chế re-deliver có thể vượt mà không hề đỏ, và vì vậy phải có assertion riêng cho mỗi
 * cái:
 *
 * 1. **Phạm vi**: chỉ việc **đã có job record**. Message chưa từng consume thuộc cơ chế (c) của
 *    control plane, không phải ở đây — một test "job reconciliation tìm thấy message chưa từng
 *    consume" đang khẳng định sai phạm vi.
 * 2. **Bất biến**: re-deliver **đúng** envelope gốc, **cùng** `delivery_id`. Không reroute,
 *    không tạo delivery mới.
 * 3. **Ownership**: không ghi logical delivery state — kể cả khi sweep thất bại.
 */

import { describe, expect, it } from 'vitest';

import { runJobReconciliation, type JobReconciliationDeps } from './job-reconciliation';
import { processDeliveryMessage } from './delivery-pipeline';
import {
  FakeJobState,
  FakeObservability,
  FakeRuntime,
  FakeSender,
  T0,
  jobRecord,
} from './delivery.fixtures';
import type { JobRecord } from './job-state-port';
import type { QueueProducerPort } from './ports';

/* -------------------------------------------------------------------------------------- */
/* Harness                                                                                    */
/* -------------------------------------------------------------------------------------- */

/** JobStatePort tối thiểu cho reconciliation: chỉ `listStuck` và `findByDeliveryId`. */
class FakeJobScan {
  readonly scans: {
    readonly stuckAfterMs: number;
    readonly nowMs: number;
    readonly limit: number;
  }[] = [];
  readonly lookups: string[] = [];
  #stuck: JobRecord[];
  #current: Map<string, JobRecord>;

  constructor(stuck: JobRecord[]) {
    this.#stuck = stuck;
    this.#current = new Map(stuck.map((job) => [job.deliveryId, job]));
  }

  async listStuck(input: {
    readonly stuckAfterMs: number;
    readonly nowMs: number;
    readonly limit: number;
  }): Promise<readonly JobRecord[]> {
    this.scans.push(input);
    return this.#stuck.slice(0, input.limit);
  }

  async findByDeliveryId(deliveryId: string): Promise<JobRecord | null> {
    this.lookups.push(deliveryId);
    return this.#current.get(deliveryId) ?? null;
  }

  /** Mô phỏng consumer đặt processed marker trong lúc sweep đang chạy. */
  markProcessedMidSweep(deliveryId: string): void {
    const job = this.#current.get(deliveryId);
    if (job !== undefined) {
      this.#current.set(deliveryId, { ...job, processed: true, terminalOutcome: 'delivered' });
    }
  }
}

/** Các method còn lại của `JobStatePort` — reconciliation không được gọi chúng. */
const unwritableJobState = {
  beginAttempt: () => {
    throw new Error('reconciliation must not open an attempt');
  },
  completeAttempt: () => {
    throw new Error('reconciliation must not complete an attempt');
  },
  markProcessed: () => {
    throw new Error('reconciliation must not write a processed marker');
  },
} satisfies Partial<JobStatePortLike>;

type JobStatePortLike = Parameters<typeof runJobReconciliation>[0]['jobs'];

class FakeProducer implements QueueProducerPort {
  readonly sent: unknown[] = [];

  constructor(private readonly behaviour: 'ok' | 'throw' = 'ok') {}

  async send(message: unknown): Promise<unknown> {
    if (this.behaviour === 'throw') {
      throw new Error('queue producer unavailable');
    }
    this.sent.push(message);
    return { id: `msg_${this.sent.length}` };
  }
}

interface Scenario {
  readonly jobs: FakeJobScan;
  readonly producer: FakeProducer;
  readonly observability: FakeObservability;
  readonly deps: JobReconciliationDeps;
  readonly sweep: (options?: {
    stuckAfterMs?: number;
    limit?: number;
    maxAttempts?: number;
  }) => Promise<{
    stuckFound: number;
    redelivered: number;
    failed: number;
    skippedProcessed: number;
    skippedExhausted: number;
  }>;
}

const STUCK_AFTER_MS = 15 * 60 * 1_000;

function scenario(options: { stuck?: JobRecord[]; producer?: FakeProducer } = {}): Scenario {
  const jobs = new FakeJobScan(options.stuck ?? []);
  const producer = options.producer ?? new FakeProducer();
  const observability = new FakeObservability();
  const deps: JobReconciliationDeps = {
    jobs: { ...unwritableJobState, ...bindMethods(jobs) } as unknown as JobStatePortLike,
    queue: producer,
    clock: { now: () => T0 },
    metrics: observability.port,
    logger: observability.port,
  };
  return {
    jobs,
    producer,
    observability,
    deps,
    sweep: (sweepOptions) =>
      runJobReconciliation(deps, {
        stuckAfterMs: sweepOptions?.stuckAfterMs ?? STUCK_AFTER_MS,
        limit: sweepOptions?.limit ?? 100,
        maxAttempts: sweepOptions?.maxAttempts,
      }),
  };
}

/** Ghép instance `FakeJobScan` thành object thỏa port (method phải là property riêng). */
function bindMethods(jobs: FakeJobScan): Record<string, unknown> {
  return {
    listStuck: (input: { stuckAfterMs: number; nowMs: number; limit: number }) =>
      jobs.listStuck(input),
    findByDeliveryId: (deliveryId: string) => jobs.findByDeliveryId(deliveryId),
  };
}

function stuckJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return jobRecord({
    deliveryId: 'del_stuck',
    lastConsumedAt: T0 - STUCK_AFTER_MS - 1,
    updatedAt: T0 - STUCK_AFTER_MS - 1,
    ...overrides,
  });
}

/* -------------------------------------------------------------------------------------- */
/* Phạm vi                                                                                    */
/* -------------------------------------------------------------------------------------- */

describe('runJobReconciliation scope', () => {
  // Cơ chế này **chỉ** thấy việc đã có job record. Test này ghim ranh giới bằng cách chứng
  // minh nó không hề có đường nào để tìm việc chưa từng consume.
  it('reads only job-recorded work, because never-consumed messages leave no job row', async () => {
    const s = scenario({ stuck: [] });

    const report = await s.sweep();

    expect(report).toEqual({
      stuckFound: 0,
      redelivered: 0,
      failed: 0,
      skippedProcessed: 0,
      skippedExhausted: 0,
    });
    expect(s.producer.sent).toEqual([]);
    // Không có một port nào đọc D1 `push`, và cũng không có một method "list deliveries".
    expect(Object.keys(s.deps.jobs).toSorted()).toEqual([
      'beginAttempt',
      'completeAttempt',
      'findByDeliveryId',
      'listStuck',
      'markProcessed',
    ]);
  });

  it('passes the operator-supplied stuck threshold and limit down to the D1 query', async () => {
    const s = scenario({ stuck: [stuckJob()] });

    await s.sweep({ stuckAfterMs: 42_000, limit: 7 });

    expect(s.jobs.scans).toEqual([{ stuckAfterMs: 42_000, nowMs: T0, limit: 7 }]);
  });

  // Ngưỡng là quyết định vận hành của operator (docs §9 gọi nó là operational gate chưa
  // chốt), nên nó phải đến từ caller chứ không phải hằng trong lib.
  it('takes the stuck threshold from the caller rather than hard-coding it', async () => {
    const s = scenario({ stuck: [] });

    await s.sweep({ stuckAfterMs: 1_000 });
    await s.sweep({ stuckAfterMs: 86_400_000 });

    expect(s.jobs.scans.map((scan) => scan.stuckAfterMs)).toEqual([1_000, 86_400_000]);
  });

  it('honours the limit so one sweep has a bounded duration', async () => {
    const s = scenario({
      stuck: [
        stuckJob({ deliveryId: 'del_a' }),
        stuckJob({ deliveryId: 'del_b' }),
        stuckJob({ deliveryId: 'del_c' }),
      ],
    });

    const report = await s.sweep({ limit: 2 });

    // D1 đã lọc bằng `LIMIT`; suite này chỉ gọi lại để đo rằng ngưỡng được truyền xuống.
    expect(report.stuckFound).toBe(2);
    expect(s.jobs.scans[0]?.limit).toBe(2);
  });
});

/* -------------------------------------------------------------------------------------- */
/* Bất biến re-deliver                                                                        */
/* -------------------------------------------------------------------------------------- */

describe('runJobReconciliation envelope fidelity', () => {
  // Đây là assertion quan trọng nhất của suite: **chính xác** envelope gốc, cùng
  // `delivery_id`. Một re-deliver dựng lại envelope từ D1 mà làm rơi `url`/`data`, hoặc đổi
  // provider/transport, sẽ gửi một nội dung khác — và điều đó chỉ lộ ra ở phía người nhận.
  it('re-delivers the exact stored envelope, including optional payload fields', async () => {
    const envelope = {
      version: 1 as const,
      delivery_id: 'del_exact',
      notification_id: 'ntf_exact',
      subscription_id: 'sub_exact',
      provider_id: 'prov_exact',
      transport: 'web' as const,
      payload: {
        title: 'Tiêu đề gốc',
        body: 'Nội dung gốc',
        url: 'https://ecoma.io/threads/42',
        data: { deep: { link: 'https://ecoma.io/deep' }, badge: 7 },
      },
    };
    const s = scenario({
      stuck: [jobRecord({ deliveryId: 'del_exact', envelope, lastConsumedAt: 0 })],
    });

    await s.sweep();

    expect(s.producer.sent).toEqual([envelope]);
    // Không thêm, không bớt field — so bằng key set chứ không bằng `toMatchObject`.
    expect(Object.keys(s.producer.sent[0] as Record<string, unknown>).toSorted()).toEqual(
      Object.keys(envelope).toSorted(),
    );
  });

  it('reuses the same delivery_id so the control plane atomic claim still fences two attempts', async () => {
    const s = scenario({ stuck: [stuckJob({ deliveryId: 'del_same' })] });

    await s.sweep();

    expect((s.producer.sent[0] as { delivery_id: string }).delivery_id).toBe('del_same');
  });

  it('never reroutes to another provider or transport', async () => {
    const s = scenario({ stuck: [stuckJob()] });

    await s.sweep();

    const sent = s.producer.sent[0] as { provider_id: string; transport: string };
    expect(sent.provider_id).toBe('prov-webpush-eu');
    expect(sent.transport).toBe('web');
  });

  // ⚠️ Thứ tự khoá trong `payload` của D1 không mang ý nghĩa, nên envelope được **dựng lại**
  // qua builder canonical. Bảo đảm cái publish đúng là envelope hợp lệ là việc của builder.
  it('rebuilds the envelope through the canonical builder so key order is stable', async () => {
    const shuffled = {
      version: 1,
      delivery_id: 'del_order',
      notification_id: 'ntf_order',
      subscription_id: 'sub_order',
      provider_id: 'prov_order',
      transport: 'web',
      payload: { data: { a: 1 }, url: 'https://ecoma.io/x', body: 'B', title: 'A' },
    };
    const s = scenario({
      stuck: [jobRecord({ deliveryId: 'del_order', envelope: shuffled, lastConsumedAt: 0 })],
    });

    await s.sweep();

    expect(s.producer.sent[0]).toEqual({
      version: 1,
      delivery_id: 'del_order',
      notification_id: 'ntf_order',
      subscription_id: 'sub_order',
      provider_id: 'prov_order',
      transport: 'web',
      payload: { title: 'A', body: 'B', url: 'https://ecoma.io/x', data: { a: 1 } },
    });
    expect(Object.keys((s.producer.sent[0] as { payload: object }).payload)).toEqual([
      'title',
      'body',
      'url',
      'data',
    ]);
  });
});

/* -------------------------------------------------------------------------------------- */
/* Độc lập từng job                                                                           */
/* -------------------------------------------------------------------------------------- */

describe('runJobReconciliation per-job isolation', () => {
  // Một publish fail không được làm dừng sweep — cùng nguyên tắc per-message của Queue.
  it('keeps going after a publish failure and reports both outcomes', async () => {
    let call = 0;
    const producer: QueueProducerPort = {
      send: async () => {
        call += 1;
        if (call === 2) {
          throw new Error('queue producer unavailable');
        }
        return { id: `msg_${call}` };
      },
    };
    const jobs = new FakeJobScan([
      stuckJob({ deliveryId: 'del_a' }),
      stuckJob({ deliveryId: 'del_b' }),
      stuckJob({ deliveryId: 'del_c' }),
    ]);
    const observability = new FakeObservability();
    const deps: JobReconciliationDeps = {
      jobs: { ...unwritableJobState, ...bindMethods(jobs) } as unknown as JobStatePortLike,
      queue: producer,
      clock: { now: () => T0 },
      metrics: observability.port,
      logger: observability.port,
    };

    const report = await runJobReconciliation(deps, { stuckAfterMs: STUCK_AFTER_MS, limit: 100 });

    expect(report).toEqual({
      stuckFound: 3,
      redelivered: 2,
      failed: 1,
      skippedProcessed: 0,
      skippedExhausted: 0,
    });
    expect(observability.logNamed('reconcile.publish_failed')[0]?.fields).toMatchObject({
      delivery_id: 'del_b',
    });
  });

  // Job state là dữ liệu bền vững: một hàng hỏng (do migration, do bug ghi) không được đẩy
  // thành message mà consumer sẽ reject rồi đưa vào DLQ.
  it('refuses to publish a stored envelope that no longer validates, without stopping the sweep', async () => {
    const corrupt = {
      ...jobRecord({ deliveryId: 'del_corrupt', lastConsumedAt: 0 }).envelope,
      version: 99,
    };
    const s = scenario({
      stuck: [
        jobRecord({ deliveryId: 'del_corrupt', envelope: corrupt, lastConsumedAt: 0 }),
        stuckJob({ deliveryId: 'del_good' }),
      ],
    });

    const report = await s.sweep();

    expect(report).toEqual({
      stuckFound: 2,
      redelivered: 1,
      failed: 1,
      skippedProcessed: 0,
      skippedExhausted: 0,
    });
    expect(s.producer.sent).toHaveLength(1);
    expect((s.producer.sent[0] as { delivery_id: string }).delivery_id).toBe('del_good');
    expect(s.observability.logNamed('reconcile.stored_envelope_invalid')[0]?.fields).toMatchObject({
      delivery_id: 'del_corrupt',
    });
  });

  it('does not publish an envelope whose payload carries a smuggled secret', async () => {
    const leaky = {
      ...jobRecord({ deliveryId: 'del_leak', lastConsumedAt: 0 }).envelope,
      payload: { title: 'A', body: 'B', auth: 'leaked-subscription-secret' },
    };
    const s = scenario({
      stuck: [jobRecord({ deliveryId: 'del_leak', envelope: leaky, lastConsumedAt: 0 })],
    });

    const report = await s.sweep();

    expect(report.failed).toBe(1);
    expect(s.producer.sent).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------- */
/* Race với consumer                                                                           */
/* -------------------------------------------------------------------------------------- */

describe('runJobReconciliation race with a consumer', () => {
  // Đọc lại là **bắt buộc**: nếu sweep chỉ tin `listStuck`, mọi job đã processed mà lọt qua
  // bộ lọc D1 sẽ bị publish lại. Test này ghim đúng giá trị mà lần đọc lại mua được.
  it('skips a job that a consumer marked processed before the sweep published it', async () => {
    const jobs = new FakeJobScan([stuckJob({ deliveryId: 'del_race' })]);
    const producer = new FakeProducer();
    const observability = new FakeObservability();
    const deps: JobReconciliationDeps = {
      jobs: {
        ...unwritableJobState,
        listStuck: (input: { stuckAfterMs: number; nowMs: number; limit: number }) =>
          jobs.listStuck(input),
        findByDeliveryId: async (deliveryId: string) => {
          // Marker đã có **trước** lần đọc lại — đây là phần race mà lần đọc lại bắt được.
          jobs.markProcessedMidSweep(deliveryId);
          return jobs.findByDeliveryId(deliveryId);
        },
      } as unknown as JobStatePortLike,
      queue: producer,
      clock: { now: () => T0 },
      metrics: observability.port,
      logger: observability.port,
    };

    const report = await runJobReconciliation(deps, { stuckAfterMs: STUCK_AFTER_MS, limit: 100 });

    expect(report).toEqual({
      stuckFound: 1,
      redelivered: 0,
      failed: 0,
      skippedProcessed: 1,
      skippedExhausted: 0,
    });
    expect(producer.sent).toEqual([]);
  });

  // ⚠️ **Giới hạn thật, ghim lại thay vì giấu.** Nếu consumer đặt marker *sau* lần đọc lại,
  // sweep **không thể** biết — không có primitive nguyên tử nào giữa đọc D1 và publish lên
  // Queue. Message vẫn được publish. Điều đó chấp nhận được **vì** consumer chặn được nó:
  // processed-marker short-circuit ACK mà không claim và không gọi provider.
  //
  // Test này nối thật hai phía — sweep publish, rồi message đó đi qua pipeline — để chứng minh
  // duplicate đó vô hại thay vì chỉ nói nó vô hại.
  it('publishes a duplicate it cannot detect, and the consumer makes it a no-op', async () => {
    const jobs = new FakeJobScan([stuckJob({ deliveryId: 'del_toctou' })]);
    const producer = new FakeProducer();
    const observability = new FakeObservability();
    const pipelineJobs = new FakeJobState({
      // Marker đã có khi consumer cuối cùng nhìn thấy job này.
      existing: jobRecord({
        deliveryId: 'del_toctou',
        processed: true,
        terminalOutcome: 'delivered',
      }),
    });
    const pipelineRuntime = new FakeRuntime();
    const pipelineSender = new FakeSender();
    const pipelineObs = new FakeObservability();
    const acks: string[] = [];

    const sweepDeps: JobReconciliationDeps = {
      jobs: {
        ...unwritableJobState,
        listStuck: (input: { stuckAfterMs: number; nowMs: number; limit: number }) =>
          jobs.listStuck(input),
        findByDeliveryId: async (deliveryId: string) => {
          const result = await jobs.findByDeliveryId(deliveryId);
          jobs.markProcessedMidSweep(deliveryId);
          return result;
        },
      } as unknown as JobStatePortLike,
      queue: producer,
      clock: { now: () => T0 },
      metrics: observability.port,
      logger: observability.port,
    };

    const report = await runJobReconciliation(sweepDeps, {
      stuckAfterMs: STUCK_AFTER_MS,
      limit: 100,
    });
    expect(report).toMatchObject({ redelivered: 1, skippedProcessed: 0 });

    // Message vừa publish đi qua pipeline thật.
    const outcome = await processDeliveryMessage(
      {
        runtime: pipelineRuntime,
        jobs: pipelineJobs,
        sender: pipelineSender,
        clock: { now: () => T0 },
        metrics: pipelineObs.port,
        logger: pipelineObs.port,
      },
      producer.sent[0],
      { attempts: 1 },
      { ack: () => acks.push('ack'), retry: () => acks.push('retry') },
    );

    // Nó là một no-op: không claim, không gọi provider. Đây là lý do TOCTOU ở trên chấp nhận
    // được, và vì say nó **không** chấp nhận được nếu marker không tồn tại.
    expect(outcome).toEqual({ kind: 'skipped', reason: 'already_processed' });
    expect(acks).toEqual(['ack']);
    expect(pipelineRuntime.calls.claims).toEqual([]);
    expect(pipelineSender.calls).toEqual([]);
  });

  // Đọc lại là **bắt buộc**, không phải tối ưu: nếu sweep chỉ tin `listStuck`, mọi job đã
  // processed mà lọt qua bộ lọc D1 sẽ bị publish lại.
  it('re-reads each candidate before publishing instead of trusting the list', async () => {
    const s = scenario({
      stuck: [stuckJob({ deliveryId: 'del_a' }), stuckJob({ deliveryId: 'del_b' })],
    });

    await s.sweep();

    expect(s.jobs.lookups).toEqual(['del_a', 'del_b']);
  });
});

/* -------------------------------------------------------------------------------------- */
/* Ownership                                                                                  */
/* -------------------------------------------------------------------------------------- */

describe('runJobReconciliation ownership', () => {
  // ⚠️ Đây là ranh giới quan trọng nhất của cơ chế này. Reconciliation sweep **không** được
  // ghi vào delivery của control plane — kể cả khi nó biết chắc là thất bại. Việc duy nhất
  // được ghi là "đã re-deliver, và vì sao".
  it('never writes job execution state; the port methods throw if called', async () => {
    const s = scenario({ stuck: [stuckJob()] });

    await expect(s.sweep()).resolves.toMatchObject({ redelivered: 1 });
    // `unwritableJobState` throw ngay khi bị gọi — nếu sweep gọi `markProcessed`, test này
    // đỏ bằng exception chứ không bằng một assertion mơ hồ.
  });

  it('writes nothing to the control plane', async () => {
    const runtimeCalls: string[] = [];
    const jobs = new FakeJobScan([stuckJob()]);
    const deps: JobReconciliationDeps = {
      jobs: { ...unwritableJobState, ...bindMethods(jobs) } as unknown as JobStatePortLike,
      queue: new FakeProducer(),
      clock: { now: () => T0 },
      metrics: new FakeObservability().port,
      logger: new FakeObservability().port,
    };
    // Job reconciliation không nhận `DeliveryRuntimePort` — không có đường nào để ghi
    // outcome, release hay invalidate từ đây.
    expect(Object.keys(deps).toSorted()).toEqual(['clock', 'jobs', 'logger', 'metrics', 'queue']);
    expect(runtimeCalls).toEqual([]);
  });
});

/* -------------------------------------------------------------------------------------- */
/* Observability                                                                              */
/* -------------------------------------------------------------------------------------- */

describe('runJobReconciliation observability', () => {
  it('records the age and consume count so an operator can see why a job was re-delivered', async () => {
    const s = scenario({
      stuck: [stuckJob({ deliveryId: 'del_obs', consumeCount: 4, lastConsumedAt: T0 - 60_000 })],
    });

    await s.sweep();

    expect(s.observability.logNamed('reconcile.redelivered')[0]?.fields).toMatchObject({
      delivery_id: 'del_obs',
      notification_id: 'ntf_del_obs',
      consume_count: 4,
      age_ms: 60_000,
    });
  });

  it('counts one sweep summary, even when nothing was stuck', async () => {
    const s = scenario({ stuck: [] });

    await s.sweep();

    expect(s.observability.logNamed('reconcile.sweep_completed')).toHaveLength(1);
    expect(s.observability.countOf('deliveries_retried')).toBe(0);
  });

  // `delivery_id` không phải metric label (high cardinality) — nó được phép trong log để dựng
  // correlation chain, nhưng metric chỉ nhận dimension tối thiểu.
  it('never uses delivery_id as a metric label', async () => {
    const s = scenario({ stuck: [stuckJob({ deliveryId: 'del_metric' })] });

    await s.sweep();

    for (const entry of s.observability.metrics) {
      expect(Object.keys(entry.dimensions ?? {})).not.toContain('delivery_id');
    }
  });

  it('never writes the endpoint or a credential to any log line', async () => {
    const s = scenario({ stuck: [stuckJob()] });

    await s.sweep();

    expect(s.observability.allLoggedFieldValues().join('|')).not.toContain('push.example');
  });
});

/* -------------------------------------------------------------------------------------- */
/* Attempt budget (DC-5)                                                                      */
/* -------------------------------------------------------------------------------------- */

describe('runJobReconciliation attempt budget', () => {
  it('does not re-deliver a job whose consume_count has reached the budget', async () => {
    const s = scenario({
      stuck: [stuckJob({ deliveryId: 'del_exhausted_cc', consumeCount: 3 })],
    });

    const report = await s.sweep({ maxAttempts: 3 });

    expect(report).toMatchObject({ stuckFound: 1, redelivered: 0, failed: 0, skippedProcessed: 0 });
    expect(s.producer.sent).toEqual([]);
    expect(s.observability.countOf('deliveries_skipped')).toBe(1);
    const log = s.observability.logNamed('reconcile.attempt_budget_exhausted');
    expect(log).toHaveLength(1);
    expect(log[0]?.fields).toMatchObject({
      delivery_id: 'del_exhausted_cc',
      consume_count: 3,
      max_attempts: 3,
    });
  });

  it('does not re-deliver a job whose lastAttempt.attempt has reached the budget', async () => {
    const base = stuckJob({ deliveryId: 'del_exhausted_la', consumeCount: 1 });
    const exhausted: JobRecord = {
      ...base,
      lastAttempt: {
        deliveryId: 'del_exhausted_la',
        attempt: 5,
        outcome: 'retrying',
        phase: 'after_send',
        httpStatus: 503,
        retryAfterMs: null,
        startedAt: T0 - 1_000,
        updatedAt: T0 - 1_000,
      },
    };
    const s = scenario({ stuck: [exhausted] });

    const report = await s.sweep({ maxAttempts: 3 });

    expect(report).toMatchObject({ stuckFound: 1, redelivered: 0, failed: 0, skippedProcessed: 0 });
    expect(s.producer.sent).toEqual([]);
    expect(s.observability.logNamed('reconcile.attempt_budget_exhausted')).toHaveLength(1);
  });

  it('does not resurrect an exhausted (DLQ-bound) job', async () => {
    // Kịch bản mission: job đã kiệt ngân sách ⇒ reconciliation không re-deliver, dù
    // processed vẫn false (đúng như DLQ resurrection scenario).
    const s = scenario({
      stuck: [stuckJob({ deliveryId: 'del_dlq', consumeCount: 10, processed: false })],
    });

    const report = await s.sweep({ maxAttempts: 3 });

    expect(report.redelivered).toBe(0);
    expect(s.producer.sent).toEqual([]);
  });

  it('still re-delivers a job under the budget', async () => {
    const s = scenario({ stuck: [stuckJob({ deliveryId: 'del_ok', consumeCount: 1 })] });

    const report = await s.sweep({ maxAttempts: 3 });

    expect(report).toMatchObject({ stuckFound: 1, redelivered: 1, failed: 0, skippedProcessed: 0 });
    expect(s.producer.sent).toHaveLength(1);
  });

  it('still skips a job marked processed as before', async () => {
    const jobs = new FakeJobScan([stuckJob({ deliveryId: 'del_proc' })]);
    const producer = new FakeProducer();
    const observability = new FakeObservability();
    const deps: JobReconciliationDeps = {
      jobs: {
        ...unwritableJobState,
        listStuck: (input: { stuckAfterMs: number; nowMs: number; limit: number }) =>
          jobs.listStuck(input),
        findByDeliveryId: async (deliveryId: string) => {
          jobs.markProcessedMidSweep(deliveryId);
          return jobs.findByDeliveryId(deliveryId);
        },
      } as unknown as JobStatePortLike,
      queue: producer,
      clock: { now: () => T0 },
      metrics: observability.port,
      logger: observability.port,
    };

    const report = await runJobReconciliation(deps, {
      stuckAfterMs: STUCK_AFTER_MS,
      limit: 100,
      maxAttempts: 3,
    });

    expect(report).toMatchObject({ skippedProcessed: 1, redelivered: 0 });
    expect(producer.sent).toEqual([]);
  });
});
