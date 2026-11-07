/**
 * Formatting ngày hiển thị của blog — tách khỏi component để test được và để
 * một quy tắc format duy nhất dùng chung mọi view (`BlogLandingView`,
 * `BlogArticleCard`, `BlogArticleView`).
 *
 * `timeZone: 'UTC'` là bắt buộc: `date` là ISO date `YYYY-MM-DD` không mang
 * giờ, parse kèm `T00:00:00Z` neo thời điểm; không neo timezone thì SSR
 * (timezone server) và hydration (timezone máy người đọc) có thể in hai ngày
 * khác nhau cho cùng một article.
 */

/** Option chung cho mọi format ngày article — năm/tháng/ngày đầy đủ, UTC. */
const DATE_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
} as const;

/**
 * Format ngày xuất bản theo locale hiển thị.
 *
 * Ngày không parse được (frontmatter lệch schema, `date: ''` từ route fallback)
 * trả **chuỗi rỗng** thay vì in `Invalid Date` ra UI — component quyết định có
 * render `<time>` hay không, chuỗi rỗng là tín hiệu "ẩn đi".
 */
export function formatArticleDate(date: string, localeCode: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }
  return parsed.toLocaleDateString(localeCode, DATE_FORMAT_OPTIONS);
}

/**
 * Đúng khi ngày hợp lệ hiển thị được — điều kiện render `<time>` của view:
 * ngày rỗng hoặc không parse được thì meta dòng ngày biến mất, phần còn lại
 * của card vẫn render.
 *
 * Round-trip qua UTC components thay vì chỉ check `NaN`: JS Date **roll over**
 * ngày ngoài lịch (`2026-02-31` → 3/3) thay vì trả Invalid Date, nên kiểm tra
 * `NaN` một mình lọt qua ngày không tồn tại mà schema regex vẫn cho qua
 * (`^\d{4}-\d{2}-\d{2}$` chỉ khớp hình dạng).
 *
 * Hàm này là **nguồn sự thật duy nhất** cho "ngày này có thật không" — schema
 * `content.config.ts` import chính nó qua `isIsoCalendarDate`, nên định nghĩa
 * ở tầng build và ở tầng view không thể trôi lệch nhau.
 */
export function isValidArticleDate(date: string): boolean {
  return isIsoCalendarDate(date);
}

/**
 * Đúng khi `value` là ngày lịch **có thật** ở dạng ISO `YYYY-MM-DD`.
 *
 * Hợp đồng của helper này là điều kiện mà zod refine của `content.config.ts`
 * gọi cho `date`, `updatedAt` và `effectiveDate`. Nó cố ý **thuần**, không
 * phụ thuộc zod: schema và view là hai tầng khác nhau của cùng một định nghĩa,
 * và hai bản sao trôi lệch nhau là một lớp lỗi hẳn.
 *
 * Ba tầng kiểm tra, mỗi tầng bắt một lớp lỗi khác nhau:
 *
 * 1. **Hình dạng** — regex chặn chuỗi không phải ISO date. `Date` của JS parse
 *    rất nhiều thứ (`2026-9-2`, `Sep 2 2026`), và những thứ đó không thuộc hợp
 *    đồng của schema.
 * 2. **Tồn tại** — `Date.parse` trả `NaN` cho tháng/ngày vượt biên thật sự
 *    (`2026-13-01`, `2026-00-10`).
 * 3. **Roll over** — Date **không** trả `NaN` cho ngày chỉ sai về một ngày
 *    có thật (`2026-02-31` → `2026-03-03`, `2025-02-29` → `2025-03-01`). Đây
 *    chính là lớp lỗi `Date.parse` một mình không bắt: giá trị đó parse thành
 *    công, lọt vào content database, xếp sai thứ tự editorial và phát sai
 *    `datePublished` mà không có lỗi nào báo. So khớp round-trip qua UTC
 *    components là cách chặn lớp lỗi này mà không cần thư viện ngày tháng.
 *
 * Ngày nhuận đúng (`2024-02-29`) được chấp nhận, ngày nhuận sai
 * (`2025-02-29`) bị loại — quy tắc nhuận của JS Gregorian đúng, không cần khai
 * tay trong helper.
 */
export function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  const year = Number.parseInt(value.slice(0, 4), 10);
  const month = Number.parseInt(value.slice(5, 7), 10);
  const day = Number.parseInt(value.slice(8, 10), 10);
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}
