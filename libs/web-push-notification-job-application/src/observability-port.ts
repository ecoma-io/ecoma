/**
 * Observability port của delivery plane — metric và log, **không** phải phụ thuộc của đường
 * serving.
 *
 * ⚠️ **Vì sao đây là port thay vì import logger của control plane.**
 * `libs/push-notification-infrastructure/src/observability.ts` là tài liệu tham khảo
 * (JSON-line, nuốt lỗi, `LogFields` chỉ nhận scalar) nhưng **không** được import: `scope`
 * của control plane và delivery plane là hai boundary khác nhau, và một tầng application
 * đi vào infrastructure của service khác là đường phụ thuộc mà Nx graph sẽ ghi nhận. Job
 * infrastructure có **bản riêng** của mình (`src/observability.ts`), cùng pattern, cùng
 * bất biến.
 *
 * ⚠️ **`delivery_id`/`notification_id` KHÔNG** bao giờ là metric label (§11): đó là
 * high-cardinality và làm metric không dùng được. Chúng được phép trong **log** (correlation
 * chain `request_id → notification_id → delivery_id → subscription_id → provider_id`), và
 * `provider_id`/`app`/`transport` là dimension tối thiểu cho cả metric lẫn alert.
 *
 * ⚠️ **Không endpoint, không payload, không secret** ở bất kỳ đâu trong port này: type của
 * metric chỉ nhận `Record<string, string | number | boolean>`, nên không có chỗ cho một
 * object lọt vào mà không bị type chặn (SR-003, §12 "không log prompt/response body").
 */

/** Label của metric — scalar, không mảng lồng, không object. */
export type MetricDimensions = Readonly<Record<string, string | number | boolean>>;

/** Tập metric bắt buộc của §11 — tập **đóng** để một metric lạ phải được thêm có chủ đích. */
export type DeliveryMetricName =
  | 'deliveries_consumed'
  | 'deliveries_delivered'
  | 'deliveries_failed'
  | 'deliveries_retried'
  | 'deliveries_skipped'
  | 'subscriptions_invalidated'
  | 'provider_request_total'
  | 'provider_request_success'
  | 'provider_request_failure'
  | 'provider_request_latency_ms'
  | 'queue_consumer_errors'
  | 'runtime_resolution_errors'
  | 'retry_count'
  | 'dlq_messages';

/**
 * Ghi metric. **Không** ném ra ngoài — một metric sink hỏng không được làm một delivery fail.
 */
export interface MetricsPort {
  increment(name: DeliveryMetricName, dimensions?: MetricDimensions): void;
  observe(name: DeliveryMetricName, value: number, dimensions?: MetricDimensions): void;
}

/**
 * Log delivery execution — **một** dòng JSON, trường scalar.
 *
 * ⚠️ Tên log `warn`/`error` mang ý nghĩa cảnh báo: `provider_auth` và `redirect_not_followed`
 * là hai failure có alert-level trong §12, còn `expired` là kết cục bình thường — hai thứ
 * này **không** được cùng một mức log, vì alert dựa trên log sẽ hỏng nếu chúng chung mức.
 */
export type DeliveryLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Trường của một dòng log — scalar, hoặc danh sách scalar (correlation chain). */
export type DeliveryLogFields = Readonly<
  Record<string, string | number | boolean | readonly (string | number | boolean)[]>
>;

export interface LoggerPort {
  log(level: DeliveryLogLevel, message: string, fields?: DeliveryLogFields): void;
}
