import { describe, expect, it } from 'vitest';

import { DELIVERY_STATUS, DELIVERY_STATUS_VALUES, type DeliveryStatus } from './delivery';
import {
  applyPublisherSuccess,
  canCreateOutboxIntent,
  decideOutboxClaim,
  isOpenOutboxStatus,
  isOutboxStatus,
  isTerminalOutboxStatus,
  OPEN_OUTBOX_STATUS_VALUES,
  OUTBOX_STATUS,
  OUTBOX_STATUS_VALUES,
  TERMINAL_OUTBOX_STATUS_VALUES,
  type OutboxRecordState,
} from './outbox';

const NOW = 1_000;

function record(overrides: Partial<OutboxRecordState> = {}): OutboxRecordState {
  return {
    status: OUTBOX_STATUS.Pending,
    attempts: 1,
    availableAt: NOW - 1,
    leaseExpiresAt: null,
    ...overrides,
  };
}

describe('outbox status vocabulary is separate from delivery status', () => {
  it('declares pending, publishing, published, failed', () => {
    expect(OUTBOX_STATUS_VALUES).toStrictEqual([
      OUTBOX_STATUS.Pending,
      OUTBOX_STATUS.Publishing,
      OUTBOX_STATUS.Published,
      OUTBOX_STATUS.Failed,
    ]);
  });

  it('shares no value with the delivery vocabulary', () => {
    const deliveryValues: readonly string[] = [
      DELIVERY_STATUS.Pending,
      DELIVERY_STATUS.Queued,
      DELIVERY_STATUS.Processing,
      DELIVERY_STATUS.Delivered,
      DELIVERY_STATUS.Failed,
      DELIVERY_STATUS.Expired,
      DELIVERY_STATUS.Cancelled,
    ];
    const shared = OUTBOX_STATUS_VALUES.filter((status) => deliveryValues.includes(status));
    // `pending` và `failed` trùng chuỗi ở hai vocabulary, nhưng chúng là hai state
    // machine độc lập — test này ghi lại rằng domain không suy ra state machine này
    // từ state machine kia.
    expect(shared).toStrictEqual([OUTBOX_STATUS.Pending, OUTBOX_STATUS.Failed]);
  });

  it('accepts declared statuses and rejects others', () => {
    for (const status of OUTBOX_STATUS_VALUES) {
      expect(isOutboxStatus(status)).toBe(true);
    }
    for (const value of ['queued', 'Publishing', '', null, 2]) {
      expect(isOutboxStatus(value)).toBe(false);
    }
  });

  it('treats only published as terminal and pending/publishing as open', () => {
    expect(TERMINAL_OUTBOX_STATUS_VALUES).toStrictEqual([OUTBOX_STATUS.Published]);
    expect(OPEN_OUTBOX_STATUS_VALUES).toStrictEqual([
      OUTBOX_STATUS.Pending,
      OUTBOX_STATUS.Publishing,
    ]);
    for (const status of OUTBOX_STATUS_VALUES) {
      expect(isTerminalOutboxStatus(status)).toBe(status === OUTBOX_STATUS.Published);
      expect(isOpenOutboxStatus(status)).toBe(
        status === OUTBOX_STATUS.Pending || status === OUTBOX_STATUS.Publishing,
      );
    }
  });

  it('does not treat failed as terminal, because it stays operator-recoverable', () => {
    expect(isTerminalOutboxStatus(OUTBOX_STATUS.Failed)).toBe(false);
    expect(isOpenOutboxStatus(OUTBOX_STATUS.Failed)).toBe(false);
  });
});

describe('outbox claim predicate', () => {
  it('claims a pending record whose backoff is due', () => {
    const result = decideOutboxClaim(record(), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(OUTBOX_STATUS.Publishing);
  });

  it('claims a pending record exactly at available_at', () => {
    const result = decideOutboxClaim(record({ availableAt: NOW }), NOW);
    expect(result.ok).toBe(true);
  });

  it('reports backoff_not_due while available_at is in the future', () => {
    const result = decideOutboxClaim(record({ availableAt: NOW + 1 }), NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('backoff_not_due');
  });

  it('claims a publishing record whose lease expired', () => {
    const result = decideOutboxClaim(
      record({ status: OUTBOX_STATUS.Publishing, leaseExpiresAt: NOW - 1 }),
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(OUTBOX_STATUS.Publishing);
  });

  it('reports lease_held while the publishing lease is effective', () => {
    const result = decideOutboxClaim(
      record({ status: OUTBOX_STATUS.Publishing, leaseExpiresAt: NOW + 1 }),
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('lease_held');
  });

  it('treats a publishing record with a null lease as malformed, matching the SQL predicate', () => {
    // `status = 'publishing' AND lease_expires_at <= :now` không khớp hàng null, nên
    // record `publishing` không mang lease là trạng thái model nói không tồn tại —
    // không được cấp lease mới cho hàng dữ liệu hỏng.
    const result = decideOutboxClaim(
      record({ status: OUTBOX_STATUS.Publishing, leaseExpiresAt: null }),
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_outbox');
  });

  it('never claims a published record', () => {
    const result = decideOutboxClaim(
      record({ status: OUTBOX_STATUS.Published, availableAt: NOW - 1 }),
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('already_published');
  });

  it('never claims a failed record, whatever the clock says', () => {
    for (const availableAt of [NOW - 1, NOW, NOW + 1]) {
      const result = decideOutboxClaim(record({ status: OUTBOX_STATUS.Failed, availableAt }), NOW);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('failed_not_claimable');
    }
  });

  it('reports terminal and failed states before the backoff window', () => {
    const published = decideOutboxClaim(
      record({ status: OUTBOX_STATUS.Published, availableAt: NOW + 1 }),
      NOW,
    );
    expect(published.ok).toBe(false);
    if (published.ok) return;
    expect(published.reason).toBe('already_published');

    const failed = decideOutboxClaim(
      record({ status: OUTBOX_STATUS.Failed, availableAt: NOW + 1 }),
      NOW,
    );
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.reason).toBe('failed_not_claimable');
  });

  it('rejects a malformed record or a non-finite now', () => {
    expect(decideOutboxClaim(record({ attempts: 0 }), NOW)).toMatchObject({
      ok: true,
      status: 'publishing',
    });

    expect(decideOutboxClaim(record({ status: 'queued' as never }), NOW)).toMatchObject({
      ok: false,
      reason: 'malformed_outbox',
    });

    expect(decideOutboxClaim(record(), Number.NaN)).toMatchObject({
      ok: false,
      reason: 'malformed_outbox',
    });
  });

  // Predicate §6.1 là `available_at <= now` và `lease_expires_at <= now`. Với mốc thời
  // gian không nguyên (`1000.5`) hoặc vượt miền an toàn, phép so sánh vẫn trả lời được
  // nhưng không có cùng ý nghĩa với `DATETIME` của D1 và có thể lệch về hai phía, nên
  // đó là dữ liệu hỏng chứ không phải "chưa tới hạn".
  it('rejects a backoff or lease deadline that is not a safe integer of epoch millis', () => {
    for (const availableAt of [NOW - 0.5, Number.NaN, Number.POSITIVE_INFINITY, null as never]) {
      const result = decideOutboxClaim(record({ availableAt }), NOW);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('malformed_outbox');
    }
    for (const leaseExpiresAt of [NOW - 0.5, Number.MAX_SAFE_INTEGER + 2, null as never]) {
      const pending = decideOutboxClaim(
        record({ status: OUTBOX_STATUS.Publishing, leaseExpiresAt }),
        NOW,
      );
      expect(pending.ok).toBe(false);
      if (pending.ok) continue;
      expect(pending.reason).toBe('malformed_outbox');
    }
  });

  it('rejects a now that is a finite but not safe integer', () => {
    // `isFiniteNumber` cũ chấp nhận `Number.NaN`… không: nó chỉ chặn NaN/Infinity, nên
    // `1000.5` lọt qua và cổng backoff so sánh với một mốc thời gian không tồn tại.
    for (const now of [NOW + 0.5, Number.MAX_SAFE_INTEGER + 2, -1.5]) {
      const result = decideOutboxClaim(record(), now);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('malformed_outbox');
    }
  });

  it('never mutates the record it is given', () => {
    const input = Object.freeze(
      record({ status: OUTBOX_STATUS.Publishing, leaseExpiresAt: NOW - 1 }),
    );
    const snapshot = structuredClone(input);
    decideOutboxClaim(input, NOW);
    expect(input).toStrictEqual(snapshot);
  });
});

describe('publisher success writes the outbox record and only conditionally the delivery', () => {
  it('advances a pending delivery to queued', () => {
    const result = applyPublisherSuccess(DELIVERY_STATUS.Pending);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outboxStatus).toBe(OUTBOX_STATUS.Published);
    expect(result.deliveryWrite.kind).toBe('advance_to_queued');
    expect(result.deliveryWrite.status).toBe(DELIVERY_STATUS.Queued);
  });

  it('keeps the delivery status when a consumer already claimed it', () => {
    const result = applyPublisherSuccess(DELIVERY_STATUS.Processing);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outboxStatus).toBe(OUTBOX_STATUS.Published);
    expect(result.deliveryWrite.kind).toBe('keep_delivery_status');
    expect(result.deliveryWrite.status).toBe(DELIVERY_STATUS.Processing);
  });

  it('keeps the delivery status when a previous publish already queued it', () => {
    const result = applyPublisherSuccess(DELIVERY_STATUS.Queued);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deliveryWrite.kind).toBe('keep_delivery_status');
    expect(result.deliveryWrite.status).toBe(DELIVERY_STATUS.Queued);
  });

  it('still marks the outbox published for a terminal delivery, without reviving it', () => {
    for (const status of [
      DELIVERY_STATUS.Delivered,
      DELIVERY_STATUS.Failed,
      DELIVERY_STATUS.Expired,
      DELIVERY_STATUS.Cancelled,
    ]) {
      const result = applyPublisherSuccess(status);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.outboxStatus).toBe(OUTBOX_STATUS.Published);
      expect(result.deliveryWrite.kind).toBe('keep_delivery_status');
      expect(result.deliveryWrite.status).toBe(status);
      expect(result.deliveryWrite.status).not.toBe(DELIVERY_STATUS.Queued);
    }
  });

  it('never writes queued for a delivery that was not pending, not even incidentally', () => {
    for (const status of [
      DELIVERY_STATUS.Processing,
      DELIVERY_STATUS.Delivered,
      DELIVERY_STATUS.Failed,
      DELIVERY_STATUS.Expired,
      DELIVERY_STATUS.Cancelled,
    ] as readonly DeliveryStatus[]) {
      const result = applyPublisherSuccess(status);
      if (!result.ok) continue;
      // `keep_delivery_status` giữ nguyên trạng thái hiện tại — không trạng thái nào
      // trong nhóm này có thể trùng `queued`.
      expect(result.deliveryWrite.kind).toBe('keep_delivery_status');
      expect(result.deliveryWrite.status).toBe(status);
    }
  });

  it('reports queued only as the result of advancing a pending delivery', () => {
    // `queued` là trạng thái hợp lệ của một delivery đã publish xong, nên nó chỉ được
    // sinh ra từ nhánh `pending`.
    const advanced = DELIVERY_STATUS_VALUES.flatMap((status) => {
      const result = applyPublisherSuccess(status);
      return result.ok && result.deliveryWrite.kind === 'advance_to_queued' ? [status] : [];
    });
    expect(advanced).toStrictEqual([DELIVERY_STATUS.Pending]);
  });

  it('rejects a status outside the vocabulary', () => {
    const result = applyPublisherSuccess('draft' as DeliveryStatus);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_delivery');
  });
});

describe('at most one open outbox intent per delivery', () => {
  it('allows the first intent', () => {
    const result = canCreateOutboxIntent(0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.allowed).toBe(true);
  });

  it('refuses a second intent while one is pending or publishing', () => {
    for (const openCount of [1, 2, 5]) {
      const result = canCreateOutboxIntent(openCount);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('open_outbox_intent');
    }
  });

  it('refuses rather than allowing a negative or fractional count', () => {
    for (const openCount of [-1, 1.5, Number.NaN]) {
      const result = canCreateOutboxIntent(openCount);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('open_outbox_intent');
    }
  });

  it('allows a new intent once the previous ones are published or failed', () => {
    // §6.1: record published/failed KHÔNG nằm trong ràng buộc — một intent mới hợp lệ
    // được phép tồn tại cạnh chúng. Trạng thái đó được biểu diễn bằng openIntentCount = 0.
    const result = canCreateOutboxIntent(0);
    expect(result.ok).toBe(true);
  });
});
