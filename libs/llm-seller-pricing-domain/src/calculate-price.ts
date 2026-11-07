/**
 * Phép tính giá cho một logical request.
 *
 * Công thức canonical nằm ở `docs/domains/llm-seller-pricing/domain-model.md` §3:
 *
 * ```text
 * price = request_count × per_request_price
 *       + (input_tokens − cached_tokens) × input_price
 *       + cached_tokens × cached_price
 *       + (output_tokens − reasoning_tokens) × output_price
 *       + reasoning_tokens × reasoning_price
 * ```
 *
 * Hai điều kiện làm công thức trên đúng:
 * - **không double-count**: input price chỉ áp cho phần input nằm ngoài cached,
 *   output price chỉ áp cho phần output nằm ngoài reasoning;
 * - **một điểm làm tròn duy nhất**: toàn bộ tích luỹ chạy chính xác ở price
 *   scale, và chỉ chuyển sang amount scale một lần ở cuối (§7).
 */

import { isCurrencyCode } from './currency';
import {
  FixedPointOverflow,
  checkedAdd,
  checkedMultiply,
  isAmountScale,
  isPriceScale,
  isRoundingRule,
  rescaleFixedPoint,
  type RoundingRule,
} from './fixed-point';
import { isRecord } from './guards';
import { isResolvedPriceSet, type ResolvedPriceSet } from './price';
import { pricingFailure, pricingOk, type PricingResult } from './result';
import { readRequestCount, readTokenUsage, type TokenUsage } from './token-usage';

/** Đầu vào của phép tính giá — mọi thứ đã resolve, không còn fallback. */
export interface PriceCalculation {
  readonly requestCount: bigint;
  readonly usage: TokenUsage;
  readonly prices: ResolvedPriceSet;
  readonly priceScale: number;
  readonly amountScale: number;
  readonly rounding: RoundingRule;
}

/**
 * Tổng tiền đã làm tròn về amount scale.
 *
 * Chỉ mang **kết quả cuối**; các thành phần trung gian ở price scale không được
 * làm tròn riêng, nên không có chỗ nào để một phép cộng các số đã làm tròn lệch
 * khỏi kết quả đúng (§7).
 */
export interface PricedAmount {
  /** Số tiền ở amount scale. */
  readonly amount: bigint;
  readonly amountScale: number;
  readonly currency: string;
}

/**
 * Tính giá một logical request và chuyển kết quả về amount scale.
 *
 * Trả `amount_overflow` khi một phép nhân/cộng vượt biên độ biểu diễn — không
 * bao giờ trả một con số đã bị cắt.
 *
 * `calculation` là tham số public, nên được **đọc lại** qua các reader thay vì
 * tin vào type: một caller dựng object ngoài đường `readPricingSchedule` có thể
 * đưa vào giá âm, usage thiếu field hay `number` thay cho `bigint`. Không đọc
 * lại thì phép nhân ném `TypeError` giữa đường tính tiền thay vì trả domain
 * error — và một exception không kiểu ở đây không có cách nào để consumer phân
 * loại.
 */
export function calculatePrice(
  calculation: PriceCalculation,
  currency: string,
): PricingResult<PricedAmount> {
  if (!isRecord(calculation)) {
    return pricingFailure('invalid_usage');
  }
  if (!isPriceScale(calculation['priceScale']) || !isAmountScale(calculation['amountScale'])) {
    return pricingFailure('invalid_scale');
  }
  if (!isRoundingRule(calculation['rounding'])) {
    return pricingFailure('invalid_rounding_rule');
  }
  if (!isCurrencyCode(currency)) {
    return pricingFailure('invalid_currency');
  }
  const inputs = readCalculation(calculation);
  if (!inputs.ok) {
    return pricingFailure(inputs.error.code);
  }
  const { requestCount, usage, prices, amountScale, priceScale, rounding } = inputs.value;
  try {
    const subtotalAtPriceScale = sumRawComponents(requestCount, usage, prices);
    const amount = rescaleFixedPoint(subtotalAtPriceScale, priceScale, amountScale, rounding);
    return pricingOk(Object.freeze({ amount, amountScale, currency }));
  } catch (error) {
    if (error instanceof FixedPointOverflow) {
      return pricingFailure('amount_overflow');
    }
    throw error;
  }
}

/**
 * Đọc các input số học mà một caller có thể dựng tay.
 *
 * Phép trừ `input − cached` chạy trước mọi phép nhân, nên một cặp vi phạm subset
 * sẽ tạo ra số âm và đi tiếp vào tổng — kết quả vẫn "đúng kiểu" nhưng vô nghĩa.
 * Vì vậy usage đi qua `readTokenUsage`, nơi bất biến subset là một mã lỗi riêng
 * (`token_subset_violation`) thay vì bị trộn vào `invalid_usage`: consumer cần
 * phân biệt "hai nguồn usage lệch nhau" với "dữ liệu hỏng".
 */
function readCalculation(value: Record<string, unknown>): PricingResult<PriceCalculation> {
  const requestCount = readRequestCount(value['requestCount']);
  if (!requestCount.ok) {
    return pricingFailure(requestCount.error.code);
  }
  const usage = readTokenUsage(value['usage']);
  if (!usage.ok) {
    return pricingFailure(usage.error.code);
  }
  const prices = value['prices'];
  if (!isResolvedPriceSet(prices)) {
    return pricingFailure('invalid_price');
  }
  return pricingOk(
    Object.freeze({
      requestCount: requestCount.value,
      usage: usage.value,
      prices,
      priceScale: value['priceScale'] as number,
      amountScale: value['amountScale'] as number,
      rounding: value['rounding'] as RoundingRule,
    }),
  );
}

/**
 * Tổng ở price scale. Mỗi thành phần được nhân riêng rồi cộng dồn — cùng kết
 * quả với việc gộp hệ số, nhưng giữ được phép kiểm biên độ ở từng bước để một
 * input sai đơn vị bị phát hiện thay vì hoà vào một tổng khổng lồ.
 */
function sumRawComponents(
  requestCount: bigint,
  usage: TokenUsage,
  prices: ResolvedPriceSet,
): bigint {
  const billableInput = usage.inputTokens - usage.cachedTokens;
  const billableOutput = usage.outputTokens - usage.reasoningTokens;
  let total = checkedMultiply(requestCount, prices.perRequest);
  total = checkedAdd(total, checkedMultiply(billableInput, prices.input));
  total = checkedAdd(total, checkedMultiply(usage.cachedTokens, prices.cached));
  total = checkedAdd(total, checkedMultiply(billableOutput, prices.output));
  total = checkedAdd(total, checkedMultiply(usage.reasoningTokens, prices.reasoning));
  return total;
}
