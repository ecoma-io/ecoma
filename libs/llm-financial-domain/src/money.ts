/**
 * Tiền tệ của `llm-financial`: denomination domain + số học fixed-point trên
 * `bigint`.
 *
 * Hai quyết định nền, đều lấy từ ADR-0004:
 *
 * - **Đơn vị biểu diễn**: số nguyên `bigint` theo đơn vị nhỏ nhất. Không dùng
 *   `number` cho tiền: IEEE-754 mất chính xác ngay trên 2^53 và mọi phép chia
 *   làm tròn theo nhị phân, nên hai ledger cùng "đúng kiểu" vẫn lệch nhau.
 * - **Denomination domain**: UC và EC là hai **miền giá trị khác nhau**, không
 *   phải hai currency của cùng một miền. Cộng UC với EC không có nghĩa, nên phép
 *   cộng/trừ trả `denomination_mismatch` thay vì cộng số học. Chuyển đổi giữa
 *   hai miền chỉ xảy ra qua một conversion command tường minh (ADR-0005), không
 *   qua phép cộng.
 *
 * Denomination luôn là VND theo ADR-0004; đây là **đơn vị ledger nội bộ**, không
 * phải tiền fiat đã disbursed.
 */

import { financialFailure, financialOk, type FinancialResult } from './shared';

/**
 * Denomination domain của wallet và ledger.
 *
 * - `UC` — Usage Credits, thuộc Console tenant.
 * - `EC` — Earnings Credits, thuộc Seller tenant.
 */
export const DENOMINATIONS = ['UC', 'EC'] as const;

/** Một denomination domain. */
export type Denomination = (typeof DENOMINATIONS)[number];

/** Type guard cho `Denomination`. */
export function isDenomination(value: unknown): value is Denomination {
  return typeof value === 'string' && (DENOMINATIONS as readonly string[]).includes(value);
}

/**
 * Đơn vị ledger của mọi denomination — VND theo ADR-0004.
 *
 * Hai denomination domain chia sẻ cùng đơn vị ledger nhưng **không** chia sẻ
 * miền giá trị: 1 UC và 1 EC không phải cùng một thứ có thể cộng.
 */
export const LEDGER_UNIT = 'VND' as const;

/**
 * Trần biên độ của một giá trị tiền: `10^30 - 1`.
 *
 * `bigint` không tự tràn, nên "overflow" ở đây là **biên độ biểu diễn mà domain
 * chấp nhận**. Vượt biên độ nghĩa là input đã sai đơn vị (minor units bị nhân
 * nhầm, hoặc một con số bịa), và cộng dồn tiếp chỉ tạo ra số vô nghĩa nhưng vẫn
 * "đúng kiểu" — đúng loại hỏng âm thầm cần chặn.
 */
export const MAX_MONEY_MAGNITUDE = 10n ** 30n - 1n;

/**
 * Số tiền đã validate trong một denomination domain.
 *
 * Bất biến: `minor >= 0` và `minor <= MAX_MONEY_MAGNITUDE`. Không có số âm trong
 * value object này — mọi phép trừ phải kiểm đủ số dư trước khi dựng kết quả, nên
 * một "số dư âm" trở thành rejection thay vì một value object âm.
 */
export interface Money<D extends Denomination = Denomination> {
  readonly denomination: D;
  readonly minor: bigint;
}

/** Số tiền UC. */
export type UcAmount = Money<'UC'>;
/** Số tiền EC. */
export type EcAmount = Money<'EC'>;

/** Đọc một số nguyên không âm từ dữ liệu ngoài (JSON number, chuỗi digit, bigint). */
function readNonNegativeInteger(value: unknown): bigint | null {
  if (typeof value === 'bigint') {
    return value >= 0n && value <= MAX_MONEY_MAGNITUDE ? value : null;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      return null;
    }
    return BigInt(value) <= MAX_MONEY_MAGNITUDE ? BigInt(value) : null;
  }
  if (typeof value === 'string' && /^[0-9]+$/u.test(value)) {
    const parsed = BigInt(value);
    return parsed <= MAX_MONEY_MAGNITUDE ? parsed : null;
  }
  return null;
}

/**
 * Đọc và validate một `Money` từ dữ liệu ngoài.
 *
 * Chấp nhận `bigint`, số nguyên an toàn, hoặc chuỗi chỉ gồm chữ số (dạng
 * `numeric`/`bigint` column trả về). Từ chối số âm, phần thập phân, exponent và
 * định danh denomination ngoài vocabulary.
 */
export function readMoney(value: unknown): FinancialResult<Money> {
  if (typeof value !== 'object' || value === null) {
    return financialFailure('invalid_amount');
  }
  const candidate = value as { denomination?: unknown; minor?: unknown };
  if (!isDenomination(candidate.denomination)) {
    return financialFailure('invalid_denomination');
  }
  const minor = readNonNegativeInteger(candidate.minor);
  if (minor === null) {
    return financialFailure('invalid_amount');
  }
  return financialOk(freezeMoney({ denomination: candidate.denomination, minor }));
}

/** Freeze một `Money` (deep: chỉ có primitive + bigint nên freeze là đủ). */
function freezeMoney<D extends Denomination>(money: Money<D>): Money<D> {
  return Object.freeze(money);
}

/**
 * Dựng số tiền từ minor units. Chấp nhận `number` an toàn, `bigint` hoặc chuỗi
 * chữ số; mọi dạng khác trả `invalid_amount`.
 */
export function createMoney<D extends Denomination>(
  denomination: D,
  minor: bigint | number | string,
): FinancialResult<Money<D>> {
  if (!isDenomination(denomination)) {
    return financialFailure('invalid_denomination');
  }
  const parsed = readNonNegativeInteger(minor);
  if (parsed === null) {
    // Phân biệt "sai định dạng" với "vượt biên độ": caller cần biết đây là
    // overflow thật hay chỉ là input rác, vì hai lỗi này cần xử lý khác nhau.
    if (
      (typeof minor === 'bigint' && minor > MAX_MONEY_MAGNITUDE) ||
      (typeof minor === 'string' && /^[0-9]+$/u.test(minor) && BigInt(minor) > MAX_MONEY_MAGNITUDE)
    ) {
      return financialFailure('amount_overflow');
    }
    return financialFailure('invalid_amount');
  }
  return financialOk(freezeMoney({ denomination, minor: parsed }));
}

/** Số 0 trong một denomination — giá trị khởi đầu, không phải "unknown". */
export function zeroMoney<D extends Denomination>(denomination: D): Money<D> {
  return freezeMoney({ denomination, minor: 0n });
}

/** Type guard cấu trúc cho `Money`. */
export function isMoney(value: unknown): value is Money {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { denomination?: unknown; minor?: unknown };
  return (
    isDenomination(candidate.denomination) &&
    typeof candidate.minor === 'bigint' &&
    candidate.minor >= 0n &&
    candidate.minor <= MAX_MONEY_MAGNITUDE
  );
}

/** Cộng hai số tiền cùng denomination. Khác denomination → `denomination_mismatch`. */
export function addMoney<D extends Denomination>(
  left: Money<D>,
  right: Money<D>,
): FinancialResult<Money<D>> {
  if (left.denomination !== right.denomination) {
    return financialFailure('denomination_mismatch');
  }
  const sum = left.minor + right.minor;
  if (sum > MAX_MONEY_MAGNITUDE) {
    return financialFailure('amount_overflow');
  }
  return financialOk(freezeMoney({ denomination: left.denomination, minor: sum }));
}

/**
 * Trừ hai số tiền cùng denomination.
 *
 * Kết quả âm là rejection (`insufficient_funds`), không phải một `Money` âm: số
 * dư âm không phải biểu diễn hợp lệ trong domain này (ADR-0004, trừ khi có
 * overdraft policy được cấp phép rõ ràng — policy đó không thuộc lib).
 */
export function subtractMoney<D extends Denomination>(
  left: Money<D>,
  right: Money<D>,
): FinancialResult<Money<D>> {
  if (left.denomination !== right.denomination) {
    return financialFailure('denomination_mismatch');
  }
  if (right.minor > left.minor) {
    return financialFailure('insufficient_funds');
  }
  return financialOk(
    freezeMoney({ denomination: left.denomination, minor: left.minor - right.minor }),
  );
}

/** So sánh hai số tiền cùng denomination: -1, 0, 1; khác denomination → `null`. */
export function compareMoney(left: Money, right: Money): -1 | 0 | 1 | null {
  if (left.denomination !== right.denomination) {
    return null;
  }
  if (left.minor < right.minor) {
    return -1;
  }
  return left.minor > right.minor ? 1 : 0;
}

/** Kiểm số tiền có phải zero không. */
export function isZeroMoney(money: Money): boolean {
  return money.minor === 0n;
}

/**
 * Cộng dồn một danh sách số tiền cùng denomination.
 *
 * Danh sách rỗng trả `zeroMoney` của `denomination`. Một phần tử khác
 * denomination huỷ cả phép cộng — không có chỗ nào "bỏ qua" phần tử lạ.
 */
export function sumMoney<D extends Denomination>(
  denomination: D,
  amounts: readonly Money[],
): FinancialResult<Money<D>> {
  let total = 0n;
  for (const amount of amounts) {
    if (amount.denomination !== denomination) {
      return financialFailure('denomination_mismatch');
    }
    total += amount.minor;
    if (total > MAX_MONEY_MAGNITUDE) {
      return financialFailure('amount_overflow');
    }
  }
  return financialOk(freezeMoney({ denomination, minor: total }));
}
