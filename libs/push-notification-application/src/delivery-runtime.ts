/**
 * Private delivery runtime API — `claim` · `release` · `outcome` · `invalidate`.
 *
 * Canonical: `docs/applications/push-notification/01-architecture.md` §8.1. Đây là **bốn**
 * operation duy nhất của interface đó (operation set đóng), và cả bốn dùng một nguyên tắc
 * chung:
 *
 * > Mọi quyết định thắng/thua nằm trong **chính statement ghi** (`meta.changes`, DB3). Lần đọc
 * > chẩn đoán chỉ **đặt tên** lý do cho `409`; nó không bao giờ là nguồn quyết định.
 *
 * Vì vậy ở đây **không** có mẫu hình "đọc rồi ghi": `claimDelivery` gọi một method guarded,
 * và chỉ khi method đó trả `null` mới có **một** lần đọc chẩn đoán.
 *
 * ⚠️ **Vì sao credential được resolve sau khi claim thắng, không trước:** nếu tra trước thì
 * một claim thua cũng đã đọc (và giải mã) secret — tức một caller không giữ lease đã chạm
 * vào credential. FR-006/§8.1 nói credential chỉ trả cho execution vừa thắng; resolve sau là
 * cách làm bất biến đó đúng **ở tầng code** chứ không chỉ ở tầng response.
 */

import {
  claimRejection,
  deliveryClaim,
  invalidateAck,
  isTerminalDeliveryStatus,
  outcomeAck,
  releaseAck,
  type ClaimRejection,
  type DeliveryClaim,
  type InvalidateAck,
  type OutcomeAck,
  type ReleaseAck,
  type TerminalDeliveryStatus,
} from '@ecoma-io/push-notification-contracts';
import {
  DELIVERY_TRANSITION_ACTOR,
  decideDeliveryClaim,
  decideFencedWrite,
  disableSubscription,
  SUBSCRIPTION_DISABLE_CAUSE,
  type DeliveryLeaseState,
  type DeliveryStatus,
  type FencedWriteOperation,
} from '@ecoma-io/push-notification-domain';
import type { PushNotificationConfig } from './config-port';
import type {
  DeliveryClaimDiagnostics,
  PushNotificationPorts,
  ResolveProviderCredential,
} from './ports';
import type { DeliveryRecord, SubscriptionRecord } from './records';
import { toRfc3339 } from './records';

/** Terminal state để đưa vào `409 terminal`. */
type ClaimTerminalState = TerminalDeliveryStatus;

/* -------------------------------------------------------------------------------------- */
/* Dependency                                                                                 */
/* -------------------------------------------------------------------------------------- */

/** Dependency của bốn use case runtime — config + port + resolver credential. */
export interface DeliveryRuntimeDeps {
  readonly config: PushNotificationConfig;
  readonly ports: PushNotificationPorts;
  /**
   * Đọc + giải mã credential theo `vapid_key_id` **của subscription**.
   *
   * ⚠️ Khoá là `vapid_key_id` của subscription chứ không phải "key hiện tại của App" (FR-006):
   * push service từ chối message ký bằng key khác key dùng lúc tạo subscription, nên một
   * "key hiện tại" là hỏng delivery âm thầm.
   */
  readonly resolveCredential: ResolveProviderCredential;
}

/* -------------------------------------------------------------------------------------- */
/* claim                                                                                     */
/* -------------------------------------------------------------------------------------- */

/**
 * Kết quả claim — union phản ánh **đúng** hai đường của §8.1:
 *
 * - `won` → `200` + `DeliveryClaim` (tập field đóng).
 * - `lost` → `409` + `ClaimRejection` (`reason`, và `state` **chỉ** khi `terminal`).
 *
 * ⚠️ `expired` **không** đổi state (kịch bản 6 của bảng concurrency): delivery vẫn non-terminal
 * cho tới khi reconciliation (c) đánh dấu `expired`. Đó là lý do `lost` không mang state mới.
 */
export type ClaimDeliveryOutcome =
  | { readonly kind: 'won'; readonly body: DeliveryClaim }
  | { readonly kind: 'lost'; readonly body: ClaimRejection };
// ⚠️ Field `body` (không phải `response`) là có chủ đích — cùng lý do với
// `InvalidateOutcome` bên dưới: giá trị là THÂN HTTP handler sẽ serialize
// (contract đóng của §8.1), không phải một `Response` của fetch/h3, và rule
// Semgrep `.github/semgrep/security.yml` nhận diện dữ liệu nhạy cảm qua field
// `response` (`x.response`) nên tên `response` trên object kết quả use case
// kéo FP vào mọi handler gọi `json(outcome.response)`.

/**
 * `POST /internal/deliveries/:delivery_id/claim`.
 *
 * @param now **Không** truyền vào: §8.1 yêu cầu control plane xác định `now` **một lần** cho cả
 *   predicate lẫn `lease_expires_at`, nên nó đọc từ `PushClock` ngay trong use case. Truyền `now`
 *   từ ngoài là mở đường cho hai giá trị khác nhau giữa predicate và write.
 */
export async function claimDelivery(
  deps: DeliveryRuntimeDeps,
  deliveryId: string,
): Promise<ClaimDeliveryOutcome> {
  const { config, ports } = deps;
  const now = ports.clock.now();

  // (1) Guarded conditional write — chỉ một statement quyết định thắng/thua (§8.1).
  const claimed = await ports.deliveries.claimDelivery({
    deliveryId,
    now,
    leaseDurationMs: config.engineering.deliveryLeaseDurationMs,
  });

  if (claimed === null) {
    // (2) Thua → **một** lần đọc chẩn đoán, theo thứ tự cố định của §8.1. `now` truyền vào
    // là **cùng** giá trị predicate vừa dùng — xem `diagnoseClaimRejection`.
    const diagnostics = await ports.deliveries.findClaimDiagnostics(deliveryId, now);
    return { kind: 'lost', body: diagnoseClaimRejection(diagnostics, now) };
  }

  // (3) Thắng → material cho execution đang giữ lease.
  const leaseExpiresAt = claimed.leaseExpiresAt;
  if (leaseExpiresAt === null) {
    // Nhánh guard của domain: `processing` không mang lease là trạng thái không tồn tại, và
    // response `200` mang một `lease_expires_at` bịa là hỏng ở consumer. Không có `reason`
    // hợp đồng cho nó → `409 terminal`.
    return { kind: 'lost', body: claimRejection('terminal', 'cancelled') };
  }

  const subscription = await ports.subscriptions.findById(claimed.subscriptionId);
  const provider = await ports.providers.findById(claimed.providerId);
  if (subscription === null || provider === null) {
    // Dữ liệu hỏng giữa lúc claim và lúc đọc — `EXISTS` trong statement claim vừa thỏa, nên
    // đây là race với một thay đổi dữ liệu, không phải nhánh bình thường. Lease đã cấp nên
    // **không** hoàn tác: `release` là đường duy nhất đưa `processing` về `queued`, và gọi nó
    // ở đây là một write không mang guard. `409 terminal` khiến worker không gọi provider và
    // ACK an toàn; delivery còn giữ lease tới khi hết hạn rồi reconciliation xử lý.
    return { kind: 'lost', body: claimRejection('terminal', 'cancelled') };
  }

  // ⚠️ Credential resolve **sau** khi claim thắng: tra trước thì một claim thua cũng đã đọc
  // (và giải mã) secret — tức một caller không giữ lease đã chạm vào credential.
  const credential = await deps.resolveCredential(
    claimed.app,
    claimed.providerId,
    subscription.vapidKeyId,
  );
  if (credential === null) {
    // Không resolve được `vapid_key_id` là **permanent failure** của attempt phía worker
    // (FR-006/§7.2): không có fallback sang key khác. Control plane không có `reason` nào trong
    // tập đóng cho việc này, nên `409 terminal` là lựa chọn fail-closed **duy nhất**: worker
    // không gọi provider và ACK an toàn, thay vì nhận một `reason` ngoài contract.
    return { kind: 'lost', body: claimRejection('terminal', 'cancelled') };
  }

  // `payload_digest` optional (§8.1 — thuật toán là open item): chỉ gắn khi digester được cấu
  // hình, và **không** dùng nó để dựng lại payload.
  const digest = await digestIfConfigured(deps, claimed.notificationId);

  return {
    kind: 'won',
    body: deliveryClaim({
      delivery_id: claimed.deliveryId,
      notification_id: claimed.notificationId,
      app: claimed.app,
      // Literal của contract, không phải state đọc lại: sau claim thắng state **là**
      // `processing`, và viết lại từ `claimed.status` sẽ biến một hằng của contract thành
      // dữ liệu — tức một hàng hỏng trong storage có thể làm response sai shape.
      status: 'processing',
      // Storage giữ epoch millis; contract §8.1 đòi RFC3339 string trên wire.
      expires_at: toRfc3339(claimed.expiresAt),
      ...(digest === null ? {} : { payload_digest: digest }),
      dispatch_generation: claimed.dispatchGeneration,
      lease_expires_at: toRfc3339(leaseExpiresAt),
      transport: claimed.transport,
      provider_id: claimed.providerId,
      subscription_id: claimed.subscriptionId,
      subscription: {
        endpoint: subscription.endpoint,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        // FR-006: worker ký bằng key theo `vapid_key_id` **của subscription**, không phải
        // "key hiện tại của App".
        vapid_key_id: subscription.vapidKeyId,
      },
      provider: {
        type: provider.type,
        configuration: provider.configuration,
        credential: { ...credential },
      },
    }),
  };
}

/**
 * Tính `payload_digest` **chỉ** khi thuật toán đã được cấu hình.
 *
 * ⚠️ Ở v1 `payload_digest_algorithm` chỉ có giá trị hợp lệ `none`, nên nhánh này luôn trả
 * `null`. Viết nó dưới dạng "có cấu hình mới tính" thay vì xoá hẳn là có chủ đích: khi operator
 * chốt thuật toán, chỉ cần đổi một giá trị config và thêm một giá trị vào
 * `SUPPORTED_PAYLOAD_DIGEST_ALGORITHM` — không phải sửa lại một đường ghi trạng thái claim đã
 * nằm trong contract.
 */
async function digestIfConfigured(
  deps: DeliveryRuntimeDeps,
  notificationId: string,
): Promise<string | null> {
  if (deps.config.sla.payloadDigestAlgorithm === 'none') {
    return null;
  }
  const notification = await deps.ports.notifications.findById(notificationId);
  if (notification === null) {
    return null;
  }
  return deps.ports.payloadDigester.digest(notification.payloadJson);
}

/**
 * Đặt tên lý do cho `409` từ một lần đọc chẩn đoán.
 *
 * ⚠️ Thứ tự tuyến tín hoá đúng của §8.1 (`terminal` → `expired` →
 * `ineligible_subscription` → `ineligible_provider_hold` → `lease_held` → `pending`) được
 * **suy ra** bằng cách đưa state qua chính `decideDeliveryClaim` của domain, chứ không viết
 * lại chuỗi so sánh ở đây. Lý do: tập `reason` và thứ tự là **hợp đồng** với delivery plane,
 * và một bản sao ở application là nguồn thứ hai có thể trôi dạt khỏi domain — biểu hiện là
 * worker không nhận biết `reason` nào để xử lý.
 *
 * ⚠️ `now` truyền vào là **cùng** `now` mà claim vừa dùng. Đó là bắt buộc cho nhất quán với
 * predicate vừa thua: nếu lấy thời gian hai lần, một delivery đã chuyển `queued` giữa hai
 * mốc đó có thể ra hai `reason` khác nhau cho cùng một request.
 *
 * ⚠️ `leaseDurationMs = 1` biến kết quả `ok` thành `lease_held`: lần đọc chẩn đoán
 * **không được cấp lease**. Nếu `decideDeliveryClaim` trả `ok` ở đây thì state đã đổi giữa
 * lúc claim và lúc đọc (một execution khác vừa claim/release) — tức lời gọi thứ hai có thể
 * đang là kẻ thắng, và trả `200` cho nó sẽ cấp hai lease. `lease_held` là fail-closed: worker
 * không gọi provider, và lần gọi sau sẽ thấy state mới.
 */
function diagnoseClaimRejection(
  diagnostics: DeliveryClaimDiagnostics | null,
  now: number,
): ClaimRejection {
  if (diagnostics === null) {
    // Delivery không tồn tại. Tập `reason` của §8.1 **không** có `not_found`, và contract
    // cấm phân biệt "không có quyền" với "không tìm thấy" — nên `409 terminal` là câu trả
    // lời hợp đồng duy nhất: worker ACK an toàn, không gọi provider, không rò tồn tại.
    return claimRejection('terminal', 'cancelled');
  }
  const { delivery, subscriptionStatus, providerStatus, providerEmergencyHold } = diagnostics;
  const decision = decideDeliveryClaim(leaseStateOf(delivery), {
    now,
    leaseDuration: 1,
    subscriptionStatus,
    providerStatus,
    providerEmergencyHold,
  });
  if (decision.ok) {
    return claimRejection('lease_held');
  }
  if (decision.reason === 'terminal' || decision.reason === 'malformed_delivery') {
    return claimRejection('terminal', terminalStateOf(delivery.status));
  }
  return claimRejection(decision.reason);
}

/** Chuyển `DeliveryRecord` sang `DeliveryLeaseState` mà domain hiểu. */
function leaseStateOf(delivery: DeliveryRecord): DeliveryLeaseState {
  return {
    status: delivery.status,
    dispatchGeneration: delivery.dispatchGeneration,
    leaseExpiresAt: delivery.leaseExpiresAt,
    expiresAt: delivery.expiresAt,
  };
}

/**
 * Terminal state để đưa vào `409 terminal`.
 *
 * ⚠️ Non-terminal thì dùng `cancelled` — trạng thái terminal **duy nhất** mà một delivery
 * chưa terminal có thể đánh dấu là hỏng về mặt ngữ nghĩa, và `state` trong `409 terminal`
 * chỉ mang ý nghĩa "đã kết thúc, không còn gì để gửi". Trả lại chính `pending`/`queued`/
 * `processing` sẽ là một `state` mà worker đọc như một trạng thái đã kết thúc trong khi nó
 * thì không — hỏng âm thầm ở phía consumer.
 */
function terminalStateOf(status: DeliveryStatus): ClaimTerminalState {
  return isTerminalDeliveryStatus(status) ? status : 'cancelled';
}

/* -------------------------------------------------------------------------------------- */
/* release / outcome — hai operation ghi kèm fencing token                                    */
/* -------------------------------------------------------------------------------------- */

/**
 * Kết quả chung của `release`/`outcome`.
 *
 * `409` ở cả hai operation đều dẫn tới **cùng** một hành vi của worker (ACK an toàn, không gọi
 * provider, không retry mù — §8.1), nên `FencedWriteOutcome` là **một** kiểu cho cả hai
 * operation: tách làm hai kiểu sẽ tạo ra hai nhánh xử lý giống hệt nhau ở composition root mà
 * không có lý do khác biệt nào.
 */
export type FencedWriteOutcome =
  | { readonly kind: 'ok'; readonly ack: ReleaseAck | OutcomeAck }
  | {
      readonly kind: 'conflict';
      readonly reason: 'stale_write' | 'terminal';
      /** Chỉ có mặt khi `reason = 'terminal'` — state terminal thật đã đọc được lúc fence. */
      readonly terminalState?: TerminalDeliveryStatus;
    };

/**
 * `POST /internal/deliveries/:delivery_id/release` — trả lease, **không** phải một kết cục của
 * delivery (§8.1): nó không ghi `failed` và không kết thúc delivery.
 *
 * `status = 'queued'` (đã release trước đó) là `200` **no-op idempotent** cùng generation —
 * đó là lý do predicate của statement phải chấp nhận `queued`, không chỉ `processing`.
 */
export async function releaseDelivery(
  deps: DeliveryRuntimeDeps,
  deliveryId: string,
  dispatchGeneration: number,
): Promise<FencedWriteOutcome> {
  const now = deps.ports.clock.now();
  const verdict = await fence(
    deps,
    deliveryId,
    dispatchGeneration,
    DELIVERY_TRANSITION_ACTOR.ReleaseLease,
  );
  if (verdict.kind === 'conflict') {
    return verdict;
  }
  const updated = await deps.ports.deliveries.releaseLease({
    deliveryId,
    // Generation worker gửi kèm là **token do worker giữ**, và nó là một phần của guard trong
    // statement — không phải generation hiện hành đọc lại ở đây (đọc lại sẽ mở đường cho một
    // write vượt fencing).
    dispatchGeneration,
    now,
  });
  if (updated === null) {
    // Guard trong statement chặn. Có hai nguyên nhân hợp lệ: một execution khác vừa reclaim
    // (generation đã đổi), hoặc delivery vừa chuyển terminal. Cả hai đều là `stale_write` ở
    // đây vì bước `decideFencedWrite` **đã** trả `terminal` cho nhánh terminal trước khi tao
    // tới statement — tức tới được statement là đã qua nhánh đó.
    return { kind: 'conflict', reason: 'stale_write' };
  }
  return {
    kind: 'ok',
    ack: releaseAck({ delivery_id: deliveryId, dispatch_generation: updated.dispatchGeneration }),
  };
}

/**
 * `POST /internal/deliveries/:delivery_id/outcome` — ghi kết quả gửi kèm fencing token.
 *
 * ⚠️ `outcome` chỉ nhận `delivered`/`failed`: `expired` và `cancelled` thuộc control plane
 * (FR-015). Kiểu của contracts đã chặn phần còn lại; ở đây là một union tường minh để một
 * lỗi ở composition root không trở thành ghi sai state ở đây.
 */
export async function recordOutcome(
  deps: DeliveryRuntimeDeps,
  deliveryId: string,
  dispatchGeneration: number,
  outcome: 'delivered' | 'failed',
): Promise<FencedWriteOutcome> {
  const now = deps.ports.clock.now();
  const verdict = await fence(
    deps,
    deliveryId,
    dispatchGeneration,
    DELIVERY_TRANSITION_ACTOR.Outcome,
  );
  if (verdict.kind === 'conflict') {
    return verdict;
  }
  const updated = await deps.ports.deliveries.recordOutcome({
    deliveryId,
    dispatchGeneration,
    outcome,
    now,
  });
  if (updated === null) {
    return { kind: 'conflict', reason: 'stale_write' };
  }
  return {
    kind: 'ok',
    ack: outcomeAck({
      delivery_id: deliveryId,
      outcome,
      dispatch_generation: updated.dispatchGeneration,
    }),
  };
}

/**
 * Chạy `decideFencedWrite` của domain trước khi ghi.
 *
 * ⚠️ Cả hai lớp guard đều còn, và **không** lớp nào thay lớp nào:
 *   - `decideFencedWrite` bắt được `stale_write` khi generation đã đổi và `terminal` khi
 *     delivery đã kết thúc — **trước** một statement ghi, tức trước cả việc mở transaction.
 *   - Guard trong statement bắt được thay đổi xảy ra **giữa** lúc quyết định và lúc ghi.
 * Bỏ một lớp thì vẫn còn lớp kia đúng, nên mất cây bảo vệ cho một trường hợp (thay đổi đúng
 * giữa hai mốc đó) mà không có test nào phát hiện ngay.
 */
async function fence(
  deps: DeliveryRuntimeDeps,
  deliveryId: string,
  dispatchGeneration: number,
  operation: FencedWriteOperation,
): Promise<
  | { kind: 'clear' }
  | {
      kind: 'conflict';
      readonly reason: 'stale_write' | 'terminal';
      readonly terminalState?: TerminalDeliveryStatus;
    }
> {
  const delivery = await deps.ports.deliveries.findById(deliveryId);
  if (delivery === null) {
    return { kind: 'conflict', reason: 'stale_write' };
  }
  const decision = decideFencedWrite(leaseStateOf(delivery), dispatchGeneration, operation);
  if (decision.ok) {
    return { kind: 'clear' };
  }
  if (decision.reason === 'terminal') {
    // State terminal **thật** đi theo conflict: composition root ghim nó vào body `409` —
    // hợp đồng của contracts đòi `state` khi `reason = 'terminal'`, và một hằng thay vì
    // giá trị thật khiến người đọc body khi debug nhận thông tin sai.
    return {
      kind: 'conflict',
      reason: 'terminal',
      terminalState: terminalStateOf(delivery.status),
    };
  }
  return { kind: 'conflict', reason: 'stale_write' };
}

/* -------------------------------------------------------------------------------------- */
/* invalidate                                                                                 */
/* -------------------------------------------------------------------------------------- */

/**
 * Kết quả invalidate — `200` ack đóng 2 field, hoặc `404`.
 *
 * ⚠️ Field `body` (không phải `response`) là có chủ đích: giá trị là THÂN HTTP
 * mà handler sẽ serialize — không phải một `Response` của fetch/h3. rule Semgrep
 * `.github/semgrep/security.yml` nhận diện dữ liệu nhạy cảm qua field `response`
 * (`x.response`), nên tên `response` trên object kết quả use case kéo FP vào mọi
 * handler gọi `json(outcome.response)`. `body` là tên chính xác: đây là payload
 * đóng theo contract, chưa bọc header/status.
 */
export type InvalidateOutcome =
  | { readonly kind: 'ok'; readonly body: InvalidateAck }
  | { readonly kind: 'not_found' };

/**
 * `POST /internal/subscriptions/:subscription_id/invalidate`.
 *
 * ⚠️ Body là **rỗng**: operation `MUST NOT` nhận evidence/payload/credential (§8.1). Điều kiện
 * "provider chứng minh endpoint chết" là policy phía worker; control plane không verify được
 * bằng chứng đó và `MUST NOT` tự fetch endpoint để kiểm chứng (FR-003).
 *
 * Idempotent theo kết quả: gọi lần hai với subscription đã `disabled` trả **cùng** `200`
 * (`disableSubscription` trả `changed: false`), không cần `Idempotency-Key`.
 */
export async function invalidateSubscription(
  deps: DeliveryRuntimeDeps,
  subscriptionId: string,
): Promise<InvalidateOutcome> {
  const now = deps.ports.clock.now();
  const existing = await deps.ports.subscriptions.findById(subscriptionId);
  if (existing === null) {
    // `404` chỉ được trả cho caller **đã xác thực** — `401` xảy ra trước lookup ở composition
    // root (§8.1).
    return { kind: 'not_found' };
  }
  await disableIfActive(deps, existing, now);
  return { kind: 'ok', body: invalidateAck(subscriptionId) };
}

/**
 * Disable subscription khi nó còn `active`, và ghi audit chỉ khi thật sự đổi state.
 *
 * ⚠️ `expired` không có transition sang `disabled` theo model (FR-004), nên một subscription đã
 * `expired` trả **cùng** ack `200`: operation này idempotent theo **kết quả**, và không có lỗi
 * transition nào để báo. Báo lỗi ở đây sẽ biến một thao tác idempotent thành lỗi.
 *
 * ⚠️ Audit chỉ ghi khi `changed: true`: ghi một `subscription_disabled` cho mỗi lần gọi lặp là
 * một audit record nói dối (nó không có thay đổi nào ứng với) — và audit là bằng chứng cho
 * operator, nên một bằng chứng sai còn tệ hơn không có bằng chứng.
 *
 * ⚠️ **Trade-off đã chấp nhận**: `disableById` persist trước, `audit.append` là statement riêng
 * sau đó — crash/D1-blip giữa hai lệnh để lại subscription `disabled/provider_invalidation`
 * không có audit record, và lặp lại thao tác (idempotent theo kết quả) cũng không tạo lại được.
 * Đây là cùng pattern audit-sau-state-write của toàn codebase (`createNotification`,
 * `recordRecovery`, mọi use case `admin-provider.ts`); tách hai port là giữ hợp đồng port
 * đơn mục đích. Trade-off đầy đủ được tài liệu ở `recordRecovery` (`admin-delivery.ts`) —
 * sửa pattern thì sửa một lần cho tất cả.
 */
async function disableIfActive(
  deps: DeliveryRuntimeDeps,
  subscription: SubscriptionRecord,
  now: number,
): Promise<void> {
  const decision = disableSubscription(
    subscription.status,
    SUBSCRIPTION_DISABLE_CAUSE.ProviderInvalidation,
  );
  if (!decision.ok || !decision.changed) {
    return;
  }
  await deps.ports.subscriptions.disableById({
    app: subscription.app,
    subscriptionId: subscription.subscriptionId,
    cause: SUBSCRIPTION_DISABLE_CAUSE.ProviderInvalidation,
    now,
  });
  await deps.ports.audit.append({
    // Id audit suy ra từ `(subscription, nguyên nhân, now)` — không cần một id sinh thêm cho
    // một record mà nội dung là xác định, và nó giữ hai lần chạy của cùng một lời gọi không
    // tạo hai audit record khác nhau.
    auditId: `${subscription.subscriptionId}:invalidate:${now}`,
    event: 'subscription_disabled',
    actor: deps.config.runtimeAuth.expectedPrincipal,
    entityType: 'push_subscription',
    entityId: subscription.subscriptionId,
    detail: { app: subscription.app, cause: SUBSCRIPTION_DISABLE_CAUSE.ProviderInvalidation },
    now,
  });
}
