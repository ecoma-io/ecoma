/**
 * Chuẩn hoá giá trị `timestamptz` của driver về ISO 8601 string.
 *
 * `postgres.js` đăng ký parser mặc định cho OID 1184 (`timestamptz`) là
 * `new Date(x)` (`types.js`, `date.from = [1082, 1114, 1184]`), nên kiểu khai
 * báo `Date | string` trên row chỉ đúng về mặt che hai khả năng, không phải sự
 * thật runtime. Contract wire và envelope event đòi ISO string có offset hoặc
 * `Z`; đưa `Date` thô vào payload làm validator trả `invalid_entry`
 * (issue #252).
 *
 * Mọi mapper timestamp — trong repository, route layer hay consumer khác — phải
 * đi qua helper này thay vì viết lại phép chuẩn hoá, để một thay đổi về sau
 * không lệch giữa các đường đọc.
 */
export function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Như {@link iso} nhưng giữ `null` — dùng cho cột `timestamptz` nullable. */
export function isoNullable(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  return iso(value);
}
