import { describe, expect, it } from 'vitest';

import {
  ENTITLEMENT_DELIVERY_DEADLINE_MS,
  ENTITLEMENT_DELIVERY_EVENT_CLASSES,
  ENTITLEMENT_DELIVERY_LATENCY_METRIC,
  ENTITLEMENT_DELIVERY_METRIC_LABELS,
  ENTITLEMENT_FRESHNESS_CHECKS_TOTAL_METRIC,
  ENTITLEMENT_FRESHNESS_FAIL_CLOSED_TOTAL_METRIC,
  ENTITLEMENT_RECONCILIATION_STALE_PUBLISHED_TOTAL_METRIC,
  isEntitlementDeliveryEventClass,
  type EntitlementDeliveryMetricDimensions,
} from './entitlement-delivery-metrics-contract';

describe('entitlement delivery metrics contract', () => {
  it('pins the ADR-0002 deadlines per event class', () => {
    // ADR-0002: target `high` <= 5s, `normal` <= 60s — con số này là target
    // vận hành, không phải cam kết cơ chế (ADR-0002).
    expect(ENTITLEMENT_DELIVERY_DEADLINE_MS).toEqual({ high: 5_000, normal: 60_000 });
  });

  it('exposes exactly two event classes', () => {
    expect([...ENTITLEMENT_DELIVERY_EVENT_CLASSES]).toEqual(['high', 'normal']);
  });

  it('names the delivery latency metric in milliseconds', () => {
    expect(ENTITLEMENT_DELIVERY_LATENCY_METRIC).toBe('entitlement_delivery_latency_ms');
  });

  it('names the freshness fail-closed and checks metrics', () => {
    expect(ENTITLEMENT_FRESHNESS_FAIL_CLOSED_TOTAL_METRIC).toBe(
      'entitlement_freshness_fail_closed_total',
    );
    expect(ENTITLEMENT_FRESHNESS_CHECKS_TOTAL_METRIC).toBe('entitlement_freshness_checks_total');
  });

  it('names the reconciliation stale-published metric', () => {
    expect(ENTITLEMENT_RECONCILIATION_STALE_PUBLISHED_TOTAL_METRIC).toBe(
      'entitlement_reconciliation_stale_published_total',
    );
  });

  it('uses a single low-cardinality label key', () => {
    // ADR-0009 §11 lý do của web-push observability cũng áp dụng: label
    // high-cardinality (staff_id/event_id) làm metric không dùng được — chỉ
    // event_class được phép.
    expect(Object.keys(ENTITLEMENT_DELIVERY_METRIC_LABELS)).toEqual(['eventClass']);
    expect(ENTITLEMENT_DELIVERY_METRIC_LABELS.eventClass).toBe('event_class');
  });

  it('validates event class values', () => {
    expect(isEntitlementDeliveryEventClass('high')).toBe(true);
    expect(isEntitlementDeliveryEventClass('normal')).toBe(true);
    expect(isEntitlementDeliveryEventClass('medium')).toBe(false);
    expect(isEntitlementDeliveryEventClass('')).toBe(false);
    expect(isEntitlementDeliveryEventClass(null)).toBe(false);
    expect(isEntitlementDeliveryEventClass(1)).toBe(false);
  });

  it('types dimensions around the event class label', () => {
    const dimensions: EntitlementDeliveryMetricDimensions = { event_class: 'high' };
    expect(dimensions.event_class).toBe('high');
  });
});
