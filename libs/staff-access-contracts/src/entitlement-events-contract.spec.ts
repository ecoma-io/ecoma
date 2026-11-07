import { describe, expect, it } from 'vitest';

import {
  entitlementEvent,
  ENTITLEMENT_EVENT_PRODUCER,
  ENTITLEMENT_EVENT_TYPES,
  FORBIDDEN_ENTITLEMENT_EVENT_FIELDS,
  isEntitlementEventType,
  validateEntitlementEvent,
  type EntitlementEvent,
  type EntitlementEventRejectionReason,
} from './entitlement-events-contract';

function makeEvent(overrides: Partial<EntitlementEvent> = {}): EntitlementEvent {
  return {
    event_id: '0f0e0d0c-0b0a-4928-8276-001122334455',
    type: 'entitlement.granted',
    staff_id: 'staff-0001',
    product: 'remote-cache',
    revision: 1,
    occurred_at: '2026-01-01T00:00:00Z',
    producer: ENTITLEMENT_EVENT_PRODUCER,
    ...overrides,
  };
}

/** Assert payload bị từ chối với `reason` và `detail` chứa `fragment`. */
function expectRejectedBy(
  result:
    | { ok: true; payload: unknown }
    | { ok: false; reason: EntitlementEventRejectionReason; detail: string },
  reason: EntitlementEventRejectionReason,
  fragment: string,
): void {
  expect(result).toMatchObject({ ok: false, reason });
  if (result.ok) {
    throw new Error('Expected the payload to be rejected, but it was accepted.');
  }
  expect(result.detail).toContain(fragment);
}

describe('validateEntitlementEvent — accept', () => {
  it.each([...ENTITLEMENT_EVENT_TYPES])('accepts type %s', (type) => {
    const event = makeEvent({ type });
    expect(validateEntitlementEvent(event)).toEqual({ ok: true, payload: event });
  });

  it('accepts an event built by entitlementEvent', () => {
    const event = entitlementEvent({
      eventId: '1f0e0d0c-0b0a-4928-8276-001122334455',
      type: 'entitlement.revoked',
      staffId: 'staff-0002',
      product: 'pact-broker',
      revision: 4,
      occurredAt: '2026-02-01T12:30:00Z',
    });
    expect(validateEntitlementEvent(event)).toEqual({ ok: true, payload: event });
  });

  it('pins the producer to staff-access via the builder', () => {
    const event = entitlementEvent({
      eventId: '2f0e0d0c-0b0a-4928-8276-001122334455',
      type: 'entitlement.granted',
      staffId: 'staff-0003',
      product: 'backoffice',
      revision: 9,
      occurredAt: '2026-03-01T00:00:00Z',
    });
    expect(event.producer).toBe('staff-access');
  });
});

describe('validateEntitlementEvent — the entitlement vs authorization boundary (ADR-0009)', () => {
  it.each([...FORBIDDEN_ENTITLEMENT_EVENT_FIELDS])('rejects an event carrying %s', (field) => {
    const event = { ...makeEvent(), [field]: 'leak' };
    const result = validateEntitlementEvent(event);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', field);
  });

  it('rejects an allow/deny verdict even when null', () => {
    const event = { ...makeEvent(), decision: null };
    expect(validateEntitlementEvent(event)).toMatchObject({
      ok: false,
      reason: 'forbidden_field',
    });
  });

  it('rejects transport hints — the mechanism is pinned by Phase 2, not by the payload', () => {
    // Event KHÔNG mang queue/topic/transport: cơ chế delivery là quyết định
    // P2.2/P2.5, không phải dữ liệu của event; một tên queue trong payload là
    // mã hoá transport vào hợp đồng nội dung.
    const event = { ...makeEvent(), queue: 'entitlement-events' };
    const result = validateEntitlementEvent(event);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', 'queue');
  });
});

describe('validateEntitlementEvent — invalid shapes', () => {
  it.each([
    ['null', null],
    ['a string', 'event'],
    ['an array', [makeEvent()]],
  ])('rejects %s as an event', (_label, event) => {
    expect(validateEntitlementEvent(event)).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });

  it.each([['missing event_id'], ['missing staff_id'], ['missing revision'], ['missing producer']])(
    'rejects an event with %s',
    (label) => {
      const field = label.replace('missing ', '') as keyof EntitlementEvent;
      // Rest-spread thay cho `delete` (no-dynamic-delete): event bị cắt field
      // vẫn mang ý nghĩa "thiếu field" mà không cần xóa key động.
      const { [field]: _removed, ...rest } = makeEvent();
      const event: Record<string, unknown> = { ...rest };
      expect(validateEntitlementEvent(event)).toMatchObject({
        ok: false,
        reason: 'invalid_payload',
      });
    },
  );

  it.each(['not-a-uuid', '', '0F0E0D0C-0B0A-4928-8276-00112233445X', 1])(
    'rejects event_id %p',
    (eventId) => {
      const event = makeEvent({ event_id: eventId as string });
      expect(validateEntitlementEvent(event)).toMatchObject({
        ok: false,
        reason: 'invalid_event_id',
      });
    },
  );

  it.each(['entitlement.suspended', 'authz.allow', '', 1, null])('rejects type %p', (type) => {
    const event = makeEvent({ type: type as EntitlementEvent['type'] });
    expect(validateEntitlementEvent(event)).toMatchObject({ ok: false, reason: 'invalid_type' });
  });

  it.each(['unknown-product', '', 1, null])('rejects product %p', (product) => {
    const event = makeEvent({ product: product as EntitlementEvent['product'] });
    expect(validateEntitlementEvent(event)).toMatchObject({
      ok: false,
      reason: 'invalid_product',
    });
  });

  it.each([0, -1, 1.5])('rejects revision %s', (revision) => {
    const event = makeEvent({ revision: revision as number });
    expect(validateEntitlementEvent(event)).toMatchObject({
      ok: false,
      reason: 'invalid_revision',
    });
  });

  it('rejects an occurred_at without an explicit offset', () => {
    const event = makeEvent({ occurred_at: '2026-01-01T00:00:00' });
    expect(validateEntitlementEvent(event)).toMatchObject({
      ok: false,
      reason: 'invalid_occurred_at',
    });
  });

  it('rejects a foreign producer', () => {
    const event = makeEvent({ producer: 'backoffice' as EntitlementEvent['producer'] });
    const result = validateEntitlementEvent(event);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'invalid_producer', 'staff-access');
  });

  it('rejects an unknown extra field', () => {
    const event = { ...makeEvent(), mystery_field: 1 };
    const result = validateEntitlementEvent(event);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', 'mystery_field');
  });
});

describe('envelope carries no transport', () => {
  it('exposes no queue/topic/SLA constants', () => {
    // ADR-0002: SLA ≤60s/≤5s là target; ADR-0009: không sync call per request;
    // P2.2/P2.5 pin cơ chế. Contract envelope CỐ Ý không có hằng transport/SLA.
    const spec = import.meta.glob('./entitlement-events-contract.ts', {
      eager: true,
      import: 'default',
    });
    const mod = spec['./entitlement-events-contract.ts'] as Record<string, unknown>;
    const transportConstants = Object.keys(mod ?? {}).filter((name) =>
      /(QUEUE|TOPIC|SLA|LATENCY|DELIVERY|TRANSPORT)/iu.test(name),
    );
    expect(transportConstants).toEqual([]);
  });
});

describe('isEntitlementEventType', () => {
  it.each([...ENTITLEMENT_EVENT_TYPES])('accepts %s', (type) => {
    expect(isEntitlementEventType(type)).toBe(true);
  });

  it.each(['entitlement.suspended', 'ENTITLEMENT.GRANTED', null, 1])('rejects %p', (type) => {
    expect(isEntitlementEventType(type)).toBe(false);
  });
});
