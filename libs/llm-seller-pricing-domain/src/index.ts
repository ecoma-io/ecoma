/**
 * `@ecoma-io/llm-seller-pricing-domain` — value object, bất biến và phép tính
 * thuần của bounded context `llm-seller-pricing`: seller-configured customer
 * price, pricing schedule theo offer, per-request/per-token pricing, peak/off-peak
 * theo IANA timezone, versioning và pricing snapshot.
 *
 * Source of truth:
 * - `docs/domains/llm-seller-pricing/domain-model.md` — khái niệm, công thức, bất biến.
 *
 * ## Ranh giới của library này
 *
 * - **Thuần**: không import Nx project khác, không SQL, không Node builtin,
 *   không I/O, không đọc đồng hồ. Mọi mốc thời gian do caller truyền vào
 *   (không đọc đồng hồ — xem `docs/domains/llm-seller-pricing/domain-model.md` §1).
 * - **Chỉ định giá**: không reserve quota, không dispatch, không settle usage,
 *   không charge wallet, không giữ balance (invariant 13).
 * - **Không suy ra customer price**: giá seller cấu hình *là* customer price;
 *   provider cost là đại lượng độc lập và không phải input của library
 *   (`domains/README.md` §5.8).
 * - **Không có tier pricing**: không graduated/volume tier, threshold, bracket
 *   hay usage window. Pricing dimension chỉ có per-request và per-token.
 * - **Một currency**: không chuyển đổi currency hay đơn vị; một snapshot mang
 *   đúng một currency và một cặp scale.
 *
 * ## Bất biến không chốt trong library này
 *
 * - Pricing granularity giữa offer và normalized model
 *   (`domains/README.md` §5.9): schedule được key theo **offer**. Library không
 *   mở rộng sang normalized model khi chưa có quyết định.
 * - Provider cost ownership/source (§5.8): ngoài phạm vi, không có kiểu nào ở
 *   đây đại diện cho nó.
 */

export {
  LLM_PRICING_DOMAIN_ERROR_MESSAGES,
  isLlmPricingDomainError,
  llmPricingDomainError,
  type LlmPricingDomainError,
  type LlmPricingDomainErrorCode,
} from './errors';
export {
  pricingFailure,
  pricingOk,
  type PricingFailure,
  type PricingOk,
  type PricingResult,
} from './result';
export {
  AMOUNT_SCALE_MAX,
  MAX_FIXED_POINT_MAGNITUDE,
  PRICE_SCALE_MAX,
  ROUNDING_RULES,
  isAmountScale,
  isFixedPointAmount,
  isPriceScale,
  isRoundingRule,
  type RoundingRule,
} from './fixed-point';
export { isCurrencyCode } from './currency';
export { isEpochMillis } from './instant';
export {
  isPriceSet,
  isResolvedPriceSet,
  isSubsetPriceRule,
  readPriceSet,
  readSubsetPriceRule,
  resolvePriceSet,
  type PriceSet,
  type ResolvedPriceSet,
  type SubsetPriceRule,
} from './price';
export {
  isIanaTimeZone,
  isPeakWindow,
  isWithinPeakWindow,
  readPeakWindow,
  type PeakWindow,
} from './peak-window';
export {
  isPricingSchedule,
  readPricingSchedule,
  type PeakPriceSet,
  type PricingSchedule,
} from './pricing-schedule';
export {
  appendPricingVersion,
  isPricingVersion,
  readPricingVersion,
  readPricingVersionHistory,
  selectApplicableVersion,
  type PricingVersion,
  type PricingVersionHistory,
} from './pricing-version';
export { isTokenUsage, readRequestCount, readTokenUsage, type TokenUsage } from './token-usage';
export { calculatePrice, type PriceCalculation, type PricedAmount } from './calculate-price';
export {
  PRICING_PERIODS,
  calculateSnapshotPrice,
  createPricingSnapshot,
  isPricingPeriod,
  readPricingSnapshot,
  resolvePricingSnapshot,
  type PricingPeriod,
  type PricingSnapshot,
} from './pricing-snapshot';
