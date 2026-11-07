/**
 * Push Provider: vocabulary, scope và mức độ đủ điều kiện nhận routing mới.
 *
 * Source of truth:
 * - `docs/applications/push-notification/02-requirements.md` FR-005 (mỗi `App` +
 *   `Transport` chỉ có **đúng một** active primary provider; nhiều provider mà
 *   không xác định được primary → routing **fail safe**, **MUST NOT** chọn random
 *   hay theo thứ tự database; `disabled` chỉ dừng **routing delivery mới**, delivery
 *   đã materialize tiếp tục xử lý; chỉ **emergency hold/revoke** mới làm delivery
 *   không eligible), FR-007 (scope theo `App`; không ambiguity trong v1).
 * - `docs/applications/push-notification/01-architecture.md` §4.2 (`ProviderType` là
 *   khái niệm **khác** `Transport`), §8.1 (claim reason `ineligible_provider_hold`).
 * - `docs/applications/push-notification/03-operations.md` §6.3, §6.5 (hold là emergency
 *   control, độc lập với `status`; release không tự chuyển subscription).
 *
 * Quyết định domain suy ra:
 * - `disabled` và `emergencyHold` là **hai trục độc lập**. Gộp chúng thành một
 *   trường "status" là sai semantics: `disabled` ngăn routing mới nhưng delivery đã
 *   materialize vẫn chạy tới cùng; `emergencyHold` làm claim ineligible ngay cả khi
 *   delivery đã có `provider_id`. Vì vậy eligibility trả về reason phân biệt
 *   `provider_disabled` với `provider_hold`.
 * - Ambiguity (hai provider cùng `App` + `Transport` cùng enabled và cùng primary)
 *   được mô hình hoá thành kết quả **fail-safe** `'ambiguous'`: hàm không nhận
 *   collection có thứ tự và không bao giờ trả "provider đầu tiên". Chọn theo thứ tự
 *   tự nhiên của một danh sách chính là "chọn theo thứ tự database" mà FR-005 cấm.
 */

import {
  type DomainOk,
  type DomainRejection,
  isNonEmptyString,
  isTransport,
  TRANSPORT,
  type Transport,
} from './shared';

/**
 * Giao thức gửi của provider — KHÁC `Transport`.
 *
 * `web-push` là provider type thuộc `Transport = web`, không bao giờ là một transport.
 */
export const PROVIDER_TYPE = {
  WebPush: 'web-push',
  Fcm: 'fcm',
  Apns: 'apns',
} as const;

export type ProviderType = (typeof PROVIDER_TYPE)[keyof typeof PROVIDER_TYPE];

export const PROVIDER_TYPE_VALUES: readonly ProviderType[] = [
  PROVIDER_TYPE.WebPush,
  PROVIDER_TYPE.Fcm,
  PROVIDER_TYPE.Apns,
];

export function isProviderType(value: unknown): value is ProviderType {
  return PROVIDER_TYPE_VALUES.includes(value as ProviderType);
}

/**
 * Provider type và transport chạy được trong v1 (NFR-010: `fcm`/`apns` được khai báo
 * upfront nhưng v1 chưa triển khai).
 *
 * ⚠️ **Đây là cửa chặn control-plane create/enable/make-primary + phòng thủ worker.**
 * Routing delivery mới **không** dùng hai hằng số này: routing chỉ quan tâm `status` +
 * scope + hold. Cổng chặn thật nằm ở `createProvider`/`setProviderStatus`/
 * `claimProviderPrimary` — một provider `fcm`/`apns` không được tạo, không được enable
 * và không được tuyên bố primary trong v1; worker vẫn giữ lớp phòng thủ thứ hai
 * (`validateV1ExecutionMaterialScope`) cho material đến từ nguồn khác.
 */
export const V1_EXECUTABLE_PROVIDER_TYPE: ProviderType = PROVIDER_TYPE.WebPush;
export const V1_EXECUTABLE_TRANSPORT: Transport = TRANSPORT.Web;

/**
 * Một provider có nằm trong scope thực thi của v1 không.
 *
 * ⚠️ Fail-closed: giá trị nào không nhận diện được (`isProviderType`/`isTransport` trả
 * `false`) thì **không** nằm trong scope v1. Lý do: một provider type lạ đọc từ DB là dữ liệu
 * ngoài vocabulary, và "cho qua rồi để worker chặn" là một lỗi hở ở tầng control plane.
 */
export function isV1ExecutableProviderScope(input: {
  readonly type: unknown;
  readonly transport: unknown;
}): boolean {
  return input.type === V1_EXECUTABLE_PROVIDER_TYPE && input.transport === V1_EXECUTABLE_TRANSPORT;
}

/**
 * Lifecycle status của provider (FR-005).
 */
export const PROVIDER_STATUS = {
  Enabled: 'enabled',
  Disabled: 'disabled',
} as const;

export type ProviderStatus = (typeof PROVIDER_STATUS)[keyof typeof PROVIDER_STATUS];

export const PROVIDER_STATUS_VALUES: readonly ProviderStatus[] = [
  PROVIDER_STATUS.Enabled,
  PROVIDER_STATUS.Disabled,
];

export function isProviderStatus(value: unknown): value is ProviderStatus {
  return PROVIDER_STATUS_VALUES.includes(value as ProviderStatus);
}

/**
 * Một provider như domain cần để quyết định routing: danh tính + scope + trạng thái
 * đủ điều kiện. Credential **không** nằm trong đây — domain không bao giờ chạm secret.
 */
export type ProviderRoutingFact = {
  readonly providerId: string;
  readonly app: string;
  readonly transport: Transport;
  readonly type: ProviderType;
  readonly status: ProviderStatus;
  /**
   * Cờ emergency hold/revoke (FR-017, `03-operations.md` §6.5). `true` nghĩa là
   * provider **giữ nguyên** `status` nhưng delivery không còn eligible để claim.
   */
  readonly emergencyHold: boolean;
};

/**
 * Lý do một provider không đủ điều kiện cho **routing delivery mới**.
 *
 * - `provider_disabled` — FR-005: dừng routing mới.
 * - `provider_hold` — emergency hold: khác `disabled`, và cũng chặn cả claim
 *   (`ineligible_provider_hold` ở `01-architecture.md` §8.1).
 */
export type ProviderIneligibilityReason = 'provider_disabled' | 'provider_hold';

export type ProviderRoutingEligibility =
  | DomainOk<{ readonly providerId: string }>
  | DomainRejection<
      ProviderIneligibilityReason | 'app_mismatch' | 'transport_mismatch' | 'malformed_provider'
    >;

/**
 * Provider có đủ điều kiện nhận **routing delivery mới** cho `(app, transport)` không.
 *
 * Thứ tự kiểm tra phản ánh mức độ nghiêm trọng: dữ liệu dị dạng → sai scope →
 * emergency hold (khẩn cấp nhất trong hai trạng thái) → `disabled`.
 *
 * Delivery **đã materialize** không đi qua hàm này: theo FR-005 nó giữ `provider_id`
 * và tiếp tục được xử lý kể cả khi provider `disabled`. Chỉ `emergencyHold` mới chạm
 * tới delivery đã materialize — và chạm ở tầng claim, không phải ở tầng routing.
 */
export function evaluateProviderRoutingEligibility(
  provider: ProviderRoutingFact | null | undefined,
  app: string,
  transport: Transport,
): ProviderRoutingEligibility {
  if (!provider) {
    return {
      ok: false,
      reason: 'malformed_provider',
      detail: 'Không có provider để đánh giá eligibility.',
    };
  }
  if (
    !isNonEmptyString(provider.providerId) ||
    !isNonEmptyString(provider.app) ||
    !isTransport(provider.transport) ||
    !isProviderType(provider.type) ||
    !isProviderStatus(provider.status) ||
    typeof provider.emergencyHold !== 'boolean'
  ) {
    return {
      ok: false,
      reason: 'malformed_provider',
      detail: 'Provider fact không đúng shape tối thiểu của domain.',
    };
  }
  if (provider.app !== app) {
    return {
      ok: false,
      reason: 'app_mismatch',
      detail: 'Provider thuộc app khác — FR-007 cấm dùng chéo app.',
    };
  }
  if (provider.transport !== transport) {
    return {
      ok: false,
      reason: 'transport_mismatch',
      detail: 'Provider phục vụ transport khác với transport đang route.',
    };
  }
  if (provider.emergencyHold) {
    return {
      ok: false,
      reason: 'provider_hold',
      detail: 'Provider đang emergency hold — delivery không eligible để claim.',
    };
  }
  if (provider.status === PROVIDER_STATUS.Disabled) {
    return {
      ok: false,
      reason: 'provider_disabled',
      detail: 'Provider disabled — không nhận routing delivery mới.',
    };
  }
  return { ok: true, providerId: provider.providerId };
}

/**
 * Kết quả chọn provider primary cho `(app, transport)`.
 *
 * `ambiguous` là kết quả **thành công về mặt từ chối**: nó là fail-safe bắt buộc,
 * không phải lỗi lập trình. Không có nhánh nào trả về "provider đầu tiên".
 *
 * Vocabulary reason tách đôi theo **nguồn của lỗi**: `malformed_provider` là dữ liệu
 * provider sai shape (row DB/input bên ngoài), còn `malformed_selector` là **tham số
 * của caller** sai (app rỗng/transport ngoài vocabulary). Gộp hai loại vào một reason
 * làm một lỗi cấu hình ở tầng gọi bị đọc như dữ liệu dị dạng và biến mất khỏi metric.
 */
export type SelectPrimaryProviderResult =
  | DomainOk<{ readonly provider: ProviderRoutingFact }>
  | DomainRejection<
      | 'no_provider'
      | 'ambiguous'
      | ProviderIneligibilityReason
      | 'malformed_selector'
      | 'malformed_provider'
    >;

/**
 * Chọn provider primary cho `(app, transport)`.
 *
 * Chỉ những provider **đã đủ điều kiện** (enabled, đúng scope, không hold) mới tham
 * gia. Nếu còn lại **đúng một** → đó là primary. Nếu còn lại **nhiều hơn một** →
 * `ambiguous`: FR-005 yêu cầu routing fail safely, **MUST NOT** chọn random và
 * **MUST NOT** chọn theo thứ tự database. Domain từ chối quyết định thay vì đoán.
 */
export function selectPrimaryProvider(
  providers: readonly ProviderRoutingFact[],
  app: string,
  transport: Transport,
): SelectPrimaryProviderResult {
  if (!isNonEmptyString(app) || !isTransport(transport)) {
    return {
      ok: false,
      reason: 'malformed_selector',
      detail: 'Tham số chọn provider không hợp lệ — không quyết định được primary.',
    };
  }
  // Collection hỏng là dữ liệu lỗi hình dạng của provider source — cùng reason với
  // guard shape bên trong `evaluateProviderRoutingEligibility`, không phải lỗi selector.
  if (!Array.isArray(providers)) {
    return {
      ok: false,
      reason: 'malformed_provider',
      detail: 'Danh sách provider không hợp lệ — không chọn được primary.',
    };
  }
  const eligible = providers.filter(
    (provider) => evaluateProviderRoutingEligibility(provider, app, transport).ok,
  );
  if (eligible.length === 0) {
    return {
      ok: false,
      reason: 'no_provider',
      detail: 'Không có provider eligible cho app và transport này.',
    };
  }
  if (eligible.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      detail:
        'Nhiều provider eligible cho cùng app và transport — fail safe, không chọn theo thứ tự.',
    };
  }
  return { ok: true, provider: eligible[0] as ProviderRoutingFact };
}

/**
 * Một VAPID key pair **thuộc một `App`** mà `App` đó đang phục vụ — tham chiếu, không
 * mang byte secret nào (FR-006: secret **MUST NOT** vào Queue message, log, API
 * response).
 *
 * `app` là phần của **danh tính** key, không phải metadata: VAPID key pair là provider
 * credential **theo từng `App`** (`01-architecture.md` §5.3, §9) và namespace các `App`
 * cô lập với nhau (§8.2). Thiếu `app`, một caller tra nhầm bảng credential của `App`
 * khác vẫn nhận về một `vapid_key_id` hợp lệ về hình thức; worker sẽ ký bằng key của
 * `App` khác và delivery hỏng âm thầm, không có lỗi nào nổi lên để metric bắt được.
 */
export type AppVapidKeyRef = {
  /** `App` sở hữu key pair — đối chiếu với `App` của subscription cần ký. */
  readonly app: string;
  /** Định danh key pair VAPID (`vapid_key_id`), xoay theo key version (FR-006). */
  readonly vapidKeyId: string;
};

/**
 * Subscription **MUST** lưu `vapid_key_id` dùng lúc tạo và worker ký bằng key theo
 * `vapid_key_id` **của subscription**, không phải "key hiện tại của App" (FR-006).
 *
 * `availableVapidKeys` là **tập** key mà `App` còn phục vụ, **không** phải một key đơn
 * lẻ: trong thời gian rotation, runtime resolution **MUST** trả được credential cho mọi
 * `vapid_key_id` còn được subscription `active` tham chiếu — kể cả key đang được retire
 * (`01-architecture.md` §5.3; `03-operations.md` §7.2). Nhận một key đơn lẻ (mặc định dễ
 * mắc: "key hiện tại của `App`") làm mọi subscription cũ bị coi là không eligible ngay
 * lúc rotation — đúng kịch bản tài liệu cấm.
 *
 * `app` là `App` của subscription cần ký: chỉ key có `app` trùng mới được dùng, nên
 * namespace `App` (§8.2) được thực thi ở tầng type chứ không chỉ ở tầng query.
 *
 * Trả `null` — **không** trả một key khác — khi `app`/`vapid_key_id` không phải chuỗi
 * không rỗng, khi `availableVapidKeys` không phải mảng, hoặc khi không có key nào vừa
 * thuộc `app` vừa khớp `vapid_key_id`. Không có fallback sang key khác: ký bằng key
 * không phải key đã cam kết là hỏng delivery một cách âm thầm.
 */
export function resolveSubscriptionSigningKeyId(
  app: string,
  subscriptionVapidKeyId: string,
  availableVapidKeys: readonly AppVapidKeyRef[],
): string | null {
  if (
    !isNonEmptyString(app) ||
    !isNonEmptyString(subscriptionVapidKeyId) ||
    !Array.isArray(availableVapidKeys)
  ) {
    return null;
  }
  const servesSubscriptionKey = availableVapidKeys.some(
    (key) => key?.app === app && key?.vapidKeyId === subscriptionVapidKeyId,
  );
  if (!servesSubscriptionKey) {
    return null;
  }
  return subscriptionVapidKeyId;
}

/**
 * Root encryption key rotation `K1 → K2` (FR-006, `03-operations.md` §7.3).
 *
 * `MUST NOT` retire `K1` khi còn record `credential_encryption_version = K1`:
 * retire sớm làm credential cũ không giải mã được, tức là mất khả năng ký VAPID cho
 * subscription hiện có. Hàm này là cửa chặn cho quyết định retire đó.
 */
export function canRetireEncryptionKey(
  keyId: string,
  encryptionVersionsInUse: readonly string[],
): boolean {
  if (!isNonEmptyString(keyId)) {
    return false;
  }
  // Danh sách usage không kiểm chứng được thì không được retire: `false` là hướng
  // fail-closed của cửa chặn này — thà chặn một lần retire hợp lệ còn hơn retire sớm
  // một key mà credential cũ còn phụ thuộc. Một phần tử không phải key id làm phép so
  // sánh `includes` mất ý nghĩa, nên cả danh sách bị coi là không đọc được.
  if (!Array.isArray(encryptionVersionsInUse)) {
    return false;
  }
  if (!encryptionVersionsInUse.every((version) => typeof version === 'string')) {
    return false;
  }
  return !encryptionVersionsInUse.includes(keyId);
}
