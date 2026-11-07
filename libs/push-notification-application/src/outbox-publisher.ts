/**
 * `Outbox Publisher` — use case của control plane đẩy `Delivery Command` vào Queue
 * (`01-architecture.md` §6.2).
 *
 * ⚠️ **Cơ chế trigger là open launch gate, nhưng handler thì không.** §6.2 nói rõ entry point
 * là `POST /internal/outbox/publish` và cơ chế gọi nó (Cron · relay · khác) **chưa chốt**, đồng
 * thời phân tách hai thuộc tính phải tách rõ:
 *
 *   (i)  Handler no-op thuần khi không có gì để publish — **bắt buộc**, kiểm chứng bằng test:
 *        không `Queue.send()`, không ghi record, không network call.
 *   (ii) Không bị tính phí invocation khi rỗng — **chưa chứng minh**, và use case này không
 *        phải nơi để khẳng định điều đó.
 *
 * ⚠️ **Không network call bên trong D1 transaction** (§6.2). Thứ tự ở đây là: claim → gọi
 * `Queue.send()` → ghi kết quả. Đảo hai bước cuối (ghi `published` rồi mới send) sẽ tạo
 * "message không bao giờ tới Queue" — mất message, tức thứ mà thiết kế ưu tiên duplicate
 * trên đường cố ý loại bỏ.
 *
 * ⚠️ **`pending → queued` chỉ do publisher, và chỉ khi `Queue.send()` thật sự thành công**
 * (FR-015, §6.2). Mọi nhánh lỗi ở đây để yên `pending`.
 */

import {
  deliveryCommandV1,
  validateNotificationPayload,
  type DeliveryCommandPayload,
  type DeliveryCommandV1,
} from '@ecoma-io/push-notification-contracts';
import {
  applyPublisherSuccess,
  canCreateOutboxIntent,
  type DeliveryStatus,
} from '@ecoma-io/push-notification-domain';
import type { PushNotificationConfig } from './config-port';
import type { IdGenerator } from './create-notification';
import type { OutboxRepository, PushNotificationPorts } from './ports';
import type { OutboxRecord } from './records';

/* -------------------------------------------------------------------------------------- */
/* Dependency và kết quả                                                                     */
/* -------------------------------------------------------------------------------------- */

/** Dependency của publisher — config + port + id generator. */
export interface OutboxPublisherDeps {
  readonly config: PushNotificationConfig;
  readonly ports: PushNotificationPorts;
  /**
   * Sinh `outbox_id`.
   *
   * ⚠️ Publisher **không** tạo intent: `MUST NOT` có hành động nào tạo `queued` từ `pending`
   * (§4.2), và tạo intent là việc của reconciliation (a4) hoặc `republish` của operator. Port
   * này có mặt vì `claimedBy` của một lượt cần một token định danh lần claim, và token đó
   * phải là **id sinh ra**, không phải timestamp — hai lượt chạy cùng mili giây sẽ sinh
   * `claimed_by` giống nhau và một lượt sẽ ghi được lên record của lượt kia.
   */
  readonly ids: IdGenerator;
}

/**
 * Kết quả một lượt publish — **đủ để test khẳng định (i)**: `sendCalls` bằng `0` khi không có
 * record đến hạn, và bằng `claimed` khi mọi record đều dựng được envelope.
 */
export interface PublishRunResult {
  /** Số record thực sự claim được. */
  readonly claimed: number;
  /** Số lần gọi `Queue.send()`. */
  readonly sendCalls: number;
  /** Số record đóng thành `published`. */
  readonly published: number;
  /** Số record ghi `failed` ở lượt này (vượt `outboxMaxPublishAttempts`). */
  readonly exhausted: number;
  /** Số record publish lỗi nhưng còn retry được (còn dưới ngưỡng attempts). */
  readonly deferred: number;
  /** Record không publish được vì **dữ liệu hỏng**, không phải vì Queue. */
  readonly skipped: readonly SkipReason[];
  /** Số record bị bỏ qua vì lease đã mất — publish có thể đã xảy ra, nên có thể có duplicate. */
  readonly leaseLost: number;
}

/**
 * Lý do bỏ qua một record — **dữ liệu hỏng hoặc dang dở giữa hai lần ghi**, không phải lỗi Queue.
 *
 * ⚠️ Cần một tập đóng thay vì im lặng bỏ qua: hai trường hợp này đều phải đi vào metric/alert
 * (§11 Outbox) — im lặng là biến một dữ liệu hỏng thành một record mà không ai giải thích được.
 * Đồng thời chúng **không** phải lỗi publish, nên không được đốt `attempts` của Queue.
 */
export type SkipReason =
  /** Delivery của record không tồn tại — orphan intent. */
  | 'delivery_missing'
  /** Notification của delivery không tồn tại — không lấy được `payload_json` ở đâu. */
  | 'notification_missing'
  /** `payload_json` không parse được thành payload đúng schema FR-013. */
  | 'payload_invalid';

/* -------------------------------------------------------------------------------------- */
/* Envelope                                                                                   */
/* -------------------------------------------------------------------------------------- */

/**
 * Dựng `DeliveryCommandV1` từ dữ liệu đã materialize trong D1.
 *
 * ⚠️ Payload được **parse lại từ `payload_json`**, không phải giữ object trong memory: giá
 * trị canonical đã commit trong transaction là nguồn sự thật (§6.3), và object trong memory có
 * thể đến từ một request khác. Parse lại còn bắt được một hàng mà `payload_json` hỏng.
 *
 * ⚠️ Envelope **không** mang `app`/`expires_at`/`dispatch_generation`/`lease_expires_at` và
 * không mang secret: đó là ranh giới của contract. Builder của contracts tự chạy validator
 * canonical nên envelope sai là **throw** ở đây chứ không phải một message hỏng trong Queue.
 */
export function buildDeliveryCommand(input: {
  readonly deliveryId: string;
  readonly notificationId: string;
  readonly subscriptionId: string;
  readonly providerId: string;
  readonly transport: DeliveryCommandV1['transport'];
  readonly payloadJson: string;
}): DeliveryCommandV1 {
  const payload = parsePayload(input.payloadJson);
  if (payload === null) {
    throw new Error('buildDeliveryCommand: payload_json không hợp lệ theo schema FR-013.');
  }
  return deliveryCommandV1({
    delivery_id: input.deliveryId,
    notification_id: input.notificationId,
    subscription_id: input.subscriptionId,
    provider_id: input.providerId,
    transport: input.transport,
    payload,
  });
}

/**
 * Parse `payload_json` thành `DeliveryCommandPayload`, hoặc `null` nếu hỏng.
 *
 * Trả `null` thay vì ném: người gọi dùng nó để **báo** một record hỏng (`payload_invalid`) rồi
 * đi tiếp. `throw` ở đây sẽ làm cả lượt publish chết theo một hàng dữ liệu hỏng — tức một
 * record hỏng chặn được cả lô record tốt.
 *
 * ⚠️ Dùng `validateNotificationPayload` của contracts chứ không tự kiểm từng field: schema
 * payload là một định nghĩa duy nhất của FR-013, và một bản sao ở đây là nguồn thứ hai có
 * thể trôi dạt (thêm một khoá hợp lệ vào schema mà chỗ này không biết).
 */
function parsePayload(payloadJson: string): DeliveryCommandPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson) as unknown;
  } catch {
    return null;
  }
  const checked = validateNotificationPayload(parsed);
  return checked.ok ? checked.payload : null;
}

/* -------------------------------------------------------------------------------------- */
/* Publisher                                                                                  */
/* -------------------------------------------------------------------------------------- */

/**
 * `POST /internal/outbox/publish` — một lượt publish.
 *
 * @param nowOverride Chỉ dùng cho test: ghim một `now` cố định để lượt quét không phụ thuộc
 *   đồng hồ thật. Không truyền ở production — `now` phải đến từ `PushClock` để mọi statement
 *   dùng một mốc.
 */
export async function publishOutbox(
  deps: OutboxPublisherDeps,
  claimedBy: string,
  nowOverride?: number,
): Promise<PublishRunResult> {
  const { config, ports } = deps;
  const now = nowOverride ?? ports.clock.now();

  // (1) Claim một lô bằng **một** guarded conditional write (§6.1). `failed` không nằm trong
  // predicate: chỉ operator mới đưa nó về đường publish (§4.3 `republish`).
  const claimed = await ports.outbox.claimDue({
    now,
    leaseDurationMs: config.engineering.outboxLeaseDurationMs,
    claimedBy,
    limit: config.engineering.outboxBatchSize,
  });

  // (2) (i) của §6.2: không có gì để publish → no-op thuần, **không** network call. Trả ở đây
  // trước khi đọc bất kỳ record nào, để "gọi Queue để xem có gì không" không thể xảy ra.
  if (claimed.length === 0) {
    return emptyRun();
  }

  let sendCalls = 0;
  let published = 0;
  let exhausted = 0;
  let deferred = 0;
  let leaseLost = 0;
  const skipped: SkipReason[] = [];

  // (3) Từng record: dựng envelope → `Queue.send()` → ghi kết quả.
  //
  // ⚠️ **Tuần tự, không `Promise.all`.** Các record độc lập với nhau nên chạy song song *được*,
  // nhưng nó mở N lần `Queue.send()` cùng lúc trong một Worker invocation, và retry/backoff
  // của Queue là thứ không thể kiểm soát hay suy diễn từ đây (§6.2 cấm giả định cơ chế Queue).
  // Batch size là tham số cấu hình nhỏ, nên chi phí tuần tự không phải ràng buộc thực tế.
  for (const entry of claimed) {
    // Một lần đọc cho cả hai kết luận: `resolveCommand` trả kèm `skip` để không phải quét
    // cùng hai hàng hai lần. Đọc hai lần không sai về state (không gì ghi ở giữa), nhưng nó
    // là hai round-trip cho một câu hỏi — và khiến `skip` và `command` có thể lệch nhau trong
    // một lần chạy song song, tức hai `SkipReason` cho cùng một record.
    const built = await resolveCommand(deps, entry.record.deliveryId);
    if (!built.ok) {
      // Dữ liệu hỏng, **không** phải lỗi Queue: `sendCalls` không tăng và không có network
      // call nào cho record này. Ghi một lần thất bại **với ngưỡng thật** — một envelope
      // không dựng được là hỏng vĩnh viễn, và record `failed` là đúng chỗ cho nó (§4.1: chờ
      // operator, không xoá tự động). Trả về `pending` mãi mãi chỉ tạo một vòng claim vô tận
      // không ai thấy.
      skipped.push(built.skip);
      const written = await writeFailure(deps, entry.record, claimedBy, 'envelope_not_built', now);
      if (written === null) {
        leaseLost += 1;
      } else if (written.status === 'failed') {
        exhausted += 1;
      } else {
        deferred += 1;
      }
      continue;
    }

    sendCalls += 1;
    if (!(await sendAndClassify(ports, built.command))) {
      const written = await writeFailure(deps, entry.record, claimedBy, 'queue_send_failed', now);
      if (written === null) {
        leaseLost += 1;
      } else if (written.status === 'failed') {
        exhausted += 1;
      } else {
        deferred += 1;
      }
      continue;
    }

    const written = await recordSuccess(deps, entry.record, built.deliveryStatus, claimedBy, now);
    if (written === null) {
      // Publish **đã** thành công nhưng lease đã mất (publisher chậm hơn lease, hoặc record
      // bị claim lại). Message đã tồn tại; record sẽ được publish lại → duplicate — hành vi
      // được chấp nhận (§6.2: ưu tiên duplicate hơn mất message). Không ghi gì: không còn giữ.
      leaseLost += 1;
      continue;
    }
    published += 1;
  }

  return {
    claimed: claimed.length,
    sendCalls,
    published,
    exhausted,
    deferred,
    skipped,
    leaseLost,
  };
}

/** Kết quả của một lượt không có gì để làm. */
function emptyRun(): PublishRunResult {
  return {
    claimed: 0,
    sendCalls: 0,
    published: 0,
    exhausted: 0,
    deferred: 0,
    skipped: [],
    leaseLost: 0,
  };
}

/**
 * Kết quả dựng envelope — union thay vì `null` vì `null` không nói được **vì sao** không dựng
 * được, và người gọi cần nhãn đó cho metric/alert.
 */
type ResolvedCommand =
  | {
      readonly ok: true;
      readonly command: DeliveryCommandV1;
      readonly deliveryStatus: DeliveryStatus;
    }
  | { readonly ok: false; readonly skip: SkipReason };

/**
 * Dựng envelope từ D1, hoặc nêu lý do không dựng được.
 *
 * ⚠️ Trả `ok: false` thay vì ném: người gọi báo record hỏng rồi đi tiếp — `throw` sẽ giết cả
 * lô, tức một hàng `payload_json` hỏng chặn được mọi record tốt trong cùng lượt publish.
 *
 * ⚠️ `deliveryStatus` chụp **tại thời điểm đọc** và được trả về cho `applyPublisherSuccess`:
 * `pending → queued` chỉ được ghi nếu delivery **vẫn** `pending` (§6.2), và guard đó nằm trong
 * statement — nên trạng thái trả về ở đây chỉ cho biết *có cần* ghi hay không, không quyết
 * định kết quả.
 */
async function resolveCommand(
  deps: OutboxPublisherDeps,
  deliveryId: string,
): Promise<ResolvedCommand> {
  const delivery = await deps.ports.deliveries.findById(deliveryId);
  if (delivery === null) {
    return { ok: false, skip: 'delivery_missing' };
  }
  const notification = await deps.ports.deliveries.findNotificationPayload(delivery.notificationId);
  if (notification === null) {
    return { ok: false, skip: 'notification_missing' };
  }
  try {
    const command = buildDeliveryCommand({
      deliveryId: delivery.deliveryId,
      notificationId: delivery.notificationId,
      subscriptionId: delivery.subscriptionId,
      providerId: delivery.providerId,
      transport: delivery.transport,
      payloadJson: notification.payloadJson,
    });
    return { ok: true, command, deliveryStatus: delivery.status };
  } catch {
    return { ok: false, skip: 'payload_invalid' };
  }
}

/**
 * Gọi `Queue.send()` và quyết định thành công/thất bại.
 *
 * ⚠️ `Queue.send()` trả `Promise<void>` ở runtime Cloudflare; port khai báo `Promise<boolean>`
 * để adapter có chỗ biểu đạt "không gửi được" mà không ném. **Nuốt exception** ở đây là chủ
 * ý: một lần publish lỗi phải ghi `attempts`/backoff và đi tiếp, không được làm chết cả lô —
 * và lỗi **không** được nối vào message (response body của Queue/provider có thể chứa
 * endpoint hoặc secret).
 */
async function sendAndClassify(
  ports: PushNotificationPorts,
  command: DeliveryCommandV1,
): Promise<boolean> {
  try {
    return await ports.queue.send(command);
  } catch {
    return false;
  }
}

/**
 * Ghi kết quả publish thành công: đóng outbox record **và** (tuỳ §6.2) đặt delivery
 * `pending → queued` trong **cùng** một `db.batch()`.
 *
 * ⚠️ `applyPublisherSuccess` của domain quyết định **có** ghi `delivery.status` hay không:
 * delivery đã rời `pending` thì chỉ ghi outbox — terminal state không bao giờ được hồi sinh,
 * và publisher không ghi đè một state mà delivery plane đã sở hữu.
 */
async function recordSuccess(
  deps: OutboxPublisherDeps,
  record: OutboxRecord,
  deliveryStatus: DeliveryStatus,
  claimedBy: string,
  now: number,
): Promise<OutboxRecord | null> {
  const decision = applyPublisherSuccess(deliveryStatus);
  if (!decision.ok) {
    // `malformed_delivery` — status trong storage không thuộc vocabulary. Không ghi gì: một
    // write dựa trên state hỏng là cách đưa state hỏng lan sang record khác.
    return null;
  }
  return deps.ports.outbox.applyPublisherSuccess({
    outboxId: record.outboxId,
    deliveryId: record.deliveryId,
    claimedBy,
    deliveryWrite:
      decision.deliveryWrite.kind === 'advance_to_queued'
        ? { kind: 'advance_to_queued' }
        : { kind: 'keep_delivery_status' },
    now,
  });
}

/**
 * Ghi thất bại publish: tăng `attempts`, đẩy `available_at` theo backoff, hoặc `failed` khi
 * chạm ngưỡng.
 *
 * ⚠️ `sanitizedError` là một **nhãn hằng**, không phải lỗi thật: cột `last_error` không nhận
 * response body của Queue/provider, endpoint hay secret (§6.2, `03-operations.md` §4.1). Hai
 * nhãn phân biệt đúng hai nguyên nhân vận hành cần tách: Queue lỗi (kiểm Queue/D1, §15.2) và
 * envelope không dựng được (kiểm dữ liệu).
 */
function writeFailure(
  deps: OutboxPublisherDeps,
  record: OutboxRecord,
  claimedBy: string,
  sanitizedError: string,
  now: number,
): Promise<OutboxRecord | null> {
  return deps.ports.outbox.recordPublishFailure({
    outboxId: record.outboxId,
    claimedBy,
    maxAttempts: deps.config.engineering.outboxMaxPublishAttempts,
    backoffMs: deps.config.engineering.outboxPublishBackoffMs,
    sanitizedError,
    now,
  });
}

/**
 * Ghi một outbox intent cho `delivery_id` — đường **duy nhất** trong control plane ngoài
 * transaction của `createNotification`.
 *
 * ⚠️ Thứ tự: `canCreateOutboxIntent` (domain) quyết định **policy**, rồi `createIntent`
 * (repository) để **partial unique index** quyết định **thắng/thua** (§6.1). Kiểm ở
 * application là điều kiện cần cho một lời gọi có lý do rõ ràng, nhưng **không** phải guard:
 * hai lượt quét chạy đồng thời đều đọc `0` rồi cùng tạo. Vì vậy khi index chặn, repository
 * trả `null` và use case coi đó là "đã có intent" chứ không phải lỗi — đúng như §4.2 yêu cầu
 * ("reconciler thua ghi intent nhận lỗi unique-constraint và bỏ qua, không phải lỗi cần alert").
 */
export async function createOutboxIntent(
  deps: Pick<OutboxPublisherDeps, 'config' | 'ports' | 'ids'>,
  deliveryId: string,
  now: number,
): Promise<{ readonly created: boolean; readonly reason?: 'open_outbox_intent' }> {
  const openIntents = await deps.ports.outbox.countOpenIntents(deliveryId);
  const decision = canCreateOutboxIntent(openIntents);
  if (!decision.ok) {
    return { created: false, reason: 'open_outbox_intent' };
  }
  const created = await deps.ports.outbox.createIntent({
    outboxId: deps.ids.next(),
    deliveryId,
    // Intent tới hạn ngay: nó được ghi để publisher publish, và publisher tự backoff khi lỗi
    // (`available_at` của lần thử sau), nên đẩy `available_at` ra xa ở đây chỉ thêm độ trễ.
    availableAt: now,
    createdAt: now,
  });
  return { created: created !== null };
}

/** Port subset mà `createOutboxIntent` cần — giữ hàm không kéo theo cả dependency của publisher. */
export type OutboxIntentDeps = Pick<OutboxPublisherDeps, 'config' | 'ports' | 'ids'>;

/** Re-export để composition root không phải import hai nơi cho cùng một kiểu. */
export type { OutboxRepository };
