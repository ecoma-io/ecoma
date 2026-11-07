/**
 * Test cho {@link createMetrics}.
 *
 * ⚠️ Vì sao khẳng định **snapshot**, không khẳng định số lần gọi `increment`: `MetricsPort` cố ý
 * **không** có `snapshot()` (nó là method đọc thêm mà pipeline không bao giờ gọi), nên test
 * phải giữ kiểu `MetricsPort & MetricsSnapshotSource` để đọc được. Đó là cách duy nhất để
 * khẳng định **hiệu ứng thật** thay vì khẳng định "hàm được gọi".
 *
 * ⚠️ Test quan trọng nhất ở đây là `orders dimension keys` — nó bắt lỗi làm metric **không
 * dùng được**: hai call site ghi cùng một metric với cùng nội dung dimension nhưng khác thứ tự
 * khoá sẽ tạo hai chuỗi đếm khác nhau, và tổng của metric sai.
 */

import { describe, expect, it } from 'vitest';

import { createMetrics } from './observability';

function harness() {
  const metrics = createMetrics({ service: 'web-push-notification-job', now: () => 1000 });
  return { metrics, snapshot: metrics.snapshot };
}

describe('createMetrics', () => {
  it('counts a metric with no dimensions under its bare name', () => {
    const { metrics, snapshot } = harness();
    metrics.increment('queue_consumer_errors');
    metrics.increment('queue_consumer_errors');

    expect(snapshot().counters.get('queue_consumer_errors')).toBe(2);
  });

  it('keeps distinct dimension sets in distinct series', () => {
    const { metrics, snapshot } = harness();
    metrics.increment('deliveries_delivered', { provider_id: 'web-push-eu' });
    metrics.increment('deliveries_delivered', { provider_id: 'web-push-us' });

    const counters = snapshot().counters;
    expect(counters.get('deliveries_delivered{provider_id=web-push-eu}')).toBe(1);
    expect(counters.get('deliveries_delivered{provider_id=web-push-us}')).toBe(1);
  });

  it('orders dimension keys, so insertion order cannot split one series in two', () => {
    const { metrics, snapshot } = harness();
    metrics.increment('deliveries_failed', { provider_id: 'p', transport: 'web' });
    metrics.increment('deliveries_failed', { transport: 'web', provider_id: 'p' });

    expect(snapshot().counters.get('deliveries_failed{provider_id=p,transport=web}')).toBe(2);
    expect(snapshot().counters.size).toBe(1);
  });

  it('treats an empty dimension object as the bare name', () => {
    const { metrics, snapshot } = harness();
    metrics.increment('dlq_messages', {});

    expect(snapshot().counters.get('dlq_messages')).toBe(1);
  });

  it('records observations as a count of samples, not a fabricated aggregate', () => {
    const { metrics, snapshot } = harness();
    metrics.observe('provider_request_latency_ms', 12, { provider_id: 'p' });
    metrics.observe('provider_request_latency_ms', 40, { provider_id: 'p' });

    expect(snapshot().counters.get('provider_request_latency_ms{provider_id=p}#observations')).toBe(
      2,
    );
  });

  it('ignores a non-finite observation instead of poisoning the metric', () => {
    const { metrics, snapshot } = harness();
    metrics.observe('provider_request_latency_ms', Number.NaN);
    metrics.observe('provider_request_latency_ms', Number.POSITIVE_INFINITY);

    expect(snapshot().counters.size).toBe(0);
  });

  it('stamps lastRecordedAt so a test can prove the counter is live', () => {
    const { metrics, snapshot } = harness();
    expect(snapshot().lastRecordedAt).toBe(0);

    metrics.increment('retry_count');
    expect(snapshot().lastRecordedAt).toBe(1000);
  });

  it('does not share series between two instances', () => {
    const first = createMetrics({ service: 'web-push-notification-job' });
    const second = createMetrics({ service: 'web-push-notification-job' });
    first.increment('deliveries_consumed');

    // ⚠️ Mỗi batch của Queue dựng một bộ đếm mới (composition root không cache isolate), nên
    // hai bộ đếm phải độc lập — nếu chúng dùng chung state thì số đo của một worker là số của
    // cả service và một metric trở nên vô nghĩa.
    expect(first.snapshot().counters.get('deliveries_consumed')).toBe(1);
    expect(second.snapshot().counters.get('deliveries_consumed')).toBeUndefined();
  });
});
