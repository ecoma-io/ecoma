/**
 * Kiến trúc dùng chung của domain library `llm-inference`.
 *
 * Mọi giá trị thời gian là epoch millis kiểu `number` do caller truyền vào —
 * domain không đọc đồng hồ (`Date.now()`), không parse RFC 3339, không sinh số
 * ngẫu nhiên, không sinh identifier. Mọi hàm là thuần: không sửa input, không
 * giữ state, và trả `InferenceResult` (`ok`/`error`) thay vì ném exception cho
 * dữ liệu đầu vào hỏng.
 *
 * Runtime string (error message) viết bằng ENGLISH theo language policy của
 * repo.
 */

import {
  inferenceDomainError,
  type InferenceDomainError,
  type InferenceDomainErrorCode,
} from './errors';

// ---------------------------------------------------------------------------
// Kết quả
// ---------------------------------------------------------------------------

/** Nhánh thành công: mang giá trị đã validate hoặc state kế tiếp. */
export interface InferenceOk<Value> {
  readonly ok: true;
  readonly value: Value;
}

/** Nhánh bị từ chối: mang đúng một domain error, không mang dữ liệu call site. */
export interface InferenceFailure {
  readonly ok: false;
  readonly error: InferenceDomainError;
}

/** Kết quả của một operation domain. */
export type InferenceResult<Value> = InferenceOk<Value> | InferenceFailure;

/** Dựng nhánh thành công. */
export function inferenceOk<Value>(value: Value): InferenceResult<Value> {
  return { ok: true, value };
}

/** Dựng nhánh bị từ chối từ một mã lỗi trong taxonomy. */
export function inferenceFailure<Value = never>(
  code: InferenceDomainErrorCode,
): InferenceResult<Value> {
  return { ok: false, error: inferenceDomainError(code) };
}

// ---------------------------------------------------------------------------
// Định danh
// ---------------------------------------------------------------------------

declare const requestIdBrand: unique symbol;
declare const attemptIdBrand: unique symbol;

/** Định danh logical request — do caller sinh, domain chỉ validate hình dạng. */
export type RequestId = string & { readonly [requestIdBrand]?: true };

/** Định danh provider attempt — do caller sinh, unique trong một logical request. */
export type AttemptId = string & { readonly [attemptIdBrand]?: true };

/** Độ dài tối đa của mọi định danh/reference opaque để chặn payload bất thường. */
export const MAX_OPAQUE_ID_LENGTH = 200;

/**
 * Opaque identifier: chuỗi không rỗng, không có whitespace thừa ở hai đầu, và
 * không vượt `MAX_OPAQUE_ID_LENGTH`. Domain không diễn giải nội dung.
 */
export function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_OPAQUE_ID_LENGTH &&
    value.trim() === value
  );
}

/** Type guard cho `RequestId` — dùng khi đọc từ persistence/transport. */
export function isRequestId(value: unknown): value is RequestId {
  return isOpaqueId(value);
}

/** Type guard cho `AttemptId`. */
export function isAttemptId(value: unknown): value is AttemptId {
  return isOpaqueId(value);
}

/**
 * Dựng `RequestId` từ giá trị đã đọc ở boundary.
 * @throws TypeError khi giá trị không phải opaque ID hợp lệ.
 */
export function createRequestId(value: string): RequestId {
  if (!isRequestId(value)) {
    throw new TypeError('Request ID must be a non-empty, trimmed opaque string.');
  }
  return value;
}

/**
 * Dựng `AttemptId` từ giá trị đã đọc ở boundary.
 * @throws TypeError khi giá trị không phải opaque ID hợp lệ.
 */
export function createAttemptId(value: string): AttemptId {
  if (!isAttemptId(value)) {
    throw new TypeError('Attempt ID must be a non-empty, trimmed opaque string.');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Thời gian và số nguyên
// ---------------------------------------------------------------------------

/** Kiểm tra một giá trị có phải epoch millis hợp lệ (số nguyên an toàn) không. */
export function isEpochMillis(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Kiểm tra một giá trị có phải số nguyên dương không. */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
