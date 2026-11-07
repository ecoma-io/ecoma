/**
 * Logical request — aggregate root của bounded context `llm-inference`.
 *
 * Source of truth: `docs/domains/llm-inference/domain-model.md` §1, §5, §6,
 * §7, §8, §9.
 *
 * Aggregate này sở hữu vòng đời của một yêu cầu suy luận: trạng thái, các
 * provider attempt, dữ kiện delivery tới client, và quyết định xem có được phép
 * thêm attempt hay không. Nó **không** sở hữu quota, usage, tiền tệ, chọn
 * candidate, xếp thứ tự fallback, persistence hay idempotency bền — tất cả là
 * input của caller hoặc thuộc bounded context khác.
 *
 * Fail-safe: mọi ngã mà domain không đủ căn cứ để kết luận đều bị từ chối bằng
 * domain error, không được suy diễn thành "provider đã dừng".
 */

import {
  classifyAttemptOutcome,
  isAttemptOpen,
  isAttemptUncertain,
  isProviderAttempt,
  type AttemptOutcome,
  type ProviderAttempt,
} from './attempt';
import {
  commitClientResponse,
  hasClientOutputCommitted,
  INITIAL_CLIENT_DELIVERY,
  isClientDelivery,
  recordClientDisconnect,
  type ClientDelivery,
} from './delivery';
import {
  canTransitionEvidence,
  EXECUTION_EVIDENCE,
  isExecutionEvidence,
  type ExecutionEvidence,
} from './evidence';
import { isExecutionPolicy, validateExecutionPolicy, type ExecutionPolicy } from './policy';
import {
  inferenceFailure,
  inferenceOk,
  isAttemptId,
  isEpochMillis,
  isOpaqueId,
  isRequestId,
  type InferenceResult,
  type RequestId,
} from './shared';

// ---------------------------------------------------------------------------
// Trạng thái và hoàn tất
// ---------------------------------------------------------------------------

/**
 * Trạng thái vòng đời của logical request.
 *
 * - `open` — còn có thể append attempt; chưa terminal.
 * - `reconciling` — còn attempt `may_have_executed` chưa được provider xác
 *   nhận; **không** append attempt mới, **không** terminal. Trạng thái này giữ
 *   cho "chưa xác định" khác biệt với "đã thất bại".
 * - `completed` / `failed` / `cancelled` — terminal.
 */
export type LogicalRequestStatus = 'open' | 'reconciling' | 'completed' | 'failed' | 'cancelled';

/** Lý do request kết thúc không thành công. */
export type RequestCancellationReason =
  | 'client_cancelled'
  | 'deadline_exceeded'
  | 'policy_cancelled';

/** Bản ghi kết thúc của logical request. */
export interface RequestCompletion {
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly closedAt: number;
  readonly reason: RequestCancellationReason | null;
}

/** Logical request cùng toàn bộ attempt của nó. */
export interface LogicalRequest {
  readonly requestId: RequestId;
  readonly admittedAt: number;
  readonly policy: ExecutionPolicy;
  readonly status: LogicalRequestStatus;
  /** Attempt theo thứ tự `sequence` tăng dần; phần tử cuối là attempt mới nhất. */
  readonly attempts: readonly ProviderAttempt[];
  readonly delivery: ClientDelivery;
  /** Chỉ khác `null` khi request đã terminal. */
  readonly completion: RequestCompletion | null;
}

const TERMINAL_STATUSES: readonly LogicalRequestStatus[] = Object.freeze([
  'completed',
  'failed',
  'cancelled',
]);

/** Trạng thái đã terminal — không attempt mới, không chuyển trạng thái nữa. */
export function isTerminalStatus(status: LogicalRequestStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Request đã terminal. */
export function isRequestTerminal(request: LogicalRequest): boolean {
  return isTerminalStatus(request.status);
}

/** Attempt cuối cùng theo thứ tự ghi nhận, nếu có. */
export function latestAttempt(request: LogicalRequest): ProviderAttempt | null {
  return request.attempts.length === 0 ? null : request.attempts[request.attempts.length - 1];
}

/** Attempt đang mở (tối đa một), nếu có. */
export function findOpenAttempt(request: LogicalRequest): ProviderAttempt | null {
  return request.attempts.find(isAttemptOpen) ?? null;
}

/** Có attempt `may_have_executed` chưa được reconcile hay không. */
export function hasUnresolvedUncertainty(request: LogicalRequest): boolean {
  return request.attempts.some(isAttemptUncertain);
}

/** Tìm attempt theo định danh; `null` khi không thuộc request này. */
export function findAttempt(request: LogicalRequest, attemptId: unknown): ProviderAttempt | null {
  if (!isAttemptId(attemptId)) {
    return null;
  }
  return request.attempts.find((attempt) => attempt.attemptId === attemptId) ?? null;
}

/** Type guard cho `LogicalRequest` — dùng khi rehydrate từ persistence. */
export function isLogicalRequest(value: unknown): value is LogicalRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const request = value as LogicalRequest;
  if (
    !isRequestId(request.requestId) ||
    !isEpochMillis(request.admittedAt) ||
    !isExecutionPolicy(request.policy) ||
    !isClientDelivery(request.delivery) ||
    !Array.isArray(request.attempts) ||
    !request.attempts.every(isProviderAttempt)
  ) {
    return false;
  }
  if (request.policy.deadlineAt <= request.admittedAt) {
    return false;
  }
  // Attempt phải liên tục 1..n và không trùng định danh — domain luôn sinh như vậy.
  const ids = new Set<string>();
  let lastRecordedAt = request.admittedAt;
  for (const [index, attempt] of request.attempts.entries()) {
    if (attempt.sequence !== index + 1 || ids.has(attempt.attemptId)) {
      return false;
    }
    if (attempt.recordedAt < lastRecordedAt) {
      return false;
    }
    ids.add(attempt.attemptId);
    lastRecordedAt = attempt.recordedAt;
  }
  if (request.delivery.committedAt !== null && request.delivery.committedAt < request.admittedAt) {
    return false;
  }
  if (
    request.delivery.disconnectedAt !== null &&
    request.delivery.disconnectedAt < request.admittedAt
  ) {
    return false;
  }

  if (
    request.status !== 'open' &&
    request.status !== 'reconciling' &&
    !isTerminalStatus(request.status)
  ) {
    return false;
  }

  if (request.status === 'open') {
    return request.completion === null;
  }
  if (request.status === 'reconciling') {
    // Chỉ tồn tại sau `awaitReconciliation`: không attempt mở, còn bất định.
    return (
      request.completion === null &&
      findOpenAttempt(request) === null &&
      hasUnresolvedUncertainty(request)
    );
  }

  const completion = request.completion;
  if (completion === null) {
    return false;
  }
  if (
    completion.status !== request.status ||
    !isEpochMillis(completion.closedAt) ||
    completion.closedAt < request.admittedAt ||
    completion.closedAt < lastRecordedAt
  ) {
    return false;
  }
  if (request.status === 'cancelled' ? completion.reason === null : completion.reason !== null) {
    return false;
  }
  // Terminal không bao giờ còn attempt mở hay bất định chưa xử lý.
  if (findOpenAttempt(request) !== null || hasUnresolvedUncertainty(request)) {
    return false;
  }
  if (request.status === 'completed') {
    return request.attempts.some(
      (attempt) => attempt.evidence === EXECUTION_EVIDENCE.confirmed_completed,
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Tạo request
// ---------------------------------------------------------------------------

/** Input admission của một logical request. */
export interface CreateLogicalRequestInput {
  readonly requestId: unknown;
  readonly admittedAt: unknown;
  readonly policy: unknown;
}

/**
 * Tạo logical request đã được admit, ở trạng thái `open`, chưa có attempt.
 *
 * Admission (auth + quota reserve) đã xảy ra trước đó và do `llm-api` sở hữu;
 * operation này chỉ validate phần dữ kiện mà domain inference cần.
 */
export function createLogicalRequest(
  input: CreateLogicalRequestInput,
): InferenceResult<LogicalRequest> {
  if (!isRequestId(input.requestId)) {
    return inferenceFailure('invalid_request_id');
  }
  if (!isEpochMillis(input.admittedAt)) {
    return inferenceFailure('invalid_timestamp');
  }
  const policy = validateExecutionPolicy(input.policy, input.admittedAt);
  if (!policy.ok) {
    return policy;
  }
  return inferenceOk(
    Object.freeze({
      requestId: input.requestId,
      admittedAt: input.admittedAt,
      policy: policy.value,
      status: 'open',
      attempts: Object.freeze([]),
      delivery: INITIAL_CLIENT_DELIVERY,
      completion: null,
    }),
  );
}

// ---------------------------------------------------------------------------
// Retry admissibility — luật duy nhất của domain
// ---------------------------------------------------------------------------

/** Lý do một attempt mới không được phép. */
export type RetryRejectionReason =
  | 'request_closed'
  | 'requires_reconciliation'
  | 'attempt_in_flight'
  | 'client_output_committed'
  | 'deadline_exhausted'
  | 'attempts_exhausted'
  | 'previous_attempt_uncertain'
  | 'previous_attempt_completed';

/** Kết quả đánh giá quyền append attempt. */
export type RetryDecision =
  | { readonly admissible: true; readonly nextSequence: number }
  | { readonly admissible: false; readonly reason: RetryRejectionReason };

/**
 * Đánh giá **duy nhất** trong domain này về việc có được append thêm attempt
 * cho logical request hay không.
 *
 * Thứ tự kiểm tra là contract ổn định (xem domain design §6): terminal →
 * reconciling → attempt đang mở → byte đã tới client → deadline → hết budget →
 * evidence chặn retry.
 *
 * Hàm này trả lời "execution có được tiếp tục hay không". Nó **không** trả lời
 * "candidate nào kế tiếp" — đó là quyết định của `llm-consumer-routing`.
 */
export function evaluateRetryAdmissibility(
  request: LogicalRequest,
  input: { readonly now: unknown },
): InferenceResult<RetryDecision> {
  if (!isEpochMillis(input.now)) {
    return inferenceFailure('invalid_timestamp');
  }
  const now = input.now;

  if (isTerminalStatus(request.status)) {
    return inferenceOk({ admissible: false, reason: 'request_closed' });
  }
  if (request.status === 'reconciling') {
    return inferenceOk({ admissible: false, reason: 'requires_reconciliation' });
  }
  if (findOpenAttempt(request) !== null) {
    return inferenceOk({ admissible: false, reason: 'attempt_in_flight' });
  }
  if (hasClientOutputCommitted(request.delivery)) {
    return inferenceOk({ admissible: false, reason: 'client_output_committed' });
  }
  if (now >= request.policy.deadlineAt) {
    return inferenceOk({ admissible: false, reason: 'deadline_exhausted' });
  }
  if (request.attempts.length >= request.policy.maxAttempts) {
    return inferenceOk({ admissible: false, reason: 'attempts_exhausted' });
  }
  const previous = latestAttempt(request);
  if (hasUnresolvedUncertainty(request)) {
    return inferenceOk({ admissible: false, reason: 'previous_attempt_uncertain' });
  }
  if (previous !== null && previous.evidence === EXECUTION_EVIDENCE.confirmed_completed) {
    return inferenceOk({ admissible: false, reason: 'previous_attempt_completed' });
  }
  return inferenceOk({ admissible: true, nextSequence: request.attempts.length + 1 });
}

// ---------------------------------------------------------------------------
// Provider attempt
// ---------------------------------------------------------------------------

/** Input ghi nhận dispatch intent của một attempt. */
export interface RecordDispatchIntentInput {
  readonly attemptId: unknown;
  readonly candidateRef: unknown;
  readonly endpointRef: unknown;
  readonly recordedAt: unknown;
}

/**
 * Ghi nhận dispatch intent: tạo attempt mới ở trạng thái mở với evidence
 * `not_sent`.
 *
 * Gọi lại với **cùng** `attemptId` và cùng dữ kiện là idempotent (trả về
 * request không đổi) — cần cho retry command sau crash. Cùng `attemptId` nhưng
 * dữ kiện khác bị từ chối (`duplicate_attempt_id`).
 *
 * Quyền append do `evaluateRetryAdmissibility` quyết định, nên chỉ có **một**
 * luật retry trong toàn bộ domain này.
 */
export function recordDispatchIntent(
  request: LogicalRequest,
  input: RecordDispatchIntentInput,
): InferenceResult<LogicalRequest> {
  if (!isAttemptId(input.attemptId)) {
    return inferenceFailure('invalid_attempt_id');
  }
  if (!isOpaqueId(input.candidateRef)) {
    return inferenceFailure('invalid_candidate_ref');
  }
  if (input.endpointRef !== null && !isOpaqueId(input.endpointRef)) {
    return inferenceFailure('invalid_candidate_ref');
  }
  if (!isEpochMillis(input.recordedAt)) {
    return inferenceFailure('invalid_timestamp');
  }
  if (input.recordedAt < request.admittedAt) {
    return inferenceFailure('timestamp_regression');
  }

  const existing = findAttempt(request, input.attemptId);
  if (existing !== null) {
    const identical =
      existing.candidateRef === input.candidateRef &&
      existing.endpointRef === input.endpointRef &&
      existing.recordedAt === input.recordedAt;
    return identical ? inferenceOk(request) : inferenceFailure('duplicate_attempt_id');
  }

  const admission = evaluateRetryAdmissibility(request, { now: input.recordedAt });
  if (!admission.ok) {
    return admission;
  }
  if (!admission.value.admissible) {
    return inferenceFailure(admission.value.reason);
  }

  const attempt: ProviderAttempt = Object.freeze({
    attemptId: input.attemptId,
    sequence: admission.value.nextSequence,
    candidateRef: input.candidateRef,
    endpointRef: input.endpointRef,
    recordedAt: input.recordedAt,
    evidence: EXECUTION_EVIDENCE.not_sent,
    evidenceRecordedAt: null,
    endedAt: null,
  });

  return inferenceOk(
    Object.freeze({
      ...request,
      attempts: Object.freeze([...request.attempts, attempt]),
    }),
  );
}

/** Input ghi nhận evidence của một attempt. */
export interface RecordEvidenceInput {
  readonly attemptId: unknown;
  readonly evidence: unknown;
  readonly recordedAt: unknown;
}

/**
 * Ghi nhận evidence cho attempt đang mở.
 *
 * Chỉ cho phép chuyển đổi làm **mạnh lên** bằng chứng (xem `evidence.ts`). Ghi
 * lại đúng giá trị đã có là idempotent; timestamp lùi bị từ chối.
 */
export function recordAttemptEvidence(
  request: LogicalRequest,
  input: RecordEvidenceInput,
): InferenceResult<LogicalRequest> {
  const attempt = findAttempt(request, input.attemptId);
  if (attempt === null) {
    return inferenceFailure('attempt_not_found');
  }
  if (!isExecutionEvidence(input.evidence)) {
    return inferenceFailure('invalid_evidence');
  }
  if (!isEpochMillis(input.recordedAt)) {
    return inferenceFailure('invalid_timestamp');
  }
  if (attempt.evidence === input.evidence && attempt.evidenceRecordedAt === input.recordedAt) {
    return inferenceOk(request);
  }
  if (!isAttemptOpen(attempt)) {
    return inferenceFailure('attempt_not_in_flight');
  }
  return updateEvidence(request, attempt, input.evidence, input.recordedAt, attempt.endedAt);
}

/** Input đóng một attempt. */
export interface CloseAttemptInput {
  readonly attemptId: unknown;
  readonly evidence: unknown;
  readonly endedAt: unknown;
}

/**
 * Đóng attempt với evidence cuối cùng.
 *
 * Chỉ đóng được attempt đang mở. Ghi lại đúng dữ kiện đã đóng là idempotent.
 * Đóng với `may_have_executed` giữ lại sự không chắc chắn: nó **không** phải
 * thất bại đã xác nhận.
 */
export function closeAttempt(
  request: LogicalRequest,
  input: CloseAttemptInput,
): InferenceResult<LogicalRequest> {
  const attempt = findAttempt(request, input.attemptId);
  if (attempt === null) {
    return inferenceFailure('attempt_not_found');
  }
  if (!isExecutionEvidence(input.evidence)) {
    return inferenceFailure('invalid_evidence');
  }
  if (!isEpochMillis(input.endedAt)) {
    return inferenceFailure('invalid_timestamp');
  }
  if (!isAttemptOpen(attempt)) {
    const identical = attempt.evidence === input.evidence && attempt.endedAt === input.endedAt;
    return identical ? inferenceOk(request) : inferenceFailure('attempt_not_in_flight');
  }
  return updateEvidence(request, attempt, input.evidence, input.endedAt, input.endedAt);
}

function updateEvidence(
  request: LogicalRequest,
  attempt: ProviderAttempt,
  evidence: ExecutionEvidence,
  recordedAt: number,
  endedAt: number | null,
): InferenceResult<LogicalRequest> {
  if (recordedAt < attempt.recordedAt) {
    return inferenceFailure('timestamp_regression');
  }
  if (attempt.evidenceRecordedAt !== null && recordedAt < attempt.evidenceRecordedAt) {
    return inferenceFailure('timestamp_regression');
  }
  if (!canTransitionEvidence(attempt.evidence, evidence)) {
    return inferenceFailure('invalid_evidence_transition');
  }
  return inferenceOk(
    replaceAttempt(request, {
      ...attempt,
      evidence,
      evidenceRecordedAt: recordedAt,
      endedAt,
    }),
  );
}

function replaceAttempt(request: LogicalRequest, replacement: ProviderAttempt): LogicalRequest {
  const attempts = Object.freeze(
    request.attempts.map((attempt) =>
      attempt.attemptId === replacement.attemptId ? Object.freeze(replacement) : attempt,
    ),
  );
  return Object.freeze({ ...request, attempts });
}

// ---------------------------------------------------------------------------
// Delivery tới client
// ---------------------------------------------------------------------------

/**
 * Ghi nhận byte response đầu tiên đã tới client.
 *
 * Từ thời điểm này không được append attempt mới cho cùng request (xem
 * `evaluateRetryAdmissibility`).
 */
export function recordClientOutputCommitted(
  request: LogicalRequest,
  input: { readonly committedAt: unknown },
): InferenceResult<LogicalRequest> {
  const delivery = commitClientResponse(request.delivery, input);
  if (!delivery.ok) {
    return delivery;
  }
  if (delivery.value === request.delivery) {
    return inferenceOk(request);
  }
  return inferenceOk(Object.freeze({ ...request, delivery: delivery.value }));
}

/**
 * Ghi nhận client ngắt kết nối.
 *
 * Chỉ là dữ kiện: trạng thái request không đổi, không attempt nào bị coi là đã
 * dừng, và không retry nào được kích hoạt.
 */
export function recordClientDisconnectEvent(
  request: LogicalRequest,
  input: { readonly disconnectedAt: unknown },
): InferenceResult<LogicalRequest> {
  const delivery = recordClientDisconnect(request.delivery, input);
  if (!delivery.ok) {
    return delivery;
  }
  if (delivery.value === request.delivery) {
    return inferenceOk(request);
  }
  return inferenceOk(Object.freeze({ ...request, delivery: delivery.value }));
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Chuyển request sang `reconciling` khi không thể tiếp tục nhưng còn attempt
 * chưa xác định.
 *
 * Yêu cầu: request đang `open`, không có attempt đang mở, và có ít nhất một
 * attempt `may_have_executed`.
 */
export function awaitReconciliation(request: LogicalRequest): InferenceResult<LogicalRequest> {
  if (isTerminalStatus(request.status)) {
    return inferenceFailure('request_closed');
  }
  if (request.status !== 'open') {
    return inferenceFailure('inconsistent_execution_state');
  }
  if (findOpenAttempt(request) !== null) {
    return inferenceFailure('attempt_in_flight');
  }
  if (!hasUnresolvedUncertainty(request)) {
    return inferenceFailure('no_uncertainty_to_reconcile');
  }
  return inferenceOk(Object.freeze({ ...request, status: 'reconciling' }));
}

/** Input reconcile một attempt bất định bằng bằng chứng authoritative. */
export interface ReconcileAttemptInput {
  readonly attemptId: unknown;
  readonly evidence: unknown;
  readonly recordedAt: unknown;
}

/**
 * Reconcile attempt `may_have_executed` bằng bằng chứng authoritative từ
 * provider.
 *
 * Chỉ chấp nhận `confirmed_completed` hoặc `confirmed_not_executed`. Sau khi
 * reconcile:
 * - có attempt `confirmed_completed` → request `completed`;
 * - ngược lại request trở lại `open`; caller đánh giá tiếp bằng
 *   `evaluateRetryAdmissibility` (budget/deadline có thể đã hết, khi đó caller
 *   gọi `failRequest`).
 */
export function reconcileUncertainAttempt(
  request: LogicalRequest,
  input: ReconcileAttemptInput,
): InferenceResult<LogicalRequest> {
  if (request.status !== 'reconciling') {
    return inferenceFailure('reconciliation_not_pending');
  }
  const attempt = findAttempt(request, input.attemptId);
  if (attempt === null) {
    return inferenceFailure('attempt_not_found');
  }
  if (!isAttemptUncertain(attempt)) {
    return inferenceFailure('attempt_not_uncertain');
  }
  if (!isExecutionEvidence(input.evidence)) {
    return inferenceFailure('invalid_evidence');
  }
  if (!isEpochMillis(input.recordedAt)) {
    return inferenceFailure('invalid_timestamp');
  }
  if (
    input.evidence !== EXECUTION_EVIDENCE.confirmed_completed &&
    input.evidence !== EXECUTION_EVIDENCE.confirmed_not_executed
  ) {
    return inferenceFailure('reconciliation_requires_confirmation');
  }

  const updated = updateEvidence(
    request,
    attempt,
    input.evidence,
    input.recordedAt,
    attempt.endedAt ?? input.recordedAt,
  );
  if (!updated.ok) {
    return updated;
  }
  if (input.evidence === EXECUTION_EVIDENCE.confirmed_completed) {
    return closeRequest(updated.value, 'completed', input.recordedAt, null);
  }
  return inferenceOk(Object.freeze({ ...updated.value, status: 'open' }));
}

// ---------------------------------------------------------------------------
// Kết thúc
// ---------------------------------------------------------------------------

/**
 * Hoàn tất request vì một attempt đã `confirmed_completed`.
 *
 * Yêu cầu attempt cuối cùng đã đóng với evidence `confirmed_completed`. Gọi lặp
 * với cùng `completedAt` là idempotent; khác thời điểm hoặc trạng thái terminal
 * khác bị từ chối.
 */
export function completeRequest(
  request: LogicalRequest,
  input: { readonly completedAt: unknown },
): InferenceResult<LogicalRequest> {
  if (!isEpochMillis(input.completedAt)) {
    return inferenceFailure('invalid_timestamp');
  }
  const replay = replayTerminal(request, 'completed', input.completedAt, null);
  if (replay !== null) {
    return replay;
  }
  if (findOpenAttempt(request) !== null) {
    return inferenceFailure('attempt_in_flight');
  }
  const previous = latestAttempt(request);
  if (previous === null || previous.evidence !== EXECUTION_EVIDENCE.confirmed_completed) {
    return inferenceFailure('completion_requires_completed_attempt');
  }
  return closeRequest(request, 'completed', input.completedAt, null);
}

/**
 * Kết thúc request là thất bại.
 *
 * Chỉ hợp lệ khi mọi attempt đã đóng và **không** attempt nào có thể đã thực
 * thi. Một attempt `may_have_executed` phải đi qua `awaitReconciliation` +
 * `reconcileUncertainAttempt` trước.
 */
export function failRequest(
  request: LogicalRequest,
  input: { readonly failedAt: unknown },
): InferenceResult<LogicalRequest> {
  if (!isEpochMillis(input.failedAt)) {
    return inferenceFailure('invalid_timestamp');
  }
  const replay = replayTerminal(request, 'failed', input.failedAt, null);
  if (replay !== null) {
    return replay;
  }
  if (findOpenAttempt(request) !== null) {
    return inferenceFailure('attempt_in_flight');
  }
  if (hasUnresolvedUncertainty(request)) {
    return inferenceFailure('uncertain_execution_unresolved');
  }
  return closeRequest(request, 'failed', input.failedAt, null);
}

/** Input huỷ request. */
export interface CancelRequestInput {
  readonly cancelledAt: unknown;
  readonly reason: unknown;
}

/**
 * Huỷ request.
 *
 * Không huỷ được khi còn attempt đang mở hoặc còn bất định: huỷ không chứng
 * minh provider đã dừng thực thi. Client disconnect **không** tự động huỷ —
 * caller quyết định, và phải xử lý bất định trước.
 *
 * Idempotent với cùng `cancelledAt` và `reason`.
 */
export function cancelRequest(
  request: LogicalRequest,
  input: CancelRequestInput,
): InferenceResult<LogicalRequest> {
  if (!isEpochMillis(input.cancelledAt)) {
    return inferenceFailure('invalid_timestamp');
  }
  if (!isCancellationReason(input.reason)) {
    return inferenceFailure('invalid_cancellation_reason');
  }
  const replay = replayTerminal(request, 'cancelled', input.cancelledAt, input.reason);
  if (replay !== null) {
    return replay;
  }
  if (findOpenAttempt(request) !== null) {
    return inferenceFailure('attempt_in_flight');
  }
  if (hasUnresolvedUncertainty(request)) {
    return inferenceFailure('uncertain_execution_unresolved');
  }
  return closeRequest(request, 'cancelled', input.cancelledAt, input.reason);
}

/**
 * Trả kết quả cho lệnh terminal lặp lại; `null` khi đây là lần kết thúc đầu
 * tiên. Idempotency này ở mức **semantics**: persistence vẫn cần khoá bền của
 * nó ở tầng application.
 */
function replayTerminal(
  request: LogicalRequest,
  status: 'completed' | 'failed' | 'cancelled',
  closedAt: number,
  reason: RequestCancellationReason | null,
): InferenceResult<LogicalRequest> | null {
  if (!isTerminalStatus(request.status)) {
    return null;
  }
  const completion = request.completion;
  if (
    request.status === status &&
    completion !== null &&
    completion.closedAt === closedAt &&
    completion.reason === reason
  ) {
    return inferenceOk(request);
  }
  return inferenceFailure('request_closed');
}

function isCancellationReason(value: unknown): value is RequestCancellationReason {
  return (
    value === 'client_cancelled' || value === 'deadline_exceeded' || value === 'policy_cancelled'
  );
}

function closeRequest(
  request: LogicalRequest,
  status: 'completed' | 'failed' | 'cancelled',
  closedAt: number,
  reason: RequestCancellationReason | null,
): InferenceResult<LogicalRequest> {
  if (closedAt < request.admittedAt) {
    return inferenceFailure('timestamp_regression');
  }
  const last = latestAttempt(request);
  if (last !== null && last.recordedAt > closedAt) {
    return inferenceFailure('timestamp_regression');
  }
  const completion: RequestCompletion = Object.freeze({ status, closedAt, reason });
  return inferenceOk(Object.freeze({ ...request, status, completion }));
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

/** Tiến trình request, đọc lại từ state — không phải nguồn sự thật thứ hai. */
export interface RequestProgress {
  readonly status: LogicalRequestStatus;
  readonly attemptCount: number;
  readonly attemptOutcomes: readonly AttemptOutcome[];
  readonly clientOutputCommitted: boolean;
  readonly clientDisconnected: boolean;
}

/**
 * Tổng hợp view phục vụ audit/truy vấn.
 *
 * `clientDisconnected` chỉ là dữ kiện delivery: nó xuất hiện cạnh trạng thái
 * thực thi, không thay thế trạng thái đó.
 */
export function describeRequestProgress(request: LogicalRequest): RequestProgress {
  return Object.freeze({
    status: request.status,
    attemptCount: request.attempts.length,
    attemptOutcomes: Object.freeze(request.attempts.map(classifyAttemptOutcome)),
    clientOutputCommitted: hasClientOutputCommitted(request.delivery),
    clientDisconnected: request.delivery.disconnectedAt !== null,
  });
}
