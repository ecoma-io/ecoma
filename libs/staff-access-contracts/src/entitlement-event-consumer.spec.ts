import { describe, expect, it } from 'vitest';

import { shouldApplyEntitlementEvent } from './entitlement-event-consumer';
import { entitlementEvent, type EntitlementEvent } from './entitlement-events-contract';

function makeEvent(overrides: Partial<EntitlementEvent> = {}): EntitlementEvent {
  return {
    event_id: '0f0e0d0c-0b0a-4928-8276-001122334455',
    type: 'entitlement.granted',
    staff_id: 'staff-0001',
    product: 'remote-cache',
    revision: 1,
    occurred_at: '2026-01-01T00:00:00Z',
    producer: 'staff-access',
    ...overrides,
  };
}

describe('shouldApplyEntitlementEvent — apply decisions', () => {
  it('applies the first event seen for the key', () => {
    expect(shouldApplyEntitlementEvent(null, makeEvent({ revision: 1 }))).toEqual({
      apply: true,
      reason: 'first',
    });
  });

  it('applies the first event even at a revision above 1', () => {
    // Không có state đã thấy thì bản đầu tiên tới là bản đúng — không đòi
    // revision bắt đầu từ 1, vì consumer có thể bắt đầu với state đồng bộ sẵn.
    expect(shouldApplyEntitlementEvent(null, makeEvent({ revision: 7 }))).toEqual({
      apply: true,
      reason: 'first',
    });
  });

  it('applies an event with a higher revision', () => {
    expect(shouldApplyEntitlementEvent(3, makeEvent({ revision: 4 }))).toEqual({
      apply: true,
      reason: 'newer',
    });
  });
});

describe('shouldApplyEntitlementEvent — drop decisions', () => {
  it('drops a duplicate at the same revision', () => {
    expect(shouldApplyEntitlementEvent(3, makeEvent({ revision: 3 }))).toEqual({
      apply: false,
      reason: 'duplicate',
    });
  });

  it('drops an out-of-order older event without rolling back', () => {
    expect(shouldApplyEntitlementEvent(5, makeEvent({ revision: 2 }))).toEqual({
      apply: false,
      reason: 'stale',
    });
  });
});

describe('shouldApplyEntitlementEvent — invalid inputs', () => {
  it.each([
    ['null', null],
    ['a string', 'event'],
    ['an array', [makeEvent()]],
    ['an object missing revision', { type: 'entitlement.granted' }],
  ])('rejects %s as an event', (_label, event) => {
    expect(shouldApplyEntitlementEvent(1, event)).toEqual({ apply: false, reason: 'invalid' });
  });

  it('rejects an event whose revision is not a positive integer', () => {
    expect(shouldApplyEntitlementEvent(1, makeEvent({ revision: 0 }))).toEqual({
      apply: false,
      reason: 'invalid',
    });
  });

  it('rejects an event carrying a forbidden authorization field', () => {
    // Ranh giới ADR-0009: envelope mang verdict/permission/role là payload sai,
    // không phải bản cũ hay bản trùng — quyết định là `invalid`.
    expect(shouldApplyEntitlementEvent(1, { ...makeEvent(), verdict: 'allow' })).toEqual({
      apply: false,
      reason: 'invalid',
    });
  });

  it('rejects an invalid event even when nothing was seen yet', () => {
    // Guard envelope chạy trước nhánh `first`: payload hỏng không bao giờ áp dụng.
    expect(shouldApplyEntitlementEvent(null, 'not-an-event')).toEqual({
      apply: false,
      reason: 'invalid',
    });
  });

  it.each([-1, 1.5, Number.NaN, '3', Number.MAX_SAFE_INTEGER + 1])(
    'rejects currentRevision %p',
    (currentRevision) => {
      expect(
        shouldApplyEntitlementEvent(currentRevision as number, makeEvent({ revision: 1 })),
      ).toEqual({ apply: false, reason: 'invalid' });
    },
  );

  it('accepts currentRevision 0 as a valid seen revision', () => {
    // 0 là revision hợp lệ của "đã thấy bản khởi điểm"; event revision >= 1 luôn
    // mới hơn nên vẫn được áp dụng.
    expect(shouldApplyEntitlementEvent(0, makeEvent({ revision: 1 }))).toEqual({
      apply: true,
      reason: 'newer',
    });
  });
});

describe('shouldApplyEntitlementEvent — monotonic convergence over replay', () => {
  it('applies strictly increasing revisions and skips the rest', () => {
    // Chuỗi delivery qua lại (duplicate + out-of-order) là bình thường của kênh
    // bất đồng bộ; consumer áp dụng lại chuỗi bất kỳ vẫn hội tụ về revision lớn nhất.
    const revisions = [5, 1, 4, 2, 6, 3, 6];
    let currentRevision: number | null = null;
    const applied: number[] = [];

    for (const revision of revisions) {
      const decision = shouldApplyEntitlementEvent(
        currentRevision,
        entitlementEvent({
          eventId: '0f0e0d0c-0b0a-4928-8276-001122334455',
          type: 'entitlement.granted',
          staffId: 'staff-0001',
          product: 'remote-cache',
          revision,
          occurredAt: '2026-01-01T00:00:00Z',
        }),
      );
      if (decision.apply) {
        applied.push(revision);
        currentRevision = revision;
      }
    }

    expect(applied).toEqual([5, 6]);
    expect(currentRevision).toBe(6);
  });
});
