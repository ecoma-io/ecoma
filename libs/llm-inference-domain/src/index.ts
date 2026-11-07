/**
 * `@ecoma-io/llm-inference-domain` — tầng domain thuần của bounded context
 * `llm-inference`: logical request lifecycle, provider attempt lifecycle,
 * execution evidence, retry admissibility, streaming/delivery facts và logical
 * request completion.
 *
 * Source of truth: `docs/domains/llm-inference/domain-model.md`.
 *
 * ## Thuần khiết
 *
 * - **Không** import Nx project khác (kể cả `type:contracts`).
 * - **Không** SQL, **Không** Node builtin, **Không** I/O, **Không** HTTP client,
 *   không provider SDK.
 * - Mọi tham số thời gian, identifier, dữ kiện thực thi, snapshot và policy
 *   limit do caller truyền vào; domain không đọc đồng hồ, không sinh identifier.
 * - Không persistence, durable idempotency, transaction, optimistic concurrency,
 *   recovery worker, event dispatch.
 *
 * ## Ranh với các bounded context khác
 *
 * - Chọn candidate, xếp thứ tự fallback endpoint/offer, routing strategy →
 *   `llm-consumer-routing`. Domain này nhận `candidateRef`/`endpointRef` như input.
 * - Model offer, upstream endpoint, endpoint pool, credential metadata →
 *   `llm-marketplace`.
 * - Usage measurement, token accounting, normalization → `llm-usage`.
 * - Customer price và pricing snapshot → `llm-seller-pricing`.
 * - Monetary state, reservation, charge, settlement → `llm-financial`.
 * - Quota authority (reserve/settle), persistence, provider adapter, HTTP/SSE
 *   và orchestration → `llm-api` (A7).
 *
 * ## Quyết định chưa chốt — không âm thầm chốt trong lib này
 *
 * Xem `docs/domains/llm-inference/domain-model.md` §10. Lib không có API
 * nào chốt các mục đó: không có default `maxAttempts`/deadline, không có policy
 * "client disconnect có huỷ request hay không", không có quy tắc escalation khi
 * bất định không thể reconcile, và không huỷ được request còn bất định.
 */
export {
  INFERENCE_DOMAIN_ERROR_MESSAGES,
  inferenceDomainError,
  isInferenceDomainError,
  type InferenceDomainError,
  type InferenceDomainErrorCode,
} from './errors';

export {
  MAX_OPAQUE_ID_LENGTH,
  createAttemptId,
  createRequestId,
  inferenceFailure,
  inferenceOk,
  isAttemptId,
  isEpochMillis,
  isOpaqueId,
  isPositiveInteger,
  isRequestId,
  type AttemptId,
  type InferenceFailure,
  type InferenceOk,
  type InferenceResult,
  type RequestId,
} from './shared';

export {
  EXECUTION_EVIDENCE,
  EXECUTION_EVIDENCE_VALUES,
  allowedEvidenceTargets,
  canTransitionEvidence,
  classifyEvidence,
  isAuthoritativeEvidence,
  isExecutionEvidence,
  isRetrySafeEvidence,
  type ExecutionEvidence,
} from './evidence';

export {
  classifyAttemptOutcome,
  isAttemptOpen,
  isAttemptUncertain,
  isProviderAttempt,
  type AttemptOutcome,
  type ProviderAttempt,
} from './attempt';

export {
  INITIAL_CLIENT_DELIVERY,
  commitClientResponse,
  hasClientOutputCommitted,
  isClientDelivery,
  isClientDisconnected,
  recordClientDisconnect,
  type ClientDelivery,
  type ClientDeliveryState,
} from './delivery';

export { isExecutionPolicy, validateExecutionPolicy, type ExecutionPolicy } from './policy';

export {
  awaitReconciliation,
  cancelRequest,
  closeAttempt,
  completeRequest,
  createLogicalRequest,
  describeRequestProgress,
  evaluateRetryAdmissibility,
  failRequest,
  findAttempt,
  findOpenAttempt,
  hasUnresolvedUncertainty,
  isLogicalRequest,
  isRequestTerminal,
  isTerminalStatus,
  latestAttempt,
  reconcileUncertainAttempt,
  recordAttemptEvidence,
  recordClientDisconnectEvent,
  recordClientOutputCommitted,
  recordDispatchIntent,
  type CancelRequestInput,
  type CloseAttemptInput,
  type CreateLogicalRequestInput,
  type LogicalRequest,
  type LogicalRequestStatus,
  type RecordDispatchIntentInput,
  type RecordEvidenceInput,
  type ReconcileAttemptInput,
  type RequestCancellationReason,
  type RequestCompletion,
  type RequestProgress,
  type RetryDecision,
  type RetryRejectionReason,
} from './request';
