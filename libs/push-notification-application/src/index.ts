/**
 * Public surface của `@ecoma-io/push-notification-application`.
 *
 * ⚠️ **Barrel này là hợp đồng với composition root**, không phải một tiện ích gom file. Nó chỉ
 * export những gì `apps/push-notification` thật sự dùng để nối các use case với adapter. Export
 * cả bề mặt nội bộ (mọi port, mọi record) sẽ biến các lựa chọn implementation của tầng
 * infrastructure thành một phần của API công khai — và mọi consumer sau này sẽ phụ thuộc vào
 * chúng mà không có lý do.
 *
 * ⚠️ **Không có `export *`.** Một `export *` làm tên trùng nhau hợp nhất âm thầm: thêm
 * `toRfc3339` ở một file khác sẽ không báo lỗi compile mà chỉ đổi nghĩa của symbol đang được
 * dùng. Danh sách tường minh ở đây buộc mỗi symbol thêm vào phải là một quyết định.
 */

/* -------------------------------------------------------------------------------------- */
/* Configuration — fail-closed                                                                 */
/* -------------------------------------------------------------------------------------- */

export { PushConfigError, resolvePushNotificationConfig } from './config-load';
export type {
  ConfigEnvironment,
  ControlPlaneAuth,
  CredentialKeyring,
  EngineeringParameters,
  PushNotificationConfig,
  RuntimeCallerAuth,
  RuntimeMetadata,
  SlaParameters,
} from './config-port';
export { readHostAllowlist, requireSecret } from './config-port';
export {
  revalidateSubscriptionEndpoints,
  type EndpointRevalidationDeps,
  type EndpointRevalidationResult,
} from './endpoint-revalidation';

/* -------------------------------------------------------------------------------------- */
/* Records và vocabulary                                                                       */
/* -------------------------------------------------------------------------------------- */

export {
  AUDIT_EVENT,
  DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST,
  MAX_PUSH_ENDPOINT_LENGTH,
  PROVIDER_TEST_RESULT,
  REQUEST_REJECTION,
  SUBSCRIPTION_DISABLE_CAUSE_VALUES,
  isSubscriptionDisableCause,
  toRfc3339,
} from './records';
export type {
  AppVapidKeyRefView,
  AuditEvent,
  CreateOutboxIntentInput,
  DecryptedProviderCredential,
  DeliveryRecord,
  DeliveryStatus,
  DeviceRecord,
  IdempotencyRecord,
  NotificationRecord,
  OutboxRecord,
  OutboxStatus,
  PersistNotificationInput,
  ProviderCredentialRecord,
  ProviderRecord,
  ProviderRoutingFactView,
  ProviderStatus,
  ProviderTestResult,
  RequestRejection,
  RoutingPolicyRecord,
  SubscriptionDisableCause,
  SubscriptionRecord,
  SubscriptionStatus,
  Transport,
  UseCaseResult,
} from './records';

/* -------------------------------------------------------------------------------------- */
/* Ports                                                                                       */
/* -------------------------------------------------------------------------------------- */

export type {
  ApplyPublisherSuccessInput,
  AuditRecordInput,
  AuditRepository,
  ClaimDeliveryInput,
  ClaimDueOutboxInput,
  ClaimedOutboxRecord,
  CredentialCipher,
  DeliveryClaimDiagnostics,
  DeliveryListFilter,
  DeliveryRepository,
  DeviceRepository,
  DisableSubscriptionInput,
  IdempotencyRepository,
  ListAgedNonTerminalInput,
  ListAgedOutboxInput,
  MarkDeliveryExpiredInput,
  NewProviderCredentialInput,
  NewProviderInput,
  NotificationRepository,
  OutboxRepository,
  PayloadDigester,
  ProviderCredentialRepository,
  ProviderMappingRecord,
  ProviderRepository,
  PushClock,
  PushNotificationPorts,
  QueuePublisher,
  RateLimitConsumeInput,
  RateLimitOutcome,
  RateLimitStore,
  RecordOutcomeInput,
  RecordPublishFailureInput,
  ReleaseLeaseInput,
  ResolveProviderCredential,
  RetryFailedDeliveryInput,
  RoutingPolicyRepository,
  SetCredentialStatusInput,
  SetPrimaryMappingInput,
  SetProviderHoldInput,
  SetProviderStatusInput,
  SubscriptionListFilter,
  SubscriptionRepository,
  UpdateProviderConfigurationInput,
  UpsertSubscriptionInput,
} from './ports';

/* -------------------------------------------------------------------------------------- */
/* Application API                                                                             */
/* -------------------------------------------------------------------------------------- */

export {
  CREATE_NOTIFICATION_REJECTION,
  canonicalRequestText,
  createNotification,
} from './create-notification';
export type {
  CreateNotificationCommand,
  CreateNotificationDeps,
  CreateNotificationRejection,
  CreateNotificationResult,
  IdGenerator,
  RequestHasher,
} from './create-notification';

/** Đăng ký / cập nhật / vô hiệu hoá `Push Subscription` (FR-003, FR-004). */
export { revalidateStoredEndpoint, validatePushEndpoint } from './endpoint-validation';
export type { EndpointValidation, EndpointValidationSuccess } from './endpoint-validation';

/**
 * Vòng đời `Device` và `Push Subscription` của **Application API** (FR-002, FR-003, FR-004).
 *
 * ⚠️ Tách khỏi `admin-subscription.ts` cố ý: đó là use case của Admin API với `ADMIN_REJECTION`
 * và actor là operator; ở đây là use case của Application API với `INVENTORY_REJECTION` và `app`
 * derive từ principal (§8.2). Trộn chúng làm một client của Application API phải hiểu
 * vocabulary quản trị.
 */
export {
  INVENTORY_REJECTION,
  disableSubscriptionByApplication,
  getDevice,
  registerDevice,
  registerSubscription,
  unregisterDevice,
  unregisterSubscription,
} from './inventory-api';
export type {
  InventoryDeps,
  InventoryRejection,
  InventoryResult,
  RegisterDeviceCommand,
  RegisterSubscriptionCommand,
  RegisterSubscriptionResult,
  SubscriptionCommand,
} from './inventory-api';

/* -------------------------------------------------------------------------------------- */
/* Private delivery runtime API (FR-015, §8.1)                                                */
/* -------------------------------------------------------------------------------------- */

export {
  claimDelivery,
  invalidateSubscription,
  recordOutcome,
  releaseDelivery,
} from './delivery-runtime';
export type {
  ClaimDeliveryOutcome,
  DeliveryRuntimeDeps,
  FencedWriteOutcome,
  InvalidateOutcome,
} from './delivery-runtime';

/* -------------------------------------------------------------------------------------- */
/* Outbox publisher (§6.1, §6.2) và reconciliation (§4.2)                                     */
/* -------------------------------------------------------------------------------------- */

export { buildDeliveryCommand, createOutboxIntent, publishOutbox } from './outbox-publisher';
export type {
  OutboxPublisherDeps,
  OutboxIntentDeps,
  PublishRunResult,
  SkipReason,
} from './outbox-publisher';

export { RECONCILE_ACTION, reconcileDeliveries, reconcileOutbox } from './reconciliation';
export type {
  DeliveryReconciliationResult,
  OutboxReconciliationResult,
  ReconcileAction,
  ReconcileDecision,
  ReconciliationDeps,
} from './reconciliation';

export { cleanupIdempotencyRecords } from './idempotency-cleanup';
export type { IdempotencyCleanupDeps, IdempotencyCleanupResult } from './idempotency-cleanup';

/* -------------------------------------------------------------------------------------- */
/* Admin API (FR-017, FR-018, FR-020)                                                          */
/* -------------------------------------------------------------------------------------- */

export {
  ADMIN_REJECTION,
  checkEncryptionKeyRetirement,
  claimProviderPrimary,
  createProvider,
  holdProvider,
  releaseProvider,
  getProvider,
  listVapidPublicKeys,
  readVapidSubject,
  rotateCredential,
  runProviderTest,
  setProviderStatus,
  updateProvider,
  validateConfigurationForProviderType,
  validateWebPushConfiguration,
  verifyVapidKeyPair,
} from './admin-provider';
export type {
  AdminDeps,
  AdminRejection,
  AdminResult,
  CreateProviderCommand,
  ProviderProbe,
  ProviderTestCommand,
  ProviderTestOutcome,
  RotateCredentialCommand,
  VapidPublicKeyView,
  ValidateConfigurationResult,
} from './admin-provider';

export {
  administrativeRetry,
  listDeliveries,
  listDevices,
  listNotifications,
  listPrimaryMappings,
  listProviders,
  listSubscriptions,
  republishDelivery,
} from './admin-delivery';
export type { RecoveryCommand, SubscriptionView } from './admin-delivery';

export {
  deleteProviderByAdmin,
  disableSubscriptionByAdmin,
  removeSubscriptionByAdmin,
} from './admin-subscription';
export type { SubscriptionAdminCommand } from './admin-subscription';
