/**
 * Reconciliation — hai cơ chế của **control plane**: (a) outbox reconciliation và
 * (c) logical delivery reconciliation (`03-operations.md` §4.2).
 *
 * ⚠️ **Ba cơ chế phải tách, và file này chỉ chứa hai.** (b) job reconciliation thuộc
 * delivery worker (`docs/applications/web-push-notification-job/02-requirements.md` FR-022) và
 * `MUST NOT` ghi state của control plane. Nguyên tắc của §4.2 là **không dùng chung một job và
 * không ghi chéo state của nhau**: (a) không ghi `push-job`; (c) không ghi state của worker và
 * không ghi trạng thái outbox ngoài việc tạo intent mà §4.2 quy định.
 *
 * ⚠️ **Bảng quyết định a1–a6 là canonical và được thực thi theo đúng thứ tự đó** — thứ tự
 * không phải ngẫu nhiên: a1 (`expires_at <= now`) đứng trước vì một delivery hết hạn không
 * được publish lại dù còn mọi điều kiện khác; a6 (terminal) ở giữa vì nó là điều kiện loại,
 * không phải hành động; a2 trước a3 trước a4 vì chúng là ba kết quả khác nhau của cùng một
 * trạng thái `pending`/`queued`.
 *
 * ⚠️ **Reconciliation không có network call.** Cả (a) lẫn (c) chỉ đọc D1 và ghi D1; publish
 * thuộc publisher (`outbox-publisher.ts`), và §4.1 nói rõ **không** network call tới Queue hay
 * provider bên trong D1 transaction.
 */

import {
  canCreateOutboxIntent,
  isNonTerminalDeliveryStatus,
  isOpenOutboxStatus,
  isTerminalDeliveryStatus,
  OUTBOX_STATUS,
  type DeliveryStatus,
} from '@ecoma-io/push-notification-domain';
import type { PushNotificationConfig } from './config-port';
import type { IdGenerator } from './create-notification';
import type { PushNotificationPorts } from './ports';

/* -------------------------------------------------------------------------------------- */
/* (a) Outbox reconciliation                                                                  */
/* -------------------------------------------------------------------------------------- */

/** Kết quả một lượt outbox reconciliation — **chỉ báo cáo**, không tự phục hồi (a3 thuộc operator). */
export interface OutboxReconciliationResult {
  /** Số record `pending`/`publishing` quá hạn tuổi đã thấy. */
  readonly agedOpen: number;
  /** Số record `failed` đã thấy — **operator xử lý**, reconciliation chỉ alert (a3). */
  readonly failed: number;
  /** Tuổi (epoch millis) của record open già nhất — đầu vào của alert "backlog quá hạn" (§11). */
  readonly oldestOpenCreatedAt: number | null;
  /**
   * Số delivery `pending` **không** có outbox record khả dụng nào.
   *
   * ⚠️ Đây là **SLA bắt buộc** của §4.2: mỗi delivery `pending` mồ côi `MUST` được phát hiện
   * và alert trong vòng `outbox_recovery_sla` kể từ khi vượt ngưỡng tuổi. Con số này là thứ
   * đo được; phần "alert" là trách nhiệm của lớp observability, nên use case chỉ đếm.
   */
  readonly orphanedPendingDeliveries: number;
}

/**
 * `POST /internal/reconcile/outbox` — lượt quét (a).
 *
 * ⚠️ **Không ghi gì.** §4.2 nói outbox reconciliation xử lý ba trạng thái bằng hành động *đã có*:
 * lease hết hạn thì claim lại (publisher làm việc đó), `pending` backlog thì publisher tự
 * catch up, `failed` thì operator quyết định. Không có hành động ghi nào thuộc (a) — một
 * reconciliation tự sửa sẽ phá ranh giới "control plane `MUST NOT` tự phục hồi" của a3.
 */
export async function reconcileOutbox(
  deps: ReconciliationDeps,
  nowOverride?: number,
): Promise<OutboxReconciliationResult> {
  const { config, ports } = deps;
  const now = nowOverride ?? ports.clock.now();

  const agedOpen = await ports.outbox.listAgedOpen({
    olderThan: now - config.sla.outboxRecoverySlaMs,
    now,
    limit: config.engineering.outboxReconciliationBatchSize,
  });
  const failed = await ports.outbox.listFailed(config.engineering.outboxReconciliationBatchSize);

  return {
    agedOpen: agedOpen.length,
    failed: failed.length,
    oldestOpenCreatedAt: oldestOf(agedOpen.map((record) => record.createdAt)),
    // Đếm delivery `pending` mồ côi: đây là phần của reconciliation **không** nằm trong
    // `push_outbox`, nên phải quét bảng delivery. `pending` là non-terminal nên thuộc phạm vi
    // (c), nhưng **điều kiện** "không còn outbox record khả dụng" là điều kiện của (a) — nên
    // phép đếm đặt ở đây và hành động thuộc (c)/operator.
    orphanedPendingDeliveries: await countOrphanedPending(deps, now),
  };
}

/**
 * Tuổi lớn nhất trong một danh sách, `null` khi rỗng.
 *
 * ⚠️ Dùng vòng lặp thay `Math.max(...list)`: một danh sách rỗng trải toả ký tự là `-Infinity`
 * (không phải lỗi), nhưng một danh sách **rất** dài làm nổi call stack — và `limit` ở đây là
 * tham số cấu hình, nên "vài trăm" là bình thường còn "hàng triệu" là một cấu hình sai.
 */
function oldestOf(timestamps: readonly number[]): number | null {
  let oldest: number | null = null;
  for (const timestamp of timestamps) {
    if (oldest === null || timestamp < oldest) {
      oldest = timestamp;
    }
  }
  return oldest;
}

/**
 * Đếm delivery `pending` không còn outbox record khả dụng (a3 — **chỉ đếm**).
 *
 * ⚠️ Quét **giới hạn theo batch** rồi đếm, chứ không quét toàn bảng: một lượt reconciliation
 * không giới hạn sẽ giữ một D1 transaction mở trên một bảng có thể có hàng triệu hàng. Vì vậy
 * con số này là **"ít nhất"**, và đó là điều đúng — một hàng thừa bị bỏ sót sẽ xuất hiện ở
 * lượt kế tiếp, còn một lượt quét không giới hạn sẽ tự nó trở thành sự cố.
 */
async function countOrphanedPending(deps: ReconciliationDeps, now: number): Promise<number> {
  const candidates = await deps.ports.deliveries.listAgedNonTerminal({
    olderThan: now - deps.config.sla.outboxRecoverySlaMs,
    now,
    limit: deps.config.engineering.reconciliationBatchSize,
  });
  let orphaned = 0;
  for (const delivery of candidates) {
    if (delivery.status !== 'pending') {
      continue;
    }
    if (!(await deps.ports.outbox.hasOpenIntent(delivery.deliveryId))) {
      orphaned += 1;
    }
  }
  return orphaned;
}

/* -------------------------------------------------------------------------------------- */
/* (c) Logical delivery reconciliation                                                        */
/* -------------------------------------------------------------------------------------- */

/** Hành động mà reconciliation (c) **đã thực hiện** cho một delivery — vocabulary đóng. */
export const RECONCILE_ACTION = {
  /** a1 — đánh dấu `expired`. */
  MarkExpired: 'mark_expired',
  /** a2 — còn outbox record đang chờ, thuộc (a); (c) không làm gì. */
  DeferredToOutboxReconciliation: 'deferred_to_outbox_reconciliation',
  /** a3 — delivery `pending` không còn đường publish; **operator** quyết định (`republish`). */
  OperatorActionRequired: 'operator_action_required',
  /** a4 — tạo **một** outbox intent mới cho cùng `delivery_id`. */
  ReDispatched: 're_dispatched',
  /** a5 — `processing` hết lease, đã claimable lại; chờ redelivery. */
  AwaitingRedelivery: 'awaiting_redelivery',
  /** a6 — terminal, không đụng. */
  TerminalUntouched: 'terminal_untouched',
} as const;

export type ReconcileAction = (typeof RECONCILE_ACTION)[keyof typeof RECONCILE_ACTION];

/** Kết quả cho **một** delivery của bảng a1–a6. */
export interface ReconcileDecision {
  readonly deliveryId: string;
  readonly action: ReconcileAction;
  /** `reason` chi tiết — hằng, không nối dữ liệu (log-safe). */
  readonly reason: string;
}

/** Kết quả một lượt reconciliation (c). */
export interface DeliveryReconciliationResult {
  /** Số delivery đã quét (giới hạn bởi `reconciliationBatchSize`). */
  readonly scanned: number;
  readonly decisions: readonly ReconcileDecision[];
  /** Số `expired` đã ghi. */
  readonly expired: number;
  /** Số intent mới đã tạo (a4). */
  readonly intentsCreated: number;
  /**
   * Số intent **không** tạo được vì index chặn (race với lượt quét khác).
   *
   * ⚠️ Đây **không** phải lỗi cần alert — §4.2 nói rõ "reconciler thua ghi intent nhận lỗi
   * unique-constraint và bỏ qua (không phải lỗi cần alert)". Đếm riêng để một lượt cho ra số
   * mà tài liệu yêu cầu, thay vì gộp vào `intentsCreated`.
   */
  readonly intentsSuppressedByIndex: number;
}

/** Dependency của cả hai cơ chế — dùng chung để chúng cùng đọc `config`/`ports`. */
export interface ReconciliationDeps {
  readonly config: PushNotificationConfig;
  readonly ports: PushNotificationPorts;
  readonly ids: IdGenerator;
}

/** Kết quả nội bộ của một delivery: quyết định + cờ "intent bị index chặn". */
interface DecisionOutcome {
  readonly decision: ReconcileDecision;
  readonly intentSuppressed: boolean;
}

/**
 * `POST /internal/reconcile/deliveries` — lượt quét (c).
 *
 * ⚠️ Ngưỡng tuổi đến từ **SLA bắt buộc** `delivery_reconciliation_age`, không phải tham số
 * kỹ thuật có default: đây là ngưỡng mà §4.2 định nghĩa để một delivery non-terminal kẹt được
 * phát hiện, và một giá trị mặc định tự chọn sẽ biến một SLA thành một ẩn số.
 */
export async function reconcileDeliveries(
  deps: ReconciliationDeps,
  nowOverride?: number,
): Promise<DeliveryReconciliationResult> {
  const { config, ports } = deps;
  const now = nowOverride ?? ports.clock.now();

  const aged = await ports.deliveries.listAgedNonTerminal({
    olderThan: now - config.sla.deliveryReconciliationAgeMs,
    now,
    limit: config.engineering.reconciliationBatchSize,
  });

  const decisions: ReconcileDecision[] = [];
  let expired = 0;
  let intentsCreated = 0;
  let intentsSuppressedByIndex = 0;

  for (const delivery of aged) {
    const outcome = await applyDecision(deps, delivery, now);
    decisions.push(outcome.decision);
    if (outcome.decision.action === RECONCILE_ACTION.MarkExpired) {
      expired += 1;
    } else if (outcome.decision.action === RECONCILE_ACTION.ReDispatched) {
      intentsCreated += 1;
    } else if (outcome.intentSuppressed) {
      intentsSuppressedByIndex += 1;
    }
  }

  return {
    scanned: aged.length,
    decisions,
    expired,
    intentsCreated,
    intentsSuppressedByIndex,
  };
}

/**
 * Quyết định + hành động cho **một** delivery — bảng a1–a6 của §4.2, theo đúng thứ tự.
 *
 * ⚠️ `intentSuppressed` là một cờ riêng chứ không suy ra từ `action`: hành động
 * `deferred_to_outbox_reconciliation` xuất hiện ở **hai** tình huống khác nhau — đã có intent
 * (không cần làm gì) và index chặn intent của một lượt khác (race, không phải lỗi). Chỉ cái sau
 * mới được đếm vào `intentsSuppressedByIndex`.
 *
 * ⚠️ Đọc `hasOpenIntent` là **tiền điều kiện** của a2/a4, và `canCreateOutboxIntent` của
 * domain là **policy** — còn **guard thật** là partial unique index ở tầng database (§6.1).
 * Đọc ở đây không phải read-then-write: nếu có race, `createIntent` trả `null` và ta đếm vào
 * `intentsSuppressedByIndex` thay vì coi là lỗi.
 */
async function applyDecision(
  deps: ReconciliationDeps,
  delivery: {
    readonly deliveryId: string;
    readonly status: DeliveryStatus;
    readonly expiresAt: number;
    readonly leaseExpiresAt: number | null;
  },
  now: number,
): Promise<DecisionOutcome> {
  const { ports } = deps;
  const untouched: DecisionOutcome = {
    decision: {
      deliveryId: delivery.deliveryId,
      action: RECONCILE_ACTION.TerminalUntouched,
      reason: 'reconcile_no_action',
    },
    intentSuppressed: false,
  };

  // (a6) Terminal — kiểm trước mọi hành động khác. Không đụng: `MUST NOT` hồi sinh terminal
  // bằng reconciliation (§4.2 a6, invariant §17.19).
  if (isTerminalDeliveryStatus(delivery.status)) {
    return untouched;
  }

  // (a1) `expires_at <= now` → `expired`, **không** gửi, **không** tạo intent. Guard
  // `status IN ('pending','queued','processing')` nằm trong statement `markExpired`.
  if (delivery.expiresAt <= now) {
    const marked = await ports.deliveries.markExpired({ deliveryId: delivery.deliveryId, now });
    return {
      decision: {
        deliveryId: delivery.deliveryId,
        action: RECONCILE_ACTION.MarkExpired,
        reason: marked === null ? 'expired_race_not_non_terminal' : 'expires_at_reached',
      },
      intentSuppressed: false,
    };
  }

  // Đây là một hàng **non-terminal** (a6 đã loại terminal), nên các nhánh dưới đây là ba
  // trạng thái còn lại của §4.2.
  switch (delivery.status) {
    case 'pending':
      return settle(await reconcilePending(deps, delivery.deliveryId));
    case 'queued':
      return reconcileQueued(deps, delivery.deliveryId, now);
    case 'processing':
      return settle(await reconcileProcessing(delivery, now));
    default:
      // Không thể tới: `isTerminalDeliveryStatus` đã loại cả bốn terminal, và `switch` đã
      // phủ ba non-terminal. Trả về "không làm gì" là fail-closed — một state lạ phải đi vào
      // metric để operator thấy, không được tự đoán một hành động ghi.
      return untouched;
  }
}

/** Bọc một `ReconcileDecision` đơn giản thành `DecisionOutcome` (không có intent nào bị chặn). */
function settle(decision: ReconcileDecision): DecisionOutcome {
  return { decision, intentSuppressed: false };
}

/**
 * a2 / a3 — delivery `pending`.
 *
 * - **a2**: còn outbox record `pending`/`publishing` → **không** làm gì, thuộc (a).
 * - **a3**: không còn record khả dụng → **alert + operator**, **không** tự động. (c) `MUST NOT`
 *   tự tạo intent ở hai trường hợp này, và `MUST NOT` tự chuyển `pending → queued`.
 */
async function reconcilePending(
  deps: ReconciliationDeps,
  deliveryId: string,
): Promise<ReconcileDecision> {
  const openIntent = await deps.ports.outbox.hasOpenIntent(deliveryId);
  return openIntent
    ? {
        deliveryId,
        action: RECONCILE_ACTION.DeferredToOutboxReconciliation,
        reason: 'outbox_intent_open',
      }
    : {
        deliveryId,
        action: RECONCILE_ACTION.OperatorActionRequired,
        reason: 'no_usable_outbox_intent_republish_required',
      };
}

/**
 * a4 — delivery `queued`, chưa quá `expires_at`, không còn intent đang chờ → tạo **một** intent
 * mới cho **cùng** `delivery_id`.
 *
 * ⚠️ **Không** đổi state: giữ `queued`, vì publisher mới là actor của `pending → queued` (§6.2)
 * và đây là delivery **đã** `queued`. Tạo `notification_id`/`delivery_id` mới là điều §4.2
 * cấm rõ ràng.
 */
async function reconcileQueued(
  deps: ReconciliationDeps,
  deliveryId: string,
  now: number,
): Promise<DecisionOutcome> {
  if (await deps.ports.outbox.hasOpenIntent(deliveryId)) {
    return settle({
      deliveryId,
      action: RECONCILE_ACTION.DeferredToOutboxReconciliation,
      reason: 'outbox_intent_open',
    });
  }
  const openIntents = await deps.ports.outbox.countOpenIntents(deliveryId);
  if (!canCreateOutboxIntent(openIntents).ok) {
    // Trường hợp này không xảy ra khi `hasOpenIntent` trả `false` (cùng một điều kiện), nhưng
    // hai lời gọi có thể thấy hai trạng thái khác nhau. Trả "defer" là fail-closed: không tạo
    // intent khi policy nói không.
    return settle({
      deliveryId,
      action: RECONCILE_ACTION.DeferredToOutboxReconciliation,
      reason: 'open_outbox_intent',
    });
  }
  const created = await deps.ports.outbox.createIntent({
    outboxId: deps.ids.next(),
    deliveryId,
    availableAt: now,
    createdAt: now,
  });
  return created === null
    ? {
        decision: {
          deliveryId,
          action: RECONCILE_ACTION.DeferredToOutboxReconciliation,
          reason: 'index_suppressed_concurrent_intent',
        },
        // §4.2: lượt quét thua là **không** phải lỗi cần alert — nhưng nó phải **đếm** được,
        // nếu không thì "không có lỗi" và "chưa chạy" trùng nhau trong số liệu.
        intentSuppressed: true,
      }
    : {
        decision: {
          deliveryId,
          action: RECONCILE_ACTION.ReDispatched,
          reason: 'queued_without_open_intent',
        },
        intentSuppressed: false,
      };
}

/**
 * a5 — delivery `processing` với `lease_expires_at <= now`: **không** làm gì ngay.
 *
 * ⚠️ Lease hết hạn **đã** làm delivery claimable lại (predicate claim của §8.1 nhận đúng nhánh
 * `processing AND lease_expires_at <= now`), và `MUST NOT` có reaper chuyển state vì lease hết
 * hạn (§5.6). Nếu không có message nào trong Queue, lượt quét sau của (c) sẽ xử lý như a4 —
 * nhưng a4 chỉ áp dụng cho `queued`, nên một delivery kẹt `processing` mà không có redelivery
 * cần tới `republish` của operator. Đó là hệ quả đã được chấp nhận của thiết kế lease.
 */
async function reconcileProcessing(
  delivery: {
    readonly deliveryId: string;
    readonly leaseExpiresAt: number | null;
  },
  now: number,
): Promise<ReconcileDecision> {
  const leaseExpired = delivery.leaseExpiresAt !== null && delivery.leaseExpiresAt <= now;
  return leaseExpired
    ? {
        deliveryId: delivery.deliveryId,
        action: RECONCILE_ACTION.AwaitingRedelivery,
        reason: 'lease_expired_awaiting_redelivery',
      }
    : {
        deliveryId: delivery.deliveryId,
        action: RECONCILE_ACTION.AwaitingRedelivery,
        reason: 'lease_still_held_by_execution',
      };
}

/**
 * Re-export để composition root dùng một nguồn cho `isOpenOutboxStatus`/`OUTBOX_STATUS` khi
 * dựng kết quả quản trị (a `failed` record không nằm trong tập open — §6.1).
 */
export { isOpenOutboxStatus, isNonTerminalDeliveryStatus, OUTBOX_STATUS };
