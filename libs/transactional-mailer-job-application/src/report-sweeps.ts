import type {
  MailDeliveryGateway,
  OutcomeReportRequest,
  OutcomeReportResult,
} from './mail-delivery-gateway';
import type { MailJobStatus } from './mail-job-model';
import type {
  AcquireReportLeaseParams,
  CompleteReportDisposition,
  CompleteReportParams,
  FindBlockedBacklogCandidatesParams,
  FindReportSweepCandidatesParams,
  FindStaleLeaseCandidatesParams,
  KeepReportPendingParams,
  MailJobRepository,
  ReportSweepItem,
} from './mail-job-repository-port';
import {
  dispositionForControlPlaneOutcome,
  type ControlPlaneOutcomeSignal,
  type OutcomeReportDisposition,
} from './mail-job-rules';

/* -------------------------------------------------------------------------------------------- */
/* Contract                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * Alert đã sanitize mà sweep phát ra.
 *
 * Đúng ba field. `detail` là **token do chính sweep dựng**, không phải exception message
 * hay raw body của bên thứ ba — sweep này không có đường nào giữ text tự do. Alert nêu
 * `delivery_id` là đủ để operator tra lại; recipient, subject/body, endpoint và
 * credential không bao giờ đi vào đây (§13, `03-operations.md` §10).
 */
export type ReportSweepAlert = {
  /** Nhãn chẩn đoán — đóng ở {@link REPORT_SWEEP_ALERT_KINDS}. */
  readonly kind: string;
  /** Delivery mà alert nói về; vắng mặt khi alert không gắn với một row cụ thể. */
  readonly deliveryId?: string;
  /** Token đã sanitize, không phải text tự do. */
  readonly detail?: string;
};

/**
 * Dependency dùng chung của cả ba sweep.
 *
 * Cả ba nhận **cùng một** deps để một scheduled handler chỉ cần dựng deps một lần, và
 * để ranh giới I/O nằm đúng một chỗ: `jobs` là port D1, `gateway` là port sang control
 * plane, `logAlert` là cổng alert mà composition root nối vào metric/alert thật.
 */
export type ReportSweepDeps = {
  /** Port persistence — không có I/O nào khác trong file này. */
  readonly jobs: MailJobRepository;
  /** Port sang private delivery interface của control plane. */
  readonly gateway: MailDeliveryGateway;
  /** Cổng alert tùy chọn: thiếu thì sweep vẫn chạy, chỉ mất tín hiệu vận hành. */
  readonly logAlert?: (alert: ReportSweepAlert) => void;
};

/**
 * Tham số chung của **mỗi** sweep — do caller truyền vào, không có default trong file.
 *
 * `owner` là token của sweeper này (UUID sinh local), được ghi vào `report_lease_owner`
 * bởi đúng statement (d) §9.2.1, và là điều kiện để `completeReport`/`keepReportPending`
 * còn ghi được sau đó. `nowMs` là **mốc duy nhất** của sweep: một lần đọc, truyền nguyên
 * vẹn cho mọi operation, để một lần quét không tự mâu thuẫn khi đồng hồ trôi giữa chừng.
 */
export type ReportSweepConfig = {
  readonly owner: string;
  readonly nowMs: number;
  /** `reportLeaseMs` — thời hạn lease của sweeper này. */
  readonly leaseMs: number;
  readonly maxReportAttempts: number;
  /** Trần số row một lần quét — bound chung cho cả ba sweep. */
  readonly batchLimit: number;
  /**
   * Ngưỡng tuổi của `blocked` cho blocked-backlog sweep: sweep chọn row có
   * `blocked_at <= blockedCutoffMs`.
   *
   * Mặc định là chính `nowMs` — tức **mọi** row `blocked` đều được báo. Đó là hành vi
   * *chặt hơn* (báo nhiều hơn), không phải lỏng hơn, nên vẫn đúng với "chỉ alert"; và nó
   * là một số nguyên hữu hạn, nên `assertSafeInteger` của repository không từ chối.
   */
  readonly blockedCutoffMs?: number;
};

/** Tổng kết một lần chạy của report sweep. */
export type ReportSweepSummary = {
  /** Số candidate đã xét, kể cả candidate bị bỏ qua vì không acquire được. */
  readonly processed: number;
  readonly reported: number;
  readonly superseded: number;
  readonly orphaned: number;
  readonly keptPending: number;
  /** Số candidate bị bỏ qua vì `report_attempts` đã chạm trần. */
  readonly blockedByBudget: number;
};

/** Tổng kết một lần chạy của hai sweep chỉ-alert. */
export type AlertSweepSummary = {
  readonly inspected: number;
  readonly alerted: number;
};

/**
 * Nhãn chẩn đoán của từng alert — đóng ở đây để metric không bao giờ nhận nhãn tự do.
 *
 * `execution-lease-stale` và `blocked-backlog` **không** phải kết quả của một lần gọi
 * API: chúng là nhãn chẩn đoán cho một tình trạng bền vững của row, tách bạch khỏi
 * `stale` của `POST .../outcome` (§9.5) và khỏi `blocked` của một job bị provider từ chối.
 */
export const REPORT_SWEEP_ALERT_KINDS = {
  /** Row chờ báo outcome đã chạm trần `report_attempts` → dừng auto-retry, alert. */
  reportBudgetExhausted: 'report-budget-exhausted',
  /** Execution lease hết hạn mà row vẫn `processing` — execution zombie. */
  executionLeaseStale: 'execution-lease-stale',
  /** Row `blocked` đã nằm quá ngưỡng tuổi. */
  blockedBacklog: 'blocked-backlog',
  /** Row vi phạm parity invariant của schema — decoder đã lọc, đây là lưới an toàn. */
  inconsistentCandidate: 'inconsistent-candidate',
} as const;

/* -------------------------------------------------------------------------------------------- */
/* Thuộc tính của report request                                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * Tập `error_class` canonical mà control plane chấp nhận trên wire.
 *
 * `last_error_class` của một row là **token đã sanitize** của worker, không phải enum: nó
 * có thể là `execution-budget-exhausted`, `delivery-not-found`, `provider-server-error`… —
 * những token không phải `error_class`. Gửi thẳng chúng lên control plane sẽ bị contract
 * **từ chối** (`400` → giữ `pending`), tức một giá trị hoàn toàn hợp lệ ở D1 lại làm hỏng
 * việc báo outcome. Vì vậy chỉ năm giá trị canonical đi qua; còn lại thì bỏ trống, vì
 * `error_class` trên wire là optional.
 */
const CANONICAL_ERROR_CLASSES = [
  'retryable',
  'permanent',
  'credential',
  'contract',
  'internal-auth',
] as const;

type CanonicalErrorClass = (typeof CANONICAL_ERROR_CLASSES)[number];

/** Thu hẹp `last_error_class` về `error_class` của wire, hoặc `undefined` để bỏ trống. */
function canonicalErrorClass(lastErrorClass: string | null): CanonicalErrorClass | undefined {
  if (lastErrorClass === null) {
    return undefined;
  }

  return (CANONICAL_ERROR_CLASSES as readonly string[]).includes(lastErrorClass)
    ? (lastErrorClass as CanonicalErrorClass)
    : undefined;
}

/* -------------------------------------------------------------------------------------------- */
/* Ánh xạ kết quả gateway                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * Thu hẹp kết quả của gateway về {@link ControlPlaneOutcomeSignal}.
 *
 * `applied`/`duplicate` là bằng chứng đã báo xong; HTTP 200 không phải bằng chứng đó.
 * `stale` và `not-found` chuyển sang terminal (`superseded`/`orphaned`) và không bao giờ
 * được giữ ở `pending` — đó là điều kiện chặn vòng retry vô hạn (§9.5).
 */
function toOutcomeSignal(result: OutcomeReportResult): ControlPlaneOutcomeSignal {
  switch (result.kind) {
    case 'applied':
      return 'applied';
    case 'duplicate':
      return 'duplicate';
    case 'stale':
      return 'stale';
    case 'not-found':
      return 'not-found';
    case 'auth-rejected':
      return 'auth-rejected';
    case 'contract-rejected':
      return 'contract-rejected';
    case 'transient':
      return 'transient';
  }
}

/** Report chỉ được gửi cho một job đã có kết quả — `processing` là lỗi parity. */
function reportableOutcome(status: MailJobStatus): OutcomeReportRequest['outcome'] | null {
  return status === 'sent' || status === 'failed' || status === 'blocked' ? status : null;
}

/** Bộ đếm của một lần chạy, gom về object mới để caller không giữ được tham chiếu. */
type Counters = {
  processed: number;
  reported: number;
  superseded: number;
  orphaned: number;
  keptPending: number;
  blockedByBudget: number;
};

function newCounters(): Counters {
  return {
    processed: 0,
    reported: 0,
    superseded: 0,
    orphaned: 0,
    keptPending: 0,
    blockedByBudget: 0,
  };
}

/**
 * Tham số chung của mọi conditional write trên `mail_jobs` trong sweep này.
 *
 * Gộp vào một chỗ vì cả ba statement đều phải mang **đúng** cặp
 * `delivery_id + dispatch_generation` và **cùng** `owner`/`nowMs` của lần quét: lệch một
 * field ở đây là một conditional write không bao giờ khớp guard, và khi đó `applied` chỉ
 * còn là giả định.
 */
function writeBase(
  item: ReportSweepItem,
  config: ReportSweepConfig,
): Pick<
  AcquireReportLeaseParams & CompleteReportParams & KeepReportPendingParams,
  'deliveryId' | 'dispatchGeneration' | 'owner' | 'nowMs'
> {
  return {
    deliveryId: item.deliveryId,
    dispatchGeneration: item.dispatchGeneration,
    owner: config.owner,
    nowMs: config.nowMs,
  };
}

/**
 * Thả report-lease sau một lần báo thất bại, nuốt lỗi của chính lần thả.
 *
 * `keepReportPending` **không** bắt buộc phải thành công: guard của nó là
 * `report_lease_owner = :owner` dưới `outcome_report_state = 'pending'`, nên khi gateway
 * đã ném, row có thể đã đổi trạng thái (một execution khác chốt trước). Trường hợp đó
 * **không** phải lỗi của sweep — và nếu lỗi của lần thả lại ném ra, một lỗi hạ tầng đơn lẻ
 * sẽ giết cả lần quét và bỏ sót các row còn lại.
 */
async function keepPendingQuietly(
  deps: ReportSweepDeps,
  item: ReportSweepItem,
  config: ReportSweepConfig,
): Promise<void> {
  try {
    await deps.jobs.keepReportPending({
      ...writeBase(item, config),
    } satisfies KeepReportPendingParams);
  } catch {
    // Cố tình im lặng: xem docblock. Không `logAlert` ở đây vì `detail` phải là token đã
    // sanitize, còn exception message thì không — §13 cấm log nó nguyên văn.
  }
}

/**
 * Áp một disposition lên row, đúng bằng **một** conditional write.
 *
 * `reported`/`superseded`/`orphaned` đi qua `completeReport` (một statement chốt terminal,
 * guard `report_lease_owner = :owner` dưới `pending`); `keep-pending` đi qua
 * `keepReportPending` — một operation **riêng**, tách khỏi việc chốt terminal vì guard và
 * ý nghĩa vận hành của nó khác hẳn (nó release report-lease để lần báo sau claim lại được).
 */
async function applyDisposition(
  deps: ReportSweepDeps,
  item: ReportSweepItem,
  config: ReportSweepConfig,
  disposition: OutcomeReportDisposition,
): Promise<void> {
  if (disposition.kind === 'keep-pending') {
    await keepPendingQuietly(deps, item, config);

    return;
  }

  await deps.jobs.completeReport({
    ...writeBase(item, config),
    disposition: disposition.kind as CompleteReportDisposition,
  } satisfies CompleteReportParams);
}

/* -------------------------------------------------------------------------------------------- */
/* Sweep 2 — báo nốt outcome (trách nhiệm 2)                                                      */
/* -------------------------------------------------------------------------------------------- */

/**
 * Quét row `outcome_report_state = 'pending'` và báo nốt outcome.
 *
 * Bốn điều không đổi, theo §9.5 và `03-operations.md` §10 hàng 2:
 *
 * 1. **Vòng lặp tuần tự, không `Promise.all`.** Hai candidate không đụng lease của nhau,
 *    nhưng chạy song song làm thứ tự ghi khó đoán khi một sweeper khác đang giữ
 *    report-lease của một trong hai row; tuần tự giữ hành vi xác định và giữ một lần quét
 *    nằm gọn trong một budget thời gian.
 * 2. **Không gọi provider.** Report là **chỉ** báo nốt outcome; báo lại không bao giờ kéo
 *    theo gửi lại mail (§9.5).
 * 3. **Không ném.** Một gateway exception là lỗi hạ tầng của lần báo đó, không phải của cả
 *    sweep: nó giữ `pending` để lần quét sau thử lại, và sweep đi tiếp với row còn lại.
 * 4. **Không có vòng retry vô hạn.** `report_attempts` tăng trong **cùng** statement (d),
 *    và khi nó chạm trần thì row đó không còn được auto-retry nữa.
 */
export async function runReportSweep(
  deps: ReportSweepDeps,
  config: ReportSweepConfig,
): Promise<ReportSweepSummary> {
  const counters = newCounters();

  const candidates = await deps.jobs.findReportSweepCandidates({
    nowMs: config.nowMs,
    maxReportAttempts: config.maxReportAttempts,
    limit: config.batchLimit,
  } satisfies FindReportSweepCandidatesParams);

  for (const item of candidates) {
    counters.processed += 1;

    // Bound `report_attempts < maxReportAttempts` là predicate **chọn row** của sweep, KHÔNG
    // nằm trong guard của statement (d) — nên một implementation copy (d) nguyên văn vẫn
    // phải tự áp bound. Query của repository đã áp rồi, nhưng sweep **tự lọc thêm** đúng
    // như spec: một repository khác (hay một query chưa nâng bound) không được làm một row
    // hết ngân sách bị báo lại mãi.
    if (item.reportAttempts >= config.maxReportAttempts) {
      counters.blockedByBudget += 1;
      deps.logAlert?.({
        kind: REPORT_SWEEP_ALERT_KINDS.reportBudgetExhausted,
        deliveryId: item.deliveryId,
      });

      // State **không** đổi: giữ `pending` và cảnh báo. Đánh terminal ở đây sẽ tạo ra một
      // trạng thái mà §9.5 không định nghĩa (report chưa bao giờ được báo xong nhưng lại
      // không còn `pending`), và độ an toàn kém hơn nhiều: còn `pending` nghĩa là một lần
      // sửa + sweep lại vẫn báo được, còn terminal thì không.
      continue;
    }

    const outcome = reportableOutcome(item.status);
    if (outcome === null) {
      // Parity invariant của schema (`outcome_report_state = 'none'` đúng khi
      // `status = 'processing'`) khiến trường hợp này không xảy ra với row đã decode từ
      // D1; đây là lưới an toàn cho một candidate tay. Báo một outcome không xác định
      // cho control plane là contract violation, nên row bị bỏ qua và alert thay vì bị gửi.
      deps.logAlert?.({
        kind: REPORT_SWEEP_ALERT_KINDS.inconsistentCandidate,
        deliveryId: item.deliveryId,
      });

      continue;
    }

    const acquired = await deps.jobs.acquireReportLease({
      ...writeBase(item, config),
      reportLeaseMs: config.leaseMs,
    } satisfies AcquireReportLeaseParams);

    // Denied là kết quả **bình thường**, không phải lỗi: sweeper khác đang giữ report-lease,
    // hoặc một execution khác đã chốt terminal trước. Cả hai đều nghĩa là "không phải việc
    // của lần quét này" — nên không tính vào bộ đếm disposition nào, và tuyệt đối không gọi
    // gateway: một báo không giữ lease chính là một báo trùng.
    if (acquired.kind === 'denied') {
      continue;
    }

    const errorClass = canonicalErrorClass(item.lastErrorClass);

    try {
      const result = await deps.gateway.reportOutcome(item.deliveryId, {
        outcome,
        ...(errorClass === undefined ? {} : { errorClass }),
        dispatchGeneration: item.dispatchGeneration,
      });

      const disposition = dispositionForControlPlaneOutcome(toOutcomeSignal(result));
      await applyDisposition(deps, item, config, disposition);

      switch (disposition.kind) {
        case 'reported':
          counters.reported += 1;
          break;
        case 'superseded':
          counters.superseded += 1;
          break;
        case 'orphaned':
          counters.orphaned += 1;
          break;
        case 'keep-pending':
          counters.keptPending += 1;
          break;
      }
    } catch {
      // Gateway ném, hoặc conditional write ném. Giữ `pending` để lần quét sau thử lại;
      // report-lease tự hết hạn theo `leaseMs`, nên không có gì cần dọn thủ công và không
      // có đường nào giữ một lease vĩnh viễn.
      await keepPendingQuietly(deps, item, config);
      counters.keptPending += 1;
    }
  }

  return {
    processed: counters.processed,
    reported: counters.reported,
    superseded: counters.superseded,
    orphaned: counters.orphaned,
    keptPending: counters.keptPending,
    blockedByBudget: counters.blockedByBudget,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Sweep 1 — stale execution lease (trách nhiệm 1)                                                 */
/* -------------------------------------------------------------------------------------------- */

/**
 * Báo đỏ vận hành cho mọi row `processing` có execution lease đã hết hạn.
 *
 * **Chỉ alert** — không claim, không ghi, không gửi lại. Row vẫn giữ `status =
 * 'processing'`: đây là lease hết hạn chứ không phải status đổi, và enum của cột đóng ở
 * `processing`/`sent`/`failed`/`blocked`. Việc claim lại thuộc đường (a) §9.2.1, và đường
 * đó **chỉ chạy khi có một command mới tới** — nên đây là chỗ duy nhất phát hiện ra một
 * execution đã chết mà không còn command nào nữa (`03-operations.md` §10 hàng 1).
 *
 * Vì không có state nào đổi, sweep này không cần lease để loại trừ hai reconciler xử lý
 * cùng một row; chống alert trùng là việc của tầng alerting, không phải một ghi state.
 */
export async function runStaleLeaseSweep(
  deps: ReportSweepDeps,
  config: ReportSweepConfig,
): Promise<AlertSweepSummary> {
  const items = await deps.jobs.findStaleLeaseCandidates({
    nowMs: config.nowMs,
    limit: config.batchLimit,
  } satisfies FindStaleLeaseCandidatesParams);

  for (const item of items) {
    deps.logAlert?.({
      kind: REPORT_SWEEP_ALERT_KINDS.executionLeaseStale,
      deliveryId: item.deliveryId,
    });
  }

  return { inspected: items.length, alerted: items.length };
}

/* -------------------------------------------------------------------------------------------- */
/* Sweep 3 — blocked backlog (trách nhiệm 3)                                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * Báo đỏ vận hành cho mọi row `blocked` đã nằm quá ngưỡng tuổi.
 *
 * **Chỉ alert**: worker không xoá marker `blocked`, không tăng `dispatch_generation`, không
 * tự re-enqueue và không tự chuyển `failed` (§9.4, invariant #14). Việc mở khoá là thao tác
 * **redrive có authorize** ở control plane, và worker không bao giờ là producer thứ hai của
 * Queue.
 */
export async function runBlockedBacklogSweep(
  deps: ReportSweepDeps,
  config: ReportSweepConfig,
): Promise<AlertSweepSummary> {
  const cutoffMs = config.blockedCutoffMs ?? config.nowMs;

  const items = await deps.jobs.findBlockedBacklogCandidates({
    cutoffMs,
    limit: config.batchLimit,
  } satisfies FindBlockedBacklogCandidatesParams);

  for (const item of items) {
    deps.logAlert?.({
      kind: REPORT_SWEEP_ALERT_KINDS.blockedBacklog,
      deliveryId: item.deliveryId,
    });
  }

  return { inspected: items.length, alerted: items.length };
}
