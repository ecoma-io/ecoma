/**
 * Admin API — administrative retry (FR-015, §5.6.1) và delivery republish (§5.6.3),
 * cùng các list quản trị (FR-017 inspect).
 *
 * ⚠️ **Hai đường phục hồi này KHÁC NHAU về bản chất, và tài liệu cấm gộp.** Chúng phân biệt
 * theo **state của delivery**:
 *
 * | | administrative retry | republish |
 * |---|---|---|
 * | state | `failed` (**terminal**) | **non-terminal** (chủ yếu `pending`) |
 * | đổi state | `failed → queued` | **không** đổi |
 * | generation | **tăng** (execution cũ không ghi đè được) | **giữ nguyên** (chưa execution nào chạy) |
 * | tạo outbox intent | có | có — đúng một |
 * | audit | `delivery_retried` | `delivery_republished` |
 *
 * Gộp thành một `recover(deliveryId)` là xoá đúng ranh giới này, và hậu quả là concrete: một
 * delivery `pending` bị republish **không** được generation mới, vì không có execution cũ nào
 * cần fence — cấp generation mới ở đó là một số không ai theo dõi, và nó làm mất khả năng phân
 * biệt "chưa từng chạy" với "đã chạy rồi bị fence".
 *
 * ⚠️ Cả hai `MUST NOT` mô tả là an toàn tuyệt đối (`01-architecture.md` §5.6.1, §5.6.3):
 * nếu provider **đã nhận** request mà outcome cũ không xác định, hành động này tạo duplicate
 * bên ngoài. Crash window đó là **đã chấp nhận** ở §7 — nó là lý do vì sao cả hai đường đều
 * cần administrative authorization + `reason` + `actor` + audit (FR-020), chứ không phải một
 * retry tự động.
 */

import {
  planAdministrativeRetry,
  planDeliveryRepublish,
  type AdministrativeRecoveryPrecondition,
} from '@ecoma-io/push-notification-domain';

import type {
  DeliveryListFilter,
  ProviderMappingRecord,
  PushNotificationPorts,
  SubscriptionListFilter,
} from './ports';
import {
  AUDIT_EVENT,
  type DeliveryRecord,
  type NotificationRecord,
  type OutboxRecord,
  type ProviderRecord,
  type ProviderStatus,
  type SubscriptionRecord,
  type SubscriptionStatus,
  type Transport,
} from './records';
import { ADMIN_REJECTION, type AdminDeps, type AdminResult } from './admin-provider';

/* -------------------------------------------------------------------------------------- */
/* Input                                                                                       */
/* -------------------------------------------------------------------------------------- */

/** Input chung của hai đường phục hồi — `reason` là **bắt buộc** (FR-020, §5.6.1). */
export interface RecoveryCommand {
  readonly app: string;
  readonly deliveryId: string;
  /** Vì sao operator làm việc này. Bắt buộc vì đây là hành động tạo duplicate bên ngoài. */
  readonly reason: string;
  readonly actor: string;
}

/* -------------------------------------------------------------------------------------- */
/* administrative retry — failed → queued (§5.6.1)                                            */
/* -------------------------------------------------------------------------------------- */

/**
 * `POST /admin/v1/deliveries/:id/retry` — requeue delivery `failed` (§4.2, FR-015).
 *
 * ⚠️ **Đây là transition DUY NHẤT rời terminal state.** Queue redelivery `MUST NOT` hồi sinh
 * delivery terminal, và không có đường code nào khác ghi `failed → *`. Vì vậy `retryFailed`
 * guard bằng `status = 'failed'` **trong statement**, và generation mới do domain tính — không
 * phải một con số do use case tự tăng. Tự tăng sẽ cho phép một admin "đoán" generation và hủy
 * fencing của execution cũ.
 *
 * ⚠️ Tiền điều kiện lấy từ **domain** (`planAdministrativeRetry`), không lặp lại ở đây:
 * subscription `active`, provider không emergency hold, notification chưa quá `expires_at`.
 * Lặp lại ở tầng application là tạo hai nơi phải giữ đồng bộ, và chỗ thứ hai luôn chậm hơn.
 */
export async function administrativeRetry(
  deps: AdminDeps,
  command: RecoveryCommand,
  nowOverride?: number,
): Promise<AdminResult<DeliveryRecord>> {
  const { ports } = deps;
  const now = nowOverride ?? ports.clock.now();

  const delivery = await ports.deliveries.findById(command.deliveryId);
  const scope = checkDeliveryScope(delivery, command.app);
  if (scope !== null) {
    return scope;
  }
  const target = delivery as DeliveryRecord;

  const precondition = toDomainPrecondition(await readRecoveryPrecondition(ports, target, now));
  const decision = planAdministrativeRetry(toLeaseState(target), precondition);
  if (!decision.ok) {
    return {
      ok: false,
      reason: ADMIN_REJECTION.RecoveryPreconditionFailed,
      detail: `${decision.reason}: ${decision.detail}`,
    };
  }

  const updated = await ports.deliveries.retryFailed({
    deliveryId: target.deliveryId,
    dispatchGeneration: decision.dispatchGeneration,
    now,
  });
  if (updated === null) {
    // Domain đã chấp nhận nhưng statement trả `null` → state đổi giữa lúc đọc và lúc ghi
    // (`failed` → đã được một admin khác requeue). Không phải `not_found`: record còn đó.
    return {
      ok: false,
      reason: ADMIN_REJECTION.StateMismatch,
      detail: 'Trạng thái delivery đã đổi sau khi đọc — thao tác không được áp dụng.',
    };
  }

  // §5.6.1: requeue `failed → queued` PHẢI đi kèm **đúng một** outbox intent — nếu không,
  // publisher (predicate chỉ đọc `push_outbox`) không bao giờ nhặt được delivery này và nó
  // nằm `queued` mãi mãi. `retryFailed` (state write) phải thành công trước; chỉ khi delivery
  // đã thực sự `queued` mới tạo intent, để không sinh intent mồ côi cho một delivery chưa
  // requeue. Thứ tự này chấp nhận một crash window giữa hai lệnh (delivery `queued` chưa có
  // intent): delivery lúc đó là **non-terminal** `queued`, nên reconciliation (c) a4 sẽ tạo
  // intent khi nó đủ già — không mất vĩnh viễn. D1 không có BEGIN/COMMIT từ tầng application
  // (chỉ `db.batch()` ở infrastructure), và gộp hai port vào một batch đòi đổi shape port cho
  // mọi use case — không nằm trong phạm vi WA-3.
  const intent = await createIntent(deps, target.deliveryId, now);
  if (intent === null) {
    // `createIntent` trả `null` nghĩa là partial unique index `push_outbox_one_open_intent`
    // chặn: đã có một intent `pending`/`publishing` cho delivery này (race hợp lệ — §4.2,
    // không phải lỗi cần alert). Khi đó delivery vẫn có đường publish qua intent đang mở,
    // nên **không** phải "mất vĩnh viễn".
    //
    // Nhưng `null` còn có thể là va chạm khoá chính (`outbox_id` trùng) — một race khác
    // **không** để lại intent nào. Fail-closed: chỉ coi là thành công khi **thật sự** có
    // intent open; nếu không, delivery `queued` không có gì để publish ⇒ báo lỗi cho operator
    // thay vì trả `{ ok: true }`.
    const hasOpen = await ports.outbox.hasOpenIntent(target.deliveryId);
    if (!hasOpen) {
      return {
        ok: false,
        reason: ADMIN_REJECTION.StorageFailure,
        detail:
          'Delivery đã requeue nhưng không tạo được outbox intent — không có gì để publish; reconciliation sẽ thử lại.',
      };
    }
  }

  await recordRecovery(deps, AUDIT_EVENT.DeliveryRetried, command, target, now, {
    dispatch_generation: decision.dispatchGeneration,
    reason: command.reason,
  });
  return { ok: true, value: updated };
}

/* -------------------------------------------------------------------------------------- */
/* delivery republish — non-terminal bị mắc kẹt (§5.6.3)                                     */
/* -------------------------------------------------------------------------------------- */

/**
 * `POST /admin/v1/deliveries/:id/republish` — tạo **đúng một** outbox intent mới (§4.2).
 *
 * ⚠️ **Không** đổi delivery state và **không** cấp generation. Lý do không phải "đơn giản là
 * không cần" mà là nguyên lý: generation là fencing token, và fencing chỉ có nghĩa đối với một
 * execution **đã từng chạy**. Delivery `pending` chưa từng được claim thì không có execution
 * nào để fence; tăng generation ở đó tạo ra một số không có execution nào mang.
 *
 * ⚠️ `pending → queued` là của **publisher** (§6.2), không phải của use case này. Republish chỉ
 * tạo intent; delivery vẫn `pending` cho tới khi publisher đóng outbox record thành công.
 */
export async function republishDelivery(
  deps: AdminDeps,
  command: RecoveryCommand,
  nowOverride?: number,
): Promise<AdminResult<{ readonly delivery: DeliveryRecord; readonly intent: OutboxRecord }>> {
  const { ports } = deps;
  const now = nowOverride ?? ports.clock.now();

  const delivery = await ports.deliveries.findById(command.deliveryId);
  const scope = checkDeliveryScope(delivery, command.app);
  if (scope !== null) {
    return scope;
  }
  const target = delivery as DeliveryRecord;

  // `hasOpenOutboxIntent` là input của domain, và nó là một **đọc** — nhưng nó không phải
  // quyết định: `createIntent` sau đó mới là guard thật (partial unique index). Đọc ở đây chỉ
  // để đưa ra một `detail` hữu ích khi domain từ chối; nếu có race giữa đọc và ghi thì index
  // bắt, và kết quả là `intent_suppressed` chứ không phải một lỗi cần alert.
  const hasOpenOutboxIntent = await ports.outbox.hasOpenIntent(target.deliveryId);
  const precondition = toDomainPrecondition(
    await readRecoveryPrecondition(ports, target, now, hasOpenOutboxIntent),
  );
  const decision = planDeliveryRepublish(toLeaseState(target), precondition);
  if (!decision.ok) {
    return {
      ok: false,
      reason: ADMIN_REJECTION.RecoveryPreconditionFailed,
      detail: `${decision.reason}: ${decision.detail}`,
    };
  }

  const intent = await createIntent(deps, target.deliveryId, now);
  if (intent === null) {
    return {
      ok: false,
      reason: ADMIN_REJECTION.OpenOutboxIntent,
      detail: 'Đã có intent open cho delivery này — index chặn intent thứ hai.',
    };
  }

  await recordRecovery(deps, AUDIT_EVENT.DeliveryRepublished, command, target, now, {
    outbox_id: intent.outboxId,
    reason: command.reason,
  });
  return { ok: true, value: { delivery: target, intent } };
}

/* -------------------------------------------------------------------------------------- */
/* List quản trị (FR-017 inspect)                                                              */
/* -------------------------------------------------------------------------------------- */

/**
 * `GET /admin/v1/notifications` — danh sách notification theo `App`.
 *
 * ⚠️ `payloadJson` **không** nằm trong response. Notification chứa payload của application;
 * đưa nó vào một list endpoint quản trị là một đường rò payload ra ngoài phạm vi cần thiết,
 * và `03-operations.md` §12 nêu payload nhạy cảm. `payloadBytes` vẫn có — đó là thứ operator
 * cần để điều tra một notification quá lớn.
 */
export async function listNotifications(
  deps: AdminDeps,
  app: string,
  limit: number,
): Promise<readonly Omit<NotificationRecord, 'payloadJson'>[]> {
  return deps.ports.notifications.listByApp(app, limit);
}

/** `GET /admin/v1/deliveries` — list delivery có filter. */
export async function listDeliveries(
  deps: AdminDeps,
  app: string,
  filter: DeliveryListFilter,
): Promise<readonly DeliveryRecord[]> {
  return deps.ports.deliveries.listByApp(app, filter);
}

/**
 * `GET /admin/v1/subscriptions` — list subscription.
 *
 * ⚠️ `endpoint`/`p256dh`/`auth` **không** lọt vào response, dù record nội bộ có chúng: chúng là
 * material mà chỉ delivery plane cần, và một list endpoint là bề mặt bị lạm dụng nhiều nhất.
 * `endpointHash` đủ để operator đối chiếu với một endpoint họ đã biết.
 */
export async function listSubscriptions(
  deps: AdminDeps,
  app: string,
  filter: SubscriptionListFilter,
): Promise<readonly SubscriptionView[]> {
  return deps.ports.subscriptions.listByApp(app, filter);
}

/** Projection của subscription cho Admin API — không có endpoint/key material. */
export type SubscriptionView = Omit<
  SubscriptionRecord,
  'endpoint' | 'p256dh' | 'auth' | 'endpointHash'
>;

/** `GET /admin/v1/devices` — list device của một user trong `App`. */
export async function listDevices(
  deps: AdminDeps,
  app: string,
  userId: string,
): Promise<
  readonly {
    readonly deviceId: string;
    readonly userId: string;
    readonly app: string;
    readonly createdAt: number;
  }[]
> {
  return deps.ports.devices.listByUser(app, userId);
}

/** `GET /admin/v1/providers` — list provider của `App`, kèm mapping primary. */
export async function listProviders(
  deps: AdminDeps,
  app: string,
  limit: number,
): Promise<readonly ProviderRecord[]> {
  return deps.ports.providers.listByApp(app, limit);
}

/** Mapping primary hiện tại của `(app, transport)` — dùng để hiển thị cấu hình scope. */
export async function listPrimaryMappings(
  deps: AdminDeps,
  app: string,
  transports: readonly Transport[],
): Promise<readonly ProviderMappingRecord[]> {
  const mappings = await Promise.all(
    transports.map(async (transport) => deps.ports.providers.findPrimaryMapping(app, transport)),
  );
  return mappings.filter((mapping): mapping is ProviderMappingRecord => mapping !== null);
}

/* -------------------------------------------------------------------------------------- */
/* Helpers                                                                                     */
/* -------------------------------------------------------------------------------------- */

/**
 * Đọc ba precondition mà cả hai đường phục hồi đều cần, trong **một** lượt.
 *
 * ⚠️ Đọc subscription và provider ở đây là read-then-decide **được chấp nhận** — khác với
 * claim. Lý do: các precondition này **không** quyết định thắng/thua của một write; chúng chỉ
 * quyết định có *nên* thử không. Write thật vẫn guarded trong statement của nó (`retryFailed`
 * guard `status = 'failed'`; `createIntent` guard index). Vì vậy một precondition đọc lỗi chỉ
 * khiến use case từ chối sớm — không bao giờ khiến một write sai đi qua.
 *
 * ⚠️ Subscription/provider **không tồn tại** trả `null` chứ không phải một status giả. Domain
 * tự từ chối ở các nhánh `ineligible_subscription` / `provider_hold` / `malformed_delivery` khi
 * fact không hợp lệ, và nhãn đúng của một entity không tồn tại là `not_found` chứ không phải
 * `invalid_*`. Đổi tên chỗ này không đổi hành vi từ chối (vẫn fail-closed), nhưng nó đổi câu
 * trả lời cho operator — và một câu trả lời sai làm việc điều tra chậm hơn thật nhiều.
 */
async function readRecoveryPrecondition(
  ports: PushNotificationPorts,
  delivery: DeliveryRecord,
  now: number,
  hasOpenOutboxIntent?: boolean,
): Promise<PreconditionRead> {
  const subscription = await ports.subscriptions.findById(delivery.subscriptionId);
  const provider = await ports.providers.findById(delivery.providerId);
  return {
    subscriptionStatus: subscription?.status ?? null,
    providerStatus: provider?.status ?? null,
    providerEmergencyHold: provider?.emergencyHold ?? null,
    now,
    hasOpenOutboxIntent: hasOpenOutboxIntent ?? false,
  };
}

/**
 * Precondition sau khi đọc — `null` nghĩa là entity **không tồn tại**.
 *
 * Không phải `AdministrativeRecoveryPrecondition` của domain: domain cố ý **không** nhận
 * `null` ở đây, vì nó muốn vocabulary hẹp và muốn mọi thứ ngoài vocabulary rơi vào
 * `malformed_delivery`. Việc phân biệt "subscription bị xoá" với "subscription `disabled`" là
 * việc của tầng application — nó xuất ra message khác nhau cho operator.
 */
interface PreconditionRead {
  readonly subscriptionStatus: SubscriptionStatus | null;
  readonly providerStatus: ProviderStatus | null;
  /** `null` = provider không tồn tại; domain coi như không đủ điều kiện. */
  readonly providerEmergencyHold: boolean | null;
  readonly now: number;
  readonly hasOpenOutboxIntent: boolean;
}

/**
 * Chuyển `PreconditionRead` sang input của domain.
 *
 * ⚠️ Entity không tồn tại được chiếu thành giá trị **fail-closed**: một subscription không tồn
 * tại được coi như `disabled` (đóng — không eligible), và một provider không tồn tại được coi
 * như **đang emergency hold** (chặn). Chiều ngược lại — coi entity không tồn tại là "eligible" —
 * sẽ cho một delivery của một subscription đã bị xoá đi qua recovery và được gửi lại, tức
 * chính là thứ mà FR-016 cấm.
 */
function toDomainPrecondition(read: PreconditionRead): AdministrativeRecoveryPrecondition {
  return {
    subscriptionStatus: read.subscriptionStatus ?? 'disabled',
    providerStatus: read.providerStatus ?? 'disabled',
    providerEmergencyHold: read.providerEmergencyHold ?? true,
    now: read.now,
    hasOpenOutboxIntent: read.hasOpenOutboxIntent,
  };
}

/**
 * Chiếu `DeliveryRecord` sang `DeliveryLeaseState` của domain.
 *
 * ⚠️ `expiresAt` lấy từ **chính delivery** (một nguồn duy nhất). Domain cố ý không nhận
 * `expires_at` qua `AdministrativeRecoveryPrecondition` — truyền nó vào lần thứ hai là mở ra
 * đúng lớp lỗi mà fencing sinh ra để chặn.
 */
function toLeaseState(delivery: DeliveryRecord): Parameters<typeof planAdministrativeRetry>[0] {
  return {
    status: delivery.status,
    dispatchGeneration: delivery.dispatchGeneration,
    leaseExpiresAt: delivery.leaseExpiresAt,
    expiresAt: delivery.expiresAt,
  };
}

/** Tạo **một** outbox intent; `null` khi index chặn (race — không phải lỗi cần alert, §4.2). */
async function createIntent(
  deps: AdminDeps,
  deliveryId: string,
  now: number,
): Promise<OutboxRecord | null> {
  return deps.ports.outbox.createIntent({
    outboxId: deps.ids.next(),
    deliveryId,
    availableAt: now,
    createdAt: now,
  });
}

function checkDeliveryScope(
  delivery: DeliveryRecord | null,
  app: string,
): {
  readonly ok: false;
  readonly reason: (typeof ADMIN_REJECTION)[keyof typeof ADMIN_REJECTION];
  readonly detail: string;
} | null {
  if (delivery === null) {
    return {
      ok: false,
      reason: ADMIN_REJECTION.DeliveryNotFound,
      detail: 'Delivery không tồn tại.',
    };
  }
  if (delivery.app !== app) {
    return {
      ok: false,
      reason: ADMIN_REJECTION.AppMismatch,
      detail: 'Delivery thuộc app khác — FR-007 cấm dùng chéo app.',
    };
  }
  return null;
}

/**
 * Ghi audit của một recovery operation.
 *
 * ⚠️ **Trade-off đã chấp nhận (toàn codebase)**: audit append xảy ra **sau** khi state write
 * đã persist, không trong cùng batch — cùng pattern với `createNotification` (persist batch
 * xong rồi mới `audit.append`) và mọi use case của `admin-provider.ts`. Crash/D1-blip giữa
 * hai lệnh làm recovery đã áp dụng mà thiếu audit record; đường gọi lại **không** tự tạo lại
 * được (precondition `failed` không còn thoả), nên bằng chứng FR-020 cho lần đó phải tra từ
 * log/trace của Worker. Batch chung đòi đổi shape port (`retryFailed` phải nhận thêm statement
 * audit) cho **mọi** use case một lúc, và vài ms window của cùng-datacenter D1 là rủi ro thấp
 * hơn chi phí một API port hai mục đích. Nếu sửa, sửa toàn bộ pattern một lần — không phải
 * chỉ path này.
 */
async function recordRecovery(
  deps: AdminDeps,
  event: typeof AUDIT_EVENT.DeliveryRetried | typeof AUDIT_EVENT.DeliveryRepublished,
  command: RecoveryCommand,
  delivery: DeliveryRecord,
  now: number,
  extra: Readonly<Record<string, string | number | boolean>>,
): Promise<void> {
  await deps.ports.audit.append({
    auditId: `push_delivery:${event}:${delivery.deliveryId}:${now}`,
    event,
    actor: command.actor,
    entityType: 'push_delivery',
    entityId: delivery.deliveryId,
    detail: {
      app: command.app,
      status_before: delivery.status,
      reason: command.reason,
      ...extra,
    },
    now,
  });
}
