/**
 * Một nơi duy nhất hỏi "timezone này có thật không".
 *
 * ⚠️ `Intl.DateTimeFormat` **ném** `RangeError` với timezone không có trong tz
 * database — nên cách kiểm là thử dựng rồi bắt lỗi. Trước đó có hai bản sao của
 * đúng mẫu đó (`/preferences` khi validate form, `useAccountFormat` khi format),
 * và mỗi bản trả lời hơi khác nhau: trang validate timezone người dùng **đang
 * gõ**, còn formatter chỉ cần biết timezone đã lưu có dùng được không. Một hàm
 * cho cả hai giữ đúng một câu hỏi.
 *
 * Trả `false` cho chuỗi rỗng: `timeZone: ''` ném `RangeError` ở runtime nhưng
 * không phải timezone nào cả, và một chuỗi rỗng phải bị từ chối trước khi tới
 * lớp `Intl`.
 */
export function isValidTimeZone(candidate: string): boolean {
  if (candidate === '') {
    return false;
  }
  try {
    // Gán vào biến: dựng `Intl` là side effect (nó nạp tz database), nên không
    // thể viết `new Intl.DateTimeFormat(...)` như một lệnh trần — đó là cái
    // `no-new` chặn, và `no-new` đúng trong trường hợp này.
    const formatter = new Intl.DateTimeFormat('en', { timeZone: candidate });
    return typeof formatter.resolvedOptions().timeZone === 'string';
  } catch {
    return false;
  }
}
