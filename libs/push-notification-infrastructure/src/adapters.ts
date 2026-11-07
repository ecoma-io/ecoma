/**
 * Adapter nhỏ nối binding của Cloudflare với port của application.
 *
 * ⚠️ **Vì sao gom về một file.** Đây là bốn adapter mỗi cái dưới 20 dòng và không có logic nào
 * đáng kể; tách bốn file cho chúng làm chi phí điều hướng tăng mà không tăng khả năng kiểm thử.
 * Phần đáng kể — cipher, auth, D1 — ở file riêng vì chúng có invariant thật.
 *
 * ⚠️ **`SystemClock` gọi `Date.now()` mỗi lần**, không cache. Use case đã được yêu cầu gọi
 * `clock.now()` **đúng một lần** mỗi lần xử lý một request (`PushClock`); cache ở đây sẽ
 * phá vỡ điều đó theo hướng khó thấy — hai lần đọc trong cùng một request sẽ ra hai thời điểm
 * khác nhau, và predicate claim so với `lease_expires_at` sẽ lệch.
 */

import type {
  IdGenerator,
  PushClock,
  QueuePublisher,
} from '@ecoma-io/push-notification-application';

/** Clock thật của Workers runtime. */
export const systemClock: PushClock = {
  now(): number {
    return Date.now();
  },
};

/**
 * Sinh id bằng `crypto.randomUUID()`.
 *
 * ⚠️ **UUIDv4, không phải timestamp.** `claimed_by` của một lượt publisher là token định danh
 * lần claim, và hai lượt chạy cùng một mili giây sẽ sinh token giống nhau nếu id là timestamp —
 * một lượt sẽ ghi được lên record của lượt kia. Với UUID về xác suất va chạm không đáng kể.
 *
 * ⚠️ `randomUUID` là **crypto-grade**, không phải `Math.random()`: id này xuất hiện trong
 * `audit_records.audit_id` và trong `claimed_by` mà một attacker có thể đọc, nên nó phải không
 * đoán được trước khi nó tồn tại.
 */
export const cryptoRandomIdGenerator: IdGenerator = {
  next(): string {
    return crypto.randomUUID();
  },
};

/**
 * Producer của Queue qua binding `QUEUE` của `wrangler.jsonc`.
 *
 * ⚠️ **Trả `false`, không ném.** `QueuePublisher.send` cố ý không ném: một lần publish lỗi là
 * một kết quả bình thường cần đưa vào backoff (`attempts` / `available_at`, §6.2), không phải
 * exception làm hỏng cả lô claim. Ném ở đây sẽ làm một lỗi Queue thành lỗi của cả request.
 *
 * ⚠️ `contentType: 'json'` là lựa chọn của contract: envelope là `DeliveryCommandV1` và
 * consumer là `web-push-notification-job`; hai bên phải thống nhất ở đây.
 */
export class BindingQueuePublisher implements QueuePublisher {
  readonly #queue: QueueBinding;

  constructor(queue: QueueBinding) {
    this.#queue = queue;
  }

  async send(message: unknown): Promise<boolean> {
    try {
      await this.#queue.send(message);
      return true;
    } catch {
      // Không log ở đây: `publishOutbox` đã đưa lỗi vào `last_error` đã sanitize và đốt
      // `attempts`. Log thêm một bản sẽ ghi nội dung lỗi của Queue ra ngoài, mà lỗi Queue có
      // thể chứa endpoint trong message bị từ chối.
      return false;
    }
  }
}

/**
 * Bề mặt của Queue binding mà adapter này cần.
 *
 * ⚠️ Thu hẹp còn `send()`: binding thật của Workers có nhiều hơn (`push`, `pushWithContent`,
 * `batch`, …), và một port chỉ cần một method thì không nên phụ thuộc vào phần còn lại.
 */
export interface QueueBinding {
  send(message: unknown): Promise<unknown>;
}
