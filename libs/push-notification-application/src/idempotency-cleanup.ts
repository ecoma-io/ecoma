/**
 * Cleanup idempotency record của `POST /v1/notifications` theo **đúng ba điều kiện
 * canonical của FR-008** (điều kiện xoá an toàn). Đây là use case của **control plane** —
 * nó đọc cấu hình SLA và gọi port; mọi điều kiện nằm ở statement của adapter (Invari B),
 * không có read-then-write ở đây.
 *
 * ⚠️ **Ba điều kiện (canonical, trích dẫn từ `02-requirements.md` FR-008):** cleanup **CHỈ**
 * được xoá một idempotency record khi đồng thời:
 *   (i) **mọi** `Push Delivery` của notification đó đã **terminal**
 *       (`delivered`/`failed`/`expired`/`cancelled`);
 *   (ii) **không** còn outbox record `pending`/`publishing` nào cho **bất kỳ** delivery nào
 *        của notification đó;
 *   (iii) `now > created_at + idempotency_retention`.
 * Thiếu bất kỳ điều kiện nào → **giữ**. Record của notification có nhiều delivery chỉ được
 * xoá khi **tất cả** delivery terminal (không xoá theo từng delivery).
 *
 * ⚠️ **Retention lấy từ config**, không tự chọn: `config.sla.idempotencyRetentionMs` ←
 * `IDEMPOTENCY_RETENTION_MS` (launch gate, `03-operations.md` §11/§13). **MUST NOT** dùng
 * `queue_retention` (`04-platform-facts.md` QU5) thay thế, và **MUST NOT** coi "message đã hết
 * retention" là lý do xoá sớm.
 *
 * ⚠️ **Job record trong `push-job` KHÔNG phải điều kiện**: một delivery chưa từng được consume
 * không có job record nào, và việc thiếu job record **MUST NOT** được coi là "đã an toàn để xoá"
 * (điều kiện (ii) nói về **outbox record**, không phải job record).
 *
 * ⚠️ **Idempotent.** Gọi lại nhiều lần không phá hỏng gì: statement chỉ xoá những record thoả
 * cả ba điều kiện; đã xoá rồi thì lần sau không còn hàng nào thoả và trả `0`. Không hồi sinh
 * delivery terminal (FR-008: replay cùng key + cùng canonical hash trả `200` cùng
 * `notification_id` **kể cả** khi notification/delivery đã terminal hoặc `expired` — và một
 * record đã bị xoá hợp lệ thì cùng key được coi là key mới → `201`).
 *
 * ⚠️ **Không có transaction boundary riêng.** `db.batch()` là ranh giới transaction duy nhất
 * của D1 (DB2), và ở đây chỉ có **một** statement `DELETE … WHERE …` — toàn bộ ba điều kiện
 * nằm trong predicate của statement đó, nên chính statement là ranh giới nguyên tử. Không cần
 * batch vì không có ghi nhiều bảng cần cùng đúng/sai, và không có network call xen giữa.
 */

import type { PushNotificationConfig } from './config-port';
import type { PushNotificationPorts } from './ports';

export interface IdempotencyCleanupDeps {
  readonly config: PushNotificationConfig;
  readonly ports: PushNotificationPorts;
}

export interface IdempotencyCleanupResult {
  /** Số idempotency record đã xoá trong lượt này. */
  readonly deleted: number;
}

/** Số record xoá mỗi lượt — lựa chọn của service, không phải giá trị tài liệu. */
const CLEANUP_BATCH_SIZE = 100;

/**
 * Một lượt cleanup idempotency record. Trả về số record đã xoá; `0` là kết quả bình thường
 * (không có record nào thoả cả ba điều kiện).
 */
export async function cleanupIdempotencyRecords(
  deps: IdempotencyCleanupDeps,
  nowOverride?: number,
): Promise<IdempotencyCleanupResult> {
  const now = nowOverride ?? deps.ports.clock.now();
  const deleted = await deps.ports.idempotency.deleteEligible({
    now,
    retentionMs: deps.config.sla.idempotencyRetentionMs,
    limit: CLEANUP_BATCH_SIZE,
  });
  return { deleted };
}
