/**
 * Queue consumer — vòng lặp per-message của `web-push-notification-job`.
 *
 * ⚠️ **Vì sao `ackAll`/`retryAll` không xuất hiện ở đây.** Chúng tồn tại trong `MessageBatch` của
 * platform, và FR-018/§12.1 yêu cầu per-message ACK/retry. Chỉ cần chúng **tồn tại trong tầm
 * nhìn** là một call site có thể dùng nhầm và biến một message lỗi thành retry cả batch. Port
 * {@link MessageDisposition} được truyền cho từng message nên một thao tác của message A về mặt
 * kiểu không thể chạm message B.
 *
 * ⚠️ **Không `abort()`** trên lỗi một message: `batchAllSettled`/`ctx.waitUntil` không cần ở
 * đây vì mọi việc đều được `await` tuần tự trong chính handler. `AbortController` sẽ cắt các
 * message chưa xử lý — tức biến một lỗi thành mất việc.
 */

import { processDeliveryMessage, type DeliveryPipelineDeps } from './delivery-pipeline';
import type { MessageDisposition, QueueMessageInfo } from './ports';

/**
 * Một message của Queue, **thu hẹp** về đúng ba thứ pipeline dùng.
 *
 * ⚠️ Không khai `readonly body: unknown` kiểu của platform rồi truyền thẳng vào: một
 * `Message<any>` sẽ làm mất kiểm soát kiểu ở `validateDeliveryCommand`, và `attempts` là
 * input của backoff nên nó phải là **con số** ở kiểu chứ không phải `any`.
 */
export interface ConsumableMessage {
  readonly body: unknown;
  readonly attempts: number;
  readonly ack: () => void;
  readonly retry: (options?: { readonly delaySeconds?: number }) => void;
}

/**
 * Xử lý **một** batch.
 *
 * ⚠️ **Tuần tự, không `Promise.all`.** Việc xử lý một message gồm claim + provider call +
 * write outcome, và chúng đi qua cùng một `delivery_id` khi Queue redeliver; chạy song song
 * chỉ để tăng tỉ lệ hai execution cùng thắng claim rồi đánh vật bằng fencing. Tính bất biến
 * idempotency **không** được phá vì hiệu năng (§17, FR-014).
 *
 * ⚠️ Một message **ném** (không phải trả về outcome) bị bắt và chuyển thành `retry()` — vì một
 * lỗi chưa dự đoán được không được biến thành ACK mù, và không được ném ra ngoài để làm hỏng
 * các message còn lại trong batch.
 */
export async function consumeQueueBatch(
  deps: DeliveryPipelineDeps,
  messages: readonly ConsumableMessage[],
): Promise<void> {
  for (const message of messages) {
    const disposition: MessageDisposition = {
      ack: () => {
        message.ack();
      },
      retry: (options) => {
        message.retry(options);
      },
    };
    const info: QueueMessageInfo = { attempts: message.attempts };
    try {
      await processDeliveryMessage(deps, message.body, info, disposition);
    } catch {
      // Đường lỗi không xác định: bounded retry (rồi DLQ), không phải ACK. `queue_consumer_errors`
      // được tăng ở use case khi lỗi đã phân loại; ở đây là lỗi chưa phân loại nên tăng thêm một
      // lần để metric phản ánh "có lỗi chưa phân loại".
      deps.metrics.increment('queue_consumer_errors');
      deps.metrics.increment('retry_count');
      deps.logger.log('error', 'delivery.unhandled_processing_error', {
        attempts: message.attempts,
      });
      message.retry();
    }
  }
}
