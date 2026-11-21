/**
 * Dây nối giữa `runner-guard.ts` (lớp quyết định thuần của slice A) và đường
 * chạy thật — issue #362 slice B. Guard không bao giờ tự gọi mạng: module này
 * là CALLER chạy truy vấn run (qua `gh api`) rồi đưa kết quả MỚI nhất vào
 * `evaluateRunnerGuard` tại đúng điểm gọi (`before-deploy` trong
 * `staging-deploy`, `before-status` trong `staging-smoke`, `coalesce` lúc
 * admission của coordinator — §7.2/§7.4).
 *
 * Hợp đồng output machine-readable: MỌI đường quyết định in đúng MỘT dòng
 * `staging-guard action=<tên>` (marker) — workflow step của coordinator đọc
 * dòng đó vào `GITHUB_OUTPUT` để điều khiện việc ghi commit status:
 *
 * - `proceed` — chạy tiếp; các step ghi status bình thường.
 * - `skip` — nhường run mới hơn: exit 0, KHÔNG ghi status nào (ghi success
 *   cho revision edge không còn phục vụ là phá bằng chứng promotion, §7.4).
 * - `abort-query-failed` — tra cứu hỏng: exit khác 0, KHÔNG đụng evidence.
 * - `abort-main-advanced` — SHA phân kỳ thật: exit khác 0 VÀ ghi failure
 *   status cho SHA của run (revision đó cố ý bị ghi lại là off-edge).
 */

import { exec, type ExecResult } from '@ecoma-io/deployment';

import {
  evaluateRunnerGuard,
  type GuardPoint,
  type RunListQueryResult,
  type RunnerGuardDecision,
  type RunnerGuardInput,
} from './runner-guard.ts';

// Re-export cho caller (staging-deploy/staging-smoke đọc type qua module này).
export type { RunListQueryResult };

/** Hành động machine-readable sau một lượt guard — hợp đồng marker ở header. */
export type GuardAction = 'proceed' | 'skip' | 'abort-query-failed' | 'abort-main-advanced';
/** Hai đường abort — CLI exit khác 0, phân biệt bởi việc ghi failure status. */
export type GuardAbortAction = 'abort-query-failed' | 'abort-main-advanced';

/** Marker in ra stdout — workflow step grep dòng này (match cuối cùng thắng). */
export const GUARD_MARKER_PREFIX = 'staging-guard action=';

/** Nhận dạng run đang bị guard — cờ CLI của coordinator/workflow step. */
export interface GuardInputs {
  /** Id run hiện tại (GITHUB_RUN_ID) — mọi run id lớn hơn là "mới hơn". */
  runId: number;
  /** `workflow_run.head_sha` của run này — SHA run đã bắt đầu. */
  contextSha: string;
  point: GuardPoint;
}

/** Abort theo guard: caller (CLI) in marker rồi exit khác 0 theo `action`. */
export class GuardAbortError extends Error {
  readonly action: GuardAbortAction;

  constructor(action: GuardAbortAction, message: string) {
    super(message);
    this.action = action;
  }
}

/** Map quyết định của guard ra hành động marker (hợp đồng ở header module). */
export function guardActionOf(decision: RunnerGuardDecision): GuardAction {
  if (decision.action === 'proceed') return 'proceed';
  if (decision.action === 'skip') return 'skip';
  return decision.writeFailureStatus === true ? 'abort-main-advanced' : 'abort-query-failed';
}

/**
 * Guard có được bật ở lệnh gọi này không: cả hai flag `--guard-run-id` /
 * `--guard-head-sha` phải có mặt cùng lúc — thiếu một nửa là cấu hình sai của
 * caller (lỗi usage), không phải "guard tắt ngầm".
 */
export function parseGuardInputs(
  runIdRaw: string | undefined,
  contextSha: string | undefined,
  point: GuardPoint,
): GuardInputs | undefined {
  if (runIdRaw === undefined && contextSha === undefined) return undefined;
  if (runIdRaw === undefined || contextSha === undefined) {
    throw new Error(
      '--guard-run-id and --guard-head-sha must be given together — half a guard ' +
        'configuration is a caller bug, not a disabled guard',
    );
  }
  const runId = /^\d+$/u.test(runIdRaw) ? Number(runIdRaw) : Number.NaN;
  if (!Number.isInteger(runId) || runId <= 0) {
    throw new Error(`--guard-run-id must be a positive integer run id, got "${runIdRaw}"`);
  }
  if (contextSha.trim().length === 0) {
    throw new Error('--guard-head-sha must be a non-empty commit SHA');
  }
  return { runId, contextSha, point };
}

/** Deps truy vấn — inject để spec chạy không cần `gh` thật. */
export interface GuardQueryDeps {
  /** Chạy `gh api <args...>` và trả kết quả thô. */
  ghApi: (args: string[]) => ExecResult;
  /** Env của process — đọc GITHUB_REPOSITORY và GITHUB_WORKFLOW_REF. */
  env: NodeJS.ProcessEnv;
}

/** Env tối thiểu cho subprocess `gh` (cùng shape `ghProcessEnv` của staging-environments). */
function guardGhEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: source.PATH ?? process.env.PATH,
    HOME: source.HOME ?? process.env.HOME,
  };
  for (const key of ['GH_TOKEN', 'GH_HOST', 'GH_REPO'] as const) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

/** Deps mặc định: `gh api` thật với env tối thiểu của process hiện tại. */
export function defaultGuardQueryDeps(source: NodeJS.ProcessEnv = process.env): GuardQueryDeps {
  return {
    ghApi: (args) => exec('gh', ['api', ...args], process.cwd(), guardGhEnv(source)),
    env: source,
  };
}

/** `gh api` phải exit 0 — mọi lỗi tra cứu là kết quả `{ok:false}` có kiểu. */
function ghApiJson(
  deps: GuardQueryDeps,
  args: string[],
  label: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const result = deps.ghApi(args);
  if (result.status !== 0 || result.error !== undefined) {
    return {
      ok: false,
      error: `${label} failed: ${result.error?.message ?? (result.stderr.trim() === '' ? 'no output' : result.stderr.trim())}`,
    };
  }
  return { ok: true, value: result.stdout };
}

/** Parse JSON bắt buộc thành công — parse hỏng là tra cứu hỏng có kiểu. */
function parseJson(
  text: string,
  label: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return {
      ok: false,
      error: `${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Điểm tra cứu của một lần guard — cây gọi `gh api` gom đúng một chỗ này. */
export const PAGE_SIZE_LIMIT = 100;

/**
 * MỘT lượt tra cứu run MỚI cho cùng workflow coordinator trên `main` + HEAD
 * hiện hành của main. Nhánh `main` và đường dẫn workflow file được suy từ env
 * của runner (`GITHUB_REPOSITORY`, `GITHUB_WORKFLOW_REF`) — vắng env là tra
 * cứu hỏng có kiểu, không đoán.
 */
export function queryFreshRunState(deps: GuardQueryDeps): RunListQueryResult {
  const repo = deps.env.GITHUB_REPOSITORY;
  if (repo === undefined || repo.trim().length === 0) {
    return { ok: false, error: 'GITHUB_REPOSITORY is not set — cannot query run freshness' };
  }
  // GITHUB_WORKFLOW_REF dạng `<file>@<ref>` — guard so độ mới giữa các run
  // của CÙNG workflow coordinator, không giữa các workflow khác nhau.
  const workflowPath = (deps.env.GITHUB_WORKFLOW_REF ?? '').split('@')[0]?.trim();
  if (workflowPath === undefined || workflowPath.length === 0) {
    return {
      ok: false,
      error: 'GITHUB_WORKFLOW_REF is not set — cannot identify the coordinator workflow',
    };
  }

  const runsCall = ghApiJson(
    deps,
    [`repos/${repo}/actions/runs?branch=main&per_page=${PAGE_SIZE_LIMIT}`],
    'gh api run list',
  );
  if (!runsCall.ok) return runsCall;
  const runsJson = parseJson(runsCall.value, 'run list');
  if (!runsJson.ok) return runsJson;

  const branchCall = ghApiJson(
    deps,
    [`repos/${repo}`, '--jq', '.default_branch'],
    'gh api repo lookup',
  );
  if (!branchCall.ok) return branchCall;
  const mainBranch = branchCall.value.trim();
  const shaCall = ghApiJson(
    deps,
    [`repos/${repo}/branches/${mainBranch}`, '--jq', '.commit.sha'],
    'gh api branch lookup',
  );
  if (!shaCall.ok) return shaCall;
  const mainSha = shaCall.value.trim();
  if (mainSha.length === 0) {
    return { ok: false, error: 'branch lookup returned an empty HEAD SHA' };
  }

  const runsRaw = (runsJson.value as { workflow_runs?: unknown }).workflow_runs;
  if (!Array.isArray(runsRaw)) {
    return { ok: false, error: 'run list response has no workflow_runs array' };
  }
  const runs: Array<{ id: number; status: string }> = [];
  for (const entry of runsRaw) {
    const record = entry as { id?: unknown; status?: unknown; path?: unknown };
    if (record.path !== workflowPath) continue;
    if (typeof record.id !== 'number' || typeof record.status !== 'string') {
      return { ok: false, error: 'run list entry has invalid id/status shape' };
    }
    runs.push({ id: record.id, status: record.status });
  }
  return { ok: true, mainSha, runs };
}

/**
 * Evaluate guard tại MỘT điểm với KẾT QUẢ TRA CỬU caller vừa chạy. Throw
 * `GuardAbortError` cho đường abort; caller CLI in marker rồi exit khác 0.
 * Trả action cho hai đường không-throw (`proceed`/`skip`).
 *
 * Đảm bảo đầy đủ của trang: trang đầy (100 run, sort newest-first) mà không
 * thấy run của caller → danh sách không đủ phán quyết freshness → coi tra
 * cứu hỏng (fail-closed), không bao giờ Proceed trên dữ liệu thiếu.
 */
export function evaluateGuardAtPoint(
  input: RunnerGuardInput,
  queryResult: RunListQueryResult,
): { action: 'proceed' | 'skip'; decision: RunnerGuardDecision } {
  let query: RunListQueryResult = queryResult;
  if (
    query.ok &&
    query.runs.length >= PAGE_SIZE_LIMIT &&
    !query.runs.some((run) => run.id === input.runId)
  ) {
    query = {
      ok: false,
      error: `run ${input.runId} is absent from the full first page of ${PAGE_SIZE_LIMIT} runs — the list cannot prove freshness`,
    };
  }
  const decision = evaluateRunnerGuard(input, query);
  if (decision.action === 'abort') {
    throw new GuardAbortError(
      decision.writeFailureStatus === true ? 'abort-main-advanced' : 'abort-query-failed',
      decision.message,
    );
  }
  return { action: decision.action, decision };
}

/** Evaluate guard với một lượt tra cứu thật (gh api) chạy ngay tại chỗ. */
export function runGuardAtPoint(
  input: RunnerGuardInput,
  deps: GuardQueryDeps,
): { action: 'proceed' | 'skip'; decision: RunnerGuardDecision } {
  return evaluateGuardAtPoint(input, queryFreshRunState(deps));
}
