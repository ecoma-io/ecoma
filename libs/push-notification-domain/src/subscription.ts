/**
 * Lifecycle của Push Subscription.
 *
 * Source of truth:
 * - `docs/applications/push-notification/02-requirements.md` FR-004 (Subscription Lifecycle):
 *   "Subscription **MUST** có lifecycle `active`, `disabled`, `expired`. Chỉ `active` đủ
 *   điều kiện tạo `Push Delivery`. Service **MUST** hỗ trợ disable khi: user unregister,
 *   administrator disable, delivery worker xác định subscription không còn hợp lệ."
 * - `docs/applications/push-notification/02-requirements.md` FR-016 (Invalid Subscription
 *   Handling): "Khi delivery worker xác định subscription không còn hợp lệ, subscription
 *   **MUST** disable/expire. Service **MUST NOT** tạo delivery mới cho subscription đã
 *   xác định không hợp lệ."
 * - `docs/applications/push-notification/01-architecture.md` §5.2 (Subscription có
 *   trạng thái `active`, `disabled`, `expired`; diagram chỉ có `active → disabled`
 *   và `active → expired`; "Subscription không còn hợp lệ (`disabled`/`expired`)
 *   **không** tiếp tục nhận delivery mới").
 * - `docs/applications/push-notification/01-architecture.md` §8.1 (invalidate: idempotent;
 *   "Invalidate **chỉ** đổi subscription state (`active → disabled`)"; "gọi lặp với cùng
 *   `subscription_id` đã `disabled` trả **cùng** `200`").
 *
 * Quyết định domain suy ra:
 * - `disabled` và `expired` là trạng thái đóng: §5.2 chỉ khai báo hai transition
 *   `active → disabled` và `active → expired`, và không tài liệu nào trong
 *   `docs/domains/push-notification/` mô tả một đường quay lại `active` — nên model
 *   ở đây **không** có transition đó. Đăng ký lại sau khi hủy là subscription mới —
 *   thuộc application layer, ngoài phạm vi domain library này.
 * - `disableSubscription` áp lên subscription đã `disabled` là idempotent (trả
 *   `ok: true` với `changed: false`) theo hợp đồng invalidate ở §8.1.
 * - `disableSubscription` áp lên `expired` bị từ chối (`invalid_status`): §8.1 nói
 *   invalidate **chỉ** đổi `active → disabled`, và `expired` không có transition đi ra
 *   theo §5.2.
 * - Emergency hold KHÔNG nằm ở đây: hold là flag trên Provider (xem `provider.ts`),
 *   là operation riêng tách biệt với `disable` theo `docs/applications/push-notification/03-operations.md`
 *   §6.5; docs cũng chỉ mô tả hold chặn delivery, không mô tả nó sửa subscription state.
 */

import type { DomainOk, DomainRejection } from './shared';

/**
 * Trạng thái business của Push Subscription — chỉ ba giá trị theo §5.2.
 */
export const SUBSCRIPTION_STATUS = {
  Active: 'active',
  Disabled: 'disabled',
  Expired: 'expired',
} as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUS)[keyof typeof SUBSCRIPTION_STATUS];

export const SUBSCRIPTION_STATUS_VALUES: readonly SubscriptionStatus[] = [
  SUBSCRIPTION_STATUS.Active,
  SUBSCRIPTION_STATUS.Disabled,
  SUBSCRIPTION_STATUS.Expired,
];

/**
 * Runtime guard chặn giá trị ngoài vocabulary (`'Active'`, `'paused'`, số…).
 */
export function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return SUBSCRIPTION_STATUS_VALUES.includes(value as SubscriptionStatus);
}

/**
 * Trạng thái đóng của subscription: không có transition nào đi ra theo model
 * (§5.2 chỉ mô tả transition xuất phát từ `active`).
 */
export const CLOSED_SUBSCRIPTION_STATUS_VALUES = [
  SUBSCRIPTION_STATUS.Disabled,
  SUBSCRIPTION_STATUS.Expired,
] as const;

export function isClosedSubscriptionStatus(status: SubscriptionStatus): boolean {
  return status !== SUBSCRIPTION_STATUS.Active;
}

/**
 * Predicate "subscription đủ điều kiện tạo delivery" (FR-004): chỉ `active`.
 * Đây là cửa chặn nghiệp vụ — status không phải `active` thì không được route
 * delivery mới, bất kể priority hay các yếu tố khác.
 */
export function isSubscriptionEligibleForDelivery(status: SubscriptionStatus): boolean {
  return status === SUBSCRIPTION_STATUS.Active;
}

/**
 * Nguyên nhân disable — bao phủ ba actor trong FR-004 (user unregister,
 * admin disable, worker xác nhận endpoint không còn hợp lệ) và re-validate định kỳ
 * thất bại từ FR-003.
 */
export const SUBSCRIPTION_DISABLE_CAUSE = {
  UserUnregister: 'user_unregister',
  AdminDisable: 'admin_disable',
  ProviderInvalidation: 'provider_invalidation',
  EndpointRevalidationFailed: 'endpoint_revalidation_failed',
} as const;

export type SubscriptionDisableCause =
  (typeof SUBSCRIPTION_DISABLE_CAUSE)[keyof typeof SUBSCRIPTION_DISABLE_CAUSE];

export const SUBSCRIPTION_DISABLE_CAUSE_VALUES: readonly SubscriptionDisableCause[] = [
  SUBSCRIPTION_DISABLE_CAUSE.UserUnregister,
  SUBSCRIPTION_DISABLE_CAUSE.AdminDisable,
  SUBSCRIPTION_DISABLE_CAUSE.ProviderInvalidation,
  SUBSCRIPTION_DISABLE_CAUSE.EndpointRevalidationFailed,
];

export function isSubscriptionDisableCause(value: unknown): value is SubscriptionDisableCause {
  return SUBSCRIPTION_DISABLE_CAUSE_VALUES.includes(value as SubscriptionDisableCause);
}

export type DisableSubscriptionResult =
  | DomainOk<{
      readonly status: typeof SUBSCRIPTION_STATUS.Disabled;
      /** `false` khi subscription đã ở `disabled` (idempotent theo §8.1). */
      readonly changed: boolean;
      readonly cause: SubscriptionDisableCause;
    }>
  | DomainRejection<'unknown_status' | 'invalid_status' | 'unknown_cause'>;

/**
 * `active → disabled` (FR-004); idempotent trên `disabled` (§8.1 invalidate);
 * từ chối trên `expired` và trên giá trị ngoài vocabulary.
 *
 * Không bao giờ trả về `active`: invariant "không tự động khôi phục subscription"
 * (FR-004) được thực thi bằng việc không tồn tại đường dẫn trạng thái nào trong
 * domain đặt subscription về `active`.
 */
export function disableSubscription(
  status: SubscriptionStatus,
  cause: SubscriptionDisableCause,
): DisableSubscriptionResult {
  if (!isSubscriptionStatus(status)) {
    return {
      ok: false,
      reason: 'unknown_status',
      detail: 'Subscription status nằm ngoài vocabulary của domain.',
    };
  }
  if (!isSubscriptionDisableCause(cause)) {
    return {
      ok: false,
      reason: 'unknown_cause',
      detail: 'Subscription disable cause nằm ngoài vocabulary của domain.',
    };
  }
  if (status === SUBSCRIPTION_STATUS.Active) {
    return {
      ok: true,
      status: SUBSCRIPTION_STATUS.Disabled,
      changed: true,
      cause,
    };
  }
  if (status === SUBSCRIPTION_STATUS.Disabled) {
    return {
      ok: true,
      status: SUBSCRIPTION_STATUS.Disabled,
      changed: false,
      cause,
    };
  }
  return {
    ok: false,
    reason: 'invalid_status',
    detail: 'Subscription expired không có transition sang disabled theo model.',
  };
}

export type ExpireSubscriptionResult =
  | DomainOk<{
      readonly status: typeof SUBSCRIPTION_STATUS.Expired;
      readonly cause: 'lifecycle_policy';
    }>
  | DomainRejection<'unknown_status' | 'invalid_status'>;

/**
 * `active → expired` (§5.2 diagram): chính sách lifecycle thu hồi subscription
 * theo thời hạn. Từ chối trên `disabled`/`expired` và giá trị ngoài vocabulary —
 * `expired` chỉ đi ra từ `active`.
 */
export function expireSubscription(status: SubscriptionStatus): ExpireSubscriptionResult {
  if (!isSubscriptionStatus(status)) {
    return {
      ok: false,
      reason: 'unknown_status',
      detail: 'Subscription status nằm ngoài vocabulary của domain.',
    };
  }
  if (status === SUBSCRIPTION_STATUS.Active) {
    return {
      ok: true,
      status: SUBSCRIPTION_STATUS.Expired,
      cause: 'lifecycle_policy',
    };
  }
  return {
    ok: false,
    reason: 'invalid_status',
    detail: 'Chỉ subscription active mới chuyển sang expired theo model.',
  };
}
