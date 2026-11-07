/**
 * Currency code của một pricing schedule.
 *
 * Domain chỉ kiểm **hình dạng** mã ISO 4217 (ba chữ cái in hoa), không giữ danh
 * sách currency và không hard-code đồng tiền nào. Một danh sách trong domain sẽ
 * là quyết định nghiệp vụ mà canonical docs không đặt ra, và sẽ âm thầm chặn
 * một currency hợp lệ khi seller thêm offer mới.
 *
 * Pricing **không** chuyển đổi currency: schedule và snapshot mang đúng một
 * currency, mọi phép tính trong một snapshot dùng chung currency đó
 * (`docs/domains/llm-seller-pricing/domain-model.md` §7).
 */

/**
 * Hình dạng mã currency — chỉ là guard cấu trúc, không phải danh sách hợp lệ.
 *
 * Cờ `u` bắt buộc: `.oxlintrc.json` bật `require-unicode-regexp` cho mọi regex.
 */
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/u;

/** Kiểm một giá trị là mã currency đúng hình dạng. */
export function isCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY_CODE_PATTERN.test(value);
}
