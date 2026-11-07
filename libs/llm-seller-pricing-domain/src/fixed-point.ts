/**
 * Số học fixed-point trên `bigint` — toàn bộ tính tiền của `llm-seller-pricing` đi qua
 * module này.
 *
 * Vì sao `bigint` chứ không `number`: một `number` là IEEE-754 double, nên phép
 * nhân `tokens × price` mất chính xác ngay khi vượt 2^53 và mọi phép chia làm
 * tròn theo nhị phân. Tiền phải cộng/nhân chính xác trên cơ số 10; `bigint` cho
 * đúng như vậy và không có `NaN`/`Infinity` để lọt vào một so sánh.
 *
 * Hai scale của một schedule:
 * - **price scale** — số chữ số thập phân của đơn vị giá (ví dụ 6 nghĩa là giá
 *   đang tính bằng `10^-6` đơn vị tiền tệ mỗi token);
 * - **amount scale** — số chữ số thập phân của số tiền sau khi tính.
 *
 * Toàn bộ phép nhân/cộng chạy chính xác ở price scale. **Chỉ một điểm làm tròn
 * duy nhất**: `rescaleFixedPoint` khi chuyển sang amount scale
 * (`docs/domains/llm-seller-pricing/domain-model.md` §7).
 */

/**
 * Trần scale — đủ rộng cho mọi đơn vị giá per-token thực tế (10^-18), đủ hẹp để
 * giữ phép lũy thừa 10 trong miền `bigint` rẻ và dễ kiểm.
 */
export const PRICE_SCALE_MAX = 18;

/** Trần scale của số tiền — cùng miền với price scale. */
export const AMOUNT_SCALE_MAX = 18;

/**
 * Trần biên độ của một giá trị fixed-point: `10^30 - 1`.
 *
 * `bigint` không tự tràn, nên "overflow" ở đây là **biên độ biểu diễn mà domain
 * chấp nhận**. Vượt biên độ nghĩa là một trong hai input đã sai đơn vị (hoặc
 * token count bịa), và cộng dồn tiếp chỉ tạo ra một con số vô nghĩa nhưng vẫn
 * "đúng kiểu" — đúng loại hỏng âm thầm cần chặn. Mọi phép nhân/cộng đều kiểm
 * biên độ ngay sau khi tính.
 */
export const MAX_FIXED_POINT_MAGNITUDE = 10n ** 30n - 1n;

/** Bốn quy tắc làm tròn mà một schedule được phép khai báo. */
export const ROUNDING_RULES = ['half_up', 'half_even', 'floor', 'ceil'] as const;

/** Quy tắc làm tròn — dữ liệu của schedule, ghi vào snapshot. */
export type RoundingRule = (typeof ROUNDING_RULES)[number];

/** Type guard cho `RoundingRule`. */
export function isRoundingRule(value: unknown): value is RoundingRule {
  return typeof value === 'string' && (ROUNDING_RULES as readonly string[]).includes(value);
}

/** Type guard cho price scale. */
export function isPriceScale(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= PRICE_SCALE_MAX
  );
}

/** Type guard cho amount scale. */
export function isAmountScale(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= AMOUNT_SCALE_MAX
  );
}

/** Type guard cho một giá trị tiền/giá đã ở dạng fixed-point hợp lệ. */
export function isFixedPointAmount(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_FIXED_POINT_MAGNITUDE;
}

/**
 * Đọc một số nguyên không âm từ dữ liệu ngoài (cấu hình, DB row, payload).
 *
 * Chấp nhận ba dạng đến từ ba nguồn thật:
 * - `bigint` — dạng native của domain;
 * - `number` nguyên an toàn — giá trị JSON/`int` column;
 * - chuỗi chỉ gồm chữ số — `numeric`/`bigint` column thường trả về dạng này
 *   (persistence của snapshot cần đọc lại được, §6).
 *
 * Từ chối mọi thứ khác, kể cả chuỗi có dấu, phần thập phân hay exponent: "1e6"
 * và "1.5" là biểu diễn của một số mà domain chưa từng chốt cách parse, nên nhận
 * chúng là âm thầm định nghĩa một quy tắc chuyển đổi đơn vị.
 */
export function readNonNegativeInteger(value: unknown): bigint | null {
  if (typeof value === 'bigint') {
    return value >= 0n && value <= MAX_FIXED_POINT_MAGNITUDE ? value : null;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      return null;
    }
    const parsed = BigInt(value);
    return parsed <= MAX_FIXED_POINT_MAGNITUDE ? parsed : null;
  }
  if (typeof value === 'string' && /^[0-9]+$/u.test(value)) {
    const parsed = BigInt(value);
    return parsed <= MAX_FIXED_POINT_MAGNITUDE ? parsed : null;
  }
  return null;
}

/**
 * Lỗi nội bộ khi một phép tính vượt biên độ biểu diễn.
 *
 * Không export qua `src/index.ts`: consumer chỉ thấy `amount_overflow` trong
 * result. Class riêng (thay vì trả `PricingResult` từ từng phép nhân) giữ phép
 * tính đọc được như số học thường, và biến mọi nhánh tràn thành một điểm bắt
 * duy nhất ở biên operation.
 */
export class FixedPointOverflow extends Error {
  constructor() {
    super('Fixed-point arithmetic exceeded the supported magnitude.');
    this.name = 'FixedPointOverflow';
  }
}

function assertWithinMagnitude(value: bigint): bigint {
  if (value > MAX_FIXED_POINT_MAGNITUDE) {
    throw new FixedPointOverflow();
  }
  return value;
}

/** Nhân hai số nguyên không âm, kiểm biên độ. */
export function checkedMultiply(left: bigint, right: bigint): bigint {
  return assertWithinMagnitude(left * right);
}

/** Cộng hai số nguyên không âm, kiểm biên độ. */
export function checkedAdd(left: bigint, right: bigint): bigint {
  return assertWithinMagnitude(left + right);
}

/** `10^exponent` dưới dạng `bigint`. */
export function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/**
 * Chuyển một giá trị từ `fromScale` sang `toScale`.
 *
 * - `toScale > fromScale`: nhân thêm lũy thừa 10 — chính xác tuyệt đối.
 * - `toScale === fromScale`: trả nguyên giá trị, không làm tròn.
 * - `toScale < fromScale`: chia và làm tròn **một lần** theo `rounding` — đây là
 *   điểm làm tròn duy nhất của toàn bộ phép tính giá.
 */
export function rescaleFixedPoint(
  value: bigint,
  fromScale: number,
  toScale: number,
  rounding: RoundingRule,
): bigint {
  if (toScale === fromScale) {
    return value;
  }
  if (toScale > fromScale) {
    return checkedMultiply(value, powerOfTen(toScale - fromScale));
  }
  return divideWithRounding(value, powerOfTen(fromScale - toScale), rounding);
}

/**
 * Chia số nguyên không âm theo quy tắc làm tròn. Chỉ nhận `dividend >= 0` và
 * `divisor > 0`, nên `floor` và `ceil` không cần nhánh dấu.
 */
function divideWithRounding(dividend: bigint, divisor: bigint, rounding: RoundingRule): bigint {
  const quotient = dividend / divisor;
  const remainder = dividend % divisor;
  if (remainder === 0n) {
    return quotient;
  }
  switch (rounding) {
    case 'floor':
      return quotient;
    case 'ceil':
      return quotient + 1n;
    case 'half_up':
      return remainder * 2n >= divisor ? quotient + 1n : quotient;
    case 'half_even': {
      const doubled = remainder * 2n;
      if (doubled > divisor) {
        return quotient + 1n;
      }
      if (doubled < divisor) {
        return quotient;
      }
      return quotient % 2n === 0n ? quotient : quotient + 1n;
    }
  }
}
