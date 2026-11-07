/**
 * Entitlement **delivery freshness metrics** — nền tảng số đo (P2.4, issue #453).
 *
 * File này chỉ định nghĩa **tên metric và label** theo ADR-0014 — không wire
 * runtime. Consumer (P2.3) và reconciliation job (P2.4) expose hai tín hiệu đo
 * bắt buộc của ADR-0014:
 *
 *   1. delivery latency theo event class (`high` ≤ 5s, `normal` ≤ 60s deadline)
 *      — percentile khoảng cách commit-state → consumer-state-updated.
 *   2. tỉ lệ freshness-bound fail-closed ở consumer.
 *
 * ⚠️ **Chỉ tên + label, không runtime.** Đây là hợp đồng về *vocabulary* của
 * số đo, giống như metric name của web-push delivery plane: tên và dimension
 * được ghim ở đây, cách ghi (sink, histogram vs counter, percentile) là quyết
 * định vận hành sau. Consumer và job đọc hằng số này khi expose metric thật,
 * nên đổi tên là breaking change với dashboard/alert đã cấu hình.
 *
 * ⚠️ **Không import implementation** — đúng ràng buộc `type:contracts`. File
 * chỉ chứa hằng số và type thuần.
 *
 * Source of truth:
 * - ADR-0014 §"Số đo và acceptance": hai tín hiệu đo bắt buộc.
 * - ADR-0002: hai risk class `normal` (≤60s) / `high` (≤5s) — deadline delivery.
 * - roadmap Phase 2 (P2.4): metric freshness.
 */

/** Risk class delivery theo ADR-0002/ADR-0014 — gắn theo event class, không theo role. */
export const ENTITLEMENT_DELIVERY_EVENT_CLASSES = ['high', 'normal'] as const;

export type EntitlementDeliveryEventClass = (typeof ENTITLEMENT_DELIVERY_EVENT_CLASSES)[number];

/** Type guard cho {@link EntitlementDeliveryEventClass}. */
export function isEntitlementDeliveryEventClass(
  value: unknown,
): value is EntitlementDeliveryEventClass {
  return (
    typeof value === 'string' &&
    (ENTITLEMENT_DELIVERY_EVENT_CLASSES as readonly string[]).includes(value)
  );
}

/**
 * Deadline delivery theo event class (ms) — đúng target của ADR-0002. Đây là
 * target vận hành của kênh, không phải cam kết cơ chế (ADR-0002).
 */
export const ENTITLEMENT_DELIVERY_DEADLINE_MS: Readonly<
  Record<EntitlementDeliveryEventClass, number>
> = {
  high: 5_000,
  normal: 60_000,
};

/**
 * Tên metric — delivery latency theo event class (khoảng cách commit-state →
 * consumer-state-updated). Đơn vị ms, tổng hợp percentile ở sink.
 */
export const ENTITLEMENT_DELIVERY_LATENCY_METRIC = 'entitlement_delivery_latency_ms' as const;

/**
 * Tên metric — số lần freshness bound fail-closed ở consumer (state stale quá
 * deadline → từ chối). Đếm theo event class.
 */
export const ENTITLEMENT_FRESHNESS_FAIL_CLOSED_TOTAL_METRIC =
  'entitlement_freshness_fail_closed_total' as const;

/**
 * Tên metric — tổng số lần kiểm freshness bound ở consumer (mẫu số của tỉ lệ
 * fail-closed). Đếm theo event class.
 */
export const ENTITLEMENT_FRESHNESS_CHECKS_TOTAL_METRIC =
  'entitlement_freshness_checks_total' as const;

/**
 * Tên metric — số outbox row đã publish nhưng còn stale quá ngưỡng reconciliation
 * (dấu hiệu delivery rớt). Expose bởi reconciliation job (P2.4, alert-only).
 */
export const ENTITLEMENT_RECONCILIATION_STALE_PUBLISHED_TOTAL_METRIC =
  'entitlement_reconciliation_stale_published_total' as const;

/**
 * Label keys dùng chung cho các metric trên. Giá trị label là
 * {@link EntitlementDeliveryEventClass} — không dùng staff_id/event_id (high
 * cardinality, làm metric không dùng được).
 */
export const ENTITLEMENT_DELIVERY_METRIC_LABELS = {
  eventClass: 'event_class',
} as const;

/** Shape của dimension hợp lệ cho các metric delivery freshness. */
export interface EntitlementDeliveryMetricDimensions {
  readonly [ENTITLEMENT_DELIVERY_METRIC_LABELS.eventClass]: EntitlementDeliveryEventClass;
}
