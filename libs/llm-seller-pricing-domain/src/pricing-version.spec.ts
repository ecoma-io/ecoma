/**
 * Ghim versioning: số version monotonic liên tiếp, `effectiveFrom` không giảm,
 * history bất biến khi append, và chọn version tại admission.
 */

import { describe, expect, it } from 'vitest';

import type { PricingSchedule } from './pricing-schedule';
import {
  appendPricingVersion,
  isPricingVersion,
  readPricingVersion,
  readPricingVersionHistory,
  selectApplicableVersion,
  type PricingVersion,
  type PricingVersionHistory,
} from './pricing-version';

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

const SCHEDULE: PricingSchedule = {
  currency: 'VND',
  priceScale: 0,
  amountScale: 0,
  rounding: 'half_up',
  offPeakPrices: {
    perRequest: 1000n,
    input: 250n,
    output: 750n,
    cached: { kind: 'fallback' },
    reasoning: { kind: 'fallback' },
  },
  peakPrices: null,
};

const OFFER = 'offer-1';

function version(overrides: Partial<PricingVersion> = {}): PricingVersion {
  return {
    offerId: OFFER,
    version: 1,
    effectiveFrom: 1_000,
    schedule: SCHEDULE,
    ...overrides,
  };
}

describe('readPricingVersion', () => {
  it('accepts a complete version and freezes it', () => {
    const parsed = expectOk(readPricingVersion(version()));
    expect(parsed.version).toEqual(1);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('rejects a missing or blank offer id', () => {
    expect(expectRejection(readPricingVersion(version({ offerId: '' })))).toEqual(
      'invalid_offer_id',
    );
    expect(expectRejection(readPricingVersion(version({ offerId: '   ' })))).toEqual(
      'invalid_offer_id',
    );
  });

  it('rejects a version number below one or non-integer', () => {
    expect(expectRejection(readPricingVersion(version({ version: 0 })))).toEqual('invalid_version');
    expect(expectRejection(readPricingVersion(version({ version: 1.5 })))).toEqual(
      'invalid_version',
    );
    expect(expectRejection(readPricingVersion(version({ version: -3 })))).toEqual(
      'invalid_version',
    );
  });

  it('rejects a non-integer effective-from', () => {
    expect(expectRejection(readPricingVersion(version({ effectiveFrom: 1.5 })))).toEqual(
      'invalid_effective_from',
    );
    expect(expectRejection(readPricingVersion(version({ effectiveFrom: Number.NaN })))).toEqual(
      'invalid_effective_from',
    );
  });

  it('rejects a version whose schedule is invalid', () => {
    expect(
      expectRejection(
        readPricingVersion({
          ...version(),
          schedule: { ...SCHEDULE, currency: 'vnd' },
        }),
      ),
    ).toEqual('invalid_currency');
  });

  it('reports isPricingVersion consistently with the reader', () => {
    expect(isPricingVersion(expectOk(readPricingVersion(version())))).toBe(true);
    expect(isPricingVersion(version({ version: 0 }))).toBe(false);
  });

  it('rejects a version that the guard would narrow to the wrong type', () => {
    // Cùng lý do với `isPricingSchedule`: version mang giá dạng `number`/chuỗi
    // là dạng wire mà reader nhận, không phải dạng đã chuẩn hoá mà guard hứa.
    expect(
      isPricingVersion({
        ...version(),
        schedule: {
          ...SCHEDULE,
          offPeakPrices: { ...SCHEDULE.offPeakPrices, input: 250 },
        },
      }),
    ).toBe(false);
    expect(isPricingVersion({ ...version(), effectiveFrom: '1000' })).toBe(false);
    expect(isPricingVersion({ ...version(), offerId: 1 })).toBe(false);
  });
});

describe('readPricingVersionHistory', () => {
  it('accepts a contiguous history with non-decreasing effective-from', () => {
    const history = expectOk(
      readPricingVersionHistory([
        version({ version: 1, effectiveFrom: 1_000 }),
        version({ version: 2, effectiveFrom: 1_000 }),
        version({ version: 3, effectiveFrom: 2_000 }),
      ]),
    );
    expect(history.map((entry) => entry.version)).toEqual([1, 2, 3]);
    expect(Object.isFrozen(history)).toBe(true);
  });

  it('accepts an empty history', () => {
    expect(expectOk(readPricingVersionHistory([]))).toEqual([]);
  });

  it('rejects a history that does not start at version 1', () => {
    expect(expectRejection(readPricingVersionHistory([version({ version: 2 })]))).toEqual(
      'invalid_version_history',
    );
  });

  it('rejects a skipped version number', () => {
    expect(
      expectRejection(
        readPricingVersionHistory([version({ version: 1 }), version({ version: 3 })]),
      ),
    ).toEqual('invalid_version_history');
  });

  it('accepts a history that carries several offers, validating each offer separately', () => {
    // Bất biến monotonic của tài liệu §5 là "trong cùng offer". Một bảng
    // `pricing_versions` lọc theo tập offer trả về nhiều offer trong một mảng,
    // nên từ chối nó sẽ chặn đúng dữ liệu mà `resolvePricingSnapshot` cần nhận.
    const history = expectOk(
      readPricingVersionHistory([
        version({ version: 1, offerId: 'offer-1' }),
        version({ version: 1, offerId: 'offer-2' }),
        version({ version: 2, offerId: 'offer-1' }),
        version({ version: 2, offerId: 'offer-2' }),
      ]),
    );
    expect(history.map((entry) => `${entry.offerId}#${entry.version}`)).toEqual([
      'offer-1#1',
      'offer-2#1',
      'offer-1#2',
      'offer-2#2',
    ]);
  });

  it('rejects a per-offer gap even when other offers are contiguous', () => {
    expect(
      expectRejection(
        readPricingVersionHistory([
          version({ version: 1, offerId: 'offer-1' }),
          version({ version: 1, offerId: 'offer-2' }),
          version({ version: 3, offerId: 'offer-1' }),
        ]),
      ),
    ).toEqual('invalid_version_history');
  });

  it('rejects a version whose effective-from goes backwards', () => {
    expect(
      expectRejection(
        readPricingVersionHistory([
          version({ version: 1, effectiveFrom: 2_000 }),
          version({ version: 2, effectiveFrom: 1_000 }),
        ]),
      ),
    ).toEqual('invalid_version_history');
  });

  it('rejects a history that is not an array', () => {
    expect(expectRejection(readPricingVersionHistory(null))).toEqual('invalid_version_history');
  });
});

describe('appendPricingVersion', () => {
  it('appends the next version without mutating the previous history', () => {
    const base: PricingVersionHistory = Object.freeze([version({ version: 1 })]);
    const next = version({ version: 2, effectiveFrom: 2_000 });
    const appended = expectOk(appendPricingVersion(base, next));
    expect(base.length).toEqual(1);
    expect(appended.length).toEqual(2);
    expect(appended[0]).toBe(base[0]);
    expect(appended[1]).toBe(next);
    expect(appended).not.toBe(base);
  });

  it('starts a new offer history at version 1', () => {
    expect(expectOk(appendPricingVersion([], version({ version: 1 }))).length).toEqual(1);
    expect(expectRejection(appendPricingVersion([], version({ version: 2 })))).toEqual(
      'invalid_version_transition',
    );
  });

  it('rejects a skipped or repeated version number', () => {
    const base: PricingVersionHistory = [version({ version: 1 })];
    expect(expectRejection(appendPricingVersion(base, version({ version: 3 })))).toEqual(
      'invalid_version_transition',
    );
    expect(expectRejection(appendPricingVersion(base, version({ version: 1 })))).toEqual(
      'invalid_version_transition',
    );
  });

  it('rejects an earlier effective-from than the previous version', () => {
    const base: PricingVersionHistory = [version({ version: 1, effectiveFrom: 2_000 })];
    expect(
      expectRejection(appendPricingVersion(base, version({ version: 2, effectiveFrom: 1_999 }))),
    ).toEqual('invalid_version_transition');
  });

  it('rejects a version appended to a different offer history', () => {
    const base: PricingVersionHistory = [version({ version: 1 })];
    expect(
      expectRejection(appendPricingVersion(base, version({ version: 2, offerId: 'offer-2' }))),
    ).toEqual('invalid_version_transition');
  });
});

describe('selectApplicableVersion', () => {
  const history: PricingVersionHistory = Object.freeze([
    version({ version: 1, effectiveFrom: 1_000 }),
    version({ version: 2, effectiveFrom: 2_000 }),
    version({ version: 3, effectiveFrom: 3_000 }),
  ]);

  it('selects the highest version effective at the admission instant', () => {
    expect(expectOk(selectApplicableVersion(history, 2_500)).version).toEqual(2);
    expect(expectOk(selectApplicableVersion(history, 1_000)).version).toEqual(1);
    expect(expectOk(selectApplicableVersion(history, 9_999)).version).toEqual(3);
  });

  it('treats effective-from as inclusive', () => {
    expect(expectOk(selectApplicableVersion(history, 3_000)).version).toEqual(3);
  });

  it('rejects an admission before the first version', () => {
    expect(expectRejection(selectApplicableVersion(history, 999))).toEqual('no_applicable_version');
  });

  it('rejects an empty history', () => {
    expect(expectRejection(selectApplicableVersion([], 5_000))).toEqual('no_applicable_version');
  });

  it('rejects an invalid admission instant', () => {
    expect(expectRejection(selectApplicableVersion(history, Number.NaN))).toEqual(
      'invalid_admission_time',
    );
  });

  it('is deterministic for the same history and instant', () => {
    const first = expectOk(selectApplicableVersion(history, 2_500));
    const second = expectOk(selectApplicableVersion(history, 2_500));
    expect(first).toEqual(second);
  });
});
