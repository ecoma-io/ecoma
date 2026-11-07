import { describe, expect, it } from 'vitest';

import {
  CLOSED_SUBSCRIPTION_STATUS_VALUES,
  disableSubscription,
  expireSubscription,
  isClosedSubscriptionStatus,
  isSubscriptionDisableCause,
  isSubscriptionEligibleForDelivery,
  isSubscriptionStatus,
  SUBSCRIPTION_DISABLE_CAUSE,
  SUBSCRIPTION_DISABLE_CAUSE_VALUES,
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_STATUS_VALUES,
  type SubscriptionStatus,
} from './subscription';

describe('Subscription status vocabulary', () => {
  it('declares exactly active, disabled, expired', () => {
    expect(SUBSCRIPTION_STATUS_VALUES).toStrictEqual([
      SUBSCRIPTION_STATUS.Active,
      SUBSCRIPTION_STATUS.Disabled,
      SUBSCRIPTION_STATUS.Expired,
    ]);
  });

  it('accepts declared values and rejects others', () => {
    for (const status of SUBSCRIPTION_STATUS_VALUES) {
      expect(isSubscriptionStatus(status)).toBe(true);
    }
    for (const value of ['Active', 'paused', 'inactive', '', null, undefined, 3]) {
      expect(isSubscriptionStatus(value)).toBe(false);
    }
  });

  it('treats disabled and expired as closed, active as open', () => {
    expect(CLOSED_SUBSCRIPTION_STATUS_VALUES).toStrictEqual([
      SUBSCRIPTION_STATUS.Disabled,
      SUBSCRIPTION_STATUS.Expired,
    ]);
    expect(isClosedSubscriptionStatus(SUBSCRIPTION_STATUS.Active)).toBe(false);
    expect(isClosedSubscriptionStatus(SUBSCRIPTION_STATUS.Disabled)).toBe(true);
    expect(isClosedSubscriptionStatus(SUBSCRIPTION_STATUS.Expired)).toBe(true);
  });
});

describe('only active subscriptions are eligible for new deliveries', () => {
  it('accepts active and rejects every closed status', () => {
    expect(isSubscriptionEligibleForDelivery(SUBSCRIPTION_STATUS.Active)).toBe(true);
    expect(isSubscriptionEligibleForDelivery(SUBSCRIPTION_STATUS.Disabled)).toBe(false);
    expect(isSubscriptionEligibleForDelivery(SUBSCRIPTION_STATUS.Expired)).toBe(false);
  });

  it('is exactly the negation of the closed predicate', () => {
    for (const status of SUBSCRIPTION_STATUS_VALUES) {
      expect(isSubscriptionEligibleForDelivery(status)).toBe(!isClosedSubscriptionStatus(status));
    }
  });
});

describe('disableSubscription moves active to disabled', () => {
  it('returns disabled from active and reports the change', () => {
    const result = disableSubscription(
      SUBSCRIPTION_STATUS.Active,
      SUBSCRIPTION_DISABLE_CAUSE.UserUnregister,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(SUBSCRIPTION_STATUS.Disabled);
    expect(result.changed).toBe(true);
    expect(result.cause).toBe(SUBSCRIPTION_DISABLE_CAUSE.UserUnregister);
  });

  it('is idempotent on an already disabled subscription', () => {
    const result = disableSubscription(
      SUBSCRIPTION_STATUS.Disabled,
      SUBSCRIPTION_DISABLE_CAUSE.AdminDisable,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(SUBSCRIPTION_STATUS.Disabled);
    expect(result.changed).toBe(false);
  });

  it('is idempotent for the worker invalidation path too', () => {
    const first = disableSubscription(
      SUBSCRIPTION_STATUS.Active,
      SUBSCRIPTION_DISABLE_CAUSE.ProviderInvalidation,
    );
    const second = disableSubscription(
      SUBSCRIPTION_STATUS.Disabled,
      SUBSCRIPTION_DISABLE_CAUSE.ProviderInvalidation,
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.status).toBe(second.status);
    expect(second.changed).toBe(false);
  });

  it('rejects disabling an expired subscription', () => {
    const result = disableSubscription(
      SUBSCRIPTION_STATUS.Expired,
      SUBSCRIPTION_DISABLE_CAUSE.AdminDisable,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_status');
  });

  it('rejects a status outside the vocabulary', () => {
    const result = disableSubscription(
      'paused' as SubscriptionStatus,
      SUBSCRIPTION_DISABLE_CAUSE.AdminDisable,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown_status');
  });

  it('rejects a cause outside the vocabulary', () => {
    const result = disableSubscription(
      SUBSCRIPTION_STATUS.Active,
      'because' as (typeof SUBSCRIPTION_DISABLE_CAUSE)[keyof typeof SUBSCRIPTION_DISABLE_CAUSE],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown_cause');
  });

  it('never returns active for any input combination', () => {
    // Quét cả input ngoài vocabulary: kết quả chỉ được là `disabled`, hoặc một từ chối
    // mang lý do thuộc vocabulary. Bất biến "invalidation không bao giờ enable lại" được
    // kiểm trên **toàn bộ** tích Đề-các, không chỉ các ca tiêu biểu.
    const outcomes = [...SUBSCRIPTION_STATUS_VALUES, 'paused' as SubscriptionStatus].flatMap(
      (status) =>
        [
          ...SUBSCRIPTION_DISABLE_CAUSE_VALUES,
          'because' as (typeof SUBSCRIPTION_DISABLE_CAUSE)[keyof typeof SUBSCRIPTION_DISABLE_CAUSE],
        ].map((cause) => disableSubscription(status, cause)),
    );

    const accepted = outcomes.flatMap((result) => (result.ok ? [result] : []));

    // Mọi kết quả `ok` đều là `disabled` — không tồn tại đường dẫn nào trả về `active`.
    expect(new Set(accepted.map((result) => result.status))).toEqual(
      new Set([SUBSCRIPTION_STATUS.Disabled]),
    );
    // `changed` đúng bằng "input là `active`": hợp đồng idempotent của invalidate (§8.1).
    expect(accepted.map((result) => result.changed)).toStrictEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    // Mọi từ chối mang lý do thuộc vocabulary, không rò rỉ giá trị nào khác.
    expect(new Set(outcomes.flatMap((result) => (result.ok ? [] : [result.reason])))).toEqual(
      new Set(['unknown_status', 'unknown_cause', 'invalid_status']),
    );
  });
});

describe('subscription disable cause vocabulary', () => {
  it('covers every actor named by FR-004 plus periodic re-validation', () => {
    expect(SUBSCRIPTION_DISABLE_CAUSE_VALUES).toStrictEqual([
      SUBSCRIPTION_DISABLE_CAUSE.UserUnregister,
      SUBSCRIPTION_DISABLE_CAUSE.AdminDisable,
      SUBSCRIPTION_DISABLE_CAUSE.ProviderInvalidation,
      SUBSCRIPTION_DISABLE_CAUSE.EndpointRevalidationFailed,
    ]);
  });

  it('accepts declared causes and rejects others', () => {
    for (const cause of SUBSCRIPTION_DISABLE_CAUSE_VALUES) {
      expect(isSubscriptionDisableCause(cause)).toBe(true);
    }
    for (const value of ['unregister', '', null, 1]) {
      expect(isSubscriptionDisableCause(value)).toBe(false);
    }
  });
});

describe('expireSubscription moves active to expired only', () => {
  it('returns expired from active', () => {
    const result = expireSubscription(SUBSCRIPTION_STATUS.Active);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(SUBSCRIPTION_STATUS.Expired);
  });

  it('rejects disabled and expired because expired only comes from active', () => {
    for (const status of [SUBSCRIPTION_STATUS.Disabled, SUBSCRIPTION_STATUS.Expired]) {
      const result = expireSubscription(status);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('invalid_status');
    }
  });

  it('rejects a status outside the vocabulary', () => {
    const result = expireSubscription('paused' as SubscriptionStatus);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown_status');
  });

  it('never revives a subscription back to active', () => {
    // `expired` là trạng thái đóng: quét toàn bộ vocabulary, kết quả `ok` chỉ được là
    // `expired` từ `active`, và mọi từ chối phải nêu lý do thuộc vocabulary.
    const outcomes = SUBSCRIPTION_STATUS_VALUES.map((status) => expireSubscription(status));

    expect(outcomes.flatMap((result) => (result.ok ? [result.status] : []))).toStrictEqual([
      SUBSCRIPTION_STATUS.Expired,
    ]);
    expect(new Set(outcomes.flatMap((result) => (result.ok ? [] : [result.reason])))).toEqual(
      new Set(['invalid_status']),
    );
  });
});
