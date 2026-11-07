/**
 * Ghim validation của pricing schedule: cả hai dimension bắt buộc, currency và
 * scale hợp lệ, rounding rule có thật, và peak chỉ tồn tại khi có đủ window +
 * bộ giá peak.
 */

import { describe, expect, it } from 'vitest';

import { isPricingSchedule, readPricingSchedule } from './pricing-schedule';

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

const OFF_PEAK = {
  perRequest: 1000n,
  input: 250n,
  output: 750n,
  cached: { kind: 'explicit', price: 50n },
  reasoning: { kind: 'fallback' },
} as const;

const PEAK = {
  perRequest: 2000n,
  input: 500n,
  output: 1500n,
  cached: { kind: 'explicit', price: 100n },
  reasoning: { kind: 'explicit', price: 2000n },
} as const;

const VALID_SCHEDULE = {
  currency: 'VND',
  priceScale: 0,
  amountScale: 0,
  rounding: 'half_up',
  offPeakPrices: OFF_PEAK,
  peakPrices: null,
} as const;

const PEAK_WINDOW = {
  timezone: 'Asia/Ho_Chi_Minh',
  days: [1, 2, 3, 4, 5],
  startMinute: 9 * 60,
  endMinute: 17 * 60,
} as const;

describe('readPricingSchedule', () => {
  it('accepts a schedule with both mandatory dimensions and no peak', () => {
    const schedule = expectOk(readPricingSchedule(VALID_SCHEDULE));
    expect(schedule.currency).toEqual('VND');
    expect(schedule.offPeakPrices.input).toEqual(250n);
    expect(schedule.peakPrices).toBeNull();
    expect(Object.isFrozen(schedule)).toBe(true);
  });

  it('accepts a schedule with a peak window and peak prices', () => {
    const schedule = expectOk(
      readPricingSchedule({
        ...VALID_SCHEDULE,
        peakPrices: { window: PEAK_WINDOW, prices: PEAK },
      }),
    );
    expect(schedule.peakPrices?.window.timezone).toEqual('Asia/Ho_Chi_Minh');
    expect(schedule.peakPrices?.prices.perRequest).toEqual(2000n);
  });

  it('accepts a schedule whose peak covers the whole week', () => {
    expect(
      expectOk(
        readPricingSchedule({
          ...VALID_SCHEDULE,
          peakPrices: {
            window: { ...PEAK_WINDOW, days: [1, 2, 3, 4, 5, 6, 7] },
            prices: PEAK,
          },
        }),
      ).peakPrices?.window.days,
    ).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('rejects an invalid currency shape', () => {
    for (const currency of ['vnd', 'VNDT', 'V1D', '', 840]) {
      expect(expectRejection(readPricingSchedule({ ...VALID_SCHEDULE, currency }))).toEqual(
        'invalid_currency',
      );
    }
  });

  it('accepts any three-letter uppercase currency shape', () => {
    // Không có danh sách currency trong domain: ba chữ in hoa là đủ hình dạng.
    expect(expectOk(readPricingSchedule({ ...VALID_SCHEDULE, currency: 'XTS' })).currency).toEqual(
      'XTS',
    );
  });

  it('rejects scales outside the supported range', () => {
    expect(expectRejection(readPricingSchedule({ ...VALID_SCHEDULE, priceScale: 19 }))).toEqual(
      'invalid_scale',
    );
    expect(expectRejection(readPricingSchedule({ ...VALID_SCHEDULE, amountScale: -1 }))).toEqual(
      'invalid_scale',
    );
    expect(expectRejection(readPricingSchedule({ ...VALID_SCHEDULE, priceScale: 2.5 }))).toEqual(
      'invalid_scale',
    );
  });

  it('rejects an unknown or missing rounding rule', () => {
    expect(
      expectRejection(readPricingSchedule({ ...VALID_SCHEDULE, rounding: 'bankers' })),
    ).toEqual('invalid_rounding_rule');
    expect(
      expectRejection(readPricingSchedule({ ...VALID_SCHEDULE, rounding: undefined })),
    ).toEqual('invalid_rounding_rule');
  });

  it('rejects a schedule missing a mandatory off-peak dimension', () => {
    const incomplete = {
      ...OFF_PEAK,
      perRequest: undefined,
      input: undefined,
      output: undefined,
    };
    expect(
      expectRejection(readPricingSchedule({ ...VALID_SCHEDULE, offPeakPrices: incomplete })),
    ).toEqual('invalid_price');
  });

  it('rejects a schedule with a negative price', () => {
    expect(
      expectRejection(
        readPricingSchedule({
          ...VALID_SCHEDULE,
          offPeakPrices: { ...OFF_PEAK, input: -1n },
        }),
      ),
    ).toEqual('invalid_price');
  });

  it('rejects a schedule missing the cached or reasoning rule', () => {
    const withoutCached = { ...OFF_PEAK, cached: undefined };
    expect(
      expectRejection(readPricingSchedule({ ...VALID_SCHEDULE, offPeakPrices: withoutCached })),
    ).toEqual('invalid_price_rule');
    const withoutReasoning = { ...OFF_PEAK, reasoning: undefined };
    expect(
      expectRejection(readPricingSchedule({ ...VALID_SCHEDULE, offPeakPrices: withoutReasoning })),
    ).toEqual('invalid_price_rule');
  });

  it('rejects peak prices without a window', () => {
    expect(
      expectRejection(readPricingSchedule({ ...VALID_SCHEDULE, peakPrices: { prices: PEAK } })),
    ).toEqual('invalid_peak_window');
  });

  it('rejects a window without peak prices', () => {
    expect(
      expectRejection(
        readPricingSchedule({ ...VALID_SCHEDULE, peakPrices: { window: PEAK_WINDOW } }),
      ),
    ).toEqual('invalid_price');
  });

  it('rejects a peak window with an invalid timezone', () => {
    expect(
      expectRejection(
        readPricingSchedule({
          ...VALID_SCHEDULE,
          peakPrices: {
            window: { ...PEAK_WINDOW, timezone: 'GMT+7' },
            prices: PEAK,
          },
        }),
      ),
    ).toEqual('invalid_timezone');
  });

  it('rejects a peak window with an invalid minute range', () => {
    expect(
      expectRejection(
        readPricingSchedule({
          ...VALID_SCHEDULE,
          peakPrices: {
            window: { ...PEAK_WINDOW, startMinute: 1200, endMinute: 1200 },
            prices: PEAK,
          },
        }),
      ),
    ).toEqual('invalid_peak_window');
  });

  it('rejects a peak configuration that is neither absent nor complete', () => {
    expect(expectRejection(readPricingSchedule({ ...VALID_SCHEDULE, peakPrices: 'peak' }))).toEqual(
      'invalid_peak_schedule',
    );
  });

  it('rejects a non-record schedule', () => {
    expect(expectRejection(readPricingSchedule(null))).toEqual('invalid_schedule');
    expect(expectRejection(readPricingSchedule([]))).toEqual('invalid_schedule');
  });

  it('reports isPricingSchedule consistently with the reader', () => {
    expect(isPricingSchedule(expectOk(readPricingSchedule(VALID_SCHEDULE)))).toBe(true);
    expect(isPricingSchedule({ ...VALID_SCHEDULE, currency: 'vnd' })).toBe(false);
  });

  it('rejects a schedule that the guard would narrow to the wrong type', () => {
    // `number`/chuỗi là dạng wire mà reader chấp nhận (`number`/chuỗi). Nếu
    // guard nhận chúng, TypeScript narrow một schedule mang chuỗi thành
    // `bigint` và phép nhân tiền ném `TypeError` giữa đường.
    expect(
      isPricingSchedule({
        ...VALID_SCHEDULE,
        offPeakPrices: { ...OFF_PEAK, perRequest: '1000' },
      }),
    ).toBe(false);
    expect(
      isPricingSchedule({
        ...VALID_SCHEDULE,
        offPeakPrices: { ...OFF_PEAK, perRequest: 1000 },
      }),
    ).toBe(false);
    expect(
      isPricingSchedule({
        ...VALID_SCHEDULE,
        offPeakPrices: { ...OFF_PEAK, cached: { kind: 'fallback', price: 50n } },
      }),
    ).toBe(false);
  });
});
