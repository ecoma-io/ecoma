/**
 * Test của ba sweep ở `report-sweeps.ts`.
 *
 * Fakes ở đây là **spy ghi lại lời gọi**, không phải một state machine thứ hai: chúng chỉ
 * trả về kết quả mà spec đã dựng sẵn và ghi lại tham số, để ca test khẳng định được
 * đúng những gì sweep **làm** (gọi gateway với payload nào, ghi state nào, có alert
 * hay không). Semantics của conditional UPDATE thuộc về `d1-mail-job-repository`, không
 * thuộc về sweep — và sweep không được tự phát minh thêm một bước quyết định nào ngoài
 * những gì port đã nêu.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi, type Mock } from 'vitest';

import type {
  DeliveryLookupResult,
  MailDeliveryGateway,
  OutcomeReportRequest,
  OutcomeReportResult,
} from './mail-delivery-gateway';
import type {
  AcquireReportLeaseParams,
  AcquireReportLeaseResult,
  BlockedBacklogSweepItem,
  CompleteReportParams,
  CompleteReportResult,
  FindBlockedBacklogCandidatesParams,
  FindReportSweepCandidatesParams,
  FindStaleLeaseCandidatesParams,
  KeepReportPendingParams,
  KeepReportPendingResult,
  MailJobRepository,
  ReportSweepItem,
  StaleLeaseSweepItem,
} from './mail-job-repository-port';
import {
  REPORT_SWEEP_ALERT_KINDS,
  runBlockedBacklogSweep,
  runReportSweep,
  runStaleLeaseSweep,
  type ReportSweepAlert,
  type ReportSweepConfig,
  type ReportSweepDeps,
} from './report-sweeps';

/** Mốc thời gian dùng chung — mọi biên được tính trên giá trị tường minh, không dùng đồng hồ. */
const NOW = 1_800_000_000_000;

/**
 * Chữ ký của từng spy, ghim theo đúng port.
 *
 * Không dùng `Record<string, Mock>`: một spy không có kiểu thì `toHaveBeenCalledWith` vẫn
 * xanh với **bất kỳ** tham số nào, và một ca test như vậy chỉ chứng minh được là sweep có
 * gọi hàm, không chứng minh được là gọi **đúng thứ**. Ở đây mỗi spy nhận kiểu thật của
 * params port truyền vào, nên sai tham số là đỏ.
 */
type AcquireReportLease = (params: AcquireReportLeaseParams) => Promise<AcquireReportLeaseResult>;
type CompleteReport = (params: CompleteReportParams) => Promise<CompleteReportResult>;
type KeepReportPending = (params: KeepReportPendingParams) => Promise<KeepReportPendingResult>;
type FindReportSweepCandidates = (
  params: FindReportSweepCandidatesParams,
) => Promise<readonly ReportSweepItem[]>;
type FindStaleLeaseCandidates = (
  params: FindStaleLeaseCandidatesParams,
) => Promise<readonly StaleLeaseSweepItem[]>;
type FindBlockedBacklogCandidates = (
  params: FindBlockedBacklogCandidatesParams,
) => Promise<readonly BlockedBacklogSweepItem[]>;
type ReportOutcome = (
  deliveryId: string,
  report: OutcomeReportRequest,
) => Promise<OutcomeReportResult>;
type GetDelivery = (deliveryId: string) => Promise<DeliveryLookupResult>;

type JobsSpies = {
  readonly acquireReportLease: Mock<AcquireReportLease>;
  readonly completeReport: Mock<CompleteReport>;
  readonly keepReportPending: Mock<KeepReportPending>;
  readonly findReportSweepCandidates: Mock<FindReportSweepCandidates>;
  readonly findStaleLeaseCandidates: Mock<FindStaleLeaseCandidates>;
  readonly findBlockedBacklogCandidates: Mock<FindBlockedBacklogCandidates>;
};

/** Config mặc định của ca test; ca nào khác thì override đúng field nó đang kiểm. */
function config(overrides: Partial<ReportSweepConfig> = {}): ReportSweepConfig {
  return {
    owner: 'report-sweeper-1',
    nowMs: NOW,
    leaseMs: 30_000,
    maxReportAttempts: 3,
    batchLimit: 100,
    ...overrides,
  };
}

/** Candidate `pending` chuẩn: đã có kết quả, chưa báo, chưa giữ report-lease. */
function candidate(overrides: Partial<ReportSweepItem> = {}): ReportSweepItem {
  return {
    deliveryId: 'delivery-1',
    messageId: 'message-1',
    dispatchGeneration: 1,
    status: 'failed',
    outcomeReportState: 'pending',
    reportAttempts: 0,
    reportLeaseOwner: null,
    reportLeaseExpiresAt: null,
    lastErrorClass: 'permanent',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Fakes                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/**
 * Fake của sáu operation mà ba sweep chạm — gồm cả ba operation mà hai sweep chỉ-alert
 * **không** được chạm.
 *
 * Mọi method đều là `vi.fn()`, kể cả method được override: một override phải vẫn để lại
 * spy, nếu không thì ca test ghi đè hành vi sẽ mất chính cái bằng chứng nó cần kiểm —
 * "sweep có gọi `acquireReportLease` không" sẽ không còn cách nào trả lời.
 *
 * Spy không phải một state machine thứ hai: chúng trả về kết quả spec đã dựng sẵn và ghi
 * lại tham số. Semantics của conditional UPDATE thuộc về `d1-mail-job-repository`; sweep
 * không được tự phát minh thêm bước quyết định nào ngoài những gì port đã nêu.
 */
function fakeJobs(overrides: Partial<MailJobRepository> = {}): {
  readonly jobs: MailJobRepository;
  readonly spies: JobsSpies;
} {
  const acquireReportLease = vi.fn<AcquireReportLease>(
    async () =>
      ({
        kind: 'acquired',
      }) as AcquireReportLeaseResult,
  );
  const completeReport = vi.fn<CompleteReport>(
    async () => ({ kind: 'applied' }) as CompleteReportResult,
  );
  const keepReportPending = vi.fn<KeepReportPending>(
    async () => ({ kind: 'applied' }) as KeepReportPendingResult,
  );
  const findReportSweepCandidates = vi.fn<FindReportSweepCandidates>(async () => []);
  const findStaleLeaseCandidates = vi.fn<FindStaleLeaseCandidates>(async () => []);
  const findBlockedBacklogCandidates = vi.fn<FindBlockedBacklogCandidates>(async () => []);

  const spies = {
    acquireReportLease,
    completeReport,
    keepReportPending,
    findReportSweepCandidates,
    findStaleLeaseCandidates,
    findBlockedBacklogCandidates,
  };

  // Override đi qua `mockImplementation` trên chính spy đó, không phải ghi đè field: một
  // field mới sẽ làm mất lời gọi đã ghi lại, và "sweep có gọi hàm này không" trở thành câu
  // hỏi không có đáp án. Tên không có trong danh sách là lỗi của ca test, không phải
  // một key cần tự sinh.
  for (const [name, implementation] of Object.entries(overrides)) {
    const existing = spies[name as keyof typeof spies] as
      | { mockImplementation(implementation: unknown): void }
      | undefined;
    if (existing === undefined) {
      throw new Error(`fakeJobs: no spy named ${name}`);
    }
    existing.mockImplementation(implementation);
  }

  const jobs = { ...spies } as unknown as MailJobRepository;

  return { jobs, spies };
}

/** Gateway chỉ cần `reportOutcome` cho sweep; `getDelivery` không được gọi ở đây. */
function fakeGateway(result: OutcomeReportResult | (() => Promise<OutcomeReportResult>)): {
  readonly gateway: MailDeliveryGateway;
  readonly reportOutcome: Mock<ReportOutcome>;
  readonly getDelivery: Mock<GetDelivery>;
} {
  const reportOutcome = vi.fn<ReportOutcome>(async () =>
    typeof result === 'function' ? await result() : result,
  );
  const getDelivery = vi.fn<GetDelivery>(async () => ({ kind: 'not-found' }) as const);

  const gateway = { reportOutcome, getDelivery } as unknown as MailDeliveryGateway;

  return { gateway, reportOutcome, getDelivery };
}

/** Dựng deps đầy đủ cho một ca, với alert được gom lại để assert. */
function harness(
  options: {
    readonly candidates?: readonly ReportSweepItem[];
    readonly reportResult?: OutcomeReportResult | (() => Promise<OutcomeReportResult>);
    readonly jobsOverrides?: Partial<MailJobRepository>;
  } = {},
): {
  readonly deps: ReportSweepDeps;
  readonly alerts: ReportSweepAlert[];
  readonly spies: Record<string, ReturnType<typeof vi.fn>>;
  readonly reportOutcome: ReturnType<typeof vi.fn>;
  readonly getDelivery: ReturnType<typeof vi.fn>;
} {
  const { jobs, spies } = fakeJobs({
    findReportSweepCandidates: async () => options.candidates ?? [],
    ...options.jobsOverrides,
  });
  const { gateway, reportOutcome, getDelivery } = fakeGateway(
    options.reportResult ?? { kind: 'applied', status: 'failed' },
  );
  const alerts: ReportSweepAlert[] = [];

  return {
    deps: {
      jobs,
      gateway,
      logAlert: (alert) => alerts.push(alert),
    },
    alerts,
    spies,
    reportOutcome,
    getDelivery,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* runReportSweep — chốt terminal theo signal của control plane                                    */
/* -------------------------------------------------------------------------------------------- */

describe('runReportSweep', () => {
  it('reports a pending row when control plane applies the outcome', async () => {
    const { deps, spies, reportOutcome, getDelivery, alerts } = harness({
      candidates: [candidate()],
      reportResult: { kind: 'applied', status: 'failed' },
    });

    const summary = await runReportSweep(deps, config());

    expect(spies.acquireReportLease).toHaveBeenCalledTimes(1);
    expect(spies.acquireReportLease).toHaveBeenCalledWith({
      deliveryId: 'delivery-1',
      dispatchGeneration: 1,
      owner: 'report-sweeper-1',
      nowMs: NOW,
      reportLeaseMs: 30_000,
    });
    expect(reportOutcome).toHaveBeenCalledWith('delivery-1', {
      outcome: 'failed',
      errorClass: 'permanent',
      dispatchGeneration: 1,
    });
    expect(spies.completeReport).toHaveBeenCalledWith({
      deliveryId: 'delivery-1',
      dispatchGeneration: 1,
      owner: 'report-sweeper-1',
      nowMs: NOW,
      disposition: 'reported',
    });
    expect(spies.keepReportPending).not.toHaveBeenCalled();
    expect(summary).toEqual({
      processed: 1,
      reported: 1,
      superseded: 0,
      orphaned: 0,
      keptPending: 0,
      blockedByBudget: 0,
    });
    // Report chỉ báo nốt outcome — không bao giờ kéo theo đọc lại delivery (§9.5).
    expect(getDelivery).not.toHaveBeenCalled();
    expect(alerts).toEqual([]);
  });

  it('treats a duplicate acknowledgement as reported', async () => {
    const { deps, spies } = harness({
      candidates: [candidate()],
      reportResult: { kind: 'duplicate', status: 'failed' },
    });

    const summary = await runReportSweep(deps, config());

    expect(spies.completeReport).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: 'reported' }),
    );
    expect(summary.reported).toBe(1);
    expect(summary.keptPending).toBe(0);
  });

  it('supersedes a stale generation instead of leaving the row pending', async () => {
    const { deps, spies } = harness({
      candidates: [candidate()],
      reportResult: { kind: 'stale', status: 'failed', currentDispatchGeneration: 7 },
    });

    const summary = await runReportSweep(deps, config());

    expect(spies.completeReport).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: 'superseded' }),
    );
    expect(spies.keepReportPending).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ processed: 1, superseded: 1, keptPending: 0 });
  });

  it('orphans a delivery that no longer exists in the control plane', async () => {
    const { deps, spies } = harness({
      candidates: [candidate()],
      reportResult: { kind: 'not-found' },
    });

    const summary = await runReportSweep(deps, config());

    expect(spies.completeReport).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: 'orphaned' }),
    );
    expect(spies.keepReportPending).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ processed: 1, orphaned: 1, keptPending: 0 });
  });

  it.each([
    ['a transient failure', { kind: 'transient' } as OutcomeReportResult],
    ['a contract rejection', { kind: 'contract-rejected' } as OutcomeReportResult],
    ['an auth rejection', { kind: 'auth-rejected' } as OutcomeReportResult],
  ])('keeps the row pending after %s', async (_label, reportResult) => {
    const { deps, spies } = harness({
      candidates: [candidate()],
      reportResult,
    });

    const summary = await runReportSweep(deps, config());

    expect(spies.keepReportPending).toHaveBeenCalledWith({
      deliveryId: 'delivery-1',
      dispatchGeneration: 1,
      owner: 'report-sweeper-1',
      nowMs: NOW,
    });
    expect(spies.completeReport).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ processed: 1, keptPending: 1 });
  });
});

/* -------------------------------------------------------------------------------------------- */
/* runReportSweep — ngân sách report                                                              */
/* -------------------------------------------------------------------------------------------- */

describe('runReportSweep report budget', () => {
  it('alerts without touching state when the candidate has exhausted its budget', async () => {
    const { deps, spies, reportOutcome, alerts } = harness({
      candidates: [candidate({ reportAttempts: 3 })],
      // maxReportAttempts = 3 ⇒ đã chạm trần.
    });

    const summary = await runReportSweep(deps, config());

    expect(summary).toEqual({
      processed: 1,
      reported: 0,
      superseded: 0,
      orphaned: 0,
      keptPending: 0,
      blockedByBudget: 1,
    });
    expect(alerts).toEqual([
      { kind: REPORT_SWEEP_ALERT_KINDS.reportBudgetExhausted, deliveryId: 'delivery-1' },
    ]);
    // Không acquire, không gọi provider: một lần báo không giữ lease chính là một lần báo trùng.
    expect(spies.acquireReportLease).not.toHaveBeenCalled();
    expect(reportOutcome).not.toHaveBeenCalled();
    // `pending` được giữ nguyên — chưa báo xong thì phải còn báo được.
    expect(spies.completeReport).not.toHaveBeenCalled();
    expect(spies.keepReportPending).not.toHaveBeenCalled();
  });

  it('alerts once per exhausted candidate across a batch', async () => {
    const { deps, spies, alerts } = harness({
      candidates: [
        candidate({ deliveryId: 'delivery-1', reportAttempts: 9 }),
        candidate({ deliveryId: 'delivery-2', reportAttempts: 3 }),
        candidate({ deliveryId: 'delivery-3', reportAttempts: 1 }),
      ],
    });

    const summary = await runReportSweep(deps, config());

    expect(summary.processed).toBe(3);
    expect(summary.blockedByBudget).toBe(2);
    expect(summary.reported).toBe(1);
    expect(alerts.map((alert) => alert.deliveryId)).toEqual(['delivery-1', 'delivery-2']);
    expect(spies.acquireReportLease).toHaveBeenCalledTimes(1);
  });

  it('reports a row whose budget has one attempt left', async () => {
    const { deps, spies } = harness({
      candidates: [candidate({ reportAttempts: 2 })],
    });

    const summary = await runReportSweep(deps, config({ maxReportAttempts: 3 }));

    expect(spies.acquireReportLease).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ blockedByBudget: 0, reported: 1 });
  });
});

/* -------------------------------------------------------------------------------------------- */
/* runReportSweep — lease và lỗi hạ tầng                                                         */
/* -------------------------------------------------------------------------------------------- */

describe('runReportSweep lease and failure handling', () => {
  it('skips a candidate whose report lease is denied without calling the gateway', async () => {
    const { deps, spies, reportOutcome } = harness({
      candidates: [candidate()],
      jobsOverrides: {
        acquireReportLease: async () => ({
          kind: 'denied',
          reason: 'report-lease-active',
        }),
      },
    });

    const summary = await runReportSweep(deps, config());

    expect(spies.acquireReportLease).toHaveBeenCalledTimes(1);
    expect(reportOutcome).not.toHaveBeenCalled();
    expect(spies.completeReport).not.toHaveBeenCalled();
    expect(spies.keepReportPending).not.toHaveBeenCalled();
    // Denied là kết quả bình thường, không phải lỗi: nó vẫn là một candidate đã xét.
    expect(summary).toEqual({
      processed: 1,
      reported: 0,
      superseded: 0,
      orphaned: 0,
      keptPending: 0,
      blockedByBudget: 0,
    });
  });

  it.each(['missing-job', 'generation-mismatch', 'not-pending'] as const)(
    'skips a candidate denied for %s',
    async (reason) => {
      const { deps, reportOutcome } = harness({
        candidates: [candidate()],
        jobsOverrides: { acquireReportLease: async () => ({ kind: 'denied', reason }) },
      });

      await runReportSweep(deps, config());

      expect(reportOutcome).not.toHaveBeenCalled();
    },
  );

  it('keeps the row pending and swallows a gateway exception', async () => {
    const { deps, spies, alerts } = harness({
      candidates: [candidate()],
      reportResult: async () => {
        throw new Error('control plane unreachable');
      },
    });

    const summary = await runReportSweep(deps, config());

    expect(spies.keepReportPending).toHaveBeenCalledWith({
      deliveryId: 'delivery-1',
      dispatchGeneration: 1,
      owner: 'report-sweeper-1',
      nowMs: NOW,
    });
    expect(spies.completeReport).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ processed: 1, keptPending: 1 });
    // Sweep giữ lỗi hạ tầng của lần báo trong im lặng: message của exception không phải
    // token đã sanitize nên không được đẩy vào alert.
    expect(alerts).toEqual([]);
  });

  it('continues with the remaining candidates after one gateway exception', async () => {
    const { deps, spies } = harness({
      candidates: [
        candidate({ deliveryId: 'delivery-1' }),
        candidate({ deliveryId: 'delivery-2' }),
      ],
      reportResult: async () => {
        throw new Error('control plane unreachable');
      },
    });

    const summary = await runReportSweep(deps, config());

    expect(spies.acquireReportLease).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ processed: 2, keptPending: 2 });
  });

  it('swallows a failing release so one bad row cannot kill the sweep', async () => {
    const { deps, spies } = harness({
      candidates: [candidate()],
      reportResult: async () => {
        throw new Error('control plane unreachable');
      },
      jobsOverrides: {
        keepReportPending: async () => {
          throw new Error('d1 unavailable');
        },
      },
    });

    const summary = await runReportSweep(deps, config());

    expect(spies.keepReportPending).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ processed: 1, keptPending: 1 });
  });

  it('runs without an alert sink wired', async () => {
    const { deps, spies } = harness({ candidates: [candidate({ reportAttempts: 9 })] });

    // Cổng alert là tuỳ chọn: sweep phải chạy được khi composition root chưa nối metric,
    // kể cả ở nhánh hết ngân sách — nhánh duy nhất vốn gọi `logAlert`.
    const summary = await runReportSweep({ jobs: deps.jobs, gateway: deps.gateway }, config());

    expect(summary.blockedByBudget).toBe(1);
    expect(spies.acquireReportLease).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------------------------- */
/* runReportSweep — payload và biên của lần báo                                                    */
/* -------------------------------------------------------------------------------------------- */

describe('runReportSweep report payload', () => {
  it.each([
    ['sent', 'retryable'],
    ['failed', 'permanent'],
    ['blocked', 'credential'],
  ] as const)('sends outcome %s with error class %s', async (status, errorClass) => {
    const { deps, reportOutcome } = harness({
      candidates: [candidate({ status, lastErrorClass: errorClass })],
    });

    await runReportSweep(deps, config());

    expect(reportOutcome).toHaveBeenCalledWith('delivery-1', {
      outcome: status,
      errorClass,
      dispatchGeneration: 1,
    });
  });

  it.each(['execution-budget-exhausted', 'delivery-not-found', 'provider-server-error', 'timeout'])(
    'omits the non-canonical error class %s',
    async (lastErrorClass) => {
      const { deps, reportOutcome } = harness({
        candidates: [candidate({ lastErrorClass })],
      });

      await runReportSweep(deps, config());

      // `error_class` trên wire là optional; gửi một token worker-internal sẽ bị contract
      // từ chối (`400` → giữ `pending` mãi) chỉ vì một giá trị hoàn toàn hợp lệ ở D1.
      expect(reportOutcome).toHaveBeenCalledWith('delivery-1', {
        outcome: 'failed',
        dispatchGeneration: 1,
      });
      const [report] = reportOutcome.mock.calls[0];
      expect(report).not.toHaveProperty('errorClass');
    },
  );

  it('omits the error class entirely when the row has none', async () => {
    const { deps, reportOutcome } = harness({
      candidates: [candidate({ lastErrorClass: null })],
    });

    await runReportSweep(deps, config());

    expect(reportOutcome).toHaveBeenCalledWith('delivery-1', {
      outcome: 'failed',
      dispatchGeneration: 1,
    });
  });

  it('forwards the dispatch generation the candidate was read at', async () => {
    const { deps, reportOutcome, spies } = harness({
      candidates: [candidate({ dispatchGeneration: 12 })],
    });

    await runReportSweep(deps, config());

    expect(reportOutcome).toHaveBeenCalledWith(
      'delivery-1',
      expect.objectContaining({ dispatchGeneration: 12 }),
    );
    expect(spies.acquireReportLease).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchGeneration: 12 }),
    );
  });

  it('passes the caller clock and lease through unchanged on every write', async () => {
    const { deps, spies } = harness({ candidates: [candidate()] });

    await runReportSweep(deps, config({ nowMs: NOW + 500, leaseMs: 1_234 }));

    expect(spies.acquireReportLease).toHaveBeenCalledWith(
      expect.objectContaining({ nowMs: NOW + 500, reportLeaseMs: 1_234 }),
    );
    expect(spies.completeReport).toHaveBeenCalledWith(
      expect.objectContaining({ nowMs: NOW + 500 }),
    );
  });

  it('forwards the batch limit and the budget to the candidate query', async () => {
    const { deps, spies } = harness();

    await runReportSweep(deps, config({ maxReportAttempts: 7, batchLimit: 25 }));

    expect(spies.findReportSweepCandidates).toHaveBeenCalledWith({
      nowMs: NOW,
      maxReportAttempts: 7,
      limit: 25,
    });
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Hai sweep chỉ-alert                                                                             */
/* -------------------------------------------------------------------------------------------- */

describe('runStaleLeaseSweep', () => {
  const staleItem: StaleLeaseSweepItem = {
    deliveryId: 'delivery-1',
    messageId: 'message-1',
    dispatchGeneration: 1,
    executionGeneration: 3,
    status: 'processing',
    leaseExpiresAt: NOW - 1,
    leaseOwner: 'execution-1',
    attempts: 2,
  };

  it('alerts once per stale execution lease without changing any state', async () => {
    const { deps, spies, alerts } = harness({
      jobsOverrides: {
        findStaleLeaseCandidates: async () => [
          staleItem,
          { ...staleItem, deliveryId: 'delivery-2' },
        ],
      },
    });

    const summary = await runStaleLeaseSweep(deps, config());

    expect(alerts).toEqual([
      { kind: REPORT_SWEEP_ALERT_KINDS.executionLeaseStale, deliveryId: 'delivery-1' },
      { kind: REPORT_SWEEP_ALERT_KINDS.executionLeaseStale, deliveryId: 'delivery-2' },
    ]);
    expect(summary).toEqual({ inspected: 2, alerted: 2 });
    expect(spies.findStaleLeaseCandidates).toHaveBeenCalledWith({ nowMs: NOW, limit: 100 });
    // Lease hết hạn không phải status đổi: mọi conditional write đều không được chạm.
    expect(spies.acquireReportLease).not.toHaveBeenCalled();
    expect(spies.completeReport).not.toHaveBeenCalled();
    expect(spies.keepReportPending).not.toHaveBeenCalled();
  });

  it('reports an empty batch without inventing work', async () => {
    const { deps, alerts } = harness();

    const summary = await runStaleLeaseSweep(deps, config());

    expect(summary).toEqual({ inspected: 0, alerted: 0 });
    expect(alerts).toEqual([]);
  });

  it('still counts inspected rows when no alert sink is wired', async () => {
    const { deps } = harness({
      jobsOverrides: { findStaleLeaseCandidates: async () => [staleItem] },
    });

    const summary = await runStaleLeaseSweep({ jobs: deps.jobs, gateway: deps.gateway }, config());

    expect(summary).toEqual({ inspected: 1, alerted: 1 });
  });
});

describe('runBlockedBacklogSweep', () => {
  const blockedItem: BlockedBacklogSweepItem = {
    deliveryId: 'delivery-1',
    messageId: 'message-1',
    dispatchGeneration: 1,
    status: 'blocked',
    blockedAt: NOW - 60_000,
    attempts: 5,
    lastErrorClass: 'execution-budget-exhausted',
  };

  it('alerts once per blocked row without changing any state', async () => {
    const { deps, spies, alerts } = harness({
      jobsOverrides: { findBlockedBacklogCandidates: async () => [blockedItem] },
    });

    const summary = await runBlockedBacklogSweep(deps, config());

    expect(alerts).toEqual([
      { kind: REPORT_SWEEP_ALERT_KINDS.blockedBacklog, deliveryId: 'delivery-1' },
    ]);
    expect(summary).toEqual({ inspected: 1, alerted: 1 });
    // Worker không tự bump generation, không tự re-enqueue, không tự đổi `blocked`.
    expect(spies.findBlockedBacklogCandidates).toHaveBeenCalledWith({
      cutoffMs: NOW,
      limit: 100,
    });
    expect(spies.completeReport).not.toHaveBeenCalled();
    expect(spies.keepReportPending).not.toHaveBeenCalled();
    expect(spies.acquireReportLease).not.toHaveBeenCalled();
  });

  it('uses the caller cutoff when one is supplied', async () => {
    const { deps, spies } = harness();

    await runBlockedBacklogSweep(deps, config({ blockedCutoffMs: NOW - 3_600_000 }));

    expect(spies.findBlockedBacklogCandidates).toHaveBeenCalledWith({
      cutoffMs: NOW - 3_600_000,
      limit: 100,
    });
  });

  it('falls back to the sweep clock as the cutoff', async () => {
    const { deps, spies } = harness();

    await runBlockedBacklogSweep(deps, config());

    // Không có ngưỡng riêng thì mọi row `blocked` đều được báo — hành vi chặt hơn, và là
    // một số hữu hạn nên vẫn bound được.
    expect(spies.findBlockedBacklogCandidates).toHaveBeenCalledWith({
      cutoffMs: NOW,
      limit: 100,
    });
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Ranh giới phụ thuộc                                                                             */
/* -------------------------------------------------------------------------------------------- */

/**
 * Đọc source text của chính file sweep, bỏ comment trước khi scan.
 *
 * Bỏ comment là bắt buộc: một regex guard luôn tự mô tả chính nó trong docblock, nên
 * không bỏ comment thì `not.toMatch(/\bconsole\b/)` sẽ đỏ vì chính dòng giải thích rằng
 * không có `console` — đỏ sai lý do, và một guard đỏ sai lý do dạy người đọc bỏ qua nó.
 */
function sweepCode(): string {
  return readFileSync(join(import.meta.dirname, 'report-sweeps.ts'), 'utf8')
    .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
    .replaceAll(/(?:^|[^:])\/\/.*$/gmu, '$1');
}

describe('dependency boundary', () => {
  it('never sends a free-form string to the alert sink', () => {
    const code = sweepCode();

    // `detail` chỉ được là token do sweep dựng; hiện sweep **không** gán field này ở
    // bất kỳ alert nào, và đó là điểm: không có đường nào đưa exception message vào alert.
    expect(code).not.toMatch(/\bdetail:/u);
  });

  it('does not import any infrastructure or application code', () => {
    const code = sweepCode();
    const specifiers = [...code.matchAll(/from\s+'([^']+)'/gu)].map((match) => match[1]);

    expect(specifiers).toEqual([
      './mail-delivery-gateway',
      './mail-job-model',
      './mail-job-repository-port',
      './mail-job-rules',
    ]);
  });

  it('does not import a Node builtin', () => {
    // Worker chạy trên Cloudflare Workers không có `node:*`; `Promise.all` thì tồn tại,
    // nhưng sweep vẫn chọn vòng lặp tuần tự để không đụng lease của cùng một row.
    expect(sweepCode()).not.toMatch(/from\s+'node:/u);
  });

  it('never calls the delivery lookup while reporting', () => {
    const code = sweepCode();

    expect(code).not.toMatch(/\.getDelivery\(/u);
  });
});
