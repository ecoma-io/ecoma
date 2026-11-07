/**
 * `POST /v1/notifications` — Application API tạo `Push Notification`.
 *
 * **Thứ tự các bước là một phần của hợp đồng**, không phải chi tiết hiện thực: FR-008 yêu
 * cầu reject trong chuỗi `validate → persist → route → enqueue`, và tài liệu cấm rõ hai
 * điều: persist rồi mới fail ở delivery time (payload budget), và cắt recipient âm thầm khi
 * vượt fan-out. Thứ tự ở đây là:
 *
 * ```text
 * 1. app khớp authenticated principal   (§8.2 — body KHÔNG phải nguồn của app)
 * 2. Idempotency-Key bắt buộc, ≤ 128    (FR-008)
 * 3. tra idempotency record              → replay 200 hoặc 409, **không** ghi gì
 * 4. kiểm ngân sách payload 3993 octets (FR-008 — trước khi có bất kỳ ghi nào)
 * 5. rate limit theo app                 (FR-021 — trước khi tốn tài nguyên routing)
 * 6. fan-out limit (fail-closed)         (FR-008 — vượt thì reject, không cắt)
 * 7. routing: device → subscription → provider (FR-009)
 * 8. materialize + persist trong MỘT db.batch() (FR-013)
 * ```
 *
 * ⚠️ Bước 3 **trước** bước 4 một cách có chủ đích: replay là một truy vấn kết quả của một
 * request đã được accept (FR-008), nên nó phải trả kết quả đó bất kể payload gửi lại có còn
 * hợp lệ hay không — kiểm payload trước sẽ biến một replay hợp lệ thành `400` khi rule
 * validate đã đổi. Ngược lại, một request **mới** vẫn phải qua validate ở bước 4, vì lời gọi
 * mới không có kết quả nào để trả về.
 */

import {
  checkPayloadPlaintextBudget,
  DELIVERY_STATUS,
  isSubscriptionEligibleForDelivery,
  selectPrimaryProvider,
  selectSubscriptionsForDevice,
  serializePayloadCanonically,
  type NotificationPayload,
  type ProviderRoutingFact,
  type RoutingSubscriptionFact,
} from '@ecoma-io/push-notification-domain';
import type { PushNotificationConfig } from './config-port';
import type { PushNotificationPorts } from './ports';
import type {
  DeliveryRecord,
  IdempotencyRecord,
  NotificationRecord,
  OutboxIntentInput,
  SubscriptionRecord,
  Transport,
} from './records';

/* -------------------------------------------------------------------------------------- */
/* Kết quả                                                                                    */
/* -------------------------------------------------------------------------------------- */

/**
 * Kết quả tạo notification — **discriminated union** thay vì một object có cờ.
 *
 * ⚠️ Vì sao không có `expiresAt` trên nhánh replay: một replay trả `notification_id` của
 * lần trước, và việc đọc lại notification chỉ để điền một trường là một query không đổi hành
 * vi. `expiresAt` là dữ liệu của **notification**, không phải của **lời gọi này** — và một
 * giá trị bịa (ví dụ `0`) ở đây là kiểu lỗi mà không ai kiểm được vì nó không ảnh hưởng
 * HTTP status. Kết quả replay vì thế có **đúng** hai trường mà FR-008 hứa.
 */
export type CreateNotificationResult =
  | {
      readonly ok: true;
      readonly replayed: false;
      readonly notificationId: string;
      readonly deliveriesCreated: number;
      readonly expiresAt: number;
    }
  | {
      readonly ok: true;
      readonly replayed: true;
      readonly notificationId: string;
    }
  | { readonly ok: false; readonly reason: CreateNotificationRejection; readonly detail: string };

/**
 * Tập `reason` từ chối — **đóng**. Mỗi giá trị ánh xạ thẳng một HTTP status ở composition
 * root; thêm một giá trị ở đây nghĩa là thêm một status mà chưa ai quyết định.
 */
export const CREATE_NOTIFICATION_REJECTION = {
  AppMismatch: 'app_mismatch',
  IdempotencyKeyMissing: 'idempotency_key_missing',
  IdempotencyKeyTooLong: 'idempotency_key_too_long',
  IdempotencyKeyConflict: 'idempotency_key_conflict',
  InvalidPayload: 'invalid_payload',
  PayloadOverBudget: 'payload_over_budget',
  RateLimited: 'rate_limited',
  FanoutLimitExceeded: 'fanout_limit_exceeded',
  NoEligibleSubscription: 'no_eligible_subscription',
  StorageFailure: 'storage_failure',
} as const;

export type CreateNotificationRejection =
  (typeof CREATE_NOTIFICATION_REJECTION)[keyof typeof CREATE_NOTIFICATION_REJECTION];

/** Request đã chuẩn hoá — những gì use case cần, không phải wire shape. */
export interface CreateNotificationCommand {
  /** `app` trong body. **Phải** khớp principal; xem `authenticatedApp`. */
  readonly requestedApp: string;
  /** `app` derive từ authenticated principal (`§8.2`). */
  readonly authenticatedApp: string;
  /** Định danh ổn định của caller **đã xác thực** — scope của idempotency (FR-008). */
  readonly principalId: string;
  readonly idempotencyKey: string;
  readonly recipients: readonly string[];
  /** Payload đã qua `validateNotificationPayload` của contracts. */
  readonly payload: NotificationPayload;
}

/** Sinh id — port để test xác định được id mà không phải mock `crypto`. */
export interface IdGenerator {
  /** Id mới cho một entity. V1 dùng `crypto.randomUUID()`. */
  next(): string;
}

/**
 * Canonical request hash của một lần gọi `POST /v1/notifications` — dùng cho FR-008
 * ("cùng key + **cùng** canonical request hash" → `200`; khác hash → `409`).
 *
 * ⚠️ Hash phải **ổn định theo nghĩa ngữ nghĩa**: hai request mang cùng nội dung phải cho
 * cùng hash bất kể thứ tự khoá `data` và bất kể thứ tự `recipients`. Vì vậy payload được
 * serialize **canonical** (thứ tự khoá cố định, `01-architecture.md` §6.3) và tập recipient
 * được sắp trước khi nối vào chuỗi hash.
 *
 * ⚠️ `hashValue` do composition root cung cấp. Application **không** tự chọn thuật toán
 * digest cho `Idempotency-Key`: đây là hash nội bộ so sánh trong D1, **không phải**
 * `payload_digest` của contract claim — và `payload_digest_algorithm` là open item, nên hai
 * thứ này cố ý là hai thứ khác nhau với hai vòng đời khác nhau.
 */
export interface RequestHasher {
  hash(value: string): Promise<string>;
}

/** Dependency của use case — config + port + hai hàm thuần cho phép test. */
export interface CreateNotificationDeps {
  readonly config: PushNotificationConfig;
  readonly ports: PushNotificationPorts;
  readonly ids: IdGenerator;
  readonly hasher: RequestHasher;
}

/* -------------------------------------------------------------------------------------- */
/* Canonical request hash                                                                    */
/* -------------------------------------------------------------------------------------- */

/**
 * Sắp recipient theo thứ tự tăng dần (lexicographic, theo **code unit** của JS — cùng thứ
 * tự với `Array#sort()` mặc định).
 *
 * ⚠️ Vì sao không dùng `Array#sort`: repo cấm `unicorn/no-array-sort`, và `lib` của workspace
 * là `es2022` nên chưa có `toSorted` (cùng lý do `deriveTransportPriorityOrder` của domain viết
 * bằng tay).
 *
 * ⚠️ So sánh dùng `<` chứ không dùng `localeCompare`. `localeCompare` phụ thuộc ICU — tức
 * thứ tự so sánh **có thể khác nhau giữa hai runtime Workers**, và `Intl` trong một
 * environment hẹp còn có thể rơi về root locale. Một hash phải ổn định qua mọi deployment,
 * nên chỉ dùng toán tử so sánh chuỗi thuần của JS. Đây cũng là lý do thứ tự này chỉ dùng để
 * tính hash chứ không phải để hiển thị: thứ tự `recipients` trong request không mang ý nghĩa
 * nghiệp vụ, nên hai request chỉ khác thứ tự phải là **cùng** một request.
 *
 * ⚠️ Insertion sort, không phải thuật toán nhanh: `recipients` bị chặn bởi
 * `defaultMaxDeliveriesPerNotification` / fan-out limit của FR-008, nên đây là một danh sách
 * nhỏ; ưu tiên là không có đường nào phụ thuộc vào hành vi của `sort` về mặt ổn định với
 * element bằng nhau.
 */
function canonicalRecipientOrder(recipients: readonly string[]): readonly string[] {
  return recipients.reduce<string[]>((sorted, recipient) => {
    let insertAt = sorted.length;
    for (let index = 0; index < sorted.length; index += 1) {
      if ((sorted[index] as string) > recipient) {
        insertAt = index;
        break;
      }
    }
    sorted.splice(insertAt, 0, recipient);
    return sorted;
  }, []);
}

/**
 * Canonical form của toàn bộ request trước khi hash.
 *
 * ⚠️ Đây là **một** định dạng, không phải JSON của request: hai request có `data` khoá khác
 * thứ tự phải hash bằng, và `recipients` là một **tập** chứ không phải danh sách có thứ tự.
 * Có tiền tố phiên bản `v1` để một thay đổi shape request trong tương lai không vô tình làm
 * thay đổi hash của các request cũ — tức một key đã dùng không âm thầm trở thành "cùng key,
 * hash khác" và `409` một cách không giải thích được.
 */
export function canonicalRequestText(command: CreateNotificationCommand): string {
  const recipients = canonicalRecipientOrder(command.recipients);
  return [
    'push-notification/create-notification/v1',
    `app=${command.authenticatedApp}`,
    `recipients=${recipients.join(',')}`,
    `payload=${serializePayloadCanonically(command.payload)}`,
  ].join('\n');
}

/* -------------------------------------------------------------------------------------- */
/* Use case                                                                                   */
/* -------------------------------------------------------------------------------------- */

/**
 * Tạo một `Push Notification` và materialize delivery của nó.
 *
 * ⚠️ **Vì sao policy đọc sau rate limit**: fan-out limit lấy từ `push_routing_policy` của `App`
 * (mặc định tài liệu khi chưa có hàng), tức cần một query. Rate limit là **một câu lệnh có
 * guard** chặn lưu lượng lạm dụng; đặt nó trước nghĩa là request bị từ chối bởi rate limit
 * không tốn query, và chỉ request đã qua hạn mới đọc policy.
 */
export async function createNotification(
  deps: CreateNotificationDeps,
  command: CreateNotificationCommand,
): Promise<CreateNotificationResult> {
  const { config, ports } = deps;

  // (1) `app` MUST derive từ authenticated principal (§8.2). Body là dữ liệu do caller
  // kiểm soát, nên so sánh ở đây là hành động chống vi phạm namespace — không phải kiểm hình
  // thức. Body khớp vẫn là dữ liệu do caller kiểm soát; giá trị được **dùng** là của
  // principal, không phải của body.
  if (command.requestedApp !== command.authenticatedApp) {
    return {
      ok: false,
      reason: CREATE_NOTIFICATION_REJECTION.AppMismatch,
      detail: 'App trong body không khớp app của authenticated principal.',
    };
  }

  // (2) Idempotency-Key bắt buộc, ≤ 128 (FR-008).
  if (typeof command.idempotencyKey !== 'string' || command.idempotencyKey.length === 0) {
    return {
      ok: false,
      reason: CREATE_NOTIFICATION_REJECTION.IdempotencyKeyMissing,
      detail: 'Thiếu Idempotency-Key.',
    };
  }
  if (command.idempotencyKey.length > config.engineering.maxIdempotencyKeyLength) {
    return {
      ok: false,
      reason: CREATE_NOTIFICATION_REJECTION.IdempotencyKeyTooLong,
      detail: `Idempotency-Key vượt trần ${config.engineering.maxIdempotencyKeyLength} ký tự.`,
    };
  }

  const now = ports.clock.now();
  const requestHash = await deps.hasher.hash(canonicalRequestText(command));

  // (3) Replay: tra idempotency record trước mọi validate nghiệp vụ khác.
  const existing = await ports.idempotency.find(
    command.authenticatedApp,
    command.principalId,
    command.idempotencyKey,
  );
  if (existing !== null) {
    if (existing.requestHash === requestHash) {
      // FR-008: `200`, cùng `notification_id`, **không** tạo notification/delivery mới.
      return { ok: true, replayed: true, notificationId: existing.notificationId };
    }
    // FR-008: cùng key + hash khác → `409`, **không** trả `notification_id` của lần trước.
    return {
      ok: false,
      reason: CREATE_NOTIFICATION_REJECTION.IdempotencyKeyConflict,
      detail: 'Idempotency-Key đã dùng cho một request khác.',
    };
  }

  // (4) Payload budget. Shape đã validate ở boundary bằng contracts; ở đây chỉ kiểm ngân sách
  // octet, và đo trên **chính** chuỗi canonical sẽ persist — số đo và số lưu không thể lệch.
  // Đo một chuỗi rồi lưu một chuỗi khác là cách một notification vượt budget vẫn persist.
  const budget = checkPayloadPlaintextBudget(command.payload);
  if (!budget.ok) {
    return {
      ok: false,
      reason:
        budget.reason === 'payload_over_budget'
          ? CREATE_NOTIFICATION_REJECTION.PayloadOverBudget
          : CREATE_NOTIFICATION_REJECTION.InvalidPayload,
      detail: budget.detail,
    };
  }
  const payloadJson = serializePayloadCanonically(command.payload);

  // (5) Rate limit theo `app` (FR-021). `consume` là một lệnh có guard, không phải
  // đọc-rồi-tăng — xem `RateLimitStore`.
  const rateLimit = await ports.rateLimit.consume({
    app: command.authenticatedApp,
    limit: config.engineering.notificationRateLimit,
    windowDurationMs: config.engineering.notificationRateLimitWindowMs,
    now,
  });
  if (!rateLimit.allowed) {
    return {
      ok: false,
      reason: CREATE_NOTIFICATION_REJECTION.RateLimited,
      detail: 'Vượt rate limit của App trong cửa sổ hiện tại.',
    };
  }

  // (6) Fan-out limit: trần là **policy của App**, mặc định tài liệu khi chưa có hàng policy.
  const policy = await ports.routingPolicy.find(command.authenticatedApp);
  const maxDeliveries =
    policy?.maxDeliveriesPerNotification ?? config.engineering.defaultMaxDeliveriesPerNotification;
  if (command.recipients.length > maxDeliveries) {
    // Reject, **không** cắt bớt recipient (FR-008).
    return {
      ok: false,
      reason: CREATE_NOTIFICATION_REJECTION.FanoutLimitExceeded,
      detail: 'Số recipient vượt trần fan-out của App.',
    };
  }

  // (7) Routing: resolve user → device → subscription (transport priority) → provider.
  const routing = await routeRecipients(deps, command, maxDeliveries);
  if (!routing.ok) {
    return {
      ok: false,
      reason: routing.reason,
      detail: routing.detail,
    };
  }
  if (routing.value.length === 0) {
    return {
      ok: false,
      reason: CREATE_NOTIFICATION_REJECTION.NoEligibleSubscription,
      detail: 'Không recipient nào có subscription active eligible.',
    };
  }

  // (8) Materialize + persist trong **một** `db.batch()` (FR-013).
  const notificationId = deps.ids.next();
  const expiresAt = now + config.sla.maxNotificationTtlMs;
  const notification: NotificationRecord = {
    notificationId,
    app: command.authenticatedApp,
    principalId: command.principalId,
    payloadJson,
    payloadBytes: budget.ok ? budget.plaintextBytes : 0,
    expiresAt,
    createdAt: now,
  };
  const deliveries: DeliveryRecord[] = [];
  const outboxIntents: OutboxIntentInput[] = [];
  for (const routed of routing.value) {
    const deliveryId = deps.ids.next();
    deliveries.push({
      deliveryId,
      notificationId,
      subscriptionId: routed.subscription.subscriptionId,
      providerId: routed.providerId,
      userId: routed.subscription.userId,
      deviceId: routed.subscription.deviceId,
      app: command.authenticatedApp,
      transport: routed.subscription.transport,
      // FR-012: delivery **MUST** được tạo với `status = 'pending'` — routing xảy ra trước
      // khi enqueue, nên lúc commit chưa có message nào trong Queue.
      status: DELIVERY_STATUS.Pending,
      dispatchGeneration: 0,
      leaseExpiresAt: null,
      // `expires_at` nhân bản từ notification **trong cùng batch**: predicate claim của §8.1
      // cần nó nằm trong đúng một statement, không join qua notification.
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });
    outboxIntents.push({
      outboxId: deps.ids.next(),
      deliveryId,
      // Intent tới hạn ngay: nó được ghi trong transaction đã commit, chờ claim (§6.1).
      availableAt: now,
      createdAt: now,
    });
  }
  const idempotency: IdempotencyRecord = {
    app: command.authenticatedApp,
    principalId: command.principalId,
    idempotencyKey: command.idempotencyKey,
    requestHash,
    notificationId,
    createdAt: now,
  };

  try {
    await ports.notifications.persistNotificationWithDeliveries({
      notification,
      deliveries,
      outboxIntents,
      idempotency,
    });
  } catch {
    // ⚠️ Không ném chi tiết lỗi ra ngoài: thông điệp của D1 có thể chứa giá trị bind (payload,
    // endpoint) và đi vào log của Worker. Lỗi unique constraint của idempotency là **kết
    // quả bình thường** của đua đồng thời (FR-008) — request thua sẽ đọc lại record ở đây
    // và nhận kết quả idempotent, nên nó không phải lỗi cần alert. Chỉ coi là StorageFailure
    // khi không có record nào được ghi (lỗi storage thật sự).
    const raced = await ports.idempotency.find(
      command.authenticatedApp,
      command.principalId,
      command.idempotencyKey,
    );
    if (raced !== null) {
      if (raced.requestHash === requestHash) {
        // FR-008: đua đồng thời thua — trả cùng shape replay thành công.
        return { ok: true, replayed: true, notificationId: raced.notificationId };
      }
      return {
        ok: false,
        reason: CREATE_NOTIFICATION_REJECTION.IdempotencyKeyConflict,
        detail: 'Idempotency-Key đã dùng cho một request khác.',
      };
    }
    return {
      ok: false,
      reason: CREATE_NOTIFICATION_REJECTION.StorageFailure,
      detail: 'Không persist được notification (lỗi storage hoặc đua idempotency).',
    };
  }

  // Audit ghi **sau** khi batch đã commit. Audit là bằng chứng quan sát được (FR-020),
  // không phải điều kiện của kết cục: nếu audit thất bại, notification đã persist vẫn là
  // kết cục thật — phải trả thành công, chỉ log để operator thấy (B-11). Không chứa
  // payload/endpoint/secret (FR-020, SR-005).
  try {
    await ports.audit.append({
      auditId: deps.ids.next(),
      event: 'notification_created',
      actor: command.principalId,
      entityType: 'push_notification',
      entityId: notificationId,
      detail: { app: command.authenticatedApp, deliveries: deliveries.length },
      now,
    });
  } catch {
    // eslint-disable-next-line no-console -- application không có logger port; Workers ghi log qua console.
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'push-notification',
        message: 'notification_created_audit_append_failed',
        notificationId,
        app: command.authenticatedApp,
      }),
    );
  }

  return {
    ok: true,
    replayed: false,
    notificationId,
    deliveriesCreated: deliveries.length,
    expiresAt,
  };
}

/* -------------------------------------------------------------------------------------- */
/* Routing                                                                                   */
/* -------------------------------------------------------------------------------------- */

interface RoutedDelivery {
  readonly subscription: SubscriptionRecord;
  readonly providerId: string;
}

type RoutingOutcome =
  | { readonly ok: true; readonly value: readonly RoutedDelivery[] }
  | { readonly ok: false; readonly reason: CreateNotificationRejection; readonly detail: string };

/**
 * Routing hoàn tất trước khi enqueue (FR-009): resolve → filter → policy → transport →
 * provider → create. Worker không làm lại (FR-009, `01-architecture.md` §6.3).
 *
 * ⚠️ **Vì sao provider được chọn theo `(app, transport)` chứ không theo subscription:**
 * `selectPrimaryProvider` nhận danh sách provider của **scope**, và FR-005 định nghĩa
 * primary theo `App` + `Transport`. Nhiều subscription cùng transport (FR-002: một device có
 * thể có nhiều subscription) dùng chung **một** provider — đó là ý nghĩa của "primary".
 *
 * ⚠️ **Vì sao mỗi device đi qua vòng lặp riêng:** FR-011 cấm coi hai subscription cùng
 * `User` là cùng một `Device`, và priority chỉ áp dụng **trong** một device. Gộp subscription
 * của nhiều device vào một lọc là đúng lỗi mà FR-011 nêu.
 */
async function routeRecipients(
  deps: CreateNotificationDeps,
  command: CreateNotificationCommand,
  maxDeliveries: number,
): Promise<RoutingOutcome> {
  const { ports } = deps;
  const app = command.authenticatedApp;
  const routed: RoutedDelivery[] = [];

  // Provider cache **theo transport**, trong phạm vi một lời gọi: một scope `(app, transport)`
  // chỉ cần tra một lần dù có bao nhiêu subscription/device. Đây là cache của một lời gọi,
  // không phải state node-local (`AGENTS.md` — không thêm state phá recovery).
  const providerByTransport = new Map<string, string | null>();

  for (const recipient of canonicalRecipientOrder(command.recipients)) {
    const devices = await ports.devices.listByUser(app, recipient);
    for (const device of devices) {
      const subscriptions = await ports.subscriptions.listByDevice(app, device.deviceId);
      const facts: RoutingSubscriptionFact[] = subscriptions.map((subscription) => ({
        subscriptionId: subscription.subscriptionId,
        app: subscription.app,
        deviceId: subscription.deviceId,
        transport: subscription.transport,
        status: subscription.status,
      }));
      const selected = selectSubscriptionsForDevice(app, device.deviceId, facts);
      if (!selected.ok) {
        if (selected.reason === 'malformed_subscription') {
          // Dữ liệu hỏng — **không** biến thành "device chưa đăng ký" (FR: malformed input
          // không được âm thầm trở thành "không tìm thấy"). Từ chối cả request: nếu chỉ bỏ qua
          // device này thì notification được tạo thiếu một delivery mà không ai biết.
          return {
            ok: false,
            reason: CREATE_NOTIFICATION_REJECTION.StorageFailure,
            detail: 'Subscription record sai shape — từ chối thay vì gửi sai nơi.',
          };
        }
        // `no_eligible_subscription` / `malformed_selector`: device này không có gì để gửi.
        // Bỏ qua **device**, không bỏ qua cả request — device khác của cùng user vẫn hợp lệ.
        continue;
      }

      const recordsById = new Map(
        subscriptions.map((subscription) => [subscription.subscriptionId, subscription] as const),
      );
      for (const fact of selected.subscriptions) {
        const record = recordsById.get(fact.subscriptionId);
        // `eligible` ở domain đã lọc `status = active`; đây là guard kép vì
        // `SubscriptionRecord` đến từ storage, và một implementation khác có thể trả về
        // một tập rộng hơn mà vẫn đúng kiểu.
        if (record === undefined || !isSubscriptionEligibleForDelivery(record.status)) {
          continue;
        }
        const providerId = await resolvePrimaryProviderId(
          deps,
          app,
          record.transport,
          providerByTransport,
        );
        if (providerId === null) {
          // Không có provider eligible cho scope này: **không** tạo delivery. Đây là FR-005
          // (fail safely) và NFR-001 (failure của một provider không làm hỏng App khác).
          continue;
        }
        routed.push({ subscription: record, providerId });
      }
    }
  }

  // Fan-out limit áp **lại** sau routing: một recipient có 3 device × 2 subscription vẫn là
  // **một** recipient ở bước 6 nhưng tạo 6 delivery. Vượt trần ở đây thì reject **toàn bộ**
  // request — cắt bớt là hành vi FR-008 cấm.
  if (routed.length > maxDeliveries) {
    return {
      ok: false,
      reason: CREATE_NOTIFICATION_REJECTION.FanoutLimitExceeded,
      detail: 'Số delivery sau routing vượt trần fan-out của App.',
    };
  }

  return { ok: true, value: routed };
}

/**
 * Resolve primary provider cho `(app, transport)`, có cache trong phạm vi một lời gọi.
 *
 * Trả `null` khi không có provider **đủ điều kiện**, kể cả khi có nhiều provider enabled
 * (`ambiguous`): FR-005 yêu cầu fail safely, `MUST NOT` chọn random và `MUST NOT` chọn theo
 * thứ tự database. Domain đã quyết định việc đó; ở đây chỉ chuyển rejection thành "không
 * route" — và **không** log tên provider, vì tên provider là dữ liệu cấu hình của một App.
 */
async function resolvePrimaryProviderId(
  deps: CreateNotificationDeps,
  app: string,
  transport: Transport,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const cached = cache.get(transport);
  if (cached !== undefined) {
    return cached;
  }
  const providers: readonly ProviderRoutingFact[] = await deps.ports.providers.listByScope(
    app,
    transport,
  );
  const selected = selectPrimaryProvider(providers, app, transport);
  const providerId = selected.ok ? selected.provider.providerId : null;
  cache.set(transport, providerId);
  return providerId;
}
