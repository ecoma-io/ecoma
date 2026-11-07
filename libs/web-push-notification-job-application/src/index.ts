/**
 * Public surface của `@ecoma-io/web-push-notification-job-application`.
 *
 * ⚠️ Barrel này là hợp đồng với composition root (`apps/web-push-notification-job`) và với
 * `@ecoma-io/web-push-notification-job-infrastructure` (implement port). **Không có
 * `export *`** — cùng lý do barrel của `push-notification-application`: export tường minh
 * buộc mỗi symbol thêm vào là một quyết định, và chặn hợp nhất tên trùng âm thầm.
 */

/* -------------------------------------------------------------------------------------- */
/* Port gửi Web Push — hợp đồng đã đóng băng giữa pipeline (Agent C) và adapter (Agent D)     */
/* -------------------------------------------------------------------------------------- */

export type {
  WebPushPermanentFailureClass,
  WebPushSendRequest,
  WebPushSendResult,
  WebPushSender,
  WebPushTransientPhase,
} from './web-push-sender';

/* -------------------------------------------------------------------------------------- */
/* Pipeline                                                                                   */
/* -------------------------------------------------------------------------------------- */

export {
  processDeliveryMessage,
  serializeEnvelopePayload,
  type DeliveryPipelineDeps,
  type MessageProcessingOutcome,
  type SkipReason,
} from './delivery-pipeline';

export { consumeQueueBatch, type ConsumableMessage } from './queue-consumer';

export {
  classifySendResult,
  projectAttempt,
  type AttemptProjection,
  type ProviderAction,
} from './error-matrix';

export { WEB_PUSH_REQUEST_TIMEOUT_MS, computeTtlSeconds, queueRetryDelaySeconds } from './timing';

/* -------------------------------------------------------------------------------------- */
/* Port                                                                                       */
/* -------------------------------------------------------------------------------------- */

export type {
  PipelineClock,
  MessageDisposition,
  QueueMessageInfo,
  QueueProducerPort,
} from './ports';

export {
  RuntimeAuthResolutionError,
  RuntimeContractError,
  RuntimeTransportError,
  type ClaimPortResult,
  type ClaimRejectionPort,
  type DeliveryRuntimePort,
  type FencedWritePortResult,
} from './runtime-control-plane-port';

export type {
  AttemptOutcome,
  AttemptPhase,
  AttemptRecord,
  JobRecord,
  JobStatePort,
  StoredDeliveryEnvelope,
} from './job-state-port';

export type {
  DeliveryLogFields,
  DeliveryLogLevel,
  DeliveryMetricName,
  LoggerPort,
  MetricDimensions,
  MetricsPort,
} from './observability-port';

/* -------------------------------------------------------------------------------------- */
/* Job reconciliation + authorization boundary của endpoint nội bộ                            */
/* -------------------------------------------------------------------------------------- */

export {
  runJobReconciliation,
  type JobReconciliationDeps,
  type JobReconciliationOptions,
  type JobReconciliationReport,
} from './job-reconciliation';

export {
  RECONCILE_PRINCIPAL_HEADER,
  RECONCILE_SHARED_SECRET_HEADER,
  WEB_PUSH_JOB_PRINCIPAL,
  authenticateReconciliationCaller,
  constantTimeEquals,
  readRequestHeader,
  type HeadersLike,
  type ReconcileHeaderReader,
  type ReconciliationAuthConfig,
} from './reconciliation-auth';
