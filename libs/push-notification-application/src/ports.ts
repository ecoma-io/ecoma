/**
 * Port của `@ecoma-io/push-notification-application` — **mọi** dependency mà use case cần,
 * khai báo dưới dạng interface. Lib này không có implementation nào: `type:application` bị
 * cấm phụ thuộc `type:infrastructure`, nên D1 binding, WebCrypto và Queue binding đều nằm
 * ở `@ecoma-io/push-notification-infrastructure` và chỉ được biết qua các interface ở đây.
 *
 * Ranh giới này không phải nghi thức: nó là thứ làm cho quyết định claim/release/outcome có
 * thể được kiểm chứng bằng test mà không cần D1 thật, đồng thời là thứ buộc implementation
 * D1 phải cung cấp đúng những method mà một use case cần.
 *
 * ⚠️ **Guarded conditional write là một method riêng cho mỗi predicate, không phải tham số
 * `expectedStatus`.** Lý do là §5.6/§6.1/§8.1 của `01-architecture.md`: predicate phải nằm
 * trong **chính statement** ghi và thắng/thua quyết định bằng số hàng **thật sự** đổi
 * (`docs/architecture/04-platform-facts.md` DB3). Một method `updateStatus(id, from, to)` có
 * vẻ tổng quát hơn nhưng đẩy việc viết predicate xuống tầng gọi — chỗ không có test nào
 * kiểm được statement đó. Ở đây mỗi method **là** một use case cụ thể, và tên method nói
 * rõ điều kiện thắng.
 *
 * Mọi mốc thời gian trong port là epoch millis `number`; application đọc đồng hồ **một
 * lần** qua `PushClock` rồi truyền xuống (không có `Date.now()` trong use case).
 */

import type {
  AppVapidKeyRef,
  DeliveryStatus,
  ProviderRoutingFact,
  ProviderStatus,
  ProviderType,
  SubscriptionStatus,
  Transport,
} from '@ecoma-io/push-notification-domain';
import type {
  AuditEvent,
  CreateOutboxIntentInput,
  DecryptedProviderCredential,
  DeliveryRecord,
  DeviceRecord,
  IdempotencyRecord,
  NotificationRecord,
  OutboxRecord,
  PersistNotificationInput,
  ProviderCredentialRecord,
  ProviderRecord,
  RoutingPolicyRecord,
  SubscriptionRecord,
} from './records';

/* -------------------------------------------------------------------------------------- */
/* Đồng hồ                                                                                   */
/* -------------------------------------------------------------------------------------- */

/**
 * Nguồn thời gian duy nhất của application.
 *
 * ⚠️ Vì sao cần một port thay vì `Date.now()`: `01-architecture.md` §8.1 yêu cầu `now` được
 * xác định **một lần** cho mỗi claim và dùng nguyên giá trị đó cho cả predicate lẫn
 * `lease_expires_at := now + lease_duration`. Hai lần đọc đồng hồ trong một claim là một
 * claim có thể vừa thắng vừa vi phạm guard của chính nó — lỗi không thể tái hiện, chỉ thấy
 * được dưới tải. Port này cho phép test tiêm một đồng hồ cố định và **đếm số lần đọc**.
 */
export interface PushClock {
  /** Epoch millis. Use case gọi **đúng một lần** mỗi lần xử lý một request. */
  now(): number;
}

/* -------------------------------------------------------------------------------------- */
/* Queue                                                                                     */
/* -------------------------------------------------------------------------------------- */

/**
 * Producer của Queue `ecoma-push-delivery` — **một** method, đúng một chỗ gọi
 * `send()` trong toàn bộ control plane (`01-architecture.md` §6.2).
 *
 * ⚠️ `send()` **không** được phép nằm trong `db.batch()`: publish là ranh giới bất đồng
 * bộ **sau** khi transaction đã commit, và crash window giữa hai bước là thứ thiết kế
 * chấp nhận (duplicate publish được chấp nhận, mất message thì không).
 */
export interface QueuePublisher {
  /**
   * Publish một envelope `DeliveryCommandV1`.
   *
   * Trả `true` khi `Queue.send()` trả về thành công, `false` khi thất bại. **Không** ném:
   * một lần publish lỗi là một kết quả bình thường cần đưa vào backoff (`attempts` /
   * `available_at`, §6.2), không phải exception làm hỏng cả lô claim.
   */
  send(message: unknown): Promise<boolean>;
}

/* -------------------------------------------------------------------------------------- */
/* Credential cipher                                                                          */
/* -------------------------------------------------------------------------------------- */

/**
 * Mã hoá at rest cho provider credential (FR-006, `01-architecture.md` §9 loại secret 1).
 *
 * ⚠️ Interface này **không** đặt tên thuật toán: đó là quyết định của infrastructure
 * (WebCrypto AES-256-GCM), còn application chỉ cần biết "mã hoá với version nào" để ghi
 * `credential_encryption_version` và "giải mã theo version của record" để đọc lại — hai
 * điều kiện bắt buộc của multi-key rotation `K1 → K2` (`03-operations.md` §7.3).
 */
export interface CredentialCipher {
  /** Bản mã mới kèm version của root key đã dùng. Không bao giờ trả plaintext. */
  encrypt(
    plaintext: string,
  ): Promise<{ readonly ciphertext: Uint8Array; readonly version: string }>;

  /**
   * Giải mã theo **version ghi trên record**.
   *
   * Không có `defaultVersion`: một record mã hoá bằng `K1` phải luôn đọc bằng `K1`, kể cả
   * sau khi `K2` thành current — nếu không thì toàn bộ credential cũ mất khả năng ký VAPID
   * ngay lúc rotation, đúng kịch bản `§7.2` cấm.
   */
  decrypt(ciphertext: Uint8Array, version: string): Promise<string>;
}

/* -------------------------------------------------------------------------------------- */
/* Digest payload (optional — §8.1 `payload_digest`)                                          */
/* -------------------------------------------------------------------------------------- */

/**
 * Tính `payload_digest` cho response `200` của claim (`01-architecture.md` §8.1).
 *
 * ⚠️ `payload_digest` là **optional** trong contract vì thuật toán digest là open item
 * (`payload_digest_algorithm` — launch gate, `03-operations.md` §11). Vì vậy hàm này trả
 * `null` khi thuật toán cấu hình không dùng được, và use case **bỏ trống** field thay vì
 * ghi một giá trị bịa. Worker đối chiếu khi có, và `MUST NOT` từ chối response thiếu digest.
 */
export interface PayloadDigester {
  digest(canonicalPayload: string): Promise<string | null>;
}

/* -------------------------------------------------------------------------------------- */
/* Rate limit (FR-021)                                                                        */
/* -------------------------------------------------------------------------------------- */

/** Kết quả một lần thử tiêu slot rate limit. */
export interface RateLimitOutcome {
  readonly allowed: boolean;
  /** Cửa sổ hiện tại kết thúc lúc nào — dùng cho `Retry-After`. `null` khi bị từ chối. */
  readonly retryAfterMs: number | null;
}

/**
 * Counter rate limit theo `App` (FR-021).
 *
 * ⚠️ **`consume` là một lệnh, không phải "kiểm rồi tăng".** Lý do: hai request đồng thời có
 * thể cùng đọc "còn 1 slot" rồi cùng tiêu — đúng loại read-then-write mà §5.6 cấm ở claim và
 * §6.1 yêu cầu thay bằng guard ở D1 cho outbox. Implementation bắt buộc ghi bằng một
 * conditional upsert để việc "vượt ngưỡng" là kết quả của **câu lệnh**.
 */
export interface RateLimitStore {
  consume(input: RateLimitConsumeInput): Promise<RateLimitOutcome>;
}

export interface RateLimitConsumeInput {
  /** Scope **duy nhất** là `App` (FR-021) — lấy từ authenticated principal, không phải IP. */
  readonly app: string;
  /** Số request tối đa trong một cửa sổ. Tham số cấu hình, không phải constraint schema. */
  readonly limit: number;
  readonly windowDurationMs: number;
  readonly now: number;
}

/* -------------------------------------------------------------------------------------- */
/* Repository: Device (FR-002, FR-011)                                                       */
/* -------------------------------------------------------------------------------------- */

export interface DeviceRepository {
  /**
   * Tra một device theo `device_id`.
   *
   * ⚠️ **Không** lọc theo `app`: các đường của delivery runtime API tra theo định danh
   * duy nhất (§8.1: "Lookup theo `delivery_id` duy nhất"), và lọc `app` ở đây sẽ khiến một
   * lookup có app không khớp trả về "không tồn tại" — tức phân biệt được với "tồn tại ở
   * App khác", đúng loại tiết lộ mà `401`/`404` của runtime API cấm. Use case kiểm `app`
   * trên record trả về khi nó đã biết app là hợp lệ.
   */
  findById(deviceId: string): Promise<DeviceRecord | null>;

  /** Toàn bộ device của một `(app, user_id)` — bước "resolve users → devices" của §5.5. */
  listByUser(app: string, userId: string): Promise<readonly DeviceRecord[]>;

  insert(device: DeviceRecord, displayName: string | null): Promise<DeviceRecord>;
}

/* -------------------------------------------------------------------------------------- */
/* Repository: Subscription (FR-003, FR-004)                                                 */
/* -------------------------------------------------------------------------------------- */

/** Tham số đăng ký/update subscription — đã qua endpoint validation của FR-003. */
export interface UpsertSubscriptionInput {
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
  readonly now: number;
}

export interface SubscriptionRepository {
  /**
   * Tra một subscription theo `subscription_id` — **không** lọc `app`, xem lý do ở
   * `DeviceRepository.findById`. `app` được kiểm trên record trả về bởi use case.
   */
  findById(subscriptionId: string): Promise<SubscriptionRecord | null>;

  /**
   * Endpoint là khoá chống trùng (FR-003: "tránh tạo subscription trùng không cần thiết").
   * Tra theo `endpoint_hash` vì `endpoint` là chuỗi dài và schema enforce unique trên hash.
   */
  findByEndpointHash(endpointHash: string): Promise<SubscriptionRecord | null>;

  /**
   * Chỉ mọi subscription của một device thuộc **đúng** `app` — FR-011: không có tham số
   * `userId` nào tham gia, nên không có đường code nào coi hai subscription cùng user là
   * cùng một device.
   */
  listByDevice(app: string, deviceId: string): Promise<readonly SubscriptionRecord[]>;

  /** Danh sách quản trị theo `App` (inspect — FR-017). */
  listByApp(app: string, filter: SubscriptionListFilter): Promise<readonly SubscriptionRecord[]>;

  /**
   * Chỉ số `push_subscriptions_vapid_key_idx` phục vụ điều kiện **bắt buộc** trước khi
   * retire một VAPID key (`03-operations.md` §7.2): chỉ retire khi không còn subscription
   * `active` nào tham chiếu.
   */
  countActiveByVapidKeyId(app: string, vapidKeyId: string): Promise<number>;

  /** Đăng ký mới. `endpoint_hash` trùng bị D1 từ chối bằng unique constraint. */
  insert(input: UpsertSubscriptionInput): Promise<SubscriptionRecord>;

  /**
   * Rotate secret của một subscription **đã `disabled`** trở lại `active`.
   *
   * ⚠️ Guard nằm trong statement (`status = 'disabled'`): FR-004 không có đường hồi sinh
   * tự động, nên chỉ một update secret **tường minh** của client mới được đưa subscription về
   * `active`, và nó phải là một lệnh có điều kiện để hai request trùng không cùng thắng.
   */
  reactivateWithNewSecret(input: UpsertSubscriptionInput): Promise<SubscriptionRecord | null>;

  /** Chuyển `active → disabled` với nguyên nhân FR-004. Idempotent trên `disabled`. */
  disableById(input: DisableSubscriptionInput): Promise<SubscriptionRecord | null>;
}

export interface SubscriptionListFilter {
  readonly userId?: string;
  readonly deviceId?: string;
  readonly status?: SubscriptionStatus;
  readonly limit: number;
}

/**
 * Input của `disableById`.
 *
 * `cause` nằm trong `UPDATE` chứ không nằm trong `SELECT`: một subscription `disabled` bởi
 * `provider_invalidation` rồi tới `admin_disable` phải **giữ** nguyên nguyên nhân đầu
 * (nguyên nhân đầu là thứ giải thích vì sao endpoint chết), nên predicate là
 * `status = 'active'` cho lần ghi và `disabled` trả `changed = false`.
 */
export interface DisableSubscriptionInput {
  readonly app: string;
  readonly subscriptionId: string;
  readonly cause:
    | 'user_unregister'
    | 'admin_disable'
    | 'provider_invalidation'
    | 'endpoint_revalidation_failed';
  readonly now: number;
}

/* -------------------------------------------------------------------------------------- */
/* Repository: Provider (FR-005, FR-007)                                                     */
/* -------------------------------------------------------------------------------------- */

export interface ProviderRepository {
  /** Tra một provider theo `provider_id` — không lọc `app`, xem `DeviceRepository.findById`. */
  findById(providerId: string): Promise<ProviderRecord | null>;

  /**
   * **Mọi** provider của `(app, transport)` — `selectPrimaryProvider` cần danh sách đầy đủ
   * để phát hiện `ambiguous` (FR-005: fail safely, `MUST NOT` chọn theo thứ tự database).
   * Trả cả provider `disabled` và đang hold: chúng là ứng viên **không** eligible, và việc
   * đưa chúng ra khỏi danh sách ở tầng query là read-then-decide.
   */
  listByScope(app: string, transport: Transport): Promise<readonly ProviderRoutingFact[]>;

  /** Provider của một `App` cho đường list quản trị (FR-017). */
  listByApp(app: string, limit: number): Promise<readonly ProviderRecord[]>;

  /** Provider đang emergency hold — câu hỏi đầu tiên của runbook §15.7. */
  listHeld(app: string): Promise<readonly ProviderRecord[]>;

  insert(provider: NewProviderInput): Promise<ProviderRecord>;

  /** Đổi `name`/`configuration`. Không đụng `status`/`emergencyHold`/`isPrimary`. */
  updateConfiguration(input: UpdateProviderConfigurationInput): Promise<ProviderRecord | null>;

  /**
   * `disabled → enabled` / `enabled → disabled`, guard bằng state hiện tại.
   *
   * ⚠️ Enable **không** tự làm provider thành primary: `is_primary` thuộc về
   * `push_app_provider_mappings` và được tuyên bố bằng method riêng. Gộp hai việc làm một
   * admin "enable" hiểu nhầm là đã thay primary của scope.
   */
  setStatus(input: SetProviderStatusInput): Promise<ProviderRecord | null>;

  /**
   * Emergency hold — trục **độc lập** với `status` (`03-operations.md` §6.5): hold giữ nguyên
   * `status` nhưng làm delivery đã materialize không eligible tới claim (§8.1 predicate).
   */
  setEmergencyHold(input: SetProviderHoldInput): Promise<ProviderRecord | null>;

  /**
   * Tuyên bố primary cho `(app, transport)` — **thay thế**, trong **một** `db.batch()`.
   *
   * ⚠️ Đây là chỗ duy nhất được phép tuyên bố primary, và **guard thật** là partial unique
   * index `push_app_provider_mappings_one_primary` trong schema — hai admin tuyên bố primary
   * cho cùng scope chạy đồng thời thì lệnh thứ hai bị D1 từ chối, không phải một kiểm
   * read-then-write ở đây.
   *
   * ⚠️ **Vì sao xoá mapping cũ nằm trong cùng method chứ không phải một method riêng.**
   * Tách thành `clearPrimaryMapping` rồi `setPrimaryMapping` là **hai transaction**, và
   * giữa chúng scope không có primary — routing trong khoảng đó fail-safe thành
   * `no_provider` cho một scope vốn đang phục vụ tốt. D1 không có `BEGIN/COMMIT` tường minh
   * (`docs/architecture/04-platform-facts.md` DB2), nên `db.batch()` là ranh giới atomic duy
   * nhất, và nó phải bao **cả hai** lệnh.
   */
  setPrimaryMapping(input: SetPrimaryMappingInput): Promise<ProviderMappingRecord | null>;

  /**
   * Mapping primary hiện tại của `(app, transport)` — đường **đọc** cho Admin API hiển thị
   * cấu hình scope. Trả `null` khi scope chưa có primary, tức routing sẽ fail-safe; đó là một
   * trạng thái **hợp lệ** phải hiển thị được, không phải lỗi cần che.
   */
  findPrimaryMapping(app: string, transport: Transport): Promise<ProviderMappingRecord | null>;

  /**
   * VAPID key mà `App` còn phục vụ — **tập**, không phải một key (FR-006: trong lúc rotation
   * runtime resolution phải trả được credential cho mọi `vapid_key_id` còn được subscription
   * `active` tham chiếu).
   */
  listAppVapidKeys(app: string): Promise<readonly AppVapidKeyRef[]>;
}

export interface NewProviderInput {
  readonly providerId: string;
  readonly app: string;
  readonly transport: Transport;
  readonly type: ProviderType;
  readonly name: string;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly now: number;
}

export interface UpdateProviderConfigurationInput {
  readonly app: string;
  readonly providerId: string;
  readonly name: string;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly now: number;
}

export interface SetProviderStatusInput {
  readonly app: string;
  readonly providerId: string;
  readonly status: ProviderStatus;
  readonly expected: ProviderStatus;
  readonly now: number;
  /** Khi `status === 'enabled'`, predicate kèm `emergency_hold` phải khớp giá trị này (mặc định `false`). */
  readonly emergencyHold?: boolean;
}

export interface SetProviderHoldInput {
  readonly app: string;
  readonly providerId: string;
  readonly hold: boolean;
  readonly now: number;
}

export interface SetPrimaryMappingInput {
  readonly mappingId: string;
  readonly app: string;
  readonly transport: Transport;
  readonly providerId: string;
  readonly now: number;
}

export interface ProviderMappingRecord {
  readonly mappingId: string;
  readonly app: string;
  readonly transport: Transport;
  readonly providerId: string;
  readonly isPrimary: boolean;
}

/* -------------------------------------------------------------------------------------- */
/* Repository: Provider credential (FR-006)                                                  */
/* -------------------------------------------------------------------------------------- */

export interface ProviderCredentialRepository {
  /**
   * Credential **còn mã hoá** theo `(provider_id, vapid_key_id)`.
   *
   * ⚠️ Khoá lookup là `vapid_key_id` **của subscription** (FR-006, §8.1), không phải "key
   * hiện tại của App". Vì thế `app` có mặt trong record và được kiểm: một caller tra nhầm
   * bảng credential của `App` khác sẽ không resolve được, thay vì nhận về một key hợp lệ về
   * hình thức và ký bằng key của `App` khác — hỏng delivery không có lỗi nổi lên.
   */
  findByVapidKeyId(
    app: string,
    providerId: string,
    vapidKeyId: string,
  ): Promise<ProviderCredentialRecord | null>;

  listByProvider(app: string, providerId: string): Promise<readonly ProviderCredentialRecord[]>;

  /**
   * Tập `credential_encryption_version` đang được dùng — điều kiện cho
   * `canRetireEncryptionKey` (`FR-006`: `MUST NOT` retire `K1` khi còn record `K1`).
   */
  listEncryptionVersionsInUse(): Promise<readonly string[]>;

  /** Số subscription `active` của App còn tham chiếu `vapid_key_id` (§7.2). */
  countActiveSubscriptionReferences(app: string, vapidKeyId: string): Promise<number>;

  insert(credential: NewProviderCredentialInput): Promise<ProviderCredentialRecord>;

  /** Đổi vòng đời `active → retired` / `active → compromised` (FR-006, §7.2). */
  setStatus(input: SetCredentialStatusInput): Promise<ProviderCredentialRecord | null>;
}

export interface NewProviderCredentialInput {
  readonly credentialId: string;
  readonly providerId: string;
  readonly app: string;
  readonly vapidKeyId: string;
  readonly publicKey: string;
  readonly credentialCiphertext: Uint8Array;
  readonly credentialEncryptionVersion: string;
  readonly now: number;
}

export interface SetCredentialStatusInput {
  readonly app: string;
  readonly credentialId: string;
  readonly status: 'retired' | 'compromised';
  readonly expected: 'active';
  readonly now: number;
}

/* -------------------------------------------------------------------------------------- */
/* Repository: Notification + Delivery + Outbox — batch của FR-013                            */
/* -------------------------------------------------------------------------------------- */

/**
 * Ghi **một** notification: notification + deliveries + outbox intents + idempotency record
 * trong **cùng một** `db.batch()` (FR-013, `01-architecture.md` §6).
 *
 * ⚠️ Vì sao đây là **một** method chứ không phải bốn: "idempotency record phải nằm trong
 * cùng batch" (FR-008) và "outbox intent phải nằm trong cùng batch" (§6.1) là hai ràng buộc
 * **về hình dạng lời gọi**. Tách thành bốn method là cho phép một lời gọi thiếu idempotency
 * record — tức một notification không có dedupe, đúng cửa sổ mà tài liệu nêu là phải không
 * tồn tại. Một tham số duy nhất làm việc đó không biểu diễn được.
 */
export interface NotificationRepository {
  /** Persist atomically toàn bộ phần của một notification. */
  persistNotificationWithDeliveries(input: PersistNotificationInput): Promise<void>;

  /**
   * Tra một notification theo `notification_id` — không lọc `app`, xem
   * `DeviceRepository.findById`. Publisher cần nó để đọc `payload_json` mà không phải đi
   * qua `app` mà `push_outbox` cố ý không lưu.
   */
  findById(notificationId: string): Promise<NotificationRecord | null>;

  /**
   * Notification của một `App` cho đường list quản trị (FR-017 inspect).
   *
   * ⚠️ Trả về **projection không có `payloadJson`**: Admin list không được phát ra payload của
   * application. Xem `admin-delivery.ts` `listNotifications`.
   */
  listByApp(
    app: string,
    limit: number,
  ): Promise<readonly Omit<NotificationRecord, 'payloadJson'>[]>;
}

/** Input của `claimDelivery` — predicate nằm trong chính statement (FR-015, §8.1). */
export interface ClaimDeliveryInput {
  readonly deliveryId: string;
  /** `now` **đã** xác định một lần cho cả predicate lẫn `lease_expires_at` (§8.1). */
  readonly now: number;
  readonly leaseDurationMs: number;
}

export interface DeliveryRepository {
  /**
   * **Guarded conditional write** của claim — `UPDATE … WHERE … RETURNING`.
   *
   * Predicate đầy đủ nằm trong statement (§8.1): `expires_at > now` và
   * `(status = 'queued' OR (status = 'processing' AND lease_expires_at <= now))` cộng hai
   * `EXISTS` cho subscription `active` và provider **không** emergency hold. `dispatch_generation`
   * tăng **trong cùng statement**; `provider.status` **không** nằm trong predicate vì FR-005
   * nói delivery đã materialize vẫn claim được khi provider `disabled`.
   *
   * Trả `null` khi `meta.changes == 0` (thua). Kết quả thua **không** ghi gì: cột
   * `dispatch_generation` của hàng phải giữ nguyên giá trị của execution đang giữ lease.
   */
  claimDelivery(input: ClaimDeliveryInput): Promise<DeliveryRecord | null>;

  /**
   * Lần **đọc chẩn đoán** sau khi claim thua, theo thứ tự cố định của §8.1.
   *
   * ⚠️ Lời gọi này **chỉ** đặt tên lý do cho `409`; nó không bao giờ là nguồn quyết định
   * thắng/thua. Không có đường code nào ghi dựa trên kết quả của nó.
   *
   * ⚠️ `diagnosedAt` là **cùng** `now` mà claim vừa dùng, truyền vào từ use case chứ không
   * lấy lại trong repository. Lấy thời gian ở tầng lưu trữ sẽ cho phép một thời điểm khác
   * với thời điểm predicate, và một delivery vừa chuyển `queued` giữa hai mốc đó sẽ ra hai
   * `reason` khác nhau cho **cùng một** request.
   */
  findClaimDiagnostics(
    deliveryId: string,
    diagnosedAt: number,
  ): Promise<DeliveryClaimDiagnostics | null>;

  /** Release lease (`processing → queued`, generation **không** đổi — §8.1). */
  releaseLease(input: ReleaseLeaseInput): Promise<DeliveryRecord | null>;

  /** Ghi outcome `delivered`/`failed` với fencing token (`processing` + lease còn hiệu lực). */
  recordOutcome(input: RecordOutcomeInput): Promise<DeliveryRecord | null>;

  /**
   * `non-terminal → expired` của reconciliation (a1). Guard `status IN
   * ('pending','queued','processing')` nằm trong statement — terminal state không bị đụng
   * (a6), và không có đường nào hồi sinh terminal (invariant §17.19).
   */
  markExpired(input: MarkDeliveryExpiredInput): Promise<DeliveryRecord | null>;

  /**
   * Administrative retry `failed → queued` + **generation mới** (`03-operations.md` §4.3).
   * Guard: `status = 'failed'` — đây là transition duy nhất rời terminal state.
   */
  retryFailed(input: RetryFailedDeliveryInput): Promise<DeliveryRecord | null>;

  /** Tra một delivery theo `delivery_id` — không lọc `app`, xem `DeviceRepository.findById`. */
  findById(deliveryId: string): Promise<DeliveryRecord | null>;

  /**
   * Delivery non-terminal quá ngưỡng tuổi — nguồn quét của reconciliation (c) (§4.2).
   *
   * ⚠️ `limit` bắt buộc: một lượt quét không giới hạn sẽ giữ một D1 transaction mở tới hết
   * đời request trên một bảng có thể có hàng triệu delivery mắc kẹt.
   */
  listAgedNonTerminal(input: ListAgedNonTerminalInput): Promise<readonly DeliveryRecord[]>;

  /** Notification của delivery — publisher cần `payload_json` để dựng envelope (§6.3). */
  findNotificationPayload(notificationId: string): Promise<NotificationRecord | null>;

  /** List quản trị (FR-017 inspect delivery). */
  listByApp(app: string, filter: DeliveryListFilter): Promise<readonly DeliveryRecord[]>;
}

/**
 * Dữ liệu cho lần đọc chẩn đoán của claim.
 *
 * Gom **cả** điều kiện của `decideDeliveryClaim` vào một lần đọc: nếu repository trả về
 * từng field bằng nhiều query thì "đọc chẩn đoán" biến thành read-then-decide với nhiều cửa
 * sổ, và `reason` được báo có thể không khớp state mà một nhánh khác sẽ thấy.
 */
export interface DeliveryClaimDiagnostics {
  readonly delivery: DeliveryRecord;
  readonly subscriptionStatus: SubscriptionStatus;
  readonly providerStatus: ProviderStatus;
  readonly providerEmergencyHold: boolean;
}

export interface ReleaseLeaseInput {
  readonly deliveryId: string;
  /** Fencing token execution đang giữ — guard bắt buộc của §8.1. */
  readonly dispatchGeneration: number;
  readonly now: number;
}

export interface RecordOutcomeInput {
  readonly deliveryId: string;
  readonly dispatchGeneration: number;
  /** Chỉ `delivered`/`failed` — `expired`/`cancelled` thuộc control plane (FR-015). */
  readonly outcome: 'delivered' | 'failed';
  readonly now: number;
}

export interface MarkDeliveryExpiredInput {
  readonly deliveryId: string;
  readonly now: number;
}

export interface RetryFailedDeliveryInput {
  readonly deliveryId: string;
  /** Generation **mới** do domain tính; guard của statement là `status = 'failed'`. */
  readonly dispatchGeneration: number;
  readonly now: number;
}

export interface ListAgedNonTerminalInput {
  /** Ngưỡng tuổi lấy từ `delivery_reconciliation_age` (SLA — cấu hình bắt buộc). */
  readonly olderThan: number;
  readonly now: number;
  readonly limit: number;
}

export interface DeliveryListFilter {
  readonly notificationId?: string;
  readonly userId?: string;
  readonly status?: DeliveryStatus;
  readonly limit: number;
}

/* -------------------------------------------------------------------------------------- */
/* Repository: Outbox (§6.1, §6.2)                                                           */
/* -------------------------------------------------------------------------------------- */

export interface OutboxRepository {
  /**
   * Claim một lô record đến hạn bằng **một** guarded conditional write: predicate
   * `status = 'pending' AND available_at <= now OR (status = 'publishing' AND
   * lease_expires_at <= now)` nằm trong statement, thắng/thua theo số hàng thật sự đổi
   * (§6.1). `failed` **không** claimable — chỉ operator đưa nó về đường publish.
   */
  claimDue(input: ClaimDueOutboxInput): Promise<readonly ClaimedOutboxRecord[]>;

  findById(outboxId: string): Promise<OutboxRecord | null>;

  /**
   * Đóng outbox record **và** (tuỳ §6.2) đặt delivery `pending → queued` trong **cùng một**
   * `db.batch()`.
   *
   * ⚠️ `deliveryWrite` là một union do `applyPublisherSuccess` của domain quyết định, không
   * phải một `status` tùy ý: chỉ khi delivery **vẫn** `pending` mới được ghi `queued`. Đã
   * rời `pending` thì chỉ ghi outbox — publish đã thật sự xảy ra nên record không được retry
   * vô hạn, và terminal state **không** được hồi sinh.
   *
   * Trả `null` khi lease đã mất (`claimed_by`/lease hết hạn) — **không ghi gì cả**: một
   * publisher không còn giữ claim thì `MUST NOT` ghi.
   */
  applyPublisherSuccess(input: ApplyPublisherSuccessInput): Promise<OutboxRecord | null>;

  /**
   * Ghi thất bại publish: tăng `attempts`, đẩy `available_at` theo backoff, xoá lease, về
   * `pending` — hoặc `failed` khi chạm `maxPublishAttempts` (§6.2). `last_error` chỉ chứa
   * lỗi **đã sanitize**: cột này không nhận response body của provider, endpoint hay secret.
   */
  recordPublishFailure(input: RecordPublishFailureInput): Promise<OutboxRecord | null>;

  /**
   * Tạo **một** outbox intent cho `delivery_id`.
   *
   * ⚠️ Guard thật là partial unique index `push_outbox_one_open_intent`, không phải kiểm ở
   * đây: hai reconciler (hoặc hai lời gọi admin) chạy đồng thời đều có thể cùng đọc "chưa
   * có intent nào" rồi cùng tạo. Implementation **MUST** dùng `INSERT OR IGNORE`-hoặc-tương
   * đương để lỗi unique không nổi thành lỗi cần alert.
   */
  createIntent(input: CreateOutboxIntentInput): Promise<OutboxRecord | null>;

  /** Có intent `pending`/`publishing` cho `delivery_id` — precondition của republish. */
  hasOpenIntent(deliveryId: string): Promise<boolean>;

  /** Số intent open — đầu vào của `canCreateOutboxIntent` (domain). */
  countOpenIntents(deliveryId: string): Promise<number>;

  /** Record `pending`/`publishing` quá hạn — nguồn quét của outbox reconciliation (a). */
  listAgedOpen(input: ListAgedOutboxInput): Promise<readonly OutboxRecord[]>;

  /** Record `failed` — quét cho operator, không tự phục hồi (§4.2 a3). */
  listFailed(limit: number): Promise<readonly OutboxRecord[]>;
}

export interface ClaimDueOutboxInput {
  readonly now: number;
  readonly leaseDurationMs: number;
  /** Token định danh lease; mọi write sau đó đều mang nó, nên lease bị mất thì write bị chặn. */
  readonly claimedBy: string;
  readonly limit: number;
}

export interface ClaimedOutboxRecord {
  readonly record: OutboxRecord;
  readonly leaseExpiresAt: number;
}

export interface ApplyPublisherSuccessInput {
  readonly outboxId: string;
  readonly deliveryId: string;
  readonly claimedBy: string;
  /** Kết quả `applyPublisherSuccess` của domain — union, không phải status tùy ý. */
  readonly deliveryWrite:
    | { readonly kind: 'advance_to_queued' }
    | { readonly kind: 'keep_delivery_status' };
  readonly now: number;
}

export interface RecordPublishFailureInput {
  readonly outboxId: string;
  readonly claimedBy: string;
  readonly maxAttempts: number;
  /** Backoff cho lần thử kế tiếp; record `failed` sẽ bỏ qua backoff này. */
  readonly backoffMs: number;
  readonly sanitizedError: string;
  readonly now: number;
}

export interface ListAgedOutboxInput {
  readonly olderThan: number;
  readonly now: number;
  readonly limit: number;
}

/* -------------------------------------------------------------------------------------- */
/* Repository: Idempotency (FR-008)                                                          */
/* -------------------------------------------------------------------------------------- */

export interface IdempotencyRepository {
  /**
   * Tra idempotency record theo scope **đầy đủ** `(app, principal_id, idempotency_key)`
   * (FR-008). `principal_id` là định danh ổn định của caller **đã xác thực**, không phải giá
   * trị header tự khai.
   */
  find(app: string, principalId: string, idempotencyKey: string): Promise<IdempotencyRecord | null>;

  /**
   * Cleanup idempotency record theo **đúng ba điều kiện canonical của FR-008** (điều kiện
   * nằm **trong** statement — guarded conditional write, Invariant B), trả về số record bị xoá:
   *   (i) không còn delivery non-terminal nào của notification đó;
   *   (ii) không còn outbox record `pending`/`publishing` nào cho bất kỳ delivery nào của
   *        notification đó;
   *   (iii) `now > created_at + retentionMs`.
   * Thiếu bất kỳ điều kiện nào → giữ. Idempotent: gọi lại không xoá thêm gì.
   */
  deleteEligible(input: {
    readonly now: number;
    readonly retentionMs: number;
    readonly limit: number;
  }): Promise<number>;
}

/* -------------------------------------------------------------------------------------- */
/* Repository: Audit (FR-020)                                                                */
/* -------------------------------------------------------------------------------------- */

/**
 * Ghi audit record.
 *
 * ⚠️ `detail` là **JSON object của mã/scope**, không phải mô tả tự do: audit không được chứa
 * secret (FR-020, SR-005) và không được chứa payload/endpoint. Vì vậy kiểu là
 * `Record<string, string | number | boolean>` — không có chỗ cho một mảng payload lọt vào mà
 * không bị type chặn.
 */
export interface AuditRepository {
  append(record: AuditRecordInput): Promise<void>;
}

export interface AuditRecordInput {
  readonly auditId: string;
  readonly event: AuditEvent;
  /** Principal đã xác thực (admin/operator/application) — không phải header tự khai. */
  readonly actor: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly detail: Readonly<Record<string, string | number | boolean>>;
  readonly now: number;
}

/* -------------------------------------------------------------------------------------- */
/* Repository: Routing policy (§5.5, FR-008 fan-out limit)                                    */
/* -------------------------------------------------------------------------------------- */

export interface RoutingPolicyRepository {
  /**
   * Policy của `App`. Trả `null` khi chưa có hàng — use case áp **mặc định tài liệu**
   * (`app > web`, `max_deliveries_per_notification = 100`) chứ không từ chối: một `App` mới
   * chưa cấu hình phải gửi được notification.
   */
  find(app: string): Promise<RoutingPolicyRecord | null>;
}

/* -------------------------------------------------------------------------------------- */
/* Bundle port: toàn bộ dependency của một use case                                           */
/* -------------------------------------------------------------------------------------- */

/**
 * Gói port mà composition root dựng **một lần** rồi truyền cho các use case.
 *
 * ⚠️ Vì sao gom: các method của use case đều cần cùng một bộ dependency, và một tham số
 * dài 12 thành phần cho mỗi method là cách để một use case quên truyền repository mà
 * typecheck không bắt được (tham số truyền thiếu thì vẫn đúng kiểu).
 */
export interface PushNotificationPorts {
  readonly clock: PushClock;
  readonly queue: QueuePublisher;
  readonly credentialCipher: CredentialCipher;
  readonly payloadDigester: PayloadDigester;
  readonly rateLimit: RateLimitStore;
  readonly devices: DeviceRepository;
  readonly subscriptions: SubscriptionRepository;
  readonly providers: ProviderRepository;
  readonly providerCredentials: ProviderCredentialRepository;
  readonly notifications: NotificationRepository;
  readonly deliveries: DeliveryRepository;
  readonly outbox: OutboxRepository;
  readonly idempotency: IdempotencyRepository;
  readonly audit: AuditRepository;
  readonly routingPolicy: RoutingPolicyRepository;
}

/** Giải mã credential thành dạng đưa vào `deliveryClaim` — dùng chung cho claim và provider test. */
export type ResolveProviderCredential = (
  app: string,
  providerId: string,
  vapidKeyId: string,
) => Promise<DecryptedProviderCredential | null>;
