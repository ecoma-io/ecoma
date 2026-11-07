/**
 * Public surface của `@ecoma-io/web-push-notification-job-infrastructure`.
 *
 * ⚠️ **Không `export *`** — cùng lý do với barrel của tầng application: export tường minh buộc
 * mỗi symbol thêm vào là một quyết định, và chặn hợp nhất tên trùng âm thầm.
 *
 * ⚠️ **Barrel này KHÔNG import `./web-push`.** Folder `src/web-push/**` thuộc một agent khác đang
 * làm **song song trong cùng working tree**: agent đó implement `WebPushSender` (protocol
 * aes128gcm/Base64URL/VAPID), còn mọi thứ ở đây là infrastructure của delivery plane
 * (control-plane client, job state trên D1, observability). Để barrel import vào
 * `./web-push` là tạo một phụ thuộc giữa hai đơn vị đang được giao song song — và composition
 * root (`apps/web-push-notification-job`) là nơi duy nhất được phép nối hai bên lại.
 */

/* -------------------------------------------------------------------------------------- */
/* Port của control plane (HTTP qua Service Binding)                                          */
/* -------------------------------------------------------------------------------------- */

export {
  RUNTIME_API_SHARED_SECRET_ENV,
  RUNTIME_AUTH_HEADERS,
  RUNTIME_CALLER_PRINCIPAL,
  RUNTIME_PRINCIPAL_HEADER,
  RuntimeControlPlaneClient,
  resolveRuntimeSharedSecret,
  type RuntimeControlPlaneOptions,
  type RuntimeServiceBinding,
} from './runtime-control-plane';

/* -------------------------------------------------------------------------------------- */
/* Job state trên D1 `push-job` — bốn nhóm FR-022                                            */
/* -------------------------------------------------------------------------------------- */

export {
  D1JobStateRepository,
  MalformedJobStateError,
  type D1JobStateRepositoryOptions,
} from './d1-job-state-repository';

export {
  readChanges,
  type D1DatabaseLike,
  type D1PreparedStatement,
  type D1ResultMeta,
  type D1ResultSet,
} from './d1-surface';

/* -------------------------------------------------------------------------------------- */
/* Observability — JSON-line logger + bộ đếm metric in-process                                */
/* -------------------------------------------------------------------------------------- */

export {
  createLogger,
  createMetrics,
  resolveLogLevel,
  type LoggerOptions,
  type MetricsOptions,
  type MetricsSnapshot,
  type MetricsSnapshotSource,
} from './observability';
