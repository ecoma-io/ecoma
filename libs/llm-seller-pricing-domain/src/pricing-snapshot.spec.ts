/**
 * Ghim pricing snapshot: bind tại admission, bất biến, tự đủ, và không bị thay
 * đổi khi schedule đổi sau đó.
 */

import { describe, expect, it } from 'vitest';

import type { PricingSchedule } from './pricing-schedule';
import type { PricingVersion, PricingVersionHistory } from './pricing-version';
import {
  calculateSnapshotPrice,
  createPricingSnapshot,
  isPricingPeriod,
  readPricingSnapshot,
  resolvePricingSnapshot,
} from './pricing-snapshot';

function expectOk<Value>(
  result: { ok: true; value: Value } | { ok: false; error: { code: string } },
): Value {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}`);
  }
  return result.value;
}

function expectRejection(result: { ok: true } | { ok: false; error: { code: string } }): string {
  if (result.ok) {
    throw new Error('expected rejection, got ok');
  }
  return result.error.code;
}

const OFFER = 'offer-1';

/** Giá off-peak: 1.000000 per request, 0.000010 input, 0.000030 output. */
const OFF_PEAK_PRICES = {
  perRequest: 1_000_000n,
  input: 10n,
  output: 30n,
  cached: { kind: 'explicit', price: 2n },
  reasoning: { kind: 'fallback' },
} as const;

/** Giá peak: gấp đôi off-peak ở mọi dimension. */
const PEAK_PRICES = {
  perRequest: 2_000_000n,
  input: 20n,
  output: 60n,
  cached: { kind: 'explicit', price: 4n },
  reasoning: { kind: 'explicit', price: 120n },
} as const;

/** 09:00–17:00 theo giờ Việt Nam, mọi ngày trong tuần. */
const PEAK_WINDOW = {
  timezone: 'Asia/Ho_Chi_Minh',
  days: [1, 2, 3, 4, 5, 6, 7],
  startMinute: 9 * 60,
  endMinute: 17 * 60,
} as const;

function schedule(overrides: Partial<PricingSchedule> = {}): PricingSchedule {
  return {
    currency: 'VND',
    priceScale: 6,
    amountScale: 6,
    rounding: 'half_up',
    offPeakPrices: OFF_PEAK_PRICES,
    peakPrices: null,
    ...overrides,
  };
}

function version(overrides: Partial<PricingVersion> = {}): PricingVersion {
  return {
    offerId: OFFER,
    version: 1,
    effectiveFrom: Date.parse('2026-01-01T00:00:00Z'),
    schedule: schedule(),
    ...overrides,
  };
}

function peakVersion(): PricingVersion {
  return version({
    schedule: schedule({
      peakPrices: { window: PEAK_WINDOW, prices: PEAK_PRICES },
    }),
  });
}

/** 2026-03-02T02:00:00Z = Monday 09:00 giờ Việt Nam. */
const PEAK_INSTANT = Date.parse('2026-03-02T02:00:00Z');
/** 2026-03-02T12:00:00Z = Monday 19:00 giờ Việt Nam. */
const OFF_PEAK_INSTANT = Date.parse('2026-03-02T12:00:00Z');

const USAGE = {
  inputTokens: 1000n,
  cachedTokens: 200n,
  outputTokens: 500n,
  reasoningTokens: 100n,
} as const;

describe('createPricingSnapshot', () => {
  it('captures the version identity, admission and off-peak decision', () => {
    const snapshot = expectOk(createPricingSnapshot(version(), OFF_PEAK_INSTANT));
    expect(snapshot).toEqual({
      offerId: OFFER,
      version: 1,
      effectiveFrom: Date.parse('2026-01-01T00:00:00Z'),
      admission: OFF_PEAK_INSTANT,
      period: 'off_peak',
      timezone: null,
      prices: {
        perRequest: 1_000_000n,
        input: 10n,
        cached: 2n,
        output: 30n,
        reasoning: 30n,
      },
      currency: 'VND',
      priceScale: 6,
      amountScale: 6,
      rounding: 'half_up',
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.prices)).toBe(true);
  });

  it('records peak when the admission falls inside the peak window', () => {
    const snapshot = expectOk(createPricingSnapshot(peakVersion(), PEAK_INSTANT));
    expect(snapshot.period).toEqual('peak');
    expect(snapshot.timezone).toEqual('Asia/Ho_Chi_Minh');
    expect(snapshot.prices.perRequest).toEqual(2_000_000n);
    expect(snapshot.prices.input).toEqual(20n);
    expect(snapshot.prices.reasoning).toEqual(120n);
  });

  it('records off-peak when the admission falls outside the peak window', () => {
    const snapshot = expectOk(createPricingSnapshot(peakVersion(), OFF_PEAK_INSTANT));
    expect(snapshot.period).toEqual('off_peak');
    expect(snapshot.timezone).toEqual('Asia/Ho_Chi_Minh');
    expect(snapshot.prices.perRequest).toEqual(1_000_000n);
    expect(snapshot.prices.reasoning).toEqual(30n);
  });

  it('applies fallback while writing resolved prices into the snapshot', () => {
    const snapshot = expectOk(createPricingSnapshot(version(), OFF_PEAK_INSTANT));
    // reasoning dùng fallback → bằng output price, không còn rule trong snapshot.
    expect(snapshot.prices.reasoning).toEqual(30n);
    expect('reasoningRule' in snapshot).toBe(false);
  });

  it('rejects an invalid admission instant', () => {
    expect(expectRejection(createPricingSnapshot(version(), Number.NaN))).toEqual(
      'invalid_admission_time',
    );
    expect(expectRejection(createPricingSnapshot(version(), 1.5))).toEqual(
      'invalid_admission_time',
    );
  });

  it('rejects an admission instant outside the Date range', () => {
    // Ngoài biên `Date` thì `Intl` không quy được về local wall-clock. Nếu vẫn
    // tạo snapshot, mọi admission đó âm thầm thành off-peak dù window phủ cả
    // tuần — một hoá đơn thấp hơn giá đã cấu hình, không có lỗi nào báo.
    const beyondRange = 9_000_000_000_000_000;
    expect(Number.isSafeInteger(beyondRange)).toBe(true);
    expect(expectRejection(createPricingSnapshot(peakVersion(), beyondRange))).toEqual(
      'invalid_admission_time',
    );
  });

  it('rejects a version that is not yet effective at the admission instant', () => {
    const future = version({ effectiveFrom: Date.parse('2026-02-01T00:00:00Z') });
    const admission = Date.parse('2026-01-15T00:00:00Z');
    expect(expectRejection(createPricingSnapshot(future, admission))).toEqual(
      'no_applicable_version',
    );
  });

  it('produces a snapshot the reader accepts', () => {
    // Producer và reader phải cùng một bất biến: snapshot được persist rồi đọc
    // lại (§6) — nếu `createPricingSnapshot` sinh ra thứ `readPricingSnapshot`
    // từ chối thì audit/replay không dùng được bản ghi đó.
    const snapshots = [
      expectOk(createPricingSnapshot(version(), OFF_PEAK_INSTANT)),
      expectOk(createPricingSnapshot(peakVersion(), PEAK_INSTANT)),
      expectOk(createPricingSnapshot(peakVersion(), OFF_PEAK_INSTANT)),
    ];
    for (const snapshot of snapshots) {
      expect(expectOk(readPricingSnapshot(snapshot))).toEqual(snapshot);
    }
  });
});

describe('resolvePricingSnapshot', () => {
  const history: PricingVersionHistory = Object.freeze([
    version({ version: 1 }),
    version({
      version: 2,
      effectiveFrom: Date.parse('2026-02-01T00:00:00Z'),
      schedule: schedule({
        offPeakPrices: { ...OFF_PEAK_PRICES, perRequest: 1_500_000n },
      }),
    }),
  ]);

  it('selects the version effective at admission and binds it into the snapshot', () => {
    const snapshot = expectOk(resolvePricingSnapshot(history, OFFER, PEAK_INSTANT));
    expect(snapshot.version).toEqual(2);
    expect(snapshot.prices.perRequest).toEqual(1_500_000n);
    expect(snapshot.effectiveFrom).toEqual(Date.parse('2026-02-01T00:00:00Z'));
  });

  it('rejects an admission before any version of the offer', () => {
    expect(
      expectRejection(resolvePricingSnapshot(history, OFFER, Date.parse('2025-12-31T00:00:00Z'))),
    ).toEqual('no_applicable_version');
  });

  it('rejects an offer with no version in the history', () => {
    expect(expectRejection(resolvePricingSnapshot(history, 'offer-unknown', PEAK_INSTANT))).toEqual(
      'no_applicable_version',
    );
  });

  it('ignores versions of a different offer when choosing the highest version', () => {
    const mixed: PricingVersionHistory = Object.freeze([
      version({ version: 1 }),
      version({
        version: 2,
        offerId: 'offer-other',
        effectiveFrom: Date.parse('2026-02-01T00:00:00Z'),
        schedule: schedule({ offPeakPrices: { ...OFF_PEAK_PRICES, perRequest: 9n } }),
      }),
    ]);
    const snapshot = expectOk(resolvePricingSnapshot(mixed, OFFER, PEAK_INSTANT));
    expect(snapshot.version).toEqual(1);
    expect(snapshot.offerId).toEqual(OFFER);
    expect(snapshot.prices.perRequest).toEqual(1_000_000n);
  });

  it('is deterministic for the same history, offer and admission', () => {
    const first = expectOk(resolvePricingSnapshot(history, OFFER, PEAK_INSTANT));
    const second = expectOk(resolvePricingSnapshot(history, OFFER, PEAK_INSTANT));
    expect(first).toEqual(second);
  });
});

describe('snapshot immunity to later schedule changes', () => {
  it('keeps the admitted price after the schedule changes', () => {
    const admitted = expectOk(resolvePricingSnapshot([version()], OFFER, OFF_PEAK_INSTANT));
    const repriced = version({
      version: 2,
      effectiveFrom: OFF_PEAK_INSTANT + 1,
      schedule: schedule({
        offPeakPrices: { ...OFF_PEAK_PRICES, perRequest: 5_000_000n, input: 99n },
      }),
    });
    const history: PricingVersionHistory = Object.freeze([version(), repriced]);

    // Request đã admit giữ snapshot cũ.
    const later = expectOk(resolvePricingSnapshot(history, OFFER, OFF_PEAK_INSTANT));
    expect(later).toEqual(admitted);

    const before = expectOk(calculateSnapshotPrice(admitted, 1n, USAGE));
    const after = expectOk(calculateSnapshotPrice(later, 1n, USAGE));
    expect(after).toEqual(before);

    // Request admit sau thời điểm đổi giá mới thấy giá mới.
    const newAdmission = expectOk(resolvePricingSnapshot(history, OFFER, OFF_PEAK_INSTANT + 10));
    expect(newAdmission.version).toEqual(2);
    expect(newAdmission.prices.perRequest).toEqual(5_000_000n);
  });

  it('keeps a peak decision even if the peak window later moves', () => {
    const admitted = expectOk(createPricingSnapshot(peakVersion(), PEAK_INSTANT));
    const laterSchedule = schedule({
      peakPrices: {
        window: { ...PEAK_WINDOW, startMinute: 10 * 60, endMinute: 17 * 60 },
        prices: PEAK_PRICES,
      },
    });
    expect(admitted.period).toEqual('peak');
    const recreatedAtSameInstant = expectOk(
      createPricingSnapshot(version({ schedule: laterSchedule }), PEAK_INSTANT),
    );
    // Snapshot mới đánh giá theo window mới; snapshot đã bind không đổi.
    expect(recreatedAtSameInstant.period).toEqual('off_peak');
    expect(admitted.period).toEqual('peak');
    expect(admitted.prices.perRequest).toEqual(2_000_000n);
  });
});

describe('calculateSnapshotPrice', () => {
  it('calculates from the snapshot prices and rounding rule', () => {
    const snapshot = expectOk(createPricingSnapshot(version(), OFF_PEAK_INSTANT));
    const priced = expectOk(calculateSnapshotPrice(snapshot, 1n, USAGE));
    // 1000000 + 800×10 + 200×2 + 400×30 + 100×30 = 1_023_400.
    expect(priced).toEqual({ amount: 1_023_400n, amountScale: 6, currency: 'VND' });
  });

  it('uses the peak price set when the snapshot recorded peak', () => {
    const snapshot = expectOk(createPricingSnapshot(peakVersion(), PEAK_INSTANT));
    const priced = expectOk(calculateSnapshotPrice(snapshot, 1n, USAGE));
    // 2000000 + 800×20 + 200×4 + 400×60 + 100×120 = 2_052_800.
    expect(priced.amount).toEqual(2_052_800n);
  });

  it('applies the snapshot rounding rule to the final amount', () => {
    const snapshot = expectOk(
      createPricingSnapshot(
        version({ schedule: schedule({ amountScale: 2, rounding: 'floor' }) }),
        OFF_PEAK_INSTANT,
      ),
    );
    // 1.023400 đơn vị → 102.34 → floor 102.
    expect(expectOk(calculateSnapshotPrice(snapshot, 1n, USAGE)).amount).toEqual(102n);
  });

  it('rejects usage that violates the token subset invariant', () => {
    const snapshot = expectOk(createPricingSnapshot(version(), OFF_PEAK_INSTANT));
    expect(
      expectRejection(calculateSnapshotPrice(snapshot, 1n, { ...USAGE, cachedTokens: 5000n })),
    ).toEqual('token_subset_violation');
  });

  it('rejects a missing usage category instead of assuming zero', () => {
    const snapshot = expectOk(createPricingSnapshot(version(), OFF_PEAK_INSTANT));
    expect(
      expectRejection(
        calculateSnapshotPrice(snapshot, 1n, {
          inputTokens: 10n,
          outputTokens: 10n,
          reasoningTokens: 0n,
        }),
      ),
    ).toEqual('incomplete_usage');
  });

  it('rejects an invalid request count', () => {
    const snapshot = expectOk(createPricingSnapshot(version(), OFF_PEAK_INSTANT));
    expect(expectRejection(calculateSnapshotPrice(snapshot, -1n, USAGE))).toEqual('invalid_usage');
  });
});

describe('readPricingSnapshot', () => {
  it('round-trips a snapshot through a JSON-safe representation', () => {
    const snapshot = expectOk(createPricingSnapshot(peakVersion(), PEAK_INSTANT));
    const persisted = JSON.parse(
      JSON.stringify(snapshot, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ) as unknown;
    const restored = expectOk(readPricingSnapshot(persisted));
    expect(restored).toEqual(snapshot);
  });

  it('accepts an off-peak snapshot without a timezone', () => {
    const snapshot = expectOk(createPricingSnapshot(version(), OFF_PEAK_INSTANT));
    const restored = expectOk(readPricingSnapshot({ ...snapshot }));
    expect(restored.timezone).toBeNull();
  });

  it('rejects a peak snapshot without a timezone', () => {
    const snapshot = expectOk(createPricingSnapshot(peakVersion(), PEAK_INSTANT));
    expect(expectRejection(readPricingSnapshot({ ...snapshot, timezone: null }))).toEqual(
      'invalid_snapshot',
    );
  });

  it('rejects an effective-from later than the admission', () => {
    const snapshot = expectOk(createPricingSnapshot(version(), OFF_PEAK_INSTANT));
    expect(
      expectRejection(readPricingSnapshot({ ...snapshot, effectiveFrom: OFF_PEAK_INSTANT + 1 })),
    ).toEqual('invalid_snapshot');
  });

  it('rejects an unknown period or invalid rounding rule', () => {
    const snapshot = expectOk(createPricingSnapshot(version(), OFF_PEAK_INSTANT));
    expect(expectRejection(readPricingSnapshot({ ...snapshot, period: 'cheap' }))).toEqual(
      'invalid_snapshot',
    );
    expect(expectRejection(readPricingSnapshot({ ...snapshot, rounding: 'nearest' }))).toEqual(
      'invalid_snapshot',
    );
  });

  it('rejects an invalid currency, scale or resolved price', () => {
    const snapshot = expectOk(createPricingSnapshot(version(), OFF_PEAK_INSTANT));
    expect(expectRejection(readPricingSnapshot({ ...snapshot, currency: 'vnd' }))).toEqual(
      'invalid_snapshot',
    );
    expect(expectRejection(readPricingSnapshot({ ...snapshot, priceScale: -1 }))).toEqual(
      'invalid_snapshot',
    );
    expect(
      expectRejection(
        readPricingSnapshot({ ...snapshot, prices: { ...snapshot.prices, cached: -1n } }),
      ),
    ).toEqual('invalid_snapshot');
  });

  it('rejects a snapshot version below one', () => {
    const snapshot = expectOk(createPricingSnapshot(version(), OFF_PEAK_INSTANT));
    expect(expectRejection(readPricingSnapshot({ ...snapshot, version: 0 }))).toEqual(
      'invalid_snapshot',
    );
  });

  it('rejects a non-record payload', () => {
    expect(expectRejection(readPricingSnapshot(null))).toEqual('invalid_snapshot');
  });

  it('keeps read snapshots frozen', () => {
    const snapshot = expectOk(createPricingSnapshot(version(), OFF_PEAK_INSTANT));
    expect(Object.isFrozen(expectOk(readPricingSnapshot({ ...snapshot })))).toBe(true);
  });
});

describe('isPricingPeriod', () => {
  it('accepts exactly the two declared periods', () => {
    expect(isPricingPeriod('peak')).toBe(true);
    expect(isPricingPeriod('off_peak')).toBe(true);
    expect(isPricingPeriod('offpeak')).toBe(false);
    expect(isPricingPeriod(undefined)).toBe(false);
  });
});
