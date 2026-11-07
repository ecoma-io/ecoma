/**
 * Pricing schedule — tập quy tắc giá seller cấu hình cho một offer.
 *
 * Source of truth: `docs/domains/llm-seller-pricing/domain-model.md` §1–§4, §7.
 *
 * Một schedule hợp lệ mang đồng thời:
 * - **currency** và hai **scale** (price scale/amount scale);
 * - **rounding rule** — không có giá trị mặc định ngầm;
 * - **bộ giá off-peak** với per-request, input, output bắt buộc, cùng rule
 *   cached/reasoning (giá riêng hoặc fallback tường minh);
 * - **bộ giá peak + peak window** tuỳ chọn, nhưng phải có đủ cả hai: window
 *   không có giá peak thì window vô nghĩa, giá peak không có window thì không
 *   bao giờ áp dụng. Nửa vời là cấu hình sai, không phải cấu hình "tắt peak".
 */

import { isCurrencyCode } from './currency';
import { isAmountScale, isPriceScale, isRoundingRule, type RoundingRule } from './fixed-point';
import { isRecord } from './guards';
import { isPeakWindow, readPeakWindow, type PeakWindow } from './peak-window';
import { isPriceSet, readPriceSet, type PriceSet } from './price';
import { pricingFailure, pricingOk, type PricingResult } from './result';

/** Bộ giá peak gắn với một window. */
export interface PeakPriceSet {
  readonly window: PeakWindow;
  readonly prices: PriceSet;
}

/** Schedule đã validate và freeze. */
export interface PricingSchedule {
  readonly currency: string;
  readonly priceScale: number;
  readonly amountScale: number;
  readonly rounding: RoundingRule;
  /** Bộ giá ngoài peak window — luôn tồn tại. */
  readonly offPeakPrices: PriceSet;
  /** Bộ giá trong peak window — `null` nghĩa là schedule không có peak. */
  readonly peakPrices: PeakPriceSet | null;
}

/**
 * Type guard cho `PricingSchedule` **chuẩn hoá**.
 *
 * Không gọi `readPricingSchedule(...).ok`: reader nhận giá dạng `number`/chuỗi
 * rồi chuyển sang `bigint`, còn guard phải bảo đảm đúng kiểu mà chữ ký hứa —
 * nếu không, TypeScript narrow một schedule mang chuỗi thành `bigint` và phép
 * nhân tiền ném `TypeError` giữa đường.
 */
export function isPricingSchedule(value: unknown): value is PricingSchedule {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isCurrencyCode(value['currency']) &&
    isPriceScale(value['priceScale']) &&
    isAmountScale(value['amountScale']) &&
    isRoundingRule(value['rounding']) &&
    isPriceSet(value['offPeakPrices']) &&
    isPeakPriceSetOrNull(value['peakPrices'])
  );
}

function isPeakPriceSetOrNull(value: unknown): value is PeakPriceSet | null {
  if (value === null) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  return isPeakWindow(value['window']) && isPriceSet(value['prices']);
}

/**
 * Validate một schedule đọc từ dữ liệu ngoài (console input, DB row).
 *
 * Từ chối — không sửa, không mặc định hoá:
 * - currency sai hình dạng, scale ngoài miền, rounding rule lạ;
 * - thiếu per-request/input/output price, hoặc giá âm/không nguyên;
 * - rule cached/reasoning không thuộc hai dạng đã chốt;
 * - peak window thiếu giá peak, hoặc giá peak thiếu window.
 */
export function readPricingSchedule(value: unknown): PricingResult<PricingSchedule> {
  if (!isRecord(value)) {
    return pricingFailure('invalid_schedule');
  }
  const currency = value['currency'];
  if (!isCurrencyCode(currency)) {
    return pricingFailure('invalid_currency');
  }
  const priceScale = value['priceScale'];
  if (!isPriceScale(priceScale)) {
    return pricingFailure('invalid_scale');
  }
  const amountScale = value['amountScale'];
  if (!isAmountScale(amountScale)) {
    return pricingFailure('invalid_scale');
  }
  const rounding = value['rounding'];
  if (!isRoundingRule(rounding)) {
    return pricingFailure('invalid_rounding_rule');
  }
  const offPeakPrices = readPriceSet(value['offPeakPrices']);
  if (!offPeakPrices.ok) {
    return pricingFailure(offPeakPrices.error.code);
  }
  const peakPrices = readPeakPriceSet(value['peakPrices']);
  if (!peakPrices.ok) {
    return pricingFailure(peakPrices.error.code);
  }
  return pricingOk(
    Object.freeze({
      currency,
      priceScale,
      amountScale,
      rounding,
      offPeakPrices: offPeakPrices.value,
      peakPrices: peakPrices.value,
    }),
  );
}

function readPeakPriceSet(value: unknown): PricingResult<PeakPriceSet | null> {
  if (value === null || value === undefined) {
    return pricingOk(null);
  }
  if (!isRecord(value)) {
    return pricingFailure('invalid_peak_schedule');
  }
  const window = readPeakWindow(value['window']);
  if (!window.ok) {
    return pricingFailure(window.error.code);
  }
  const prices = readPriceSet(value['prices']);
  if (!prices.ok) {
    return pricingFailure(prices.error.code);
  }
  return pricingOk(Object.freeze({ window: window.value, prices: prices.value }));
}
