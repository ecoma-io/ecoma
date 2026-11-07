/**
 * Pricing snapshot — bản chụp bất biến của quyết định giá tại admission.
 *
 * Source of truth: `docs/domains/llm-seller-pricing/domain-model.md` §6.
 *
 * Snapshot phải **tự đủ**: mọi giá trị cần cho phép tính nằm trong snapshot,
 * không còn tham chiếu nào tới version đang sống. Nhờ vậy một request đã admit
 * giữ nguyên giá khi schedule đổi sau đó, và reconciliation đọc snapshot thay vì
 * đọc schedule hiện hành (invariant 7, 8, 11).
 *
 * Hệ quả thiết kế: snapshot chứa **giá đã resolve**, không chứa rule
 * cached/reasoning. Rule là dữ liệu cấu hình; giá đã resolve mới là dữ liệu kinh
 * tế. Giữ rule trong snapshot có nghĩa là lúc đọc phải áp lại fallback dựa trên
 * một cấu hình — đúng thứ snapshot sinh ra để loại bỏ.
 */

import { isCurrencyCode } from './currency';
import { isAmountScale, isPriceScale, isRoundingRule, type RoundingRule } from './fixed-point';
import { isRecord } from './guards';
import { isEpochMillis } from './instant';
import { isIanaTimeZone, isWithinPeakWindow } from './peak-window';
import { readResolvedPriceSet, resolvePriceSet, type ResolvedPriceSet } from './price';
import {
  selectApplicableVersion,
  type PricingVersion,
  type PricingVersionHistory,
} from './pricing-version';
import { calculatePrice, type PricedAmount } from './calculate-price';
import { pricingFailure, pricingOk, type PricingResult } from './result';
import { readRequestCount, readTokenUsage } from './token-usage';

/** Bộ giá nào của schedule đang áp dụng. */
export const PRICING_PERIODS = ['peak', 'off_peak'] as const;

/** Kỳ giá đã chọn tại admission. */
export type PricingPeriod = (typeof PRICING_PERIODS)[number];

/** Type guard cho `PricingPeriod`. */
export function isPricingPeriod(value: unknown): value is PricingPeriod {
  return typeof value === 'string' && (PRICING_PERIODS as readonly string[]).includes(value);
}

/** Bản chụp bất biến, tự đủ, của quyết định giá cho một logical request. */
export interface PricingSnapshot {
  readonly offerId: string;
  readonly version: number;
  /** `effectiveFrom` của version đã dùng. */
  readonly effectiveFrom: number;
  /** Thời điểm admission đã dùng cho quyết định này. */
  readonly admission: number;
  readonly period: PricingPeriod;
  /** Timezone của schedule khi có peak window; `null` khi schedule không có peak. */
  readonly timezone: string | null;
  readonly prices: ResolvedPriceSet;
  readonly currency: string;
  readonly priceScale: number;
  readonly amountScale: number;
  readonly rounding: RoundingRule;
}

/**
 * Tạo snapshot từ một version đã chọn và admission instant.
 *
 * Quyết định peak/off-peak dùng **admission instant**, không dùng thời điểm đọc
 * cấu hình: đó là điểm duy nhất mà mọi consumer (dispatch, settlement, charge)
 * có thể tái lập mà không cần biết thứ tự sự kiện.
 *
 * Từ chối version chưa có hiệu lực tại `admission` (`effectiveFrom > admission`).
 * Lý do không chỉ là nhất quán với `readPricingSnapshot`: một snapshot như vậy
 * sẽ được persist rồi bị chính domain từ chối lúc đọc lại (§6), tức là ghi
 * một bản ghi mà audit/replay không dùng được.
 */
export function createPricingSnapshot(
  version: PricingVersion,
  admission: number,
): PricingResult<PricingSnapshot> {
  if (!isEpochMillis(admission)) {
    return pricingFailure('invalid_admission_time');
  }
  if (version.effectiveFrom > admission) {
    return pricingFailure('no_applicable_version');
  }
  const { schedule } = version;
  const peak = schedule.peakPrices;
  const isPeak = peak !== null && isWithinPeakWindow(peak.window, admission);
  const prices = resolvePriceSet(isPeak && peak !== null ? peak.prices : schedule.offPeakPrices);
  return pricingOk(
    Object.freeze({
      offerId: version.offerId,
      version: version.version,
      effectiveFrom: version.effectiveFrom,
      admission,
      period: isPeak ? 'peak' : 'off_peak',
      timezone: peak === null ? null : peak.window.timezone,
      prices,
      currency: schedule.currency,
      priceScale: schedule.priceScale,
      amountScale: schedule.amountScale,
      rounding: schedule.rounding,
    }),
  );
}

/**
 * Resolve giá cho một admission: chọn version của **offer này** rồi tạo snapshot.
 *
 * Bước lọc theo `offerId` không thể bỏ: một history có thể chứa version của
 * nhiều offer, và version số lớn nhất của offer khác không áp dụng cho offer
 * đang cần.
 */
export function resolvePricingSnapshot(
  history: PricingVersionHistory,
  offerId: string,
  admission: number,
): PricingResult<PricingSnapshot> {
  const scoped = history.filter((entry) => entry.offerId === offerId);
  if (scoped.length === 0) {
    return pricingFailure('no_applicable_version');
  }
  const version = selectApplicableVersion(scoped, admission);
  if (!version.ok) {
    return pricingFailure(version.error.code);
  }
  return createPricingSnapshot(version.value, admission);
}

/**
 * Validate một snapshot đọc từ dữ liệu persisting (DB row, outbox payload).
 *
 * Kiểm cả quan hệ `effectiveFrom <= admission`: một snapshot vi phạm quan hệ đó
 * không thể là snapshot hợp lệ do domain sinh ra, nên nhận nó nghĩa là dữ liệu
 * đã bị sửa sai — và mọi phép tính sau đó sẽ "đúng kiểu" trên một quyết định
 * không bao giờ xảy ra.
 */
export function readPricingSnapshot(value: unknown): PricingResult<PricingSnapshot> {
  if (!isRecord(value)) {
    return pricingFailure('invalid_snapshot');
  }
  const offerId = value['offerId'];
  if (typeof offerId !== 'string' || offerId.trim().length === 0) {
    return pricingFailure('invalid_snapshot');
  }
  const version = value['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return pricingFailure('invalid_snapshot');
  }
  const effectiveFrom = value['effectiveFrom'];
  if (!isEpochMillis(effectiveFrom)) {
    return pricingFailure('invalid_snapshot');
  }
  const admission = value['admission'];
  if (!isEpochMillis(admission) || effectiveFrom > admission) {
    return pricingFailure('invalid_snapshot');
  }
  const period = value['period'];
  if (!isPricingPeriod(period)) {
    return pricingFailure('invalid_snapshot');
  }
  const timezone = value['timezone'];
  if (timezone !== null && !isIanaTimeZone(timezone)) {
    return pricingFailure('invalid_snapshot');
  }
  // Bất biến chéo: peak chỉ tồn tại khi schedule có timezone, vì quyết định peak
  // không thể tái lập nếu không biết nó được đánh giá ở timezone nào.
  if (period === 'peak' && timezone === null) {
    return pricingFailure('invalid_snapshot');
  }
  const prices = readResolvedPriceSet(value['prices']);
  if (!prices.ok) {
    return pricingFailure(prices.error.code);
  }
  const currency = value['currency'];
  if (!isCurrencyCode(currency)) {
    return pricingFailure('invalid_snapshot');
  }
  const priceScale = value['priceScale'];
  if (!isPriceScale(priceScale)) {
    return pricingFailure('invalid_snapshot');
  }
  const amountScale = value['amountScale'];
  if (!isAmountScale(amountScale)) {
    return pricingFailure('invalid_snapshot');
  }
  const rounding = value['rounding'];
  if (!isRoundingRule(rounding)) {
    return pricingFailure('invalid_snapshot');
  }
  return pricingOk(
    Object.freeze({
      offerId,
      version,
      effectiveFrom,
      admission,
      period,
      timezone,
      prices: prices.value,
      currency,
      priceScale,
      amountScale,
      rounding,
    }),
  );
}

/**
 * Tính tiền từ **snapshot**, không từ schedule.
 *
 * Đây là entry point duy nhất mà settlement/charge dùng: nó không nhận
 * `PricingVersionHistory` làm tham số, nên không có đường nào để một thay đổi
 * pricing sau admission ảnh hưởng tới request đã admit (invariant 8).
 */
export function calculateSnapshotPrice(
  snapshot: PricingSnapshot,
  requestCount: unknown,
  usage: unknown,
): PricingResult<PricedAmount> {
  const count = readRequestCount(requestCount);
  if (!count.ok) {
    return pricingFailure(count.error.code);
  }
  const parsedUsage = readTokenUsage(usage);
  if (!parsedUsage.ok) {
    return pricingFailure(parsedUsage.error.code);
  }
  return calculatePrice(
    {
      requestCount: count.value,
      usage: parsedUsage.value,
      prices: snapshot.prices,
      priceScale: snapshot.priceScale,
      amountScale: snapshot.amountScale,
      rounding: snapshot.rounding,
    },
    snapshot.currency,
  );
}
