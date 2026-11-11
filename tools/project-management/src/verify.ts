/**
 * Stage verify (mode apply): sau khi các mutation đã chạy, đọc lại snapshot
 * item của Project và đối chiếu desired membership — KHÔNG tin kết quả
 * mutation thành công.
 *
 * GitHub Projects truyền bá item mới/xoá không đồng bộ: mutation trả về ok
 * nhưng snapshot đọc ngay sau đó có thể chưa thấy hiệu ứng (quan sát thật
 * 2026-11-11: 15/15 add ok, refetch thấy 37/40 sau ~0s và clean sau 57s).
 * Verify vì vậy poll theo bounded exponential backoff với jitter, trong một
 * deadline cấu hình được, và phân biệt:
 *
 * - `clean` — snapshot hoàn chỉnh khớp desired membership.
 * - `propagation_pending` — hết deadline nhưng mọi residual đều là hiệu ứng
 *   chưa hiện của mutation ĐÃ thành công (plausibly propagation, chưa phải
 *   drift); kỳ audit kế tiếp sẽ chứng minh.
 * - `drift` — residual chứa khác biệt KHÔNG giải thích được bằng mutation đã
 *   chạy (mutation lỗi thật, hoặc state đổi ngoài pipeline) — dừng poll sớm
 *   vì chờ thêm không thể làm khác biệt đó biến mất.
 * - `verification_failed` — deadline hết mà vẫn không đọc được snapshot nào
 *   (API lỗi ở trang đầu của mọi attempt).
 * - `inventory_incomplete` — deadline hết mà mọi snapshot cuối đều dở dang
 *   (trang giữa lỗi); không bao giờ kết luận clean/drift trên snapshot một phần.
 *
 * Không bao giờ mutation thêm trong verify (no auto re-apply) và không bao
 * giờ trả clean trên inventory một phần.
 */

import type { IssueClassification } from './classify.js';
import type { GitHubPort } from './github.js';
import { auditState, type AuditFinding } from './audit.js';
import { buildPlan, type PlanAction } from './plan.js';
import type { NormalizedIssue, ProjectItemRecord } from './types.js';

/** Trạng thái verify có thể có trong report. */
export type VerificationStatus =
  | 'not_applicable'
  | 'clean'
  | 'propagation_pending'
  | 'drift'
  | 'verification_failed'
  | 'inventory_incomplete';

/** Một mutation đã thực thi trong mode apply, kèm kết quả thật của nó. */
export interface AppliedMutation {
  action: 'add' | 'remove';
  issueNumber: number | null;
  /** itemId trả về (add) hoặc itemId đích (remove); null khi mutation lỗi. */
  itemId: string | null;
  ok: boolean;
  detail: string;
}

/** Kết quả của một lần đọc snapshot trong vòng poll. */
export interface VerificationAttempt {
  index: number;
  outcome: 'clean' | 'residual_pending' | 'residual_drift' | 'error' | 'incomplete';
  detail: string;
}

export interface VerificationResult {
  /** false cho mode audit: audit không mutation nên không có gì để verify. */
  performed: boolean;
  status: VerificationStatus;
  residualFindings: AuditFinding[];
  /** Chỉ chứa action mutation còn sót lại trên snapshot cuối cùng đọc được. */
  residualPlan: PlanAction[];
  detail: string;
  /** Nhật ký từng lần đọc snapshot theo thứ tự; rỗng khi `performed: false`. */
  attempts: VerificationAttempt[];
  /** Tổng thời gian đã chờ giữa các attempt (không tính thời gian gọi API). */
  waitedMs: number;
  /** Ngân sách deadline của lần verify này; 0 khi `performed: false`. */
  deadlineMs: number;
}

/** Cấu hình vòng poll verify; mọi giá trị inject được để test deterministic. */
export interface VerifyPollingOptions {
  /** Tổng ngân sách tính từ lần refetch đầu tiên (deadline cứng). */
  deadlineMs: number;
  /** Độ trễ trước lần refetch thứ hai. */
  initialDelayMs: number;
  /** Hệ số tăng delay sau mỗi attempt. */
  multiplier: number;
  /** Trần delay giữa hai attempt. */
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  nowMs: () => number;
  /** Nguồn jitter ∈ [0,1); default `Math.random`. */
  rng: () => number;
}

/**
 * Lịch mặc định: 2s → 4s → 8s → 16s → 30s → 30s…, deadline tổng 120s —
 * quan sát thật thấy hội tụ trong 57s, deadline để gấp đôi khoảng đó. Verify
 * hết deadline là tín hiệu để chạy audit chứ không phải lỗi của pipeline.
 */
export const DEFAULT_VERIFY_POLLING: VerifyPollingOptions = {
  deadlineMs: 120_000,
  initialDelayMs: 2_000,
  multiplier: 2,
  maxDelayMs: 30_000,
  sleep: async (ms: number): Promise<void> => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  },
  nowMs: () => Date.now(),
  rng: () => Math.random(),
};

/** Đầu vào của `verifyAfterApply`. */
export interface VerifyInput {
  port: GitHubPort;
  issues: readonly NormalizedIssue[];
  classifications: readonly IssueClassification[];
  appliedMutations: readonly AppliedMutation[];
  options?: Partial<VerifyPollingOptions>;
}

/** Kết quả verify kèm snapshot cuối đọc được (partial nếu dở dang). */
export interface VerifyOutcome {
  verification: VerificationResult;
  afterItems: ProjectItemRecord[];
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const MUTATING_ACTIONS = new Set<PlanAction['action']>(['add', 'remove']);

/**
 * Residual action là "hiệu ứng chưa hiện của mutation đã thành công" khi
 * pipeline có một mutation ok tương ứng: `add #N` giải thích được bởi một add
 * ok cùng số issue; `remove itemId X` giải thích được bởi một remove ok cùng
 * itemId. Residual không có cặp mutation ok nào là khác biệt thật (mutation
 * lỗi, hoặc state đổi ngoài pipeline) — propagation không thể sinh ra nó.
 */
function explainableBySuccessfulMutations(
  residualPlan: readonly PlanAction[],
  appliedMutations: readonly AppliedMutation[],
): boolean {
  return residualPlan.every((action) => {
    if (action.action === 'add') {
      return appliedMutations.some(
        (mutation) =>
          mutation.action === 'add' && mutation.ok && mutation.issueNumber === action.issueNumber,
      );
    }
    if (action.action === 'remove') {
      return action.itemId !== undefined
        ? appliedMutations.some(
            (mutation) =>
              mutation.action === 'remove' && mutation.ok && mutation.itemId === action.itemId,
          )
        : false;
    }
    return false;
  });
}

function notApplicableResult(detail: string): VerificationResult {
  return {
    performed: false,
    status: 'not_applicable',
    residualFindings: [],
    residualPlan: [],
    detail,
    attempts: [],
    waitedMs: 0,
    deadlineMs: 0,
  };
}

/**
 * Poll verify sau apply. Vòng lặp: đọc snapshot → clean thì dừng; residual
 * không giải thích được thì dừng là drift thật; còn lại chờ (backoff +
 * jitter) rồi đọc lại cho tới deadline. Mọi giá trị thời gian qua `options`
 * inject được.
 */
export async function verifyAfterApply(input: VerifyInput): Promise<VerifyOutcome> {
  const { port, issues, classifications, appliedMutations } = input;
  const options: VerifyPollingOptions = { ...DEFAULT_VERIFY_POLLING, ...input.options };
  const attempts: VerificationAttempt[] = [];
  const deadlineAtMs = options.nowMs() + options.deadlineMs;
  let delayMs = options.initialDelayMs;
  let waitedMs = 0;
  let lastItems: ProjectItemRecord[] = [];
  let lastResidualPlan: PlanAction[] = [];
  let lastResidualFindings: AuditFinding[] = [];
  let lastFailure: 'error' | 'incomplete' | null = null;
  let lastErrorDetail = 'unknown verification failure';
  let index = 0;

  const finished = (status: VerificationStatus, detail: string): VerifyOutcome => ({
    verification: {
      performed: true,
      status,
      residualFindings: lastResidualFindings,
      residualPlan: lastResidualPlan,
      detail,
      attempts,
      waitedMs,
      deadlineMs: options.deadlineMs,
    },
    afterItems: lastItems,
  });

  while (true) {
    index += 1;
    let snapshotSucceeded = false;
    let snapshotComplete = false;
    let snapshot: { items: ProjectItemRecord[]; error: string | null } | null = null;
    try {
      const read = await port.refetchProjectItems();
      snapshotSucceeded = true;
      snapshotComplete = read.complete;
      snapshot = { items: read.items, error: read.error };
    } catch (cause) {
      lastFailure = 'error';
      lastErrorDetail = `refetch failed: ${errorMessage(cause)}`;
      lastItems = [];
      lastResidualPlan = [];
      lastResidualFindings = [];
      attempts.push({ index, outcome: 'error', detail: lastErrorDetail });
    }

    if (snapshotSucceeded && snapshot !== null) {
      lastItems = snapshot.items;
      if (!snapshotComplete) {
        lastFailure = 'incomplete';
        lastErrorDetail = snapshot.error ?? 'pagination did not reach the last page';
        lastResidualPlan = [];
        lastResidualFindings = [];
        attempts.push({ index, outcome: 'incomplete', detail: lastErrorDetail });
      } else {
        lastFailure = null;
        const residualPlan = buildPlan(classifications, snapshot.items).filter((action) =>
          MUTATING_ACTIONS.has(action.action),
        );
        lastResidualPlan = residualPlan;
        lastResidualFindings = auditState(issues, snapshot.items, classifications);
        if (residualPlan.length === 0) {
          attempts.push({
            index,
            outcome: 'clean',
            detail: 'complete snapshot matches the desired membership',
          });
          return finished('clean', 'refetched project items match the desired membership');
        }
        if (!explainableBySuccessfulMutations(residualPlan, appliedMutations)) {
          attempts.push({
            index,
            outcome: 'residual_drift',
            detail: `${String(residualPlan.length)} residual action(s) not explained by successful mutations`,
          });
          return finished(
            'drift',
            `${String(residualPlan.length)} mutation(s) still required after apply; residual differences are not explainable as pending propagation`,
          );
        }
        attempts.push({
          index,
          outcome: 'residual_pending',
          detail: `${String(residualPlan.length)} residual action(s), all explainable as pending propagation of successful mutations`,
        });
      }
    }

    // Hết ngân sách (kể cả lần chờ kế tiếp sẽ vượt deadline) → chốt theo dạng
    // thất bại/residual cuối cùng; không bao giờ vượt deadline để poll tiếp.
    const jitter = 0.5 + 0.5 * options.rng();
    const nextWaitMs = delayMs * jitter;
    if (options.nowMs() + nextWaitMs >= deadlineAtMs) {
      if (lastFailure === 'error') {
        return finished(
          'verification_failed',
          `could not refetch the project items within the ${String(options.deadlineMs)}ms deadline; last failure: ${lastErrorDetail}`,
        );
      }
      if (lastFailure === 'incomplete') {
        return finished(
          'inventory_incomplete',
          `snapshot pagination stayed incomplete within the ${String(options.deadlineMs)}ms deadline; refusing to conclude on a partial inventory; last failure: ${lastErrorDetail}`,
        );
      }
      return finished(
        'propagation_pending',
        `residual differences persisted for the whole ${String(options.deadlineMs)}ms deadline and are all explainable as pending propagation of successful mutations; run an audit to confirm convergence`,
      );
    }
    await options.sleep(nextWaitMs);
    waitedMs += nextWaitMs;
    delayMs = Math.min(delayMs * options.multiplier, options.maxDelayMs);
  }
}

export { notApplicableResult };
