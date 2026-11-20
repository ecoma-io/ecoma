/**
 * Stale-run guard hai điểm cho lane staging (issue #362 slice A; hợp đồng
 * `02-delivery.md` §7.2/§7.4):
 *
 * - Guard chạy ở HAI thời điểm — ngay trước `wrangler deploy` và ngay trước
 *   khi ghi status — và MỖI lượt caller phải tra lại danh sách run rồi đưa
 *   KẾT QUẢ tra cứu mới vào đây; guard không bao giờ tái dùng ảnh chụp của
 *   lượt trước (cửa sổ giữa deploy và ghi status trải qua smoke retry).
 * - Concurrency group không-cancel xếp hàng; guard bổ sung quyết định
 *   coalescing lúc admission (`point: 'coalesce'`): có run mới hơn (đang
 *   chờ hoặc đã chạy) cho cùng nhóm là nhường — skip — thay vì xếp thêm một
 *   run deploy lại SHA cũ hoặc mới hơn.
 * - Phân biệt hai loại abort (§7.4): abort vì TRA CỨU LỖI thì dừng với exit
 *   khác 0 nhưng KHÔNG đụng evidence (`writeFailureStatus: false`); abort vì
 *   SHA PHÂN KỲ THẬT (main đã tiến vượt SHA của run) thì ghi failure —
 *   revision đó không còn là edge và có chủ đích ghi lại điều đó.
 * - Run không còn mới nhất (một run mới hơn đã hoàn thành) skip mà KHÔNG
 *   ghi gì: ghi success cho revision edge không còn phục vụ sẽ phá bằng
 *   chứng promotion.
 *
 * Hàm thuần: caller (slice B) tự chạy truy vấn `gh run list`/API rồi đưa
 * kết quả vào; guard quyết định, không tự gọi mạng.
 */

/** Điểm guard chạy — admission (coalescing), trước deploy, trước ghi status. */
export type GuardPoint = 'coalesce' | 'before-deploy' | 'before-status';

/** Một run trong danh sách tra cứu MỚI của cùng concurrency group. */
export interface GuardRun {
  /** Id run GitHub — run mới hơn có id lớn hơn run hiện tại. */
  id: number;
  /** Trạng thái run GitHub: `queued`, `in_progress` hoặc `completed`. */
  status: string;
}

/**
 * Kết quả MỘT lượt tra cứu danh sách run mà caller vừa chạy lại. Tra cứu lỗi
 * là một kết quả có kiểu — guard phải phân biệt được "không có run mới" với
 * "không biết có run mới hay không".
 */
export type RunListQueryResult =
  | { ok: true; /** HEAD hiện hành của `main` trên origin. */ mainSha: string; runs: GuardRun[] }
  | { ok: false; /** Lý do tra cứu hỏng, tiếng Anh, in verbatim được. */ error: string };

/** Quyết định của guard. */
export interface RunnerGuardDecision {
  action: 'proceed' | 'skip' | 'abort';
  /** Code machine-readable của lý do. */
  code:
    | 'proceed-newest-run'
    | 'query-failed'
    | 'superseded-by-newer-completed-run'
    | 'coalesced-into-newer-pending-run'
    | 'main-advanced';
  /** Lý do tiếng Anh — tooling phát verbatim vào log (language policy). */
  message: string;
  /**
   * Chỉ có ý nghĩa khi `action: 'abort'`: `true` = SHA phân kỳ thật — caller
   * GHI failure status cho SHA của run; `false` = tra cứu lỗi — dừng mà
   * KHÔNG đụng evidence (§7.4).
   */
  writeFailureStatus?: boolean;
}

/** Input định danh run đang bị guard. */
export interface RunnerGuardInput {
  /** `workflow_run.head_sha` của run này — SHA run đã bắt đầu. */
  contextSha: string;
  /** Id run hiện tại — mọi run có id lớn hơn là "mới hơn". */
  runId: number;
  point: GuardPoint;
}

/** Trạng thái run mới hơn đang chờ (chưa hoàn thành). */
const PENDING_RUN_STATUSES = new Set(['queued', 'in_progress']);

/** Throw khi input định danh run sai hình dạng — lỗi dựng input của caller, không phải runtime. */
function expectGuardInput(input: RunnerGuardInput): void {
  if (typeof input.contextSha !== 'string' || input.contextSha.trim().length === 0) {
    throw new Error(
      'runner-guard: contextSha is required — the guard cannot reason about a run without its start SHA',
    );
  }
  if (!Number.isInteger(input.runId) || input.runId < 0) {
    throw new Error('runner-guard: runId must be a non-negative integer run id');
  }
}

/**
 * Evaluate guard cho MỘT điểm với KẾT QUẢ TRA CỨU MỚI. Thứ tự phán quyết:
 * 1. tra cứu lỗi → abort, không đụng evidence;
 * 2. run mới hơn đã hoàn thành → skip không ghi gì (evidence mới hơn đã
 *    tồn tại — ghi đè là phá bằng chứng);
 * 3. main tiến vượt SHA của run → abort VÀ ghi failure (SHA phân kỳ thật —
 *    phân kỳ được kiểm TRƯỚC coalesce để revision off-edge không bị nuốt
 *    vào một skip chỉ vì có run mới hơn đang chờ, §7.2);
 * 4. điểm `coalesce`: run mới hơn đang chờ → skip không ghi gì (nhường —
 *    run đó sẽ phục vụ SHA mới hơn);
 * 5. còn lại → proceed: run này là mới nhất và SHA vẫn là edge.
 */
export function evaluateRunnerGuard(
  input: RunnerGuardInput,
  query: RunListQueryResult,
): RunnerGuardDecision {
  expectGuardInput(input);
  if (!query.ok) {
    return {
      action: 'abort',
      code: 'query-failed',
      message:
        `run list query failed (${query.error}) — cannot verify freshness, aborting without ` +
        'touching any evidence (§7.4)',
      writeFailureStatus: false,
    };
  }
  const newerRuns = query.runs.filter((run) => run.id > input.runId);
  const newerCompleted = newerRuns.find((run) => run.status === 'completed');
  if (newerCompleted !== undefined) {
    return {
      action: 'skip',
      code: 'superseded-by-newer-completed-run',
      message:
        `run ${newerCompleted.id} of the same group already completed — this run is no longer ` +
        'the newest and must not overwrite newer evidence; exiting without writing status (§7.4)',
    };
  }
  if (query.mainSha !== input.contextSha) {
    return {
      action: 'abort',
      code: 'main-advanced',
      message:
        `main is at ${query.mainSha} but this run started at ${input.contextSha} — the revision ` +
        'is off-edge; aborting and recording the failure for this SHA (§7.4)',
      writeFailureStatus: true,
    };
  }
  if (input.point === 'coalesce') {
    const newerPending = newerRuns.find((run) => PENDING_RUN_STATUSES.has(run.status));
    if (newerPending !== undefined) {
      return {
        action: 'skip',
        code: 'coalesced-into-newer-pending-run',
        message:
          `run ${newerPending.id} is already pending for this group — coalescing: this run ` +
          'skips so the newer run serves the newer revision (§7.2 coalescing)',
      };
    }
  }
  return {
    action: 'proceed',
    code: 'proceed-newest-run',
    message: `run ${input.runId} is the newest for its group and ${input.contextSha} is still main's edge`,
  };
}
