/**
 * Push Delivery: state machine, lease/fencing, claim decision, và các transition vận hành.
 *
 * Source of truth:
 * - `docs/applications/push-notification/02-requirements.md` FR-015 (state đóng; transition
 *   hợp lệ; terminal state; administrative recovery `failed → queued`; expiry từ mọi
 *   non-terminal; `cancelled` khai báo nhưng **không có actor** trong v1),
 *   FR-014 (`delivery_id` là logical identity, **không** phải exactly-once external
 *   side effect).
 * - `docs/applications/push-notification/01-architecture.md` §5.6 (nghĩa canonical của
 *   từng state; lease + `dispatch_generation`; guarded conditional write; claim
 *   predicate; ai set `expired`; giới hạn của fencing), §5.6.1 (administrative retry),
 *   §5.6.3 (re-publish), §6.2 (actor duy nhất của `pending → queued`), §8.1
 *   (vocabulary `reason` của claim).
 *
 * Quyết định domain suy ra:
 * - **Actor là tham số của transition, không phải suy diễn.** `pending → queued` chỉ
 *   hợp lệ với actor `outbox_publisher`; `queued → processing` chỉ với `claim`;
 *   `processing → queued` chỉ với `release_lease`. Biến actor thành tham số khiến
 *   "delivery plane MUST NOT chuyển state này" (§6.2) là một bất biến kiểm tra được
 *   thay vì một quy ước.
 * - `cancelled` được khai báo trong vocabulary (FR-015) nhưng domain **không** có
 *   transition nào đi vào nó: không actor nào được chấp nhận. Thêm cancel là quyết
 *   định phase sau; domain không tự suy ra nó đã tồn tại.
 * - Fencing được mô hình hoá thành một hàm thuần quyết định thắng/thua **đúng như
 *   predicate SQL** (§5.6). Domain không tự thực thi write; nó là nguồn sự thật cho
 *   điều kiện mà statement phải mang.
 * - **Không** mô hình hoá "claim ghi state khi từ chối": §5.6 nói rõ `409 expired` là
 *   no-op với state. Vì vậy claim từ chối trả về decision, không trả state mới.
 */

import {
  type DomainOk,
  type DomainRejection,
  isEpochMillis,
  isNonNegativeInteger,
  isPositiveInteger,
} from './shared';
import {
  isClosedSubscriptionStatus,
  isSubscriptionStatus,
  type SubscriptionStatus,
} from './subscription';
import { isProviderStatus, type ProviderStatus } from './provider';

/**
 * State của Push Delivery (FR-015) — vocabulary đóng.
 */
export const DELIVERY_STATUS = {
  Pending: 'pending',
  Queued: 'queued',
  Processing: 'processing',
  Delivered: 'delivered',
  Failed: 'failed',
  Expired: 'expired',
  Cancelled: 'cancelled',
} as const;

export type DeliveryStatus = (typeof DELIVERY_STATUS)[keyof typeof DELIVERY_STATUS];

export const DELIVERY_STATUS_VALUES: readonly DeliveryStatus[] = [
  DELIVERY_STATUS.Pending,
  DELIVERY_STATUS.Queued,
  DELIVERY_STATUS.Processing,
  DELIVERY_STATUS.Delivered,
  DELIVERY_STATUS.Failed,
  DELIVERY_STATUS.Expired,
  DELIVERY_STATUS.Cancelled,
];

export function isDeliveryStatus(value: unknown): value is DeliveryStatus {
  return DELIVERY_STATUS_VALUES.includes(value as DeliveryStatus);
}

/**
 * Terminal state (FR-015): không có transition ra theo đường bình thường. Ngoại lệ
 * **duy nhất** là `failed → queued` qua administrative retry (§5.6.1).
 */
export const TERMINAL_DELIVERY_STATUS_VALUES: readonly DeliveryStatus[] = [
  DELIVERY_STATUS.Delivered,
  DELIVERY_STATUS.Failed,
  DELIVERY_STATUS.Expired,
  DELIVERY_STATUS.Cancelled,
];

export function isTerminalDeliveryStatus(status: DeliveryStatus): boolean {
  return TERMINAL_DELIVERY_STATUS_VALUES.includes(status);
}

/**
 * Non-terminal state (§5.6): `pending`/`queued`/`processing`. Delivery chưa kết thúc —
 * chỉ nhóm này mới có thể chuyển sang `expired`, và chỉ nhóm này mới eligible cho
 * re-publish (§5.6.3).
 */
export function isNonTerminalDeliveryStatus(status: DeliveryStatus): boolean {
  return isDeliveryStatus(status) && !isTerminalDeliveryStatus(status);
}

/**
 * Actor của transition. Khai báo tường minh để mỗi transition chỉ hợp lệ với đúng
 * actor mà tài liệu cho phép.
 */
export const DELIVERY_TRANSITION_ACTOR = {
  /** §6.2: actor **duy nhất** của `pending → queued`. */
  OutboxPublisher: 'outbox_publisher',
  /** §5.6: atomic claim — operation duy nhất cấp lease. */
  Claim: 'claim',
  /** §5.6: worker nhả lease trước khi retry transient. */
  ReleaseLease: 'release_lease',
  /** §5.6: worker ghi kết quả delivery. */
  Outcome: 'outcome',
  /** §5.6: logical delivery reconciliation của control plane. */
  Reconciliation: 'reconciliation',
  /** §5.6.1: administrative retry — ngoại lệ duy nhất rời terminal state. */
  AdministrativeRetry: 'administrative_retry',
} as const;

export type DeliveryTransitionActor =
  (typeof DELIVERY_TRANSITION_ACTOR)[keyof typeof DELIVERY_TRANSITION_ACTOR];

export const DELIVERY_TRANSITION_ACTOR_VALUES: readonly DeliveryTransitionActor[] = [
  DELIVERY_TRANSITION_ACTOR.OutboxPublisher,
  DELIVERY_TRANSITION_ACTOR.Claim,
  DELIVERY_TRANSITION_ACTOR.ReleaseLease,
  DELIVERY_TRANSITION_ACTOR.Outcome,
  DELIVERY_TRANSITION_ACTOR.Reconciliation,
  DELIVERY_TRANSITION_ACTOR.AdministrativeRetry,
];

export function isDeliveryTransitionActor(value: unknown): value is DeliveryTransitionActor {
  return DELIVERY_TRANSITION_ACTOR_VALUES.includes(value as DeliveryTransitionActor);
}

/**
 * Ánh xạ `từ → tới` sang actor được phép. Đây là **nguồn duy nhất** của transition
 * table; mọi hàm khác đọc từ đây thay vì khai báo lại cặp trạng thái.
 *
 * `Failed → Queued` xuất hiện với actor `administrative_retry` — nó vừa là ngoại lệ
 * rời terminal, vừa **không** phải transition chạy tự động (§5.6.1).
 */
export const DELIVERY_TRANSITIONS: readonly {
  readonly from: DeliveryStatus;
  readonly to: DeliveryStatus;
  readonly actor: DeliveryTransitionActor;
}[] = [
  {
    from: DELIVERY_STATUS.Pending,
    to: DELIVERY_STATUS.Queued,
    actor: DELIVERY_TRANSITION_ACTOR.OutboxPublisher,
  },
  {
    from: DELIVERY_STATUS.Queued,
    to: DELIVERY_STATUS.Processing,
    actor: DELIVERY_TRANSITION_ACTOR.Claim,
  },
  {
    from: DELIVERY_STATUS.Processing,
    to: DELIVERY_STATUS.Delivered,
    actor: DELIVERY_TRANSITION_ACTOR.Outcome,
  },
  {
    from: DELIVERY_STATUS.Processing,
    to: DELIVERY_STATUS.Failed,
    actor: DELIVERY_TRANSITION_ACTOR.Outcome,
  },
  {
    from: DELIVERY_STATUS.Processing,
    to: DELIVERY_STATUS.Queued,
    actor: DELIVERY_TRANSITION_ACTOR.ReleaseLease,
  },
  {
    from: DELIVERY_STATUS.Pending,
    to: DELIVERY_STATUS.Expired,
    actor: DELIVERY_TRANSITION_ACTOR.Reconciliation,
  },
  {
    from: DELIVERY_STATUS.Queued,
    to: DELIVERY_STATUS.Expired,
    actor: DELIVERY_TRANSITION_ACTOR.Reconciliation,
  },
  {
    from: DELIVERY_STATUS.Processing,
    to: DELIVERY_STATUS.Expired,
    actor: DELIVERY_TRANSITION_ACTOR.Reconciliation,
  },
  {
    from: DELIVERY_STATUS.Failed,
    to: DELIVERY_STATUS.Queued,
    actor: DELIVERY_TRANSITION_ACTOR.AdministrativeRetry,
  },
];

export type ValidateDeliveryTransitionResult =
  | DomainOk<{ readonly to: DeliveryStatus }>
  | DomainRejection<'unknown_status' | 'unknown_actor' | 'transition_not_allowed'>;

/**
 * Kiểm tra một transition `from → to` có hợp lệ với `actor` hay không.
 *
 * Từ chối khi: giá trị ngoài vocabulary (`unknown_status`/`unknown_actor`), hoặc cặp
 * `(from, to, actor)` không nằm trong `DELIVERY_TRANSITIONS`.
 */
export function validateDeliveryTransition(
  from: DeliveryStatus,
  to: DeliveryStatus,
  actor: DeliveryTransitionActor,
): ValidateDeliveryTransitionResult {
  if (!isDeliveryStatus(from) || !isDeliveryStatus(to)) {
    return {
      ok: false,
      reason: 'unknown_status',
      detail: 'Delivery status nằm ngoài vocabulary của domain.',
    };
  }
  if (!isDeliveryTransitionActor(actor)) {
    return {
      ok: false,
      reason: 'unknown_actor',
      detail: 'Actor nằm ngoài vocabulary transition của domain.',
    };
  }
  const allowed = DELIVERY_TRANSITIONS.some(
    (transition) => transition.from === from && transition.to === to && transition.actor === actor,
  );
  if (!allowed) {
    return {
      ok: false,
      reason: 'transition_not_allowed',
      detail: 'Cặp transition và actor không nằm trong transition table.',
    };
  }
  return { ok: true, to };
}

/**
 * Trạng thái lease + fencing của một delivery, như control plane lưu.
 *
 * `dispatchGeneration` khởi tạo `0` (delivery chưa từng được claim) nên guard dùng
 * `isNonNegativeInteger` chứ không `isPositiveInteger`.
 *
 * ⚠️ **Mọi mốc thời gian là epoch millis nguyên và phải là safe integer** — `expiresAt`,
 * `leaseExpiresAt`. Xem `isEpochMillis` trong `./shared`: `isFiniteNumber` chỉ chặn
 * `NaN`/`Infinity`, nên một `expires_at` nằm ngoài miền số nguyên an toàn vẫn lọt qua và
 * làm cổng `expires_at <= now` của §5.6 cho kết quả ngược ý.
 */
export type DeliveryLeaseState = {
  readonly status: DeliveryStatus;
  readonly dispatchGeneration: number;
  readonly leaseExpiresAt: number | null;
  /** Hạn **nghiệp vụ** của notification (FR-008), không phải Web Push TTL. */
  readonly expiresAt: number;
};

function isMalformedLeaseState(state: DeliveryLeaseState): boolean {
  if (!isDeliveryStatus(state.status)) return true;
  if (!isNonNegativeInteger(state.dispatchGeneration)) return true;
  if (!isEpochMillis(state.expiresAt)) return true;
  if (state.leaseExpiresAt !== null && !isEpochMillis(state.leaseExpiresAt)) {
    return true;
  }
  return false;
}

/**
 * Tăng `dispatch_generation` — bước tính `dispatch_generation + 1` mà §5.6 yêu cầu nằm
 * **trong cùng statement** với predicate claim.
 *
 * Hàm hóa phép `+ 1` ở một chỗ để overflow trở thành một **rejection có tên**, không phải
 * một `dispatchGeneration` âm lặng: `Number.MAX_SAFE_INTEGER + 1` vẫn là một số nguyên
 * *an toàn theo mọi guard shape khác*, nên nếu chỉ kiểm `isNonNegativeInteger` ở đầu hàm
 * thì một delivery bị re-claim vô hạn lần sẽ đi từ `9007199254740991` sang
 * `-9007199254740991` và fencing bị **đảo chiều**: execution cũ bị coi là đang giữ
 * generation hiện hành. Vì thế cả hai nơi tính generation mới (claim và administrative
 * retry) đều đi qua đây và trả `malformed_delivery` — reason đã có sẵn trong tập của cả
 * hai decision, không thêm vocabulary mới.
 */
function nextDispatchGeneration(current: number): number | null {
  const next = current + 1;
  return isNonNegativeInteger(next) ? next : null;
}

/**
 * Tập `reason` của claim, **khai báo đúng thứ tự chẩn đoán canonical** của
 * `01-architecture.md` §8.1. Thứ tự union là thứ tự đó, không phải thứ tự ngẫu nhiên:
 * đây là thứ mà người đọc tiếp theo sẽ dùng để đối chiếu với §8.1, và người dùng sai
 * sẽ đọc xong tưởng domain dùng thứ tự khác.
 *
 * Đây cũng là tập **đóng** mà contract hứa: control plane map thẳng từng reason sang
 * response `409 <reason>`, không phải quyết định lại lần nữa. `malformed_delivery` là
 * reason riêng của domain (guard shape), **không** thuộc tập này — nó chỉ xuất hiện
 * khi dữ liệu không đủ để trả một reason canonical.
 */
export type ClaimRejectionReason =
  | 'terminal'
  | 'expired'
  | 'ineligible_subscription'
  | 'ineligible_provider_hold'
  | 'lease_held'
  | 'pending';

export type DeliveryClaimDecision =
  | DomainOk<{
      readonly status: typeof DELIVERY_STATUS.Processing;
      /** Generation mới: `dispatch_generation + 1` (§5.6). */
      readonly dispatchGeneration: number;
      readonly leaseExpiresAt: number;
    }>
  | DomainRejection<ClaimRejectionReason | 'malformed_delivery'>;

/**
 * Bối cảnh để quyết định claim — gom mọi yếu tố mà predicate cần, để domain là hàm
 * thuần: không đọc đồng hồ, `now` và `leaseDuration` do caller truyền vào.
 */
export type ClaimDeliveryContext = {
  /** Control plane xác định **một** `now` cho cả predicate lẫn `lease_expires_at`. */
  readonly now: number;
  readonly leaseDuration: number;
  readonly subscriptionStatus: SubscriptionStatus;
  /**
   * FR-005: `disabled` chỉ dừng **routing delivery mới** — delivery đã materialize
   * giữ nguyên `provider_id` và **tiếp tục** được xử lý. Vì vậy đây là tham số được
   * validate cho đúng shape nhưng **cố ý không** tham gia quyết định; điều kiện
   * provider duy nhất chặn claim là `providerEmergencyHold`. Giữ trường này trong
   * context để test được bất biến "disabled ≠ hold": một provider `disabled` vẫn
   * claim được, một provider `enabled` nhưng đang hold thì không.
   */
  readonly providerStatus: ProviderStatus;
  readonly providerEmergencyHold: boolean;
};

/**
 * Quyết định claim cho một execution.
 *
 * **Bất biến cốt lõi:** `dispatch_generation` luôn là `state.dispatchGeneration + 1`
 * khi thắng — không bao giờ là giá trị đã đọc từ trước và không bao giờ tái dùng.
 * Vì hàm này nhận state và trả generation mới trong một bước, không có cửa sổ để
 * caller "đọc rồi ghi lại giá trị đã đọc" (§5.6 cấm điều đó).
 *
 * **Thứ tự từ chối** — nguyên văn thứ tự chẩn đoán canonical của
 * `01-architecture.md` §8.1, không phải một thứ tự do domain tự chọn:
 *
 * 1. terminal state → `terminal`.
 * 2. `expires_at <= now` → `expired`. Delivery **vẫn** non-terminal (claim không ghi
 *    state khi từ chối); chỉ reconciliation mới đánh dấu `expired`.
 * 3. subscription không `active` → `ineligible_subscription`.
 * 4. provider emergency hold → `ineligible_provider_hold`.
 * 5. `processing` và lease còn hiệu lực → `lease_held`.
 * 6. `pending` → `pending` (chưa có lần publish thành công nào — §5.6).
 *
 * Thứ tự này đổi **`reason` được báo** khi nhiều điều kiện từ chối cùng đúng, chứ
 * **không** đổi ai thắng: claim thắng khi và chỉ khi nó đi qua được **mọi** nhánh, nên
 * tập thắng/thua là giao của các phủ định — bất biến theo thứ tự.
 *
 * **Guard shape:** shape của `state` và tham số claim (`now`/`leaseDuration`) kiểm
 * trước cả sáu nhánh; shape của từng field context kiểm ngay trước nhánh nghiệp vụ của
 * chính nó (`subscriptionStatus` trước `ineligible_subscription`; `providerStatus`/
 * `providerEmergencyHold` trước `ineligible_provider_hold`). Một field hỏng vì thế
 * luôn được báo `malformed_delivery` tại chỗ nó được đọc — kể cả khi một điều kiện
 * canonical cũng đúng. Trường hợp **duy nhất** đặt cuối, ngay trước `return` thắng:
 * `processing` không mang lease (§5.6) — trạng thái model nói không tồn tại; nó chỉ
 * được báo khi không nhánh canonical nào áp dụng. Bất biến mà tests ghim không phải
 * "hàng hỏng luôn ra `malformed_delivery`", mà là hàng hỏng **không bao giờ thắng**
 * claim — ví dụ `processing` đã quá `expires_at` vẫn ra `expired` (reason thuộc
 * contract, worker ACK an toàn) chứ không phải một reason ngoài contract.
 *
 * Lưu ý: `provider disabled` **không** nằm trong danh sách từ chối. FR-005 nói rõ
 * delivery đã materialize vẫn tiếp tục được xử lý khi provider `disabled` — chỉ
 * emergency hold mới chặn claim.
 */
export function decideDeliveryClaim(
  state: DeliveryLeaseState,
  context: ClaimDeliveryContext,
): DeliveryClaimDecision {
  if (!state || isMalformedLeaseState(state)) {
    return {
      ok: false,
      reason: 'malformed_delivery',
      detail: 'Delivery state không đúng shape tối thiểu của domain.',
    };
  }
  if (!isEpochMillis(context.now) || !isPositiveInteger(context.leaseDuration)) {
    return {
      ok: false,
      reason: 'malformed_delivery',
      detail: 'Tham số claim (now, leaseDuration) không hợp lệ.',
    };
  }
  // Thứ tự chẩn đoán canonical (§8.1): terminal → expired → ineligible_subscription
  // → ineligible_provider_hold → lease_held → pending.
  if (isTerminalDeliveryStatus(state.status)) {
    return {
      ok: false,
      reason: 'terminal',
      detail: 'Delivery đã ở terminal state.',
    };
  }
  if (state.expiresAt <= context.now) {
    return {
      ok: false,
      reason: 'expired',
      detail: 'Delivery đã vượt expires_at — không claimable; reconciliation set expired.',
    };
  }

  if (!isSubscriptionStatus(context.subscriptionStatus)) {
    return {
      ok: false,
      reason: 'malformed_delivery',
      detail: 'Subscription status nằm ngoài vocabulary của domain.',
    };
  }
  if (isClosedSubscriptionStatus(context.subscriptionStatus)) {
    return {
      ok: false,
      reason: 'ineligible_subscription',
      detail: 'Subscription không active — delivery không eligible để claim.',
    };
  }
  if (
    !isProviderStatus(context.providerStatus) ||
    typeof context.providerEmergencyHold !== 'boolean'
  ) {
    return {
      ok: false,
      reason: 'malformed_delivery',
      detail: 'Provider fact nằm ngoài vocabulary của domain.',
    };
  }
  if (context.providerEmergencyHold) {
    return {
      ok: false,
      reason: 'ineligible_provider_hold',
      detail: 'Provider đang emergency hold — delivery không eligible để claim.',
    };
  }

  if (state.status === DELIVERY_STATUS.Processing) {
    // `leaseExpiresAt` là `number | null`; null đã bị chặn ở guard cuối hàm (nhánh
    // "would otherwise win"). Ở đây chỉ còn nhánh `lease_held`.
    const leaseExpiresAt = state.leaseExpiresAt;
    if (leaseExpiresAt !== null && leaseExpiresAt > context.now) {
      return {
        ok: false,
        reason: 'lease_held',
        detail: 'Delivery đang được execution khác giữ lease còn hiệu lực.',
      };
    }
  }
  if (state.status === DELIVERY_STATUS.Pending) {
    return {
      ok: false,
      reason: 'pending',
      detail: 'Delivery chưa queued — chưa có lần publish nào thành công.',
    };
  }

  // Guard shape của riêng claim, đặt **cuối**: `processing` nghĩa là "đang giữ lease"
  // (§5.6), nên một hàng `processing` không mang lease là trạng thái model nói không
  // tồn tại — predicate SQL (`lease_expires_at <= :now`) cũng không khớp nó. Đây là
  // trường hợp **duy nhất** còn lại có thể đi tới `return` thắng, nên đặt ở đây vừa
  // chặn được một hàng hỏng claim thành công, vừa **không** cướp mất `reason` canonical
  // của sáu nhánh trên: `malformed_delivery` không thuộc tập `reason` đóng của §8.1
  // (`expires_at <= now → expired` là vô điều kiện), nên nó chỉ được báo khi không nhánh
  // canonical nào áp dụng.
  if (state.status === DELIVERY_STATUS.Processing && state.leaseExpiresAt === null) {
    return {
      ok: false,
      reason: 'malformed_delivery',
      detail: 'Delivery processing nhưng không mang lease — trạng thái không tồn tại.',
    };
  }

  // Overflow của `dispatch_generation` bị từ chối **trước khi** trả kết quả thắng: một
  // hàng vừa chạm `Number.MAX_SAFE_INTEGER` không được sinh ra generation âm (xem
  // `nextDispatchGeneration`). Nhánh này không thuộc tập `reason` đóng của §8.1 — claim
  // thắng ở đây không thể ghi generation hợp lệ, nên worker phải thấy một rejection
  // (`malformed_delivery`) chứ không phải một lease mang fencing token âm.
  const dispatchGeneration = nextDispatchGeneration(state.dispatchGeneration);
  if (dispatchGeneration === null) {
    return {
      ok: false,
      reason: 'malformed_delivery',
      detail: 'dispatch_generation không còn tăng an toàn — tránh tràn số nguyên.',
    };
  }
  // `now + leaseDuration` phải là epoch millis hợp lệ: cả hai vế đều là safe integer
  // (guard ở trên) nhưng tổng của chúng có thể vượt miền đó, và một `lease_expires_at`
  // không parse được trên wire khiến response `200` của claim hỏng ở consumer.
  const leaseExpiresAt = context.now + context.leaseDuration;
  if (!isEpochMillis(leaseExpiresAt)) {
    return {
      ok: false,
      reason: 'malformed_delivery',
      detail: 'now + leaseDuration không phải epoch millis an toàn.',
    };
  }

  return {
    ok: true,
    status: DELIVERY_STATUS.Processing,
    dispatchGeneration,
    leaseExpiresAt,
  };
}

/**
 * Operation ghi kèm fencing token — **đúng hai** operation của private delivery runtime
 * API dùng guard này (`01-architecture.md` §8.1): `release` (trả lease) và `outcome` (ghi
 * kết quả gửi).
 *
 * Suy ra từ `DELIVERY_TRANSITION_ACTOR` thay vì khai một vocabulary thứ ba: hai actor đó
 * **chính là** hai operation, nên một tập hằng riêng là một nguồn thứ hai có thể lệch — và
 * lệch ở đây là lệch ở chính bất biến fencing mà `index.spec.ts` ghim vocabulary.
 */
export const FENCED_WRITE_OPERATIONS = [
  DELIVERY_TRANSITION_ACTOR.ReleaseLease,
  DELIVERY_TRANSITION_ACTOR.Outcome,
] as const;

export type FencedWriteOperation = (typeof FENCED_WRITE_OPERATIONS)[number];

export function isFencedWriteOperation(value: unknown): value is FencedWriteOperation {
  return (FENCED_WRITE_OPERATIONS as readonly unknown[]).includes(value);
}

/**
 * Fencing: write của một execution chỉ được áp dụng khi nó **còn** giữ generation
 * hiện hành (§5.6: guard `AND dispatch_generation = :generation` nằm trong cùng
 * statement ghi) **và** delivery còn ở trạng thái cho phép operation đó ghi (§8.1).
 *
 * ⚠️ **Vì sao phải truyền `operation` thay vì so generation một mình.** §8.1 định nghĩa
 * hai predicate ghi khác nhau:
 *
 * ```text
 * outcome: status = 'processing' + generation khớp + lease còn hiệu lực
 *          → 200 ; nếu status ≠ 'processing' hoặc lease đã hết → 409 stale_write
 * release: status = 'processing' → 200 (trả lease, generation KHÔNG đổi)
 *          status = 'queued' (đã release trước đó) → 200 no-op idempotent, cùng generation
 * ```
 *
 * Cửa sổ nguy hiểm là `release`: nó đưa delivery về `queued` mà **giữ nguyên**
 * `dispatch_generation` (§8.1, và §5.6.3/§5.6.1 cũng vậy), nên một execution cũ vẫn còn
 * khớp generation trong khoảng giữa lúc release và lúc execution kia claim lại. Nếu
 * domain chỉ so generation, nó sẽ trả `ok` cho `outcome` của execution đó trong đúng khoảng
 * đó — một `outcome` ghi `delivered`/`failed` lên một delivery **không còn `processing`**.
 * Đó chính là "ghi chỉ vì delivery còn non-terminal", và nó là hỏng âm thầm: reason trả về
 * là `ok` nên caller áp, còn statement `WHERE ... status = 'processing'` ở D1 mới là nơi
 * thật sự chặn — tức domain và database bất đồng ý về kết quả.
 *
 * `pending` cũng bị chặn: nó nghĩa là "chưa có lần publish thành công nào" (§5.6), tức
 * chưa execution nào từng giữ lease, nên không có write nào hợp lệ để áp dụng.
 *
 * Quá hạn lease **không** bị xét ở đây: §5.6 nói rõ lease hết hạn không thu hồi quyền ghi
 * nếu generation/state còn hợp lệ, và thêm một nhánh đồng hồ vào một hàm **thuần** sẽ tạo
 * ra đường "write cũ bị từ chối vì thời gian" mà canonical design không có. Predicate
 * `lease_expires_at > :now` thuộc guarded statement ở tầng database, đúng như §5.6 yêu
 * cầu "guard nằm trong cùng statement ghi".
 */
export type FencedWriteDecision =
  | DomainOk<{ readonly generation: number }>
  | DomainRejection<'stale_write' | 'terminal' | 'malformed_delivery'>;

/**
 * Quyết định có áp dụng write của một execution hay không.
 *
 * **Thứ tự kiểm** — nguyên văn §8.1: shape của đầu vào → `generation` → `terminal` →
 * `status`. Thứ tự này **không** đổi hành vi của worker (mọi `409` ở đây cùng dẫn tới ACK
 * an toàn), nên nó chỉ làm kết quả xác định thay vì tuỳ thứ tự implement.
 */
export function decideFencedWrite(
  state: DeliveryLeaseState,
  heldGeneration: number,
  operation: FencedWriteOperation,
): FencedWriteDecision {
  if (!state || isMalformedLeaseState(state)) {
    return {
      ok: false,
      reason: 'malformed_delivery',
      detail: 'Delivery state không đúng shape tối thiểu của domain.',
    };
  }
  if (!isNonNegativeInteger(heldGeneration)) {
    return {
      ok: false,
      reason: 'malformed_delivery',
      detail: 'dispatch_generation do execution gửi không phải số nguyên không âm.',
    };
  }
  // Operation ngoài vocabulary là **lỗi chương trình** ở tầng gọi, không phải dữ liệu hỏng:
  // báo `stale_write`/`terminal` cho nó sẽ khiến worker ACK một write vốn không có shape hợp
  // lệ. `malformed_delivery` là reason đã có sẵn, không thêm vocabulary.
  if (!isFencedWriteOperation(operation)) {
    return {
      ok: false,
      reason: 'malformed_delivery',
      detail: 'Operation ghi kèm fencing nằm ngoài vocabulary của domain.',
    };
  }
  if (heldGeneration !== state.dispatchGeneration) {
    return {
      ok: false,
      reason: 'stale_write',
      detail: 'Generation không khớp generation hiện hành — write bị từ chối.',
    };
  }
  if (isTerminalDeliveryStatus(state.status)) {
    return {
      ok: false,
      reason: 'terminal',
      detail: 'Delivery đã terminal — write theo đường thường không được áp dụng.',
    };
  }
  // §8.1: `outcome` chỉ ghi được khi delivery **đang** `processing`; `release` ngoài ra còn
  // chấp nhận `queued` vì gọi lặp sau một lần release trước là `200` no-op idempotent.
  const writable = writableStatuses(operation);
  if (!writable.includes(state.status)) {
    return {
      ok: false,
      reason: 'stale_write',
      detail: 'Delivery không ở trạng thái cho phép ghi với operation này.',
    };
  }
  return { ok: true, generation: state.dispatchGeneration };
}

/** Trạng thái mà một operation ghi còn được phép áp dụng — xem `decideFencedWrite`. */
function writableStatuses(operation: FencedWriteOperation): readonly DeliveryStatus[] {
  return operation === DELIVERY_TRANSITION_ACTOR.ReleaseLease
    ? [DELIVERY_STATUS.Processing, DELIVERY_STATUS.Queued]
    : [DELIVERY_STATUS.Processing];
}

/**
 * Tiền điều kiện của hai đường phục hồi vận hành (§5.6.1 administrative retry,
 * §5.6.3 re-publish).
 *
 * Chúng **phân biệt theo state** và không dùng lẫn: `failed` đi đường retry,
 * non-terminal đi đường republish. Gộp hai hàm thành một hàm "recover" sẽ xoá đúng
 * ranh giới mà tài liệu vẽ ra, nên chúng được tách riêng.
 */
export type AdministrativeRecoveryPrecondition = {
  readonly subscriptionStatus: SubscriptionStatus;
  readonly providerStatus: ProviderStatus;
  readonly providerEmergencyHold: boolean;
  /**
   * Thời điểm đánh giá. Hạn **nghiệp vụ** (`expiresAt`) lấy từ chính
   * `DeliveryLeaseState` thay vì truyền vào lần thứ hai: hai nguồn `expires_at`
   * khác nhau cho cùng một delivery là chính xác thứ fencing không được mở ra.
   */
  readonly now: number;
  /**
   * Chỉ dùng cho re-publish: có outbox record `pending`/`publishing` nào cho
   * `delivery_id` không (chống dồn intent — §5.6.3, §6.1).
   */
  readonly hasOpenOutboxIntent: boolean;
};

export type AdministrativeRecoveryRejection =
  | 'not_failed'
  | 'not_non_terminal'
  | 'notification_expired'
  | 'ineligible_subscription'
  | 'provider_hold'
  | 'open_outbox_intent'
  | 'malformed_delivery';

export type AdministrativeRetryDecision =
  | DomainOk<{
      readonly to: typeof DELIVERY_STATUS.Queued;
      /** §5.6.1: generation tăng — không tái dùng generation cũ. */
      readonly dispatchGeneration: number;
    }>
  | DomainRejection<AdministrativeRecoveryRejection>;

/**
 * Administrative retry `failed → queued` (§5.6.1) — transition **duy nhất** rời
 * terminal state.
 *
 * Tiền điều kiện canonical (FR-015): delivery `failed`; subscription `active`;
 * provider không emergency hold; notification chưa quá `expires_at`. Không thoả →
 * từ chối kèm lý do, **không** requeue một phần.
 *
 * `delivered`/`expired`/`cancelled` không đi qua đường này; muốn gửi lại thì tạo
 * notification mới. Delivery non-terminal cũng không — chúng không ở terminal nên
 * không có gì để hồi sinh; đường phục hồi của chúng là `planDeliveryRepublish`.
 */
export function planAdministrativeRetry(
  state: DeliveryLeaseState,
  precondition: AdministrativeRecoveryPrecondition,
): AdministrativeRetryDecision {
  if (!state || isMalformedLeaseState(state)) {
    return {
      ok: false,
      reason: 'malformed_delivery',
      detail: 'Delivery state không đúng shape tối thiểu của domain.',
    };
  }
  // `now` là cổng chặn `expires_at`; thiếu guard thì `expires_at <= NaN` luôn `false`
  // và một notification đã hết hạn vẫn đi qua đường requeue (FR-015 cấm). Cùng lý do,
  // `precondition` hỏng phải trả rejection chứ không được ném — hợp đồng của lib.
  if (!precondition || !isEpochMillis(precondition.now)) {
    return {
      ok: false,
      reason: 'malformed_delivery',
      detail: 'Tham số precondition (now) không hợp lệ.',
    };
  }
  if (state.status !== DELIVERY_STATUS.Failed) {
    return {
      ok: false,
      reason: 'not_failed',
      detail: 'Chỉ delivery failed mới đi qua administrative retry.',
    };
  }
  if (state.expiresAt <= precondition.now) {
    return {
      ok: false,
      reason: 'notification_expired',
      detail: 'Notification đã quá expires_at — không còn đường requeue.',
    };
  }
  if (
    !isSubscriptionStatus(precondition.subscriptionStatus) ||
    isClosedSubscriptionStatus(precondition.subscriptionStatus)
  ) {
    return {
      ok: false,
      reason: 'ineligible_subscription',
      detail: 'Subscription không active — không đủ tiền điều kiện retry.',
    };
  }
  if (
    !isProviderStatus(precondition.providerStatus) ||
    typeof precondition.providerEmergencyHold !== 'boolean'
  ) {
    return {
      ok: false,
      reason: 'malformed_delivery',
      detail: 'Provider fact nằm ngoài vocabulary của domain.',
    };
  }
  if (precondition.providerEmergencyHold) {
    return {
      ok: false,
      reason: 'provider_hold',
      detail: 'Provider đang emergency hold — không đủ tiền điều kiện retry.',
    };
  }
  // §5.6.1: khi requeue thì `dispatch_generation` **tăng** — không tái dùng generation cũ.
  // Overflow bị từ chối ở đây thay vì trả một generation âm (xem `nextDispatchGeneration`):
  // generation âm làm guard `AND dispatch_generation = :generation` của một execution
  // khác khớp nhầm, tức hồi sinh đúng lớp hỏng mà fencing sinh ra để chặn.
  const dispatchGeneration = nextDispatchGeneration(state.dispatchGeneration);
  if (dispatchGeneration === null) {
    return {
      ok: false,
      reason: 'malformed_delivery',
      detail: 'dispatch_generation không còn tăng an toàn — tránh tràn số nguyên.',
    };
  }
  return {
    ok: true,
    to: DELIVERY_STATUS.Queued,
    dispatchGeneration,
  };
}

export type RepublishDecision =
  | DomainOk<{
      /** §5.6.3: republish **không** đổi delivery state. */
      readonly status: DeliveryStatus;
      readonly retainsGeneration: true;
    }>
  | DomainRejection<AdministrativeRecoveryRejection>;

/**
 * Re-publish cho delivery **non-terminal** bị mắc kẹt (§5.6.3).
 *
 * Khác `planAdministrativeRetry` ở hai điểm bản chất, và cả hai đều nằm trong kiểu
 * trả về:
 * 1. Chỉ áp dụng cho non-terminal — `failed` là terminal, không đi đường này.
 * 2. **Không** đổi delivery state và **không** tăng generation: chưa có execution nào
 *    từng chạy (delivery còn `pending` chưa từng được claim), nên không có execution
 *    cũ nào cần bị fence. Trả về `status` hiện tại thay vì một state mới.
 *
 * Publisher mới là actor của `pending → queued` (§6.2) — hàm này chỉ tạo intent.
 */
export function planDeliveryRepublish(
  state: DeliveryLeaseState,
  precondition: AdministrativeRecoveryPrecondition,
): RepublishDecision {
  if (!state || isMalformedLeaseState(state)) {
    return {
      ok: false,
      reason: 'malformed_delivery',
      detail: 'Delivery state không đúng shape tối thiểu của domain.',
    };
  }
  // Cùng lý do như `planAdministrativeRetry`: `now` không hợp lệ làm cổng chặn
  // `expires_at` bị vô hiệu (fail-open), và `precondition` hỏng không được ném.
  if (!precondition || !isEpochMillis(precondition.now)) {
    return {
      ok: false,
      reason: 'malformed_delivery',
      detail: 'Tham số precondition (now) không hợp lệ.',
    };
  }
  if (isTerminalDeliveryStatus(state.status)) {
    return {
      ok: false,
      reason: 'not_non_terminal',
      detail: 'Re-publish chỉ dành cho delivery non-terminal.',
    };
  }
  if (state.expiresAt <= precondition.now) {
    return {
      ok: false,
      reason: 'notification_expired',
      detail: 'Notification đã quá expires_at — không còn đường republish.',
    };
  }
  if (
    !isSubscriptionStatus(precondition.subscriptionStatus) ||
    isClosedSubscriptionStatus(precondition.subscriptionStatus)
  ) {
    return {
      ok: false,
      reason: 'ineligible_subscription',
      detail: 'Subscription không active — không đủ tiền điều kiện republish.',
    };
  }
  if (
    !isProviderStatus(precondition.providerStatus) ||
    typeof precondition.providerEmergencyHold !== 'boolean'
  ) {
    return {
      ok: false,
      reason: 'malformed_delivery',
      detail: 'Provider fact nằm ngoài vocabulary của domain.',
    };
  }
  if (precondition.providerEmergencyHold) {
    return {
      ok: false,
      reason: 'provider_hold',
      detail: 'Provider đang emergency hold — không đủ tiền điều kiện republish.',
    };
  }
  if (precondition.hasOpenOutboxIntent) {
    return {
      ok: false,
      reason: 'open_outbox_intent',
      detail: 'Đã có outbox intent đang chờ publish cho delivery này — chống dồn intent.',
    };
  }
  return { ok: true, status: state.status, retainsGeneration: true };
}
