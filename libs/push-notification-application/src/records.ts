/**
 * Value object và vocabulary mà **use case** của `push-notification` dùng.
 *
 * Source of truth: `docs/applications/push-notification/01-architecture.md` §5 (domain model),
 * §5.6 (state/lease/fencing), §6.1 (outbox), §7 (delivery idempotency), §8.1 (runtime API);
 * `docs/applications/push-notification/02-requirements.md` FR-001..FR-021.
 *
 * ⚠️ **Vì sao file này khai lại `Transport`/`ProviderType` mà không import từ
 * `@ecoma-io/push-notification-domain`.** Thực ra application layer **có** import được
 * domain (`type:application` được phép phụ thuộc `type:domain`), và phần lớn module ở đây
 * dùng đúng domain — kể cả `DELIVERY_STATUS`, `SUBSCRIPTION_STATUS`, `OUTBOX_STATUS`. Cái
 * được khai lại ở đây **chỉ** là những thứ *không* phải business state mà domain sở hữu:
 * ảnh chụp dữ liệu đọc được từ storage (`record`), và các `reason` từ chối của **use case**
 * (không phải của domain).
 *
 * ⚠️ **Mọi mốc thời gian là epoch millis `number`.** Application không parse RFC 3339; việc
 * serialize sang RFC 3339 cho wire thuộc composition root (`apps/push-notification`), vì
 * domain dùng `number` và contracts kiểm **chuỗi** RFC 3339 — đó là ranh giới wire.
 */

import type {
  AppVapidKeyRef,
  DeliveryStatus,
  OutboxStatus,
  ProviderRoutingFact,
  ProviderStatus,
  ProviderType,
  SubscriptionStatus,
  Transport,
} from '@ecoma-io/push-notification-domain';

/**
 * Re-export các **union trạng thái** của domain cho consumer của lib này.
 *
 * ⚠️ Vì sao re-export thay vì bắt mọi file import từ domain: `Transport`/`ProviderStatus`/
 * `SubscriptionStatus`/`DeliveryStatus`/`OutboxStatus` xuất hiện trong **mọi** record và mọi
 * command của application, nên chúng là một phần của public surface của lib; export lại chúng
 * từ đây giữ cho consumer chỉ cần một entrypoint.
 *
 * ⚠️ Đây là **cùng một union**, không phải bản khai lại: dưới đây chỉ là `export type` của đúng
 * symbol đã import. Không có từ khoá `type`/`interface` nào được định nghĩa ở file này, nên không
 * có vocabulary thứ hai nào có thể trôi khỏi domain mà không bị typecheck bắt.
 */
export type { Transport, ProviderStatus, SubscriptionStatus, DeliveryStatus, OutboxStatus };

/* -------------------------------------------------------------------------------------- */
/* Vocabularies đóng                                                                        */
/* -------------------------------------------------------------------------------------- */

/**
 * Audit event — **tập đóng 12 giá trị** của FR-020.
 *
 * Đây là nguồn duy nhất ở tầng application: repository ghi vào cột `event` của
 * `audit_records`, và CHECK của schema chốt đúng tập này. Thêm giá trị ở đây mà không sửa
 * FR-020 (và schema) là một audit record mà không tài liệu nào yêu cầu.
 */
export const AUDIT_EVENT = {
  ProviderCreated: 'provider_created',
  ProviderUpdated: 'provider_updated',
  ProviderEnabled: 'provider_enabled',
  ProviderDisabled: 'provider_disabled',
  ProviderHeld: 'provider_held',
  ProviderReleased: 'provider_released',
  CredentialRotated: 'credential_rotated',
  SubscriptionDisabled: 'subscription_disabled',
  SubscriptionRemoved: 'subscription_removed',
  NotificationCreated: 'notification_created',
  DeliveryRetried: 'delivery_retried',
  DeliveryRepublished: 'delivery_republished',
} as const;

export type AuditEvent = (typeof AUDIT_EVENT)[keyof typeof AUDIT_EVENT];

/**
 * Phân loại kết quả provider test (FR-018) — vocabulary đóng, **không** suy ra từ HTTP code.
 *
 * `configuration_invalid` và `authentication_failed` là hai lớp khác nhau về remediation
 * (§15.3: 401/403 → credential/config path; §6.1: validation trước enable → configuration
 * path), nên gộp chúng làm mất một nhánh vận hành.
 */
export const PROVIDER_TEST_RESULT = {
  ConfigurationInvalid: 'configuration_invalid',
  AuthenticationFailed: 'authentication_failed',
  ProviderRejectedRequest: 'provider_rejected_request',
  SubscriptionInvalid: 'subscription_invalid',
  DeliveryAccepted: 'delivery_accepted',
} as const;

export type ProviderTestResult = (typeof PROVIDER_TEST_RESULT)[keyof typeof PROVIDER_TEST_RESULT];

/**
 * Lý do **application-level** từ chối một request/use case — TÁCH khỏi `reason` của domain.
 *
 * ⚠️ Domain đã có vocabulary `reason` riêng cho claim (`pending`/`lease_held`/…) và cho
 * administrative recovery. Ở đây là các lý do chỉ tồn tại ở tầng use case: validation đầu
 * vào, quota, và việc tra cứu không thấy entity. Trộn chúng làm một `409 terminal` của
 * contract và một `409 notification_not_found` của Admin API trở thành cùng một loại.
 */
export const REQUEST_REJECTION = {
  InvalidPayload: 'invalid_payload',
  IdempotencyKeyMissing: 'idempotency_key_missing',
  IdempotencyKeyTooLong: 'idempotency_key_too_long',
  IdempotencyKeyConflict: 'idempotency_key_conflict',
  AppMismatch: 'app_mismatch',
  UnauthorizedPrincipal: 'unauthorized_principal',
  RateLimited: 'rate_limited',
  FanoutLimitExceeded: 'fanout_limit_exceeded',
  PayloadOverBudget: 'payload_over_budget',
  EndpointRejected: 'endpoint_rejected',
  NotFound: 'not_found',
  RouteRejected: 'route_rejected',
  StorageFailure: 'storage_failure',
  PreconditionFailed: 'precondition_failed',
} as const;

export type RequestRejection = (typeof REQUEST_REJECTION)[keyof typeof REQUEST_REJECTION];

/* -------------------------------------------------------------------------------------- */
/* Records đọc được từ storage                                                              */
/* -------------------------------------------------------------------------------------- */

/** Ảnh chụp một `Device` như use case cần (không phải shape của schema). */
export interface DeviceRecord {
  readonly deviceId: string;
  readonly userId: string;
  readonly app: string;
  readonly createdAt: number;
}

/**
 * Ảnh chụp một `Push Subscription`.
 *
 * `endpointHash` được mang vì tầng repository cần nó để chặn trùng endpoint (FR-003), nhưng
 * nó **không phải** material trả ra ngoài: không endpoint đầy đủ, không `p256dh`, không
 * `auth` lọt vào bất kỳ response nào ngoài response `200` của claim (§8.1).
 */
export interface SubscriptionRecord {
  readonly subscriptionId: string;
  readonly deviceId: string;
  readonly userId: string;
  readonly app: string;
  readonly transport: Transport;
  readonly endpoint: string;
  readonly endpointHash: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly vapidKeyId: string;
  readonly providerId: string | null;
  readonly status: SubscriptionStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Ảnh chụp một `Push Provider`. `emergencyHold` đã được quy đổi từ INTEGER 0/1 sang boolean. */
export interface ProviderRecord {
  readonly providerId: string;
  readonly app: string;
  readonly transport: Transport;
  readonly type: ProviderType;
  readonly name: string;
  readonly status: ProviderStatus;
  readonly emergencyHold: boolean;
  readonly isPrimary: boolean;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Credential provider **đã giải mã** — chỉ tồn tại trong memory, trên đường `claim` thắng.
 *
 * ⚠️ Kiểu này **cố ý** không có `credentialId`/`version`: đây là thứ được đưa vào
 * `DeliveryClaim.provider.credential`, và mọi field thừa ở đó là một field ngoài tập đóng
 * của contract (§8.1) mà consumer sẽ từ chối. Ai cần định danh thì đọc `ProviderCredentialRecord`.
 */
export interface DecryptedProviderCredential {
  readonly privateKey: string;
  readonly publicKey: string;
}

/** Ảnh chụp một credential provider **còn mã hoá** như repository đọc từ storage. */
export interface ProviderCredentialRecord {
  readonly credentialId: string;
  readonly providerId: string;
  readonly app: string;
  readonly vapidKeyId: string;
  readonly publicKey: string;
  readonly credentialCiphertext: Uint8Array;
  readonly credentialEncryptionVersion: string;
  readonly status: 'active' | 'retired' | 'compromised';
  /**
   * Mốc thời gian có mặt vì §7.3 dùng chúng để quyết định **bao lâu** một key đã `retired`
   * mới đủ lâu để retire root key tương ứng, và audit `credential_rotated` ghi khoảng thời
   * gian đó. Không có chúng, quyết định retire phải suy từ `last_seen` của subscription — thứ
   * không đo được tuổi của chính credential.
   */
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Ảnh chụp một `Push Notification`. */
export interface NotificationRecord {
  readonly notificationId: string;
  readonly app: string;
  readonly principalId: string;
  /** Canonical serialization của payload (FR-013) — nguồn duy nhất để dựng envelope. */
  readonly payloadJson: string;
  readonly payloadBytes: number;
  readonly expiresAt: number;
  readonly createdAt: number;
}

/**
 * Ảnh chụp một `Push Delivery` — bao gồm **đủ** trạng thái để domain quyết định.
 *
 * ⚠️ `dispatchGeneration` dùng `isNonNegativeInteger` (không `isPositiveInteger`) vì delivery
 * chưa từng được claim có generation `0` — xem `DeliveryLeaseState` của domain.
 */
export interface DeliveryRecord {
  readonly deliveryId: string;
  readonly notificationId: string;
  readonly subscriptionId: string;
  readonly providerId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly app: string;
  readonly transport: Transport;
  readonly status: DeliveryStatus;
  readonly dispatchGeneration: number;
  readonly leaseExpiresAt: number | null;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Ảnh chụp một outbox record như publisher cần. */
export interface OutboxRecord {
  readonly outboxId: string;
  readonly deliveryId: string;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly availableAt: number;
  readonly leaseExpiresAt: number | null;
  readonly claimedBy: string | null;
  readonly lastError: string | null;
  readonly createdAt: number;
}

/** Ảnh chụp một idempotency record (FR-008). */
export interface IdempotencyRecord {
  readonly app: string;
  readonly principalId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly notificationId: string;
  readonly createdAt: number;
}

/** `Push Routing Policy` của một `App`. */
export interface RoutingPolicyRecord {
  readonly app: string;
  /** Thứ tự ưu tiên transport; v1 cố định `app > web` (§5.5). */
  readonly transportPriority: readonly Transport[];
  readonly maxDeliveriesPerNotification: number;
}

/**
 * Routing fact mà `selectPrimaryProvider` cần — suy ra từ `ProviderRecord` bởi repository,
 * nên use case không dựng lại vocabulary và không thể truyền một provider ở sai shape.
 */
export type ProviderRoutingFactView = ProviderRoutingFact;

/**
 * Một `vapid_key_id` mà `App` còn phục vụ — **tập**, không phải một key (FR-006).
 *
 * ⚠️ Vì sao view riêng thay vì dùng thẳng `AppVapidKeyRef`: `ports.ts` đã khai báo
 * `listAppVapidKeys` trả `AppVapidKeyRef`, và một view tại đây cho consumer của lib ngoài domain
 * import trực tiếp mà không cần `type:domain` trong tầng trên. Cùng một symbol, không phải khai
 * lại.
 */
export type AppVapidKeyRefView = AppVapidKeyRef;

/* -------------------------------------------------------------------------------------- */
/* Kết quả chung                                                                            */
/* -------------------------------------------------------------------------------------- */

/**
 * Kết quả của một use case: hoặc thành công có dữ liệu, hoặc bị từ chối với `reason` **đóng**
 * và `detail` hằng.
 *
 * `detail` không bao giờ nối giá trị đầu vào: nó có thể đi vào log và response, còn payload,
 * endpoint, `Idempotency-Key` và secret đều là dữ liệu nhạy cảm hoặc do caller kiểm soát
 * (log injection bằng newline). Xem `DomainRejection` của domain — cùng nguyên tắc, hai tầng
 * độc lập.
 */
export type UseCaseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: RequestRejection; readonly detail: string };

/**
 * Hàng cần ghi để materialize một notification.
 *
 * Một object này là **input** của `db.batch()` duy nhất (§6, FR-013): notification,
 * deliveries, outbox intents và idempotency record đi trong cùng một transaction. Vì vậy nó
 * là một kiểu duy nhất thay vì bốn tham số rời — không có cách nào truyền "3 delivery và 2
 * outbox intent" một cách âm thầm.
 */
export interface PersistNotificationInput {
  readonly notification: NotificationRecord;
  readonly deliveries: readonly DeliveryRecord[];
  readonly outboxIntents: readonly OutboxIntentInput[];
  readonly idempotency: IdempotencyRecord;
}

/**
 * Một outbox intent **mới** (chưa có `outboxId`/state nào trong storage).
 *
 * ⚠️ `availableAt` có mặt vì publisher claim predicate dùng nó (`§6.1`); v1 ghi `createdAt`
 * cho tất cả intent của một notification, tức intent tới hạn ngay khi transaction commit —
 * đúng nghĩa "đã ghi trong transaction, chờ claim" của §6.1.
 */
export interface OutboxIntentInput {
  readonly outboxId: string;
  readonly deliveryId: string;
  readonly availableAt: number;
  readonly createdAt: number;
}

/** Tham số của một lần tạo outbox intent (republish / reconciliation a4). */
export interface CreateOutboxIntentInput {
  readonly outboxId: string;
  readonly deliveryId: string;
  readonly availableAt: number;
  readonly createdAt: number;
}

/* -------------------------------------------------------------------------------------- */
/* Nguyên nhân disable subscription — vocabulary đóng, dùng chung với schema               */
/* -------------------------------------------------------------------------------------- */

/**
 * Nguyên nhân disable — **cùng tập** với `SUBSCRIPTION_DISABLE_CAUSE` của domain và với
 * CHECK `push_subscriptions_disabled_reason_check` của schema.
 *
 * Sở hữu thực sự là của domain; ở đây chỉ re-export dưới tên use case dùng, để use case không
 * phải import domain chỉ để lấy một union bốn giá trị.
 */
export const SUBSCRIPTION_DISABLE_CAUSE_VALUES = [
  'user_unregister',
  'admin_disable',
  'provider_invalidation',
  'endpoint_revalidation_failed',
] as const;

export type SubscriptionDisableCause = (typeof SUBSCRIPTION_DISABLE_CAUSE_VALUES)[number];

export function isSubscriptionDisableCause(value: unknown): value is SubscriptionDisableCause {
  return SUBSCRIPTION_DISABLE_CAUSE_VALUES.includes(value as SubscriptionDisableCause);
}

/* -------------------------------------------------------------------------------------- */
/* Allowlist endpoint của Browser Push Service (FR-003)                                     */
/* -------------------------------------------------------------------------------------- */

/**
 * Allowlist host `Browser Push Service` **mặc định** (FR-003).
 *
 * ⚠️ Đây là allowlist **do operator kiểm soát**, không phải danh sách đóng của spec: một
 * deployment có thể chạy một Browser Push Service riêng, nên biến môi trường ghi đè được
 * JSON array. Giá trị mặc định là ba host mà v1 thực sự cần (Chrome/Firefox/Safari qua
 * `web-push`).
 *
 * ⚠️ Allowlist **không** phải cơ chế chống SSRF hoàn hảo: host trong allowlist vẫn có thể
 * resolve về địa chỉ private qua DNS rebinding, và FR-003 nêu rõ điều đó. Giảm thiểu, không
 * triệt để.
 */
export const DEFAULT_PUSH_ENDPOINT_HOST_ALLOWLIST: readonly string[] = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'webkit.push.apple.com',
];

/**
 * Ngưỡng độ dài endpoint — chặn chi phí, không phải chặn định dạng.
 *
 * Endpoint thực của Browser Push Service dài ~150–400 ký tự; 2048 là trần rộng có chủ ý để
 * một push service khác vẫn nằm trong giới hạn mà không cần đổi schema. Giữ trần này ở một
 * chỗ: một giá trị "hợp lý" khác ở nơi khác là hai nguồn sự thật.
 */
export const MAX_PUSH_ENDPOINT_LENGTH = 2048;

/* -------------------------------------------------------------------------------------- */
/* Chuyển thời gian ở boundary                                                                */
/* -------------------------------------------------------------------------------------- */

/**
 * Epoch millis → RFC3339 `…Z` cho **wire**.
 *
 * ⚠️ Tồn tại vì storage và wire dùng **hai** kiểu thời gian khác nhau: mọi cột `*_at` trong
 * schema là `INTEGER` epoch millis (một kiểu số để so sánh được trong SQL), còn response của
 * delivery runtime API là **string** RFC3339 (`01-architecture.md` §8.1). Hàm chuyển đổi
 * phải nằm ở đúng một chỗ: một `new Date(...).toISOString()` rải rác trong use case là nhiều
 * nguồn sự thật, và chỗ nào quên `Z` là wire sai mà type không bắt được.
 *
 * ⚠️ `toISOString()` **ném** `RangeError` khi millis không phải ngày hợp lệ (`NaN`,
 * `Infinity`). Ở đây mọi millis đến từ `PushClock` hoặc từ một cột đã qua schema, nên một
 * giá trị hỏng là **lỗi dữ liệu** và ném là hành vi đúng — im lặng trả `null` sẽ biến nó
 * thành một response `200` mang `lease_expires_at` bịa, tức hỏng âm thầm ở phía consumer.
 */
export function toRfc3339(epochMillis: number): string {
  return new Date(epochMillis).toISOString();
}
