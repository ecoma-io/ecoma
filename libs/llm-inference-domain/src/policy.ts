/**
 * Execution policy — giới hạn thực thi của một logical request.
 *
 * Source of truth: `docs/domains/llm-inference/domain-model.md` §4.
 *
 * Domain **không** định nghĩa default cho `maxAttempts` hay độ dài deadline:
 * cả hai là quyết định policy do caller (admission của `llm-api`) truyền vào và
 * được snapshot bất biến tại admission. Thay đổi policy sau admission không
 * ảnh hưởng request đã admit.
 */

import {
  inferenceFailure,
  inferenceOk,
  isEpochMillis,
  isPositiveInteger,
  type InferenceResult,
} from './shared';

/** Giới hạn thực thi bất biến của một logical request. */
export interface ExecutionPolicy {
  /** Số attempt tối đa, tính cả attempt đầu tiên. Số nguyên dương. */
  readonly maxAttempts: number;
  /** Mốc deadline tuyệt đối (epoch millis), phải sau thời điểm admission. */
  readonly deadlineAt: number;
}

/** Type guard cho `ExecutionPolicy`. */
export function isExecutionPolicy(value: unknown): value is ExecutionPolicy {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const policy = value as ExecutionPolicy;
  return isPositiveInteger(policy.maxAttempts) && isEpochMillis(policy.deadlineAt);
}

/**
 * Validate policy tại admission.
 *
 * `deadlineAt` phải **sau** `admittedAt`: một request nhận vào khi deadline đã
 * qua không thể có attempt hợp lệ nào.
 */
export function validateExecutionPolicy(
  policy: unknown,
  admittedAt: number,
): InferenceResult<ExecutionPolicy> {
  if (!isExecutionPolicy(policy)) {
    return inferenceFailure('invalid_attempt_limit');
  }
  if (policy.deadlineAt <= admittedAt) {
    return inferenceFailure('invalid_deadline');
  }
  return inferenceOk(
    Object.freeze({ maxAttempts: policy.maxAttempts, deadlineAt: policy.deadlineAt }),
  );
}
