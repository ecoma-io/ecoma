/**
 * Token usage mà `llm-seller-pricing` nhận vào để tính giá.
 *
 * Source of truth: `docs/domains/llm-seller-pricing/domain-model.md` §3 và
 * `docs/domains/llm-usage/domain-model.md` §4.
 *
 * Pricing **không** đo, không chuẩn hoá, không tổng hợp usage — `llm-usage` làm
 * việc đó. Module này chỉ kiểm bất biến subset mà phép tính giá dựa vào:
 *
 * - `cachedTokens` là **subset** của `inputTokens`;
 * - `reasoningTokens` là **subset** của `outputTokens`.
 *
 * Vi phạm subset là input không hợp lệ, **không** phải trường hợp "sửa về 0":
 * một cặp `cached > input` nghĩa là hai con số đến từ hai nguồn khác nhau, và
 * chọn bên nào cũng tạo ra một hoá đơn sai một cách âm thầm.
 */

import { MAX_FIXED_POINT_MAGNITUDE, readNonNegativeInteger } from './fixed-point';
import { isRecord } from './guards';
import { pricingFailure, pricingOk, type PricingResult } from './result';

/**
 * Token count từng category, tất cả là số nguyên không âm.
 *
 * Cả bốn category đều bắt buộc: một usage thiếu `cachedTokens` không thể phân
 * biệt "không có cached token" với "nguồn usage không đo cached token", và hai
 * trường hợp đó cho hai hoá đơn khác nhau. Bắt buộc tường minh `0n` biến sự mơ
 * hồ thành lỗi cấu hình (`incomplete_usage`) thay vì một khoản tiền.
 */
export interface TokenUsage {
  readonly inputTokens: bigint;
  /** Subset của `inputTokens`; `0n` nghĩa là không có cached token. */
  readonly cachedTokens: bigint;
  readonly outputTokens: bigint;
  /** Subset của `outputTokens`; `0n` nghĩa là không có reasoning token. */
  readonly reasoningTokens: bigint;
}

/**
 * Validate token usage đọc từ dữ liệu ngoài.
 *
 * Nhận `bigint` hoặc số nguyên an toàn `number` (giá trị JSON/DB điển hình) rồi
 * chuyển sang `bigint`; từ chối mọi thứ khác — kể cả `number` vượt miền an toàn,
 * vì một token count đã mất chính xác không thể dùng để tính tiền.
 *
 * Phân biệt hai loại lỗi: category **thiếu** là `incomplete_usage`, category có
 * mặt nhưng giá trị sai là `invalid_usage`. Consumer cần hai mã khác nhau vì
 * cách xử lý khác nhau — thiếu field là lỗi tích hợp, giá trị sai là dữ liệu
 * hỏng.
 */
export function readTokenUsage(value: unknown): PricingResult<TokenUsage> {
  if (!isRecord(value)) {
    return pricingFailure('invalid_usage');
  }
  const inputTokens = value['inputTokens'];
  const cachedTokens = value['cachedTokens'];
  const outputTokens = value['outputTokens'];
  const reasoningTokens = value['reasoningTokens'];
  if (
    inputTokens === undefined ||
    cachedTokens === undefined ||
    outputTokens === undefined ||
    reasoningTokens === undefined
  ) {
    return pricingFailure('incomplete_usage');
  }
  const input = toTokenCount(inputTokens);
  const cached = toTokenCount(cachedTokens);
  const output = toTokenCount(outputTokens);
  const reasoning = toTokenCount(reasoningTokens);
  if (input === null || cached === null || output === null || reasoning === null) {
    return pricingFailure('invalid_usage');
  }
  if (cached > input || reasoning > output) {
    return pricingFailure('token_subset_violation');
  }
  return pricingOk(
    Object.freeze({
      inputTokens: input,
      cachedTokens: cached,
      outputTokens: output,
      reasoningTokens: reasoning,
    }),
  );
}

function toTokenCount(value: unknown): bigint | null {
  return value === undefined ? null : readNonNegativeInteger(value);
}

/**
 * Type guard cho `TokenUsage` **chuẩn hoá**: mọi count phải là `bigint` trong
 * biên, không phải số hay chuỗi đọc từ ngoài.
 *
 * Vì sao không dùng `readTokenUsage(...).ok`: reader cố ý nhận `number` và
 * chuỗi chữ số để đọc `numeric` column, rồi **chuyển** sang `bigint`. Một guard
 * trả `true` cho giá trị mà kiểu của nó nói là `bigint` nhưng thực tế là chuỗi
 * sẽ khiến TypeScript narrow một object không đúng kiểu — và phép tính tiền sau
 * đó ném `TypeError: Cannot mix BigInt and other types` thay vì trả domain
 * error. Kiểm đúng kiểu ở đây giữ lời hứa của chữ ký: giá trị đã qua guard dùng
 * được trực tiếp trong phép tính.
 */
export function isTokenUsage(value: unknown): value is TokenUsage {
  if (!isRecord(value)) {
    return false;
  }
  const input = value['inputTokens'];
  const cached = value['cachedTokens'];
  const output = value['outputTokens'];
  const reasoning = value['reasoningTokens'];
  if (
    typeof input !== 'bigint' ||
    typeof cached !== 'bigint' ||
    typeof output !== 'bigint' ||
    typeof reasoning !== 'bigint'
  ) {
    return false;
  }
  return (
    input >= 0n &&
    cached >= 0n &&
    output >= 0n &&
    reasoning >= 0n &&
    input <= MAX_FIXED_POINT_MAGNITUDE &&
    cached <= MAX_FIXED_POINT_MAGNITUDE &&
    output <= MAX_FIXED_POINT_MAGNITUDE &&
    reasoning <= MAX_FIXED_POINT_MAGNITUDE &&
    cached <= input &&
    reasoning <= output
  );
}

/**
 * Request count của một logical request — số nguyên không âm.
 *
 * Một logical request có thể gộp nhiều lần gọi upstream (retry, multi-step), nên
 * đây là input riêng chứ không luôn bằng 1.
 */
export function readRequestCount(value: unknown): PricingResult<bigint> {
  const count = toTokenCount(value);
  if (count === null) {
    return pricingFailure('invalid_usage');
  }
  return pricingOk(count);
}
