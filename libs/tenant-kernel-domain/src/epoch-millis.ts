/**
 * Thời gian do caller truyền vào: epoch millis kiểu number. Kernel không đọc
 * đồng hồ, không parse RFC 3339, không sinh số ngẫu nhiên.
 */

/**
 * Kiểm tra giá trị có phải epoch millis hợp lệ: số nguyên an toàn
 * (Number.isSafeInteger). Từ chối NaN, Infinity, -Infinity, số lẻ, chuỗi,
 * null và undefined. Không ném.
 */
export function isEpochMillis(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}
