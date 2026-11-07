/**
 * `@ecoma-io/push-notification-domain` — domain library thuần cho Push Notification
 * Service: business invariants và state transitions. Không I/O, không Cloudflare,
 * không SDK provider, không Node builtin.
 *
 * ## Ranh giới với `@ecoma-io/push-notification-contracts`
 *
 * Dependency rule của repo: `<bc>-domain` **không** phụ thuộc Nx project nào khác
 * (`docs/architecture/05-code-architecture.md` §3), nên lib này không import contracts —
 * và vì vậy nó **khai báo lại** các vocabulary mà nó cần. Ranh giới trách nhiệm là:
 *
 * - **contracts** sở hữu **wire**: schema và validator cho envelope/claim/payload,
 *   chính sách unknown-field, tính tương thích JSON của `data`, danh sách khoá bị cấm,
 *   và vocabulary được serialize ra ngoài. Đây là boundary validation chạy khi dữ liệu
 *   vào hệ thống.
 * - **domain** (lib này) sở hữu **business rule**: ai được phép chuyển một delivery
 *   sang trạng thái nào, khi nào provider đủ điều kiện nhận routing, khi nào
 *   administrative retry/re-publish được phép, bất biến lease/fencing, và ngân sách
 *   byte của payload.
 *
 * ⚠️ **Rủi ro trôi dạt có thật:** hai lib mirror cùng vocabulary (`Transport`,
 * `ProviderType`, subscription status, delivery status) và `docs/domains/push-notification/`
 * là nguồn canonical cho cả hai. Khi tài liệu đổi vocabulary, **cả hai** lib phải đổi
 * trong cùng một thay đổi — không có cơ chế compile-time nào bắt được lệch giữa chúng
 * vì chúng không được phép import lẫn nhau.
 *
 * ## Thời gian và tính thuần khiết
 *
 * Mọi giá trị thời gian là epoch millis kiểu `number` do caller truyền vào — domain
 * không đọc đồng hồ (`Date.now()`), không parse RFC 3339, không sinh ngẫu nhiên. Mọi
 * hàm là thuần: không sửa input, không giữ state, và trả `null`/result object thay vì
 * ném exception cho dữ liệu hỏng.
 *
 * Public surface được giữ có chủ đích; mọi thứ khác trong các module là internal.
 */

export type { DomainOk, DomainRejection, Transport } from './shared';
export {
  TRANSPORT,
  TRANSPORT_VALUES,
  isEpochMillis,
  isFiniteNumber,
  isNonEmptyString,
  isNonNegativeInteger,
  isPositiveInteger,
  isTransport,
} from './shared';

export type {
  DisableSubscriptionResult,
  ExpireSubscriptionResult,
  SubscriptionDisableCause,
  SubscriptionStatus,
} from './subscription';
export {
  CLOSED_SUBSCRIPTION_STATUS_VALUES,
  SUBSCRIPTION_DISABLE_CAUSE,
  SUBSCRIPTION_DISABLE_CAUSE_VALUES,
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_STATUS_VALUES,
  disableSubscription,
  expireSubscription,
  isClosedSubscriptionStatus,
  isSubscriptionDisableCause,
  isSubscriptionEligibleForDelivery,
  isSubscriptionStatus,
} from './subscription';

export type {
  AppVapidKeyRef,
  ProviderIneligibilityReason,
  ProviderRoutingEligibility,
  ProviderRoutingFact,
  ProviderStatus,
  ProviderType,
  SelectPrimaryProviderResult,
} from './provider';
export {
  PROVIDER_STATUS,
  PROVIDER_STATUS_VALUES,
  PROVIDER_TYPE,
  PROVIDER_TYPE_VALUES,
  V1_EXECUTABLE_PROVIDER_TYPE,
  V1_EXECUTABLE_TRANSPORT,
  canRetireEncryptionKey,
  evaluateProviderRoutingEligibility,
  isProviderStatus,
  isProviderType,
  isV1ExecutableProviderScope,
  resolveSubscriptionSigningKeyId,
  selectPrimaryProvider,
} from './provider';

export type { RoutingSubscriptionFact, SelectDeviceSubscriptionsResult } from './routing';
export { TRANSPORT_PRIORITY_ORDER, selectSubscriptionsForDevice } from './routing';

export type {
  AdministrativeRecoveryPrecondition,
  AdministrativeRecoveryRejection,
  AdministrativeRetryDecision,
  ClaimDeliveryContext,
  ClaimRejectionReason,
  DeliveryClaimDecision,
  DeliveryLeaseState,
  DeliveryStatus,
  DeliveryTransitionActor,
  FencedWriteDecision,
  FencedWriteOperation,
  RepublishDecision,
  ValidateDeliveryTransitionResult,
} from './delivery';
export {
  DELIVERY_STATUS,
  DELIVERY_STATUS_VALUES,
  DELIVERY_TRANSITIONS,
  DELIVERY_TRANSITION_ACTOR,
  DELIVERY_TRANSITION_ACTOR_VALUES,
  FENCED_WRITE_OPERATIONS,
  TERMINAL_DELIVERY_STATUS_VALUES,
  decideDeliveryClaim,
  decideFencedWrite,
  isDeliveryStatus,
  isDeliveryTransitionActor,
  isFencedWriteOperation,
  isNonTerminalDeliveryStatus,
  isTerminalDeliveryStatus,
  planAdministrativeRetry,
  planDeliveryRepublish,
  validateDeliveryTransition,
} from './delivery';

export type {
  ApplyPublisherSuccessRejection,
  ApplyPublisherSuccessResult,
  DeliveryWriteAfterPublish,
  OutboxClaimDecision,
  OutboxClaimRejectionReason,
  OutboxRecordState,
  OutboxStatus,
} from './outbox';
export {
  OPEN_OUTBOX_STATUS_VALUES,
  OUTBOX_STATUS,
  OUTBOX_STATUS_VALUES,
  TERMINAL_OUTBOX_STATUS_VALUES,
  applyPublisherSuccess,
  canCreateOutboxIntent,
  decideOutboxClaim,
  isOutboxStatus,
  isOpenOutboxStatus,
  isTerminalOutboxStatus,
} from './outbox';

export type {
  NotificationPayload,
  PayloadBudgetRejection,
  PayloadBudgetResult,
} from './notification';
export {
  MAX_PAYLOAD_PLAINTEXT_BYTES,
  MAX_PUSH_BODY_BYTES,
  PUSH_PROTOCOL_FRAMING_OVERHEAD_BYTES,
  checkPayloadPlaintextBudget,
  isPushBodyWithinLimit,
  measurePayloadPlaintextBytes,
  serializePayloadCanonically,
} from './notification';
