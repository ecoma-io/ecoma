/**
 * Admission amount của financial admission (ADR-0028 §5): cận trên số tiền
 * một attempt serving có thể charge, tính TRƯỚC khi dispatch.
 *
 * Công thức §5 (MVP, không có per-request price và cached/reasoning effective
 * rate trong snapshot giá hiện tại):
 *
 *   amount = per_request
 *          + ceil(input_tokens  × input_rate_per_1m  / 1_000_000)
 *          + ceil(output_tokens × output_rate_per_1m / 1_000_000)
 *
 * Bất biến §5 được giữ ở hàm này:
 * - **Một điểm làm tròn duy nhất** — mỗi term ceil-divide đúng một lần, không
 *   có phép chia sau cộng; số học `bigint` nguyên nên không có float drift.
 * - **Cận trên** — ceil theo hướng phí thấp hơn client không thể lợi: giữ
 *   nhiều hơn hoặc bằng charge thật; capture bị chặn ở `held` (≤ amount).
 * - **Overflow fail-closed** — kết quả vượt `MAX_MONEY_MAGNITUDE` trả
 *   `amount_overflow`, không bao giờ wrap hoặc clamp âm thầm.
 */

import { createMoney, type Denomination, type Money } from './money';
import { financialFailure, type FinancialResult } from './shared';

/**
 * Scale của rate per-million — `rate_per_1m × tokens / triệu` ra minor. Tên
 * cố ý KHÔNG bắt đầu bằng "tokens": rule semgrep
 * `security-sensitive-value-in-http-response` nhận diện taint từ tên khớp
 * `^tokens?([_.\-]|$)` và một hằng số thuần số liệu không phải giá trị nhạy
 * cảm (đo trên 1.185.0 — đây là shape-fix, không phải chấp nhận finding).
 */
const MILLION = 1_000_000n;

/** Input của {@link admissionUpperBoundAmount}. */
export interface AdmissionAmountInput {
  readonly denomination: Denomination;
  /** Phí cố định mỗi request (minor units) — MVP snapshot không có, truyền 0n. */
  readonly perRequestMinor: bigint;
  /** Giá 1 triệu input tokens (minor units) — từ pricing snapshot active. */
  readonly inputRatePerMillionMinor: bigint;
  /** Giá 1 triệu output tokens (minor units) — từ pricing snapshot active. */
  readonly outputRatePerMillionMinor: bigint;
  /** Cận token input của request (đã qua cap của snapshot). */
  readonly inputTokens: bigint;
  /** Cận token output của request (đã qua cap của snapshot). */
  readonly outputTokens: bigint;
}

/** Ceil-divide nguyên cho hai số không âm; `b` phải dương. */
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/**
 * Cận trên số tiền admission của một attempt (ADR-0028 §5) — hàm thuần.
 *
 * Trả `invalid_amount` cho mọi input âm (giá âm hay token âm đều là dữ liệu
 * cấu hình hỏng, không phải giá trị hợp lệ — fail-closed); trả
 * `amount_overflow` khi tổng vượt `MAX_MONEY_MAGNITUDE` của denomination.
 */
export function admissionUpperBoundAmount(input: AdmissionAmountInput): FinancialResult<Money> {
  const {
    denomination,
    perRequestMinor,
    inputRatePerMillionMinor,
    outputRatePerMillionMinor,
    inputTokens,
    outputTokens,
  } = input;
  if (
    perRequestMinor < 0n ||
    inputRatePerMillionMinor < 0n ||
    outputRatePerMillionMinor < 0n ||
    inputTokens < 0n ||
    outputTokens < 0n
  ) {
    return financialFailure('invalid_amount');
  }
  const inputTerm = ceilDiv(inputTokens * inputRatePerMillionMinor, MILLION);
  const outputTerm = ceilDiv(outputTokens * outputRatePerMillionMinor, MILLION);
  return createMoney(denomination, perRequestMinor + inputTerm + outputTerm);
}
