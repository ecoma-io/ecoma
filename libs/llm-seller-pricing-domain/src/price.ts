/**
 * Bộ giá của một schedule và bộ giá đã resolve của một snapshot.
 *
 * `PriceSet` là dữ liệu seller cấu hình: cached/reasoning price có thể là một
 * giá riêng, hoặc khai báo fallback tường minh về input/output price
 * (`docs/domains/llm-seller-pricing/domain-model.md` §3). Không có trạng thái
 * "thiếu giá": kiểu dữ liệu chỉ có hai dạng, và fallback là một lựa chọn được
 * ghi ra chứ không phải giá trị mặc định ngầm.
 *
 * `ResolvedPriceSet` là kết quả sau khi áp fallback — mọi dimension đều có giá
 * cụ thể. Snapshot giữ bộ này, nên tái lập giá không cần đọc lại schedule
 * (invariant 11).
 */

import { isFixedPointAmount, readNonNegativeInteger } from './fixed-point';
import { isRecord } from './guards';
import { pricingFailure, pricingOk, type PricingResult } from './result';

/**
 * Giá của một token subset — hoặc giá riêng, hoặc fallback tường minh về
 * category cha (cached → input, reasoning → output).
 */
export type SubsetPriceRule =
  | { readonly kind: 'explicit'; readonly price: bigint }
  | { readonly kind: 'fallback' };

/** Bộ giá của một schedule, ở price scale của chính schedule đó. */
export interface PriceSet {
  readonly perRequest: bigint;
  readonly input: bigint;
  readonly output: bigint;
  readonly cached: SubsetPriceRule;
  readonly reasoning: SubsetPriceRule;
}

/** Bộ giá đã áp fallback — mọi dimension đều mang số cụ thể. */
export interface ResolvedPriceSet {
  readonly perRequest: bigint;
  readonly input: bigint;
  readonly cached: bigint;
  readonly output: bigint;
  readonly reasoning: bigint;
}

/**
 * Validate một `SubsetPriceRule` từ dữ liệu ngoài.
 *
 * `explicit` bắt buộc có `price` là fixed-point không âm; `fallback` bắt buộc
 * **không** có `price` — một rule vừa khai fallback vừa mang giá là cấu hình
 * mâu thuẫn, không phải trường hợp "giá bị bỏ qua".
 */
export function readSubsetPriceRule(value: unknown): PricingResult<SubsetPriceRule> {
  if (!isRecord(value)) {
    return pricingFailure('invalid_price_rule');
  }
  const kind = value['kind'];
  const rawPrice = value['price'];
  if (kind === 'fallback') {
    if (rawPrice !== undefined && rawPrice !== null) {
      return pricingFailure('invalid_price_rule');
    }
    return pricingOk(Object.freeze({ kind: 'fallback' }));
  }
  if (kind === 'explicit') {
    const price = readNonNegativeInteger(rawPrice);
    if (price === null) {
      return pricingFailure('invalid_price_rule');
    }
    return pricingOk(Object.freeze({ kind: 'explicit', price }));
  }
  return pricingFailure('invalid_price_rule');
}

/**
 * Validate một bộ giá: per-request, input và output là bắt buộc; cached và
 * reasoning đi qua `readSubsetPriceRule`.
 */
export function readPriceSet(value: unknown): PricingResult<PriceSet> {
  if (!isRecord(value)) {
    return pricingFailure('invalid_price');
  }
  const perRequest = readNonNegativeInteger(value['perRequest']);
  if (perRequest === null) {
    return pricingFailure('invalid_price');
  }
  const input = readNonNegativeInteger(value['input']);
  if (input === null) {
    return pricingFailure('invalid_price');
  }
  const output = readNonNegativeInteger(value['output']);
  if (output === null) {
    return pricingFailure('invalid_price');
  }
  const cached = readSubsetPriceRule(value['cached']);
  if (!cached.ok) {
    return pricingFailure(cached.error.code);
  }
  const reasoning = readSubsetPriceRule(value['reasoning']);
  if (!reasoning.ok) {
    return pricingFailure(reasoning.error.code);
  }
  return pricingOk(
    Object.freeze({
      perRequest,
      input,
      output,
      cached: cached.value,
      reasoning: reasoning.value,
    }),
  );
}

/**
 * Áp fallback để có giá cụ thể cho mọi dimension.
 *
 * Fallback không phải giá trị mặc định mà là một rule đã khai: cached fallback
 * nghĩa là cached tokens được tính đúng bằng input price, nên tổng tiền của
 * `input_tokens` không phụ thuộc việc tách `cached_tokens`.
 */
export function resolvePriceSet(set: PriceSet): ResolvedPriceSet {
  return Object.freeze({
    perRequest: set.perRequest,
    input: set.input,
    cached: set.cached.kind === 'explicit' ? set.cached.price : set.input,
    output: set.output,
    reasoning: set.reasoning.kind === 'explicit' ? set.reasoning.price : set.output,
  });
}

/** Validate một `ResolvedPriceSet` đọc từ dữ liệu đã persist. */
export function readResolvedPriceSet(value: unknown): PricingResult<ResolvedPriceSet> {
  if (!isRecord(value)) {
    return pricingFailure('invalid_snapshot');
  }
  const perRequest = readNonNegativeInteger(value['perRequest']);
  const input = readNonNegativeInteger(value['input']);
  const cached = readNonNegativeInteger(value['cached']);
  const output = readNonNegativeInteger(value['output']);
  const reasoning = readNonNegativeInteger(value['reasoning']);
  if (
    perRequest === null ||
    input === null ||
    cached === null ||
    output === null ||
    reasoning === null
  ) {
    return pricingFailure('invalid_snapshot');
  }
  return pricingOk(Object.freeze({ perRequest, input, cached, output, reasoning }));
}

/**
 * Type guard cho `SubsetPriceRule` **chuẩn hoá**.
 *
 * Kiểm cả số field: `fallback` chỉ có `kind`, `explicit` có đúng `kind` + `price`.
 * Một object vừa khai fallback vừa mang `price` không phải rule hợp lệ — `read*`
 * từ chối nó, và guard phải cùng kết luận để hai đường không lệch nhau.
 */
export function isSubsetPriceRule(value: unknown): value is SubsetPriceRule {
  if (!isRecord(value)) {
    return false;
  }
  const ownKeys = Object.keys(value);
  if (ownKeys.length === 1) {
    return value['kind'] === 'fallback';
  }
  if (ownKeys.length !== 2 || !ownKeys.includes('price')) {
    return false;
  }
  return value['kind'] === 'explicit' && isFixedPointAmount(value['price']);
}

/** Type guard cho `PriceSet` **chuẩn hoá**. */
export function isPriceSet(value: unknown): value is PriceSet {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFixedPointAmount(value['perRequest']) &&
    isFixedPointAmount(value['input']) &&
    isFixedPointAmount(value['output']) &&
    isSubsetPriceRule(value['cached']) &&
    isSubsetPriceRule(value['reasoning'])
  );
}

/**
 * Type guard cho `ResolvedPriceSet` **chuẩn hoá**: mọi giá phải là `bigint`
 * trong biên, không phải số hay chuỗi.
 *
 * Cùng lý do với `isTokenUsage`: reader nhận thêm `number`/chuỗi rồi chuyển đổi,
 * còn guard phải bảo đảm đúng kiểu mà chữ ký hứa — nếu không, TypeScript narrow
 * một object mang chuỗi thành `bigint` và phép nhân ném `TypeError` ở giữa đường
 * tính tiền.
 */
export function isResolvedPriceSet(value: unknown): value is ResolvedPriceSet {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFixedPointAmount(value['perRequest']) &&
    isFixedPointAmount(value['input']) &&
    isFixedPointAmount(value['cached']) &&
    isFixedPointAmount(value['output']) &&
    isFixedPointAmount(value['reasoning'])
  );
}
