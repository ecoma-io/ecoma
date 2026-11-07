/**
 * `@ecoma-io/push-notification-contracts` — boundary artifact của cặp service
 * `push-notification` (control plane) và `web-push-notification-job` (delivery plane).
 *
 * ⚠️ **Project này KHÔNG import một project nào khác.** Constraint `type:contracts` trong
 * `.oxlintrc.json` cấm phụ thuộc `type:domain`/`type:application`/`type:infrastructure`/
 * `type:composition`/`type:tooling` (kể cả transitive), và đó là đúng: contract là thứ
 * provider **publish** để consumer phụ thuộc vào, không phải một tầng để đi theo chiều phụ
 * thuộc. Vì vậy `Transport`, provider type và delivery state được **khai báo lại** ở đây
 * thay vì import từ tầng domain của `push-notification`.
 *
 * Project cũng **không** chứa implementation: không Hono handler, không truy cập D1/SQL,
 * không Queue producer/consumer, không state machine, không Cloudflare binding, không
 * credential lookup/key management, không HMAC, không encryption, và **không** network call.
 * Nội dung chỉ là: hình dạng message/envelope, validator hình thức chạy ở runtime, và hằng
 * số vocabulary mà cả hai plane phải đọc giống nhau.
 *
 * Vì thuần schema/validation, project mang tag `runtime:universal` — không dùng API nào
 * riêng của Workers, browser hay Node (không WebCrypto, không `node:*`).
 *
 * Canonical docs: `docs/applications/push-notification/01-architecture.md` §8.1 ·
 * `docs/applications/push-notification/02-requirements.md` FR-013 · `docs/applications/web-push-notification-job/01-architecture.md` §5, §7.
 */

export {
  DELIVERY_STATUS_VALUES,
  NON_TERMINAL_DELIVERY_STATUS_VALUES,
  TERMINAL_DELIVERY_STATUS_VALUES,
  TRANSPORT_VALUES,
  PROVIDER_TYPE_VALUES,
  V1_EXECUTABLE_PROVIDER_TYPE,
  V1_EXECUTABLE_TRANSPORT,
  FORBIDDEN_DELIVERY_MATERIAL_FIELDS,
  SUBSCRIPTION_STATUS_VALUES,
  isDeliveryStatus,
  isNonEmptyString,
  isNonTerminalDeliveryStatus,
  isPlainObject,
  isPositiveInteger,
  isProviderType,
  isRfc3339Timestamp,
  isSubscriptionStatus,
  isTerminalDeliveryStatus,
  isTransport,
  validateV1ExecutionMaterialScope,
  validateV1ExecutionTransport,
  type DeliveryStatus,
  type ExecutionScopeRejectionReason,
  type ExecutionScopeValidation,
  type NonTerminalDeliveryStatus,
  type ProviderType,
  type SubscriptionStatus,
  type TerminalDeliveryStatus,
  type Transport,
} from './shared';

export {
  NOTIFICATION_PAYLOAD_FIELDS,
  REQUIRED_NOTIFICATION_PAYLOAD_FIELDS,
  validateNotificationPayload,
  type NotificationPayload,
  type NotificationPayloadRejectionReason,
  type NotificationPayloadValidation,
} from './notification-payload';

export {
  DELIVERY_COMMAND_FIELDS,
  DELIVERY_COMMAND_VERSION,
  FORBIDDEN_DELIVERY_COMMAND_FIELDS,
  deliveryCommandV1,
  isSupportedDeliveryCommandVersion,
  validateDeliveryCommand,
  type DeliveryCommandPayload,
  type DeliveryCommandRejectionReason,
  type DeliveryCommandV1,
  type DeliveryCommandValidation,
} from './delivery-command';

export {
  CLAIM_REJECTION_REASONS,
  CLAIM_REJECTION_REASON_WITH_STATE,
  FORBIDDEN_CLAIM_REJECTION_FIELDS,
  claimRejection,
  deliveryClaim,
  isClaimRejectionReason,
  validateClaimRejection,
  validateClaimRequest,
  validateDeliveryClaim,
  type ClaimRejection,
  type ClaimRejectionReason,
  type ClaimRejectionValidation,
  type ClaimRequest,
  type ClaimResponseRejectionReason,
  type ClaimResult,
  type ClaimValidation,
  type ClaimedProvider,
  type ClaimedSubscription,
  type DeliveryClaim,
  type EmptyRequestValidation,
} from './claim';

export {
  DELIVERY_OUTCOME_VALUES,
  FORBIDDEN_LEASE_FENCED_REJECTION_FIELDS,
  LEASE_FENCED_REJECTION_REASONS,
  LEASE_FENCED_REASON_WITH_STATE,
  isDeliveryOutcomeValue,
  isLeaseFencedRejectionReason,
  leaseFencedRejection,
  outcomeAck,
  releaseAck,
  validateLeaseFencedRejection,
  validateOutcomeAck,
  validateOutcomeRequest,
  validateReleaseAck,
  validateReleaseRequest,
  type DeliveryOutcomeValue,
  type LeaseFencedRejection,
  type LeaseFencedRejectionReason,
  type LeaseFencedRejectionValidation,
  type LeaseFencedRejectionValidationReason,
  type OutcomeAck,
  type OutcomeRequest,
  type OutcomeRequestValidation,
  type OutcomeResult,
  type OutcomeValidation,
  type ReleaseAck,
  type ReleaseRequest,
  type ReleaseRequestValidation,
  type ReleaseResult,
  type ReleaseValidation,
  type WriteAckRejectionReason,
  type WriteRequestRejectionReason,
} from './delivery-write';

export {
  FORBIDDEN_INVALIDATE_ACK_FIELDS,
  INVALIDATE_RESULT_SUBSCRIPTION_STATUS,
  invalidateAck,
  validateInvalidateAck,
  validateInvalidateRequest,
  type InvalidateAck,
  type InvalidateRequest,
  type InvalidateRequestValidation,
  type InvalidateResponseRejectionReason,
  type InvalidateValidation,
} from './invalidate';
