/**
 * Thời điểm trong domain `llm-seller-pricing`.
 *
 * Mọi mốc thời gian là **epoch millis UTC** dạng `number`, do caller truyền vào.
 * Domain không đọc đồng hồ, không parse RFC 3339 — serialization và việc lấy
 * "bây giờ" thuộc tầng application
 * (`docs/domains/llm-seller-pricing/domain-model.md` §1).
 */

/**
 * Biên của `Date`: `new Date(value)` ngoài miền này là Invalid Date, và
 * `Intl.DateTimeFormat#formatToParts` ném `RangeError` khi nhận nó.
 *
 * Đây là biên của domain chứ không chỉ của thư viện chuẩn: mọi quyết định
 * peak/off-peak phải quy được về local wall-clock, nên một instant không dựng
 * được thành `Date` không thể là admission timestamp hợp lệ. Chặn tại đây biến
 * nó thành rejection thay vì âm thầm rơi vào nhánh "không phải peak".
 */
export const MAX_EPOCH_MILLIS = 8_640_000_000_000_000;

/**
 * Kiểm một giá trị là epoch millis hợp lệ.
 *
 * Dùng `Number.isSafeInteger` chứ không chỉ `Number.isFinite`: một mốc ngoài
 * miền số nguyên an toàn vẫn so sánh được nhưng đã mất chính xác, và mọi quyết
 * định `effective_from <= admission` dựa trên nó sẽ so sánh hai con số không còn
 * đúng.
 *
 * Đồng thời chặn ngoài biên `Date`: instant ngoài miền đó không quy được về
 * local wall-clock, nên không thể dùng để chọn peak/off-peak (xem
 * `MAX_EPOCH_MILLIS`). Miền âm trong biên vẫn được chấp nhận — domain không có
 * "hiện tại" để so.
 */
export function isEpochMillis(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= MAX_EPOCH_MILLIS
  );
}
