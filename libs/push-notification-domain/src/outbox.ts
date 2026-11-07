/**
 * Push Outbox: trạng thái record, predicate claim, và chống dồn intent.
 *
 * Source of truth:
 * - `docs/applications/push-notification/01-architecture.md` §6.1 (model record; predicate
 *   claim; **tối đa một** record "đang chờ publish" (`pending`/`publishing`) cho mỗi
 *   `delivery_id`, enforce bằng partial unique index ở D1 — **không** chỉ bằng
 *   read-then-write ở application; `published` là terminal của record; `failed`
 *   **không** claimable), §6.2 (actor duy nhất của `pending → queued` là Outbox
 *   Publisher; publish thành công ghi outbox `published` **và** delivery `queued`
 *   trong **cùng** `db.batch()`; `Queue.send()` thất bại thì delivery **giữ**
 *   `pending`; record `failed` → delivery kẹt `pending` chờ operator).
 * - `docs/applications/push-notification/02-requirements.md` FR-013 (Notification,
 *   Delivery, Outbox Entry persist trong cùng một `db.batch()`; D1 commit và Queue
 *   publish **không** atomic — duplicate publish phải được chấp nhận).
 *
 * Quyết định domain suy ra:
 * - Outbox record và delivery là **hai state machine khác nhau** và domain giữ chúng
 *   tách biệt: `published` của outbox **không** phải `queued` của delivery, và
 *   `failed` của outbox **không** phải `failed` của delivery. Hàm
 *   `applyPublisherSuccess` trả về **cả hai** giá trị tiếp theo trong một kết quả
 *   duy nhất để bất biến "hai bước ghi cùng một batch" được thực thi ở tầng kiểu —
 *   caller không thể lấy bước đầu mà bỏ bước hai.
 * - "Tối đa một open intent" được mô hình hoá thành một **điều kiện trên đầu vào**
 *   (`hasOpenOutboxIntent`), **không** phải một hàm tự đọc database: domain không có
 *   I/O. Tài liệu nói rõ ràng buộc này phải nằm ở tầng database; hàm đây là nơi
 *   application đặt kết quả truy vấn đó vào trước khi quyết định, và là thứ khiến
 *   sai sót "đọc rồi ghi" trở thành sai sót **kiểu dữ liệu**.
 */

import { type DomainOk, type DomainRejection, isEpochMillis, isNonNegativeInteger } from './shared';
import { DELIVERY_STATUS, type DeliveryStatus, isDeliveryStatus } from './delivery';

/**
 * Trạng thái của outbox record (§6.1) — vocabulary đóng, **không** đồng nhất với
 * delivery status.
 */
export const OUTBOX_STATUS = {
  Pending: 'pending',
  Publishing: 'publishing',
  Published: 'published',
  Failed: 'failed',
} as const;

export type OutboxStatus = (typeof OUTBOX_STATUS)[keyof typeof OUTBOX_STATUS];

export const OUTBOX_STATUS_VALUES: readonly OutboxStatus[] = [
  OUTBOX_STATUS.Pending,
  OUTBOX_STATUS.Publishing,
  OUTBOX_STATUS.Published,
  OUTBOX_STATUS.Failed,
];

export function isOutboxStatus(value: unknown): value is OutboxStatus {
  return OUTBOX_STATUS_VALUES.includes(value as OutboxStatus);
}

/**
 * Terminal của record: `published` (§6.1 — "published là terminal của record").
 * `failed` **không** nằm trong nhóm này: nó recoverable để operator xử lý, chỉ là
 * không claimable.
 */
export const TERMINAL_OUTBOX_STATUS_VALUES: readonly OutboxStatus[] = [OUTBOX_STATUS.Published];

export function isTerminalOutboxStatus(status: OutboxStatus): boolean {
  return TERMINAL_OUTBOX_STATUS_VALUES.includes(status);
}

/**
 * Record đang "đang chờ publish": `pending` hoặc `publishing`. Chính nhóm này bị
 * ràng buộc "tối đa một cho mỗi `delivery_id`" (§6.1, partial unique index).
 */
export const OPEN_OUTBOX_STATUS_VALUES: readonly OutboxStatus[] = [
  OUTBOX_STATUS.Pending,
  OUTBOX_STATUS.Publishing,
];

export function isOpenOutboxStatus(status: OutboxStatus): boolean {
  return OPEN_OUTBOX_STATUS_VALUES.includes(status);
}

/**
 * Trạng thái một outbox record như control plane lưu.
 *
 * `availableAt` và `leaseExpiresAt` là **epoch millis nguyên** — xem `isEpochMillis`:
 * predicate claim của §6.1 so `available_at <= now` / `lease_expires_at <= now`, nên một
 * mốc thời gian không nguyên hoặc vượt miền an toàn sẽ làm cổng backoff/lease cho kết quả
 * ngược ý thay vì bị loại là dữ liệu hỏng.
 */
export type OutboxRecordState = {
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly availableAt: number;
  readonly leaseExpiresAt: number | null;
};

function isMalformedOutboxState(state: OutboxRecordState): boolean {
  if (!isOutboxStatus(state.status)) return true;
  if (!isNonNegativeInteger(state.attempts)) return true;
  if (!isEpochMillis(state.availableAt)) return true;
  if (state.leaseExpiresAt !== null && !isEpochMillis(state.leaseExpiresAt)) {
    return true;
  }
  return false;
}

export type OutboxClaimRejectionReason =
  | 'already_published'
  | 'failed_not_claimable'
  | 'backoff_not_due'
  | 'lease_held'
  | 'malformed_outbox';

export type OutboxClaimDecision =
  | DomainOk<{
      readonly status: typeof OUTBOX_STATUS.Publishing;
    }>
  | DomainRejection<OutboxClaimRejectionReason>;

/**
 * Predicate claim của outbox record, đối xứng với claim predicate của delivery (§6.1):
 *
 * ```text
 * status = 'pending' AND available_at <= now
 * OR (status = 'publishing' AND lease_expires_at <= now)
 * ```
 *
 * `failed` **không** claimable: chỉ operator mới đưa nó trở lại đường publish. Vì
 * publisher là component chạy định kỳ, "chưa tới hạn backoff" là một kết quả bình
 * thường (`backoff_not_due`), không phải lỗi.
 *
 * Predicate này phải nằm **trong chính** statement `UPDATE` ở tầng database — hàm
 * đây là đặc tả thuần để implementation và test cùng tham chiếu.
 */
export function decideOutboxClaim(state: OutboxRecordState, now: number): OutboxClaimDecision {
  if (!state || isMalformedOutboxState(state)) {
    return {
      ok: false,
      reason: 'malformed_outbox',
      detail: 'Outbox record không đúng shape tối thiểu của domain.',
    };
  }
  if (!isEpochMillis(now)) {
    return {
      ok: false,
      reason: 'malformed_outbox',
      detail: 'Tham số now không hợp lệ.',
    };
  }
  if (state.status === OUTBOX_STATUS.Published) {
    return {
      ok: false,
      reason: 'already_published',
      detail: 'Record đã published — terminal, không được publish lại.',
    };
  }
  if (state.status === OUTBOX_STATUS.Failed) {
    return {
      ok: false,
      reason: 'failed_not_claimable',
      detail: 'Record failed không claimable — chỉ operator mới đưa về đường publish.',
    };
  }
  if (state.status === OUTBOX_STATUS.Pending) {
    if (state.availableAt > now) {
      return {
        ok: false,
        reason: 'backoff_not_due',
        detail: 'Record đang trong backoff — available_at chưa tới.',
      };
    }
    return { ok: true, status: OUTBOX_STATUS.Publishing };
  }
  // status === 'publishing'
  if (state.leaseExpiresAt === null) {
    // `status = 'publishing' AND lease_expires_at <= :now` không khớp hàng null
    // (§6.1). Record publishing luôn lấy lease từ guarded UPDATE, nên null là dữ
    // liệu hỏng: fail-safe, không cấp lease mới.
    return {
      ok: false,
      reason: 'malformed_outbox',
      detail: 'Record publishing nhưng không mang lease — trạng thái không tồn tại.',
    };
  }
  if (state.leaseExpiresAt > now) {
    return {
      ok: false,
      reason: 'lease_held',
      detail: 'Record đang giữ lease còn hiệu lực — không claim được.',
    };
  }
  return { ok: true, status: OUTBOX_STATUS.Publishing };
}

/**
 * Trạng thái delivery **sau** khi `Queue.send()` trả về thành công (§6.2).
 *
 * - `advance_to_queued` — delivery **vẫn** đang `pending`: ghi `queued`.
 * - `keep_delivery_status` — delivery đã rời `pending` trong lúc publish (đã `queued`,
 *   đang `processing`, hoặc bị đánh dấu `expired`/`failed`): publisher **MUST NOT**
 *   ghi `delivery.status`, và **không bao giờ** hồi sinh terminal state. Publish đã
 *   thực sự xảy ra nên outbox record vẫn được đánh `published`.
 */
export type DeliveryWriteAfterPublish =
  | { readonly kind: 'advance_to_queued'; readonly status: typeof DELIVERY_STATUS.Queued }
  | { readonly kind: 'keep_delivery_status'; readonly status: DeliveryStatus };

export type ApplyPublisherSuccessRejection = 'malformed_delivery';

export type ApplyPublisherSuccessResult =
  | DomainOk<{
      readonly outboxStatus: typeof OUTBOX_STATUS.Published;
      readonly deliveryWrite: DeliveryWriteAfterPublish;
    }>
  | DomainRejection<ApplyPublisherSuccessRejection>;

/**
 * Áp dụng kết quả của một lần publish thành công lên **cả hai** record, như một giá
 * trị duy nhất (§6.2, FR-013).
 *
 * Ba bất biến nằm trong chính hàm:
 * 1. Outbox record **luôn** chuyển sang `published` — kể cả khi delivery đã terminal
 *    (bị reconciliation đánh dấu `expired`, bị mark `failed`): `Queue.send()` đã
 *    thực sự thành công nên record không được retry vô hạn (§6.2).
 * 2. Delivery **chỉ** chuyển sang `queued` khi nó còn `pending`.
 * 3. Với mọi trạng thái còn lại — terminal, đã `queued`, đang `processing` — hàm trả
 *    `keep_delivery_status` kèm chính trạng thái hiện tại, nên terminal state **không**
 *    bao giờ bị hồi sinh qua đường publish và publisher không ghi đè một trạng thái
 *    mà delivery plane đã sở hữu.
 *
 * Không có nhánh nào trả "outbox đã published nhưng delivery giữ nguyên `pending`" —
 * đó là trạng thái không có thật: `pending` nghĩa là "chưa có lần publish nào thành
 * công" (§5.6).
 */
export function applyPublisherSuccess(deliveryStatus: DeliveryStatus): ApplyPublisherSuccessResult {
  if (!isDeliveryStatus(deliveryStatus)) {
    return {
      ok: false,
      reason: 'malformed_delivery',
      detail: 'Delivery status nằm ngoài vocabulary của domain.',
    };
  }
  if (deliveryStatus === DELIVERY_STATUS.Pending) {
    return {
      ok: true,
      outboxStatus: OUTBOX_STATUS.Published,
      deliveryWrite: {
        kind: 'advance_to_queued',
        status: DELIVERY_STATUS.Queued,
      },
    };
  }
  // Đã `queued`; đang `processing` (consumer claim trước khi publisher kịp ghi); hoặc
  // đã terminal (`delivered`/`failed`/`expired`/`cancelled`): ghi outbox, không đụng
  // delivery — đúng guard của §6.2.
  return {
    ok: true,
    outboxStatus: OUTBOX_STATUS.Published,
    deliveryWrite: { kind: 'keep_delivery_status', status: deliveryStatus },
  };
}

/**
 * Điều kiện tạo một outbox intent mới cho một `delivery_id` (§6.1 ràng buộc chống
 * dồn intent; §6.1 "record `published`/`failed` **không** nằm trong ràng buộc — một
 * intent mới hợp lệ được phép tồn tại cạnh chúng").
 *
 * Hàm nhận **số** record đang open, không tự đếm từ database: domain không có I/O.
 * Điều kiện này **MUST** được enforce ở tầng database bằng partial unique index;
 * kiểm tra application-level đơn lẻ là không đủ vì hai reconciler chạy đồng thời có
 * thể cùng đọc "không có record nào đang chờ" rồi cùng tạo intent (§6.1).
 */
export function canCreateOutboxIntent(
  openIntentCount: number,
): DomainOk<{ readonly allowed: true }> | DomainRejection<'open_outbox_intent'> {
  if (!Number.isSafeInteger(openIntentCount) || openIntentCount < 0) {
    return {
      ok: false,
      reason: 'open_outbox_intent',
      detail: 'Số record open intent không hợp lệ — fail-safe, không tạo intent.',
    };
  }
  if (openIntentCount > 0) {
    return {
      ok: false,
      reason: 'open_outbox_intent',
      detail: 'Đã có record pending/publishing cho delivery này — tối đa một open intent (§6.1).',
    };
  }
  return { ok: true, allowed: true };
}
