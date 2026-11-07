/**
 * Kiểu kết quả của mọi operation domain trong `llm-seller-pricing`.
 *
 * Business rejection là trường hợp dự kiến (schedule hỏng, usage vi phạm subset,
 * không version nào áp dụng), không phải lỗi lập trình — nên operation trả
 * result thay vì throw. Chỉ lỗi lập trình thật (ví dụ truyền một `code` ngoài
 * taxonomy vào factory error) mới throw.
 */

import {
  llmPricingDomainError,
  type LlmPricingDomainError,
  type LlmPricingDomainErrorCode,
} from './errors';

/** Nhánh thành công: mang giá trị đã validate và đã freeze. */
export interface PricingOk<Value> {
  readonly ok: true;
  readonly value: Value;
}

/** Nhánh bị từ chối: mang đúng một domain error, không mang dữ liệu call site. */
export interface PricingFailure {
  readonly ok: false;
  readonly error: LlmPricingDomainError;
}

/** Kết quả của một operation domain. */
export type PricingResult<Value> = PricingOk<Value> | PricingFailure;

/** Dựng nhánh thành công. */
export function pricingOk<Value>(value: Value): PricingResult<Value> {
  return { ok: true, value };
}

/** Dựng nhánh bị từ chối từ một mã lỗi trong taxonomy. */
export function pricingFailure<Value = never>(
  code: LlmPricingDomainErrorCode,
): PricingResult<Value> {
  return { ok: false, error: llmPricingDomainError(code) };
}
