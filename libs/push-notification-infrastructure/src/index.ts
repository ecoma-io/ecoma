/**
 * Public surface của `@ecoma-io/push-notification-infrastructure`.
 *
 * ⚠️ **Barrel này là hợp đồng với composition root** (`apps/push-notification`), không phải một
 * tiện ích gom file. Nó chỉ export adapter mà app thật sự dựng; export cả bề mặt nội bộ sẽ biến
 * chi tiết implementation (projection của một query, cách ghép filter) thành API mà mọi
 * consumer sau này phụ thuộc vào mà không có lý do.
 *
 * ⚠️ **Không có `export *`.** Một `export *` làm tên trùng nhau hợp nhất âm thầm: thêm một tên
 * ở file khác sẽ đổi nghĩa của symbol đang được dùng mà không có lỗi compile. Danh sách tường
 * minh ở đây buộc mỗi symbol thêm vào phải là một quyết định.
 *
 * ⚠️ **Bề mặt D1 được re-export vì app cần dựng adapter**: `D1DatabaseLike` là hợp đồng giữa
 * adapter và `env.DB`, và định nghĩa lại nó ở app sẽ là hai kiểu không liên quan cho cùng một
 * binding.
 */

/* -------------------------------------------------------------------------------------- */
/* Bề mặt D1                                                                                   */
/* -------------------------------------------------------------------------------------- */

export type { D1DatabaseLike, D1PreparedStatement, D1ResultMeta, D1ResultSet } from './d1-surface';

/* -------------------------------------------------------------------------------------- */
/* Adapter đơn giản — clock, id, Queue                                                        */
/* -------------------------------------------------------------------------------------- */

export { BindingQueuePublisher, cryptoRandomIdGenerator, systemClock } from './adapters';
export type { QueueBinding } from './adapters';

/* -------------------------------------------------------------------------------------- */
/* Repositories                                                                                */
/* -------------------------------------------------------------------------------------- */

export {
  D1AuditRepository,
  D1DeviceRepository,
  D1IdempotencyRepository,
  D1ProviderCredentialRepository,
  D1ProviderRepository,
  D1RoutingPolicyRepository,
  D1SubscriptionRepository,
} from './d1-inventory-repositories';

export {
  D1DeliveryRepository,
  D1NotificationRepository,
  D1OutboxRepository,
} from './d1-delivery-repositories';

/* -------------------------------------------------------------------------------------- */
/* Credential cipher                                                                           */
/* -------------------------------------------------------------------------------------- */

export { WebCryptoCredentialCipher } from './credential-cipher';
export type { CredentialCipherOptions } from './credential-cipher';

/* -------------------------------------------------------------------------------------- */
/* Rate limit                                                                                  */
/* -------------------------------------------------------------------------------------- */

export { D1RateLimitStore } from './d1-rate-limit-store';

/* -------------------------------------------------------------------------------------- */
/* Auth                                                                                       */
/* -------------------------------------------------------------------------------------- */

export {
  authenticateBearer,
  authenticateRuntimeCaller,
  constantTimeEquals,
  readBearerToken,
} from './auth';
export type { AuthConfig, AuthenticatedCaller, RuntimeAuthHeaders } from './auth';

/* -------------------------------------------------------------------------------------- */
/* Observability                                                                               */
/* -------------------------------------------------------------------------------------- */

export { createLogger, isRetryableStorageError } from './observability';
export type { LogFields, LogLevel, Logger, LoggerOptions } from './observability';
