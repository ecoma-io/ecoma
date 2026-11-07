/**
 * Strict parse cho bề mặt Home: một pathname **chỉ** hợp lệ khi nó là
 * locale-root của Home (`/en`, `/vi`) — locale hợp lệ, **không** remainder.
 *
 * Đây là seam dùng chung giữa `definePageMeta({ validate })` (chặn route) và
 * phần render (lấy locale + content): một nguồn duy nhất cho luật "đâu là
 * Home locale-root", nên hai chỗ không thể lệch nhau.
 *
 * Không tự phân tích locale: toàn bộ luật cấu trúc (`?`/`#`, `//`, trailing
 * slash, so khớp locale **exact từng byte**) thuộc `parsePublicPath` của
 * `app/i18n`. Vì hàm đó không decode, không lowercase, không repair, nên
 * `/%65n`, `/EN`, `/en/`, `/en/foo`, `/` đều trả `undefined` — đúng hợp đồng
 * strict canonicality mà không cần thêm bảng locale thứ hai.
 *
 * Hàm **pure** (không Nuxt, không Vue, không I/O) nên test được trực tiếp,
 * không cần dựng runtime Nuxt.
 */

import { parsePublicPath, type PublicLocale } from '../i18n/index';

/**
 * Trả về locale khi `pathname` là locale-root của Home, ngược lại `undefined`.
 *
 * Chỉ nhận `kind === 'localized'` với `remainder === ''`: `root` (`/`),
 * `invalid` (mọi lý do) và mọi pathname có resource phía sau locale đều bị
 * từ chối. Locale trả về do chính parser quyết định, không suy từ
 * `route.params` — tham số route là dữ liệu đã decode, không phải nguồn
 * chân lý của URL.
 */
export function parseHomeLocaleRoot(pathname: string): PublicLocale | undefined {
  const parsed = parsePublicPath(pathname);
  if (parsed.kind !== 'localized') {
    return undefined;
  }
  if (parsed.remainder !== '') {
    return undefined;
  }
  return parsed.locale;
}
