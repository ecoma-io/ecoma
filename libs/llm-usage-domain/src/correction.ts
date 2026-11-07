/**
 * `Correction` validity — quyết định liệu một correction có được áp dụng hay không.
 *
 * Nguồn: `docs/domains/llm-usage/domain-model.md` §6.
 *
 * Quy tắc domain (không chút ordering / replacement / conflict — U-2 vẫn mở):
 * - `correction_id` không được rỗng.
 * - `usage` phải hợp lệ (đủ invariant).
 * - `usage` không được tạo giá trị âm (đảm bảo qua `validateUsageInvariants` + isValidTokenCount).
 * - Charge-affecting correction yêu cầu `llm-financial` xử lý idempotent adjustment
 *   theo `(reservation_id, correction_id)`; domain KHÔNG trực tiếp sửa ledger/balance.
 *
 * U-2 (thứ tự correction, replacement vs merge, conflict trùng khóa) vẫn mở;
 * hàm này KHÔNG implement ordering hay replacement policy.
 */

import type { Correction, NormalizedUsage } from './types';
import { isNormalizedUsage, isValidTokenCount, validateUsageInvariants } from './normalized-usage';

/** Kiểm một `Correction` có cấu trúc hợp lệ không (type guard). */
export function isCorrection(value: unknown): value is Correction {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const c = value as Correction;
  return (
    typeof c.correction_id === 'string' &&
    c.correction_id.trim().length > 0 &&
    (c.scope === 'request' || c.scope === 'attempt') &&
    (c.scope !== 'request' || typeof c.reservation_id === 'string') &&
    (c.scope !== 'attempt' || typeof c.attempt_id === 'string') &&
    typeof c.usage === 'object' &&
    c.usage !== null
  );
}

/**
 * Kiểm correction có hợp lệ để áp dụng không.
 *
 * @param correction - correction cần kiểm.
 * @param _existingUsage - usage hiện tại, DƯ RIÊNG cho U-2/U-3 (ordering /
 *   replacement vs merge, request vs attempt correction relationship). Hiện tại
 *   không ảnh hưởng đến kết quả validation; giữ lại trong signature theo DoF
 *   §11.7, chưa được business chốt ngữ nghĩa.
 * @returns `{ valid: true }` hoặc `{ valid: false, reason: string }`.
 * Không mutate input.
 */
export function isCorrectionValid(
  correction: Correction,
  _existingUsage: NormalizedUsage,
): { readonly valid: boolean; readonly reason?: string } {
  if (!isCorrection(correction)) {
    return { valid: false, reason: 'Correction does not have valid structure' };
  }

  // usage phải là NormalizedUsage hợp lệ (tất cả trường token hợp lệ), không
  // chỉ kiểm tra chéo cached ≤ input qua validateUsageInvariants.
  if (!isNormalizedUsage(correction.usage)) {
    return { valid: false, reason: 'Correction usage is not a valid NormalizedUsage' };
  }

  const usageValidation = validateUsageInvariants(correction.usage);
  if (!usageValidation.valid) {
    return { valid: false, reason: usageValidation.violation };
  }

  // Idempotency key thành phần không được rỗng.
  if (
    correction.scope === 'request' &&
    (!correction.reservation_id || correction.reservation_id.trim().length === 0)
  ) {
    return { valid: false, reason: 'reservation_id is required for request-level correction' };
  }
  if (
    correction.scope === 'attempt' &&
    (!correction.attempt_id || correction.attempt_id.trim().length === 0)
  ) {
    return { valid: false, reason: 'attempt_id is required for attempt-level correction' };
  }

  // Correction không được tạo giá trị âm, NaN, hoặc Infinity — kiểm qua
  // isValidTokenCount (Number.isFinite && >= 0), đồng nhất với normalized-usage.
  for (const [name, value] of Object.entries({
    input_tokens: correction.usage.input_tokens,
    output_tokens: correction.usage.output_tokens,
    cached_tokens: correction.usage.cached_tokens,
    reasoning_tokens: correction.usage.reasoning_tokens,
    request_count: correction.usage.request_count,
  })) {
    if (value !== null && !isValidTokenCount(value)) {
      return { valid: false, reason: `${name} is not a valid token count` };
    }
  }

  // Charge-affecting correction: domain yêu cầu llm-financial xử lý adjustment
  // idempotent theo (reservation_id, correction_id); domain không trực tiếp sửa ledger.
  // Bất biến charge: correction không thay đổi charge đã settle trừ khi policy rõ ràng —
  // enforce ở tầng application/llm-financial, không ở đây.

  return { valid: true };
}

/**
 * Xây chuỗi idempotency key cho correction.
 *
 * - Request-level: `(reservation_id, correction_id)`
 * - Attempt-level: `(attempt_id, correction_id)`
 *
 * U-3 (mối quan hệ giữa hai cấp correction) vẫn mở; hàm này chỉ xây khóa theo scope
 * được caller chỉ định, KHÔNG Suy luận mối quan hệ giữa chúng.
 */
export function correctionIdempotencyKey({
  scope,
  id,
  correction_id,
}: {
  scope: 'request' | 'attempt';
  id: string;
  correction_id: string;
}): string {
  if (!id || id.trim().length === 0) {
    throw new TypeError(`id không được rỗng (scope: ${scope})`);
  }
  if (!correction_id || correction_id.trim().length === 0) {
    throw new TypeError('correction_id không được rỗng');
  }
  return `${scope}:${id}:${correction_id}`;
}
