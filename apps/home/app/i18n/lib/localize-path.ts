/**
 * `localizePath` — dựng public path cho một pathname **chưa** có locale.
 *
 * Input là **root-relative resource pathname chưa localise** — không phải
 * public localized pathname, cũng không phải URL normalizer chung: `/fr/blog`,
 * `/enabled` là resource hợp lệ và được nhận nguyên văn. Đây là hàm dựng
 * (builder), không phải re-localizer: input đã mang locale bị từ chối bằng
 * `already_localized`, nên `localizePath('vi', '/en/blog')` không bao giờ sinh
 * ra `/vi/en/blog`. Muốn đổi locale của pathname đã localized thì dùng
 * `switchLocale`.
 */

import { isPublicLocale, type PublicLocale } from './locale-registry';
import {
  hasPathnameShape,
  invalidPath,
  localizedPath,
  splitFirstSegment,
  type PublicPathResult,
} from './public-path';

/**
 * Trả về public path đầy đủ `/<locale><pathname>` dưới dạng `localized`
 * (`path` là kết quả đầy đủ, `remainder` là pathname verbatim), hoặc `invalid`.
 *
 * Input contract: pathname **chưa** có locale (root-relative resource path).
 * `/fr/blog`, `/enabled` là resource hợp lệ và được localise bình thường —
 * chỉ đúng một supported locale ở segment đầu tiên mới tính là "đã localise".
 *
 * Thứ tự kiểm tra (precedence, match đầu tiên thắng) — cấu trúc trước, locale
 * sau, đúng thứ tự của `parsePublicPath`:
 *
 * 1. `locale` đích không có trong registry (`unsupported_locale`) — guard runtime
 *    cho cả caller đi qua cast;
 * 2. không có cấu trúc pathname (`not_a_pathname`);
 * 3. đúng `/` → `/<locale>` (root là entry point hợp lệ để localise);
 * 4. đoạn rỗng `//` (`empty_segment`);
 * 5. trailing slash (`trailing_slash`) — không bao giờ strip, chỉ từ chối;
 * 6. segment đầu tiên là supported locale (`already_localized`) — chống
 *    double-localize.
 *
 * Kiểm tra cấu trúc trước khi phân loại locale nên input hỏng không bao giờ
 * bị gắn nhãn `already_localized`: `/en//blog` → `empty_segment`,
 * `/en/` → `trailing_slash`, còn `/en/blog` mới là `already_localized`.
 *
 * Mọi thành công đều ghép qua `localizedPath(locale, pathname)` — pathname giữ
 * nguyên từng byte (không decode, không lowercase, không trim).
 */
export function localizePath(locale: PublicLocale, pathname: string): PublicPathResult {
  if (!isPublicLocale(locale)) {
    return invalidPath('unsupported_locale');
  }

  if (!hasPathnameShape(pathname)) {
    return invalidPath('not_a_pathname');
  }

  if (pathname === '/') {
    return localizedPath(locale, '');
  }

  if (pathname.includes('//')) {
    return invalidPath('empty_segment');
  }

  if (pathname.endsWith('/')) {
    return invalidPath('trailing_slash');
  }

  const { segment } = splitFirstSegment(pathname);
  if (isPublicLocale(segment)) {
    return invalidPath('already_localized');
  }

  return localizedPath(locale, pathname);
}
