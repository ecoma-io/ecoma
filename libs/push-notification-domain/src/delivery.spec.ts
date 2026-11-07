import { describe, expect, it } from 'vitest';

import {
  type ClaimRejectionReason,
  decideDeliveryClaim,
  decideFencedWrite,
  DELIVERY_STATUS,
  DELIVERY_STATUS_VALUES,
  DELIVERY_TRANSITIONS,
  DELIVERY_TRANSITION_ACTOR,
  DELIVERY_TRANSITION_ACTOR_VALUES,
  type DeliveryLeaseState,
  type DeliveryStatus,
  type DeliveryTransitionActor,
  FENCED_WRITE_OPERATIONS,
  isDeliveryStatus,
  isDeliveryTransitionActor,
  isFencedWriteOperation,
  isNonTerminalDeliveryStatus,
  isTerminalDeliveryStatus,
  planAdministrativeRetry,
  planDeliveryRepublish,
  TERMINAL_DELIVERY_STATUS_VALUES,
  validateDeliveryTransition,
} from './delivery';
import { PROVIDER_STATUS } from './provider';
import { SUBSCRIPTION_STATUS } from './subscription';

const NOW = 1_000;
const EXPIRES_AT = 10_000;
const LEASE_DURATION = 30_000;

function state(overrides: Partial<DeliveryLeaseState> = {}): DeliveryLeaseState {
  return {
    status: DELIVERY_STATUS.Queued,
    dispatchGeneration: 0,
    leaseExpiresAt: null,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

function claimContext(overrides: Record<string, unknown> = {}) {
  return {
    now: NOW,
    leaseDuration: LEASE_DURATION,
    subscriptionStatus: SUBSCRIPTION_STATUS.Active,
    providerStatus: PROVIDER_STATUS.Enabled,
    providerEmergencyHold: false,
    ...overrides,
  } as Parameters<typeof decideDeliveryClaim>[1];
}

function recoveryPrecondition(overrides: Record<string, unknown> = {}) {
  return {
    subscriptionStatus: SUBSCRIPTION_STATUS.Active,
    providerStatus: PROVIDER_STATUS.Enabled,
    providerEmergencyHold: false,
    now: NOW,
    hasOpenOutboxIntent: false,
    ...overrides,
  } as Parameters<typeof planAdministrativeRetry>[1];
}

describe('delivery status vocabulary', () => {
  it('declares exactly the seven states of FR-015', () => {
    expect(DELIVERY_STATUS_VALUES).toStrictEqual([
      DELIVERY_STATUS.Pending,
      DELIVERY_STATUS.Queued,
      DELIVERY_STATUS.Processing,
      DELIVERY_STATUS.Delivered,
      DELIVERY_STATUS.Failed,
      DELIVERY_STATUS.Expired,
      DELIVERY_STATUS.Cancelled,
    ]);
  });

  it('accepts declared statuses and rejects others', () => {
    for (const status of DELIVERY_STATUS_VALUES) {
      expect(isDeliveryStatus(status)).toBe(true);
    }
    for (const value of ['draft', 'Pending', 'queued ', '', null, 7]) {
      expect(isDeliveryStatus(value)).toBe(false);
    }
  });

  it('marks exactly delivered, failed, expired, cancelled as terminal', () => {
    expect(TERMINAL_DELIVERY_STATUS_VALUES).toStrictEqual([
      DELIVERY_STATUS.Delivered,
      DELIVERY_STATUS.Failed,
      DELIVERY_STATUS.Expired,
      DELIVERY_STATUS.Cancelled,
    ]);
    for (const status of DELIVERY_STATUS_VALUES) {
      const expected = TERMINAL_DELIVERY_STATUS_VALUES.includes(status);
      expect(isTerminalDeliveryStatus(status)).toBe(expected);
      expect(isNonTerminalDeliveryStatus(status)).toBe(!expected);
    }
  });

  it('treats a value outside the vocabulary as neither terminal nor non-terminal', () => {
    const junk = 'draft' as DeliveryStatus;
    expect(isTerminalDeliveryStatus(junk)).toBe(false);
    expect(isNonTerminalDeliveryStatus(junk)).toBe(false);
  });
});

describe('delivery transition table', () => {
  it('declares the actor vocabulary', () => {
    expect(DELIVERY_TRANSITION_ACTOR_VALUES).toStrictEqual([
      DELIVERY_TRANSITION_ACTOR.OutboxPublisher,
      DELIVERY_TRANSITION_ACTOR.Claim,
      DELIVERY_TRANSITION_ACTOR.ReleaseLease,
      DELIVERY_TRANSITION_ACTOR.Outcome,
      DELIVERY_TRANSITION_ACTOR.Reconciliation,
      DELIVERY_TRANSITION_ACTOR.AdministrativeRetry,
    ]);
    for (const actor of DELIVERY_TRANSITION_ACTOR_VALUES) {
      expect(isDeliveryTransitionActor(actor)).toBe(true);
    }
    for (const value of ['publisher', '', null, 1]) {
      expect(isDeliveryTransitionActor(value)).toBe(false);
    }
  });

  it('accepts every documented transition with its own actor', () => {
    const documented: readonly [DeliveryStatus, DeliveryStatus, DeliveryTransitionActor][] = [
      [DELIVERY_STATUS.Pending, DELIVERY_STATUS.Queued, DELIVERY_TRANSITION_ACTOR.OutboxPublisher],
      [DELIVERY_STATUS.Queued, DELIVERY_STATUS.Processing, DELIVERY_TRANSITION_ACTOR.Claim],
      [DELIVERY_STATUS.Processing, DELIVERY_STATUS.Delivered, DELIVERY_TRANSITION_ACTOR.Outcome],
      [DELIVERY_STATUS.Processing, DELIVERY_STATUS.Failed, DELIVERY_TRANSITION_ACTOR.Outcome],
      [DELIVERY_STATUS.Processing, DELIVERY_STATUS.Queued, DELIVERY_TRANSITION_ACTOR.ReleaseLease],
      [DELIVERY_STATUS.Pending, DELIVERY_STATUS.Expired, DELIVERY_TRANSITION_ACTOR.Reconciliation],
      [DELIVERY_STATUS.Queued, DELIVERY_STATUS.Expired, DELIVERY_TRANSITION_ACTOR.Reconciliation],
      [
        DELIVERY_STATUS.Processing,
        DELIVERY_STATUS.Expired,
        DELIVERY_TRANSITION_ACTOR.Reconciliation,
      ],
      [
        DELIVERY_STATUS.Failed,
        DELIVERY_STATUS.Queued,
        DELIVERY_TRANSITION_ACTOR.AdministrativeRetry,
      ],
    ];
    for (const [from, to, actor] of documented) {
      const result = validateDeliveryTransition(from, to, actor);
      expect(result.ok).toBe(true);
    }
  });

  it('rejects every triple outside the table, with no extra transitions', () => {
    // Ma trận đầy đủ: 7 × 7 × 6 = 294 tổ hợp. Đúng 9 tổ hợp được chấp nhận.
    const outcomes = DELIVERY_STATUS_VALUES.flatMap((from) =>
      DELIVERY_STATUS_VALUES.flatMap((to) =>
        DELIVERY_TRANSITION_ACTOR_VALUES.map((actor) =>
          validateDeliveryTransition(from, to, actor),
        ),
      ),
    );

    const accepted = outcomes.flatMap((result) => (result.ok ? [result] : []));
    const rejectedReasons = [
      ...new Set(outcomes.flatMap((result) => (result.ok ? [] : [result.reason]))),
    ];

    expect(accepted.length).toBe(DELIVERY_TRANSITIONS.length);
    expect(rejectedReasons).toStrictEqual(['transition_not_allowed']);
  });

  it('allows failed → queued only through the administrative retry actor', () => {
    const withRetry = validateDeliveryTransition(
      DELIVERY_STATUS.Failed,
      DELIVERY_STATUS.Queued,
      DELIVERY_TRANSITION_ACTOR.AdministrativeRetry,
    );
    expect(withRetry.ok).toBe(true);
    for (const actor of DELIVERY_TRANSITION_ACTOR_VALUES) {
      if (actor === DELIVERY_TRANSITION_ACTOR.AdministrativeRetry) continue;
      const result = validateDeliveryTransition(
        DELIVERY_STATUS.Failed,
        DELIVERY_STATUS.Queued,
        actor,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('transition_not_allowed');
    }
  });

  it('never revives a delivered delivery with any actor', () => {
    for (const to of DELIVERY_STATUS_VALUES) {
      for (const actor of DELIVERY_TRANSITION_ACTOR_VALUES) {
        const result = validateDeliveryTransition(DELIVERY_STATUS.Delivered, to, actor);
        expect(result.ok).toBe(false);
      }
    }
  });

  it('never revives an expired delivery with any actor, including administrative retry', () => {
    for (const to of DELIVERY_STATUS_VALUES) {
      for (const actor of DELIVERY_TRANSITION_ACTOR_VALUES) {
        const result = validateDeliveryTransition(DELIVERY_STATUS.Expired, to, actor);
        expect(result.ok).toBe(false);
      }
    }
  });

  it('never admits cancelled, because v1 declares no actor for it', () => {
    // FR-015: cancelled được khai báo để state machine không đóng cứng, nhưng v1
    // KHÔNG có API/permission/runbook nào đưa delivery vào cancelled.
    for (const from of DELIVERY_STATUS_VALUES) {
      const withCancelled = validateDeliveryTransition(
        from,
        DELIVERY_STATUS.Cancelled,
        DELIVERY_TRANSITION_ACTOR.Outcome,
      );
      expect(withCancelled.ok).toBe(false);
    }
    expect(DELIVERY_TRANSITIONS.filter((t) => t.to === DELIVERY_STATUS.Cancelled)).toStrictEqual(
      [],
    );
  });

  it('does not let the delivery plane publish or release its way into queued from pending', () => {
    for (const actor of [
      DELIVERY_TRANSITION_ACTOR.Claim,
      DELIVERY_TRANSITION_ACTOR.ReleaseLease,
      DELIVERY_TRANSITION_ACTOR.Outcome,
      DELIVERY_TRANSITION_ACTOR.AdministrativeRetry,
    ]) {
      const result = validateDeliveryTransition(
        DELIVERY_STATUS.Pending,
        DELIVERY_STATUS.Queued,
        actor,
      );
      expect(result.ok).toBe(false);
    }
  });

  it('rejects out-of-vocabulary inputs before checking the table', () => {
    const unknownFrom = validateDeliveryTransition(
      'draft' as DeliveryStatus,
      DELIVERY_STATUS.Queued,
      DELIVERY_TRANSITION_ACTOR.Claim,
    );
    expect(unknownFrom.ok).toBe(false);
    if (unknownFrom.ok) return;
    expect(unknownFrom.reason).toBe('unknown_status');

    const unknownTo = validateDeliveryTransition(
      DELIVERY_STATUS.Queued,
      'draft' as DeliveryStatus,
      DELIVERY_TRANSITION_ACTOR.Claim,
    );
    expect(unknownTo.ok).toBe(false);
    if (unknownTo.ok) return;
    expect(unknownTo.reason).toBe('unknown_status');

    const unknownActor = validateDeliveryTransition(
      DELIVERY_STATUS.Queued,
      DELIVERY_STATUS.Processing,
      'worker' as DeliveryTransitionActor,
    );
    expect(unknownActor.ok).toBe(false);
    if (unknownActor.ok) return;
    expect(unknownActor.reason).toBe('unknown_actor');
  });
});

describe('claim decision follows the documented diagnostic order', () => {
  it('grants a claim on a queued delivery', () => {
    const result = decideDeliveryClaim(state(), claimContext());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(DELIVERY_STATUS.Processing);
    expect(result.dispatchGeneration).toBe(1);
    expect(result.leaseExpiresAt).toBe(NOW + LEASE_DURATION);
  });

  it('increments the generation from its current value, never reusing it', () => {
    const claimed = state({ status: DELIVERY_STATUS.Processing, dispatchGeneration: 4 });
    const result = decideDeliveryClaim(
      state({ status: DELIVERY_STATUS.Queued, dispatchGeneration: 4 }),
      claimContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dispatchGeneration).toBe(5);
    expect(claimed.dispatchGeneration).toBe(4);
  });

  it('takes over a processing delivery whose lease has expired', () => {
    const result = decideDeliveryClaim(
      state({
        status: DELIVERY_STATUS.Processing,
        dispatchGeneration: 2,
        leaseExpiresAt: NOW - 1,
      }),
      claimContext(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dispatchGeneration).toBe(3);
    expect(result.leaseExpiresAt).toBe(NOW + LEASE_DURATION);
  });

  it('reports lease_held while the lease is still effective', () => {
    const result = decideDeliveryClaim(
      state({ status: DELIVERY_STATUS.Processing, leaseExpiresAt: NOW + 1 }),
      claimContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('lease_held');
  });

  it('treats a processing delivery with no lease as malformed rather than claimable', () => {
    const result = decideDeliveryClaim(
      state({ status: DELIVERY_STATUS.Processing, leaseExpiresAt: null }),
      claimContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_delivery');
  });

  it('reports ineligible_subscription for a pending delivery with an ineligible subscription', () => {
    // `pending` là nhánh **cuối** của thứ tự chẩn đoán canonical (§8.1): eligibility
    // được hỏi trước, nên một delivery chưa publish mà subscription đã chết không
    // được báo là `pending`.
    const result = decideDeliveryClaim(
      state({ status: DELIVERY_STATUS.Pending }),
      claimContext({
        subscriptionStatus: SUBSCRIPTION_STATUS.Disabled,
        providerEmergencyHold: true,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ineligible_subscription');
  });

  it('reports terminal before expired, following the canonical diagnostic order', () => {
    const result = decideDeliveryClaim(
      state({ status: DELIVERY_STATUS.Delivered, expiresAt: NOW }),
      claimContext({ subscriptionStatus: SUBSCRIPTION_STATUS.Disabled }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('terminal');
  });

  it('reports terminal for a terminal delivery that is not yet expired', () => {
    const result = decideDeliveryClaim(
      state({ status: DELIVERY_STATUS.Expired, expiresAt: NOW + 1 }),
      claimContext({ subscriptionStatus: SUBSCRIPTION_STATUS.Disabled }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('terminal');
  });

  it('reports ineligible_subscription before ineligible_provider_hold', () => {
    const result = decideDeliveryClaim(
      state(),
      claimContext({
        subscriptionStatus: SUBSCRIPTION_STATUS.Disabled,
        providerEmergencyHold: true,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ineligible_subscription');
  });

  it('reports ineligible_subscription for an expired subscription', () => {
    const result = decideDeliveryClaim(
      state(),
      claimContext({ subscriptionStatus: SUBSCRIPTION_STATUS.Expired }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ineligible_subscription');
  });

  it('reports ineligible_provider_hold for a provider on emergency hold', () => {
    const result = decideDeliveryClaim(state(), claimContext({ providerEmergencyHold: true }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ineligible_provider_hold');
  });

  it('grants the claim even when the provider is disabled, because disabled only stops new routing', () => {
    // FR-005: delivery đã materialize giữ nguyên provider_id và TIẾP TỤC được xử lý.
    const result = decideDeliveryClaim(
      state(),
      claimContext({ providerStatus: PROVIDER_STATUS.Disabled }),
    );
    expect(result.ok).toBe(true);
  });

  it('still blocks a disabled provider that is also on emergency hold', () => {
    const result = decideDeliveryClaim(
      state(),
      claimContext({
        providerStatus: PROVIDER_STATUS.Disabled,
        providerEmergencyHold: true,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ineligible_provider_hold');
  });

  it('rejects a non-positive or fractional lease duration', () => {
    for (const leaseDuration of [0, -1, 1.5, Number.NaN]) {
      const result = decideDeliveryClaim(state(), claimContext({ leaseDuration }));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('malformed_delivery');
    }
  });

  it('rejects a non-finite now', () => {
    const result = decideDeliveryClaim(state(), claimContext({ now: Number.NaN }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_delivery');
  });

  // `isFiniteNumber` chỉ chặn NaN/Infinity; một mốc thời gian **thừa nguyên hoặc vượt
  // miền an toàn** vẫn lọt qua và làm cổng `expires_at <= now` của §5.6 cho kết quả
  // ngược ý. `isEpochMillis` chặn cả hai vế.
  it('rejects a now or an expiry that is not a safe integer of epoch millis', () => {
    for (const now of [1.5, Number.MAX_SAFE_INTEGER + 2]) {
      const result = decideDeliveryClaim(state({ expiresAt: EXPIRES_AT }), claimContext({ now }));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('malformed_delivery');
    }
    for (const expiresAt of [EXPIRES_AT + 0.5, Number.MAX_SAFE_INTEGER + 2]) {
      const result = decideDeliveryClaim(state({ expiresAt }), claimContext());
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('malformed_delivery');
    }
    for (const leaseExpiresAt of [NOW + 0.5, Number.MAX_SAFE_INTEGER + 2]) {
      const result = decideDeliveryClaim(
        state({ status: DELIVERY_STATUS.Processing, leaseExpiresAt }),
        claimContext(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('malformed_delivery');
    }
  });

  // `MAX_SAFE_INTEGER + 1` vẫn là số nguyên **an toàn theo mọi guard shape khác**, nên
  // `dispatch_generation + 1` sẽ đi từ `MAX_SAFE_INTEGER` sang `-MAX_SAFE_INTEGER` và
  // fencing bị đảo chiều: execution cũ bị coi là đang giữ generation hiện hành.
  it('refuses to mint a generation that would overflow the safe integer range', () => {
    const result = decideDeliveryClaim(
      state({ dispatchGeneration: Number.MAX_SAFE_INTEGER }),
      claimContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_delivery');
  });

  // `lease_expires_at` đi lên wire dưới dạng RFC3339 (`claim.ts` `validateDeliveryClaim`),
  // nên một tổng không còn là số nguyên an toàn sẽ sinh ra một response `200` mà consumer
  // không validate được — tức claim "thắng" nhưng không dùng được. `expiresAt` phải
  // ở xa `now` để cổng `expired` (đứng trước) không che mất kết quả cần đo.
  it('refuses a lease expiry that now plus the lease duration would overflow', () => {
    const result = decideDeliveryClaim(
      state({ expiresAt: Number.MAX_SAFE_INTEGER }),
      claimContext({ now: Number.MAX_SAFE_INTEGER - 10, leaseDuration: 1_000 }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_delivery');
  });

  it('rejects a malformed delivery state', () => {
    const result = decideDeliveryClaim(state({ dispatchGeneration: -1 }), claimContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_delivery');
  });

  it('is a pure decision: it never mutates the state it is given', () => {
    const input = Object.freeze(
      state({ status: DELIVERY_STATUS.Processing, leaseExpiresAt: NOW - 1 }),
    );
    const snapshot = structuredClone(input);
    decideDeliveryClaim(input, claimContext());
    expect(input).toStrictEqual(snapshot);
  });
});

/**
 * Thứ tự chẩn đoán canonical của `01-architecture.md` §8.1, ghim bằng bảng: mỗi dòng
 * là một tình huống **nhiều** điều kiện từ chối cùng đúng, và `reason` kỳ vọng là điều
 * kiện đứng trước trong thứ tự đó. Bảng này là thứ bắt được việc đảo thứ tự các nhánh
 * trong `decideDeliveryClaim`; các test đơn điều kiện ở trên không bắt được.
 */
describe('claim rejection reasons follow the canonical diagnostic order of §8.1', () => {
  const precedenceCases: readonly {
    readonly name: string;
    readonly deliveryState: Partial<DeliveryLeaseState>;
    readonly context: Record<string, unknown>;
    readonly expectedReason: ClaimRejectionReason | 'malformed_delivery';
  }[] = [
    {
      name: 'terminal beats expired and ineligible_subscription',
      deliveryState: { status: DELIVERY_STATUS.Failed, expiresAt: NOW },
      context: { subscriptionStatus: SUBSCRIPTION_STATUS.Disabled },
      expectedReason: 'terminal',
    },
    {
      name: 'terminal beats expired even when the provider is on hold',
      deliveryState: { status: DELIVERY_STATUS.Expired, expiresAt: NOW },
      context: { providerEmergencyHold: true },
      expectedReason: 'terminal',
    },
    {
      name: 'expired beats ineligible_subscription and lease_held',
      deliveryState: {
        status: DELIVERY_STATUS.Processing,
        leaseExpiresAt: NOW + 1,
        expiresAt: NOW,
      },
      context: { subscriptionStatus: SUBSCRIPTION_STATUS.Disabled },
      expectedReason: 'expired',
    },
    {
      name: 'expired beats ineligible_provider_hold',
      deliveryState: { status: DELIVERY_STATUS.Queued, expiresAt: NOW },
      context: { providerEmergencyHold: true },
      expectedReason: 'expired',
    },
    {
      name: 'ineligible_subscription beats ineligible_provider_hold',
      deliveryState: { status: DELIVERY_STATUS.Queued },
      context: {
        subscriptionStatus: SUBSCRIPTION_STATUS.Disabled,
        providerEmergencyHold: true,
      },
      expectedReason: 'ineligible_subscription',
    },
    {
      name: 'ineligible_subscription beats lease_held',
      deliveryState: { status: DELIVERY_STATUS.Processing, leaseExpiresAt: NOW + 1 },
      context: { subscriptionStatus: SUBSCRIPTION_STATUS.Disabled },
      expectedReason: 'ineligible_subscription',
    },
    {
      name: 'ineligible_provider_hold beats lease_held',
      deliveryState: { status: DELIVERY_STATUS.Processing, leaseExpiresAt: NOW + 1 },
      context: { providerEmergencyHold: true },
      expectedReason: 'ineligible_provider_hold',
    },
    {
      name: 'ineligible_provider_hold beats pending, because pending is checked last',
      deliveryState: { status: DELIVERY_STATUS.Pending },
      context: { providerEmergencyHold: true },
      expectedReason: 'ineligible_provider_hold',
    },
    {
      name: 'ineligible_subscription beats pending',
      deliveryState: { status: DELIVERY_STATUS.Pending },
      context: { subscriptionStatus: SUBSCRIPTION_STATUS.Disabled },
      expectedReason: 'ineligible_subscription',
    },
    {
      name: 'pending is reported only when no other branch rejects',
      deliveryState: { status: DELIVERY_STATUS.Pending },
      context: {},
      expectedReason: 'pending',
    },
    {
      name: 'a corrupt processing row still reports the canonical reason that applies',
      deliveryState: { status: DELIVERY_STATUS.Processing, leaseExpiresAt: null },
      context: {
        subscriptionStatus: SUBSCRIPTION_STATUS.Disabled,
        providerEmergencyHold: true,
      },
      expectedReason: 'ineligible_subscription',
    },
  ];

  it.each(precedenceCases)('$name', ({ deliveryState, context, expectedReason }) => {
    const result = decideDeliveryClaim(state(deliveryState), claimContext(context));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(expectedReason);
  });

  // Ca riêng cho guard shape của claim: `malformed_delivery` **không** thuộc tập
  // `reason` đóng của §8.1, nên nó chỉ được báo khi không nhánh canonical nào áp dụng.
  // Điều bắt buộc không phải là nó luôn được báo, mà là một hàng hỏng **không bao giờ
  // thắng** claim.
  it('never lets a corrupt processing row win a claim', () => {
    const corrupt: DeliveryLeaseState = {
      status: DELIVERY_STATUS.Processing,
      dispatchGeneration: 2,
      leaseExpiresAt: null,
      expiresAt: NOW + 1_000,
    };
    const result = decideDeliveryClaim(corrupt, claimContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_delivery');
  });

  it('reports expired rather than malformed when a corrupt row is also past expires_at', () => {
    // `expires_at <= now → expired` là vô điều kiện theo §8.1, và `expired` là reason
    // thuộc contract nên worker ACK an toàn — trong khi một reason ngoài contract bị
    // xử lý như lỗi contract (retry bounded → DLQ). Thứ tự này giữ đúng hệ quả đó.
    const corruptAndExpired: DeliveryLeaseState = {
      status: DELIVERY_STATUS.Processing,
      dispatchGeneration: 2,
      leaseExpiresAt: null,
      expiresAt: NOW,
    };
    const result = decideDeliveryClaim(corruptAndExpired, claimContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('expired');
  });

  // Guard shape phải đặt tại chỗ field được đọc: context.subscriptionStatus ngoài
  // vocabulary phải trả `malformed_delivery` (fail-closed), chứ không rơi xuống
  // `ineligible_subscription` — nếu không, một row hỏng bị đọc như một quyết định
  // nghiệp vụ hợp lệ và lỗi dữ liệu biến mất khỏi metric.
  it('reports malformed_delivery when subscriptionStatus is outside the vocabulary', () => {
    const result = decideDeliveryClaim(
      state({ status: DELIVERY_STATUS.Queued }),
      claimContext({ subscriptionStatus: 'archived' as unknown }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_delivery');
  });

  it('reports malformed_delivery when providerStatus is outside the vocabulary', () => {
    const result = decideDeliveryClaim(
      state({ status: DELIVERY_STATUS.Queued }),
      claimContext({ providerStatus: 'stale' as unknown }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_delivery');
  });

  it('reports malformed_delivery when providerEmergencyHold is not a boolean', () => {
    const result = decideDeliveryClaim(
      state({ status: DELIVERY_STATUS.Queued }),
      claimContext({ providerEmergencyHold: null as unknown }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_delivery');
  });

  // `lease_held` chỉ áp dụng cho `processing`, và **mọi** điều kiện khác có thể cùng
  // đúng với `processing` đều đứng trước nó trong thứ tự canonical — nên nó không bao
  // giờ xuất hiện trong một hàng đa điều kiện. Nó có test riêng ngay dưới đây.
  // `malformed_delivery` cũng vậy: guard shape đứng **sau** cả sáu nhánh canonical,
  // nên nó chỉ xuất hiện khi không nhánh nào áp dụng (xem test riêng ngay trên).
  it('exercises every canonical rejection reason, which is the closed set of §8.1', () => {
    const covered = new Set(precedenceCases.map((testCase) => testCase.expectedReason));
    expect(covered).toEqual(
      new Set<ClaimRejectionReason>([
        'terminal',
        'expired',
        'ineligible_subscription',
        'ineligible_provider_hold',
        'pending',
      ]),
    );
  });

  it('still reports lease_held when nothing earlier rejects', () => {
    const result = decideDeliveryClaim(
      state({ status: DELIVERY_STATUS.Processing, leaseExpiresAt: NOW + 1 }),
      claimContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('lease_held');
  });
});

describe('fencing rejects writes that do not hold the current generation', () => {
  it('accepts a write carrying the current generation', () => {
    const result = decideFencedWrite(
      state({ status: DELIVERY_STATUS.Processing, dispatchGeneration: 3 }),
      3,
      DELIVERY_TRANSITION_ACTOR.Outcome,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.generation).toBe(3);
  });

  it('rejects a stale generation and reports stale_write', () => {
    const result = decideFencedWrite(
      state({ status: DELIVERY_STATUS.Processing, dispatchGeneration: 4 }),
      3,
      DELIVERY_TRANSITION_ACTOR.Outcome,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('stale_write');
  });

  it('reports stale_write before terminal, because the generation check comes first', () => {
    const result = decideFencedWrite(
      state({ status: DELIVERY_STATUS.Delivered, dispatchGeneration: 4 }),
      3,
      DELIVERY_TRANSITION_ACTOR.Outcome,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('stale_write');
  });

  it('reports terminal for a terminal delivery carrying the current generation', () => {
    const result = decideFencedWrite(
      state({ status: DELIVERY_STATUS.Failed, dispatchGeneration: 2 }),
      2,
      DELIVERY_TRANSITION_ACTOR.Outcome,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('terminal');
  });

  it('does not consult the clock: a held generation still writes after its lease expired', () => {
    // Lease expiry chỉ làm delivery claimable lại; nó không thu hồi quyền ghi của
    // execution đang giữ generation hiện hành (§5.6). Predicate `lease_expires_at > :now`
    // thuộc guarded statement ở tầng database, không thuộc hàm thuần này.
    const result = decideFencedWrite(
      state({
        status: DELIVERY_STATUS.Processing,
        dispatchGeneration: 5,
        leaseExpiresAt: NOW - 1,
      }),
      5,
      DELIVERY_TRANSITION_ACTOR.Outcome,
    );
    expect(result.ok).toBe(true);
  });

  it('does not consult expires_at: an in-flight send may still record its outcome', () => {
    // §5.6: execution đang giữ lease khi expires_at trôi qua vẫn ghi được
    // delivered/failed — expiry chặn claim mới, không huỷ một lần gửi đã bắt đầu.
    const result = decideFencedWrite(
      state({
        status: DELIVERY_STATUS.Processing,
        dispatchGeneration: 1,
        leaseExpiresAt: NOW + LEASE_DURATION,
        expiresAt: NOW - 1,
      }),
      1,
      DELIVERY_TRANSITION_ACTOR.Outcome,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a generation that is not a non-negative integer', () => {
    for (const heldGeneration of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = decideFencedWrite(
        state({ status: DELIVERY_STATUS.Processing, dispatchGeneration: 1 }),
        heldGeneration,
        DELIVERY_TRANSITION_ACTOR.Outcome,
      );
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('malformed_delivery');
    }
  });

  it('rejects an operation outside the fenced-write vocabulary', () => {
    // `claim` là operation **cấp** lease, không phải operation ghi kèm token; đưa nó
    // vào đây là lỗi chương trình ở tầng gọi và phải bị từ chối tường minh thay vì rơi
    // vào `stale_write` (reason nằm trong contract 409 của worker).
    for (const operation of [
      DELIVERY_TRANSITION_ACTOR.Claim,
      DELIVERY_TRANSITION_ACTOR.OutboxPublisher,
      DELIVERY_TRANSITION_ACTOR.Reconciliation,
      DELIVERY_TRANSITION_ACTOR.AdministrativeRetry,
      'write' as never,
    ]) {
      const result = decideFencedWrite(
        state({ status: DELIVERY_STATUS.Processing, dispatchGeneration: 1 }),
        1,
        operation as Parameters<typeof decideFencedWrite>[2],
      );
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('malformed_delivery');
    }
  });

  it('rejects a malformed state', () => {
    const result = decideFencedWrite(
      state({ expiresAt: Number.NaN }),
      0,
      DELIVERY_TRANSITION_ACTOR.Outcome,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_delivery');
  });

  it('never mutates the state it is given', () => {
    const input = Object.freeze(
      state({ status: DELIVERY_STATUS.Processing, dispatchGeneration: 4 }),
    );
    const snapshot = structuredClone(input);
    decideFencedWrite(input, 3, DELIVERY_TRANSITION_ACTOR.Outcome);
    expect(input).toStrictEqual(snapshot);
  });
});

/**
 * `release` để lại delivery ở `queued` **và giữ nguyên `dispatch_generation`** (§8.1). Đó
 * là khoảng thời gian mà một execution cũ vẫn khớp generation trong khi delivery đã rời
 * trạng thái cho phép nó ghi — nếu `decideFencedWrite` chỉ so generation thì nó trả `ok`
 * cho một `outcome` mà guarded statement `WHERE status = 'processing'` ở D1 sẽ chặn, tức
 * domain và database bất đồng ý về kết quả.
 *
 * Nhóm test dưới đây ghim đúng khoảng đó cho **cả hai** operation.
 */
describe('a held generation alone does not authorise a write outside the writable state', () => {
  const HELD = 4;

  const afterRelease = state({
    status: DELIVERY_STATUS.Queued,
    dispatchGeneration: HELD,
    leaseExpiresAt: null,
  });

  it('rejects an outcome once release returned the delivery to queued', () => {
    const result = decideFencedWrite(afterRelease, HELD, DELIVERY_TRANSITION_ACTOR.Outcome);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // §8.1: `status ≠ 'processing'` là `stale_write`, **không phải** `terminal` — delivery
    // vẫn non-terminal nên `terminal` sẽ mô tả sai state.
    expect(result.reason).toBe('stale_write');
  });

  it('accepts a release on an already-released delivery as the documented no-op', () => {
    // §8.1: `status = 'queued'` (đã release trước đó) → `200` no-op, idempotent, cùng
    // generation. Đây là idempotency của release, không phải một đường ghi state.
    const result = decideFencedWrite(afterRelease, HELD, DELIVERY_TRANSITION_ACTOR.ReleaseLease);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.generation).toBe(HELD);
  });

  it('rejects an outcome on a pending delivery, which was never leased', () => {
    const result = decideFencedWrite(
      state({ status: DELIVERY_STATUS.Pending, dispatchGeneration: HELD }),
      HELD,
      DELIVERY_TRANSITION_ACTOR.Outcome,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('stale_write');
  });

  it('rejects a release on a pending delivery', () => {
    const result = decideFencedWrite(
      state({ status: DELIVERY_STATUS.Pending, dispatchGeneration: HELD }),
      HELD,
      DELIVERY_TRANSITION_ACTOR.ReleaseLease,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('stale_write');
  });

  it('accepts both operations while the delivery is still processing', () => {
    const processing = state({
      status: DELIVERY_STATUS.Processing,
      dispatchGeneration: HELD,
      leaseExpiresAt: NOW + LEASE_DURATION,
    });
    for (const operation of [
      DELIVERY_TRANSITION_ACTOR.Outcome,
      DELIVERY_TRANSITION_ACTOR.ReleaseLease,
    ]) {
      expect(decideFencedWrite(processing, HELD, operation).ok).toBe(true);
    }
  });

  it('keeps terminal ahead of the writable-state check for both operations', () => {
    for (const status of [
      DELIVERY_STATUS.Delivered,
      DELIVERY_STATUS.Failed,
      DELIVERY_STATUS.Expired,
      DELIVERY_STATUS.Cancelled,
    ]) {
      for (const operation of [
        DELIVERY_TRANSITION_ACTOR.Outcome,
        DELIVERY_TRANSITION_ACTOR.ReleaseLease,
      ]) {
        const result = decideFencedWrite(
          state({ status, dispatchGeneration: HELD }),
          HELD,
          operation,
        );
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.reason).toBe('terminal');
      }
    }
  });

  it('exposes exactly the two fenced-write operations as its vocabulary', () => {
    // Tập này suy ra từ `DELIVERY_TRANSITION_ACTOR`: `release` và `outcome` **chính là**
    // hai operation ghi kèm fencing token của §8.1, nên một tập hằng riêng sẽ là nguồn
    // thứ hai có thể lệch.
    expect(new Set(FENCED_WRITE_OPERATIONS)).toStrictEqual(
      new Set<DeliveryTransitionActor>([
        DELIVERY_TRANSITION_ACTOR.ReleaseLease,
        DELIVERY_TRANSITION_ACTOR.Outcome,
      ]),
    );
    for (const operation of FENCED_WRITE_OPERATIONS) {
      expect(isFencedWriteOperation(operation)).toBe(true);
      expect(DELIVERY_TRANSITION_ACTOR_VALUES).toContain(operation);
    }
    expect(isFencedWriteOperation(DELIVERY_TRANSITION_ACTOR.Claim)).toBe(false);
  });
});

describe('administrative retry is the only path out of failed', () => {
  it('requeues a failed delivery and raises the generation', () => {
    const result = planAdministrativeRetry(
      state({ status: DELIVERY_STATUS.Failed, dispatchGeneration: 2 }),
      recoveryPrecondition(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.to).toBe(DELIVERY_STATUS.Queued);
    expect(result.dispatchGeneration).toBe(3);
  });

  it('rejects a delivery that is not failed', () => {
    for (const status of [
      DELIVERY_STATUS.Pending,
      DELIVERY_STATUS.Queued,
      DELIVERY_STATUS.Processing,
      DELIVERY_STATUS.Delivered,
      DELIVERY_STATUS.Expired,
      DELIVERY_STATUS.Cancelled,
    ]) {
      const result = planAdministrativeRetry(state({ status }), recoveryPrecondition());
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('not_failed');
    }
  });

  it('rejects once the notification is past its business expiry', () => {
    const result = planAdministrativeRetry(
      state({ status: DELIVERY_STATUS.Failed, expiresAt: NOW }),
      recoveryPrecondition(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('notification_expired');
  });

  it('rejects when the subscription is no longer active', () => {
    for (const subscriptionStatus of [SUBSCRIPTION_STATUS.Disabled, SUBSCRIPTION_STATUS.Expired]) {
      const result = planAdministrativeRetry(
        state({ status: DELIVERY_STATUS.Failed }),
        recoveryPrecondition({ subscriptionStatus }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('ineligible_subscription');
    }
  });

  it('rejects when the provider is on emergency hold', () => {
    const result = planAdministrativeRetry(
      state({ status: DELIVERY_STATUS.Failed }),
      recoveryPrecondition({ providerEmergencyHold: true }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('provider_hold');
  });

  it('does not reject a disabled provider, because hold is the only provider condition', () => {
    const result = planAdministrativeRetry(
      state({ status: DELIVERY_STATUS.Failed }),
      recoveryPrecondition({ providerStatus: PROVIDER_STATUS.Disabled }),
    );
    expect(result.ok).toBe(true);
  });

  it('reports notification_expired before the subscription and provider conditions', () => {
    const result = planAdministrativeRetry(
      state({ status: DELIVERY_STATUS.Failed, expiresAt: NOW }),
      recoveryPrecondition({
        subscriptionStatus: SUBSCRIPTION_STATUS.Disabled,
        providerEmergencyHold: true,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('notification_expired');
  });

  it('rejects a malformed state', () => {
    const result = planAdministrativeRetry(
      state({ status: DELIVERY_STATUS.Failed, dispatchGeneration: -1 }),
      recoveryPrecondition(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_delivery');
  });

  it('never mutates the state it is given', () => {
    const input = Object.freeze(state({ status: DELIVERY_STATUS.Failed, dispatchGeneration: 2 }));
    const snapshot = structuredClone(input);
    planAdministrativeRetry(input, recoveryPrecondition());
    expect(input).toStrictEqual(snapshot);
  });

  // `now` là cổng chặn `expires_at`: không guard thì `expires_at <= NaN` luôn `false`
  // và một notification đã hết hạn vẫn được requeue (fail-open, FR-015 cấm). Cùng
  // nhóm với guard của `decideDeliveryClaim` để hai đường không lệch nhau.
  it('rejects an invalid now rather than letting an expired notification through', () => {
    const expired = state({ status: DELIVERY_STATUS.Failed, expiresAt: 1_000 });
    for (const now of [Number.NaN, undefined, null, 'now']) {
      const result = planAdministrativeRetry(expired, recoveryPrecondition({ now }) as never);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('malformed_delivery');
    }
    // Cùng delivery đó, với `now` hợp lệ: cổng chặn phải đóng.
    const valid = planAdministrativeRetry(expired, recoveryPrecondition({ now: 5_000 }));
    expect(valid.ok).toBe(false);
    if (valid.ok) return;
    expect(valid.reason).toBe('notification_expired');
  });

  // Không có `nextDispatchGeneration` thì `MAX_SAFE_INTEGER + 1` là số âm
  // (`-9007199254740991`), tức một generation âm đã được "thành công" trả về cho
  // SQL guard — fencing token âm không hề chặn được lần ghi sau đó vì so sánh
  // bằng vẫn cho phép. Phải từ chối, không được phát ra token hỏng.
  it('refuses to mint a generation that would overflow the safe integer range', () => {
    const result = planAdministrativeRetry(
      state({ status: DELIVERY_STATUS.Failed, dispatchGeneration: Number.MAX_SAFE_INTEGER }),
      recoveryPrecondition(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_delivery');
  });

  it('returns a rejection instead of throwing when precondition is missing', () => {
    const result = planAdministrativeRetry(
      state({ status: DELIVERY_STATUS.Failed }),
      null as unknown as Parameters<typeof planAdministrativeRetry>[1],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_delivery');
  });
});

describe('republish is distinct from retry and never changes delivery state', () => {
  it('plans a republish for a non-terminal delivery without changing its state', () => {
    const input = state({ status: DELIVERY_STATUS.Pending, dispatchGeneration: 0 });
    const result = planDeliveryRepublish(input, recoveryPrecondition());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(DELIVERY_STATUS.Pending);
    expect(result.retainsGeneration).toBe(true);
  });

  it('plans a republish for a queued and a processing delivery too', () => {
    for (const status of [DELIVERY_STATUS.Queued, DELIVERY_STATUS.Processing]) {
      const result = planDeliveryRepublish(state({ status }), recoveryPrecondition());
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.status).toBe(status);
    }
  });

  it('rejects a terminal delivery, including failed', () => {
    for (const status of [
      DELIVERY_STATUS.Delivered,
      DELIVERY_STATUS.Failed,
      DELIVERY_STATUS.Expired,
      DELIVERY_STATUS.Cancelled,
    ]) {
      const result = planDeliveryRepublish(state({ status }), recoveryPrecondition());
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('not_non_terminal');
    }
  });

  it('rejects when the notification is past its business expiry', () => {
    const result = planDeliveryRepublish(
      state({ status: DELIVERY_STATUS.Pending, expiresAt: NOW }),
      recoveryPrecondition(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('notification_expired');
  });

  it('rejects when the subscription is no longer active', () => {
    const result = planDeliveryRepublish(
      state({ status: DELIVERY_STATUS.Pending }),
      recoveryPrecondition({ subscriptionStatus: SUBSCRIPTION_STATUS.Disabled }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ineligible_subscription');
  });

  it('rejects when the provider is on emergency hold', () => {
    const result = planDeliveryRepublish(
      state({ status: DELIVERY_STATUS.Pending }),
      recoveryPrecondition({ providerEmergencyHold: true }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('provider_hold');
  });

  it('rejects when an open outbox intent already exists for the delivery', () => {
    const result = planDeliveryRepublish(
      state({ status: DELIVERY_STATUS.Pending }),
      recoveryPrecondition({ hasOpenOutboxIntent: true }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('open_outbox_intent');
  });

  it('rejects an invalid now and returns a rejection instead of throwing when precondition is missing', () => {
    for (const now of [Number.NaN, undefined, null, 'now']) {
      const result = planDeliveryRepublish(
        state({ status: DELIVERY_STATUS.Pending, expiresAt: 1_000 }),
        recoveryPrecondition({ now }) as never,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('malformed_delivery');
    }
    const result = planDeliveryRepublish(
      state({ status: DELIVERY_STATUS.Pending }),
      null as unknown as Parameters<typeof planDeliveryRepublish>[1],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed_delivery');
  });

  it('never mutates the state it is given', () => {
    const input = Object.freeze(state({ status: DELIVERY_STATUS.Pending }));
    const snapshot = structuredClone(input);
    planDeliveryRepublish(input, recoveryPrecondition());
    expect(input).toStrictEqual(snapshot);
  });
});

describe('retry and republish are not interchangeable', () => {
  it('rejects republish on failed while retry succeeds', () => {
    const failed = state({ status: DELIVERY_STATUS.Failed });
    const precondition = recoveryPrecondition();
    const republish = planDeliveryRepublish(failed, precondition);
    const retry = planAdministrativeRetry(failed, precondition);
    expect(republish.ok).toBe(false);
    if (republish.ok) return;
    expect(republish.reason).toBe('not_non_terminal');
    expect(retry.ok).toBe(true);
  });

  it('rejects retry on a non-terminal delivery while republish succeeds', () => {
    for (const status of [
      DELIVERY_STATUS.Pending,
      DELIVERY_STATUS.Queued,
      DELIVERY_STATUS.Processing,
    ]) {
      const delivery = state({ status });
      const precondition = recoveryPrecondition();
      const retry = planAdministrativeRetry(delivery, precondition);
      const republish = planDeliveryRepublish(delivery, precondition);
      expect(retry.ok).toBe(false);
      if (retry.ok) continue;
      expect(retry.reason).toBe('not_failed');
      expect(republish.ok).toBe(true);
    }
  });

  it('changes the generation only for retry, never for republish', () => {
    const failed = state({ status: DELIVERY_STATUS.Failed, dispatchGeneration: 7 });
    const retry = planAdministrativeRetry(failed, recoveryPrecondition());
    expect(retry).toMatchObject({ ok: true, dispatchGeneration: 8 });

    const queued = state({ status: DELIVERY_STATUS.Queued, dispatchGeneration: 7 });
    const republish = planDeliveryRepublish(queued, recoveryPrecondition());
    // Republish **không** mang `dispatchGeneration`: nó không được phép chạm generation,
    // nên kết quả không có field nào để caller lỡ đọc ra một generation mới.
    expect(republish).toMatchObject({
      ok: true,
      status: DELIVERY_STATUS.Queued,
      retainsGeneration: true,
    });
    expect(republish).not.toHaveProperty('dispatchGeneration');
  });
});

describe('lease expiry never changes delivery state on its own', () => {
  it('makes a processing delivery claimable again without altering it', () => {
    const input = state({
      status: DELIVERY_STATUS.Processing,
      dispatchGeneration: 6,
      leaseExpiresAt: NOW - 1,
    });
    const snapshot = structuredClone(input);
    const claim = decideDeliveryClaim(input, claimContext());
    expect(claim.ok).toBe(true);
    // Quyết định claim không sửa state gốc; state chỉ đổi khi control plane áp
    // kết quả thắng (meta.changes == 1) qua guarded UPDATE.
    expect(input).toStrictEqual(snapshot);
  });

  it('keeps the previous holder from writing once a new claim bumped the generation', () => {
    const afterTakeover = state({
      status: DELIVERY_STATUS.Processing,
      dispatchGeneration: 7,
      leaseExpiresAt: NOW + LEASE_DURATION,
    });
    const staleHolder = decideFencedWrite(afterTakeover, 6, DELIVERY_TRANSITION_ACTOR.Outcome);
    expect(staleHolder.ok).toBe(false);
    if (staleHolder.ok) return;
    expect(staleHolder.reason).toBe('stale_write');
  });
});
