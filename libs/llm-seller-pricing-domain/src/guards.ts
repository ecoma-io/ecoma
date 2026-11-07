/**
 * Guard cấu trúc dùng chung.
 *
 * Domain nhận dữ liệu từ DB/API ở biên, nên bước đầu của mọi hàm `create*` là
 * kiểm hình dạng thay vì tin vào type annotation. `isRecord` loại cả `null` và
 * mảng — hai giá trị mà `typeof value === 'object'` vẫn cho qua.
 */

/** Kiểm một giá trị là object thường (không `null`, không mảng). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
