/**
 * `switchLocale` — đổi segment locale đầu tiên của một pathname đã localized,
 * giữ nguyên phần resource.
 *
 * Chỉ `switchLocale` được nhận pathname đã có locale; nó là operation duy nhất
 * được phép thay thế locale. `unsupported_locale` trong hàm này **chỉ** nghĩa
 * là locale đích không có trong registry; source không mang locale (root `/`
 * hoặc segment đầu tiên không phải locale supported) trả `not_localized` —
 * hai lý do khác nhau, hai action khác nhau phía caller. Root `/` không bao
 * giờ biến thành `/vi` (`/` là locale-resolution entry point, policy resolve
 * thuộc về caller).
 */

import { isPublicLocale, type PublicLocale } from './locale-registry';
import { invalidPath, localizedPath, type PublicPathResult } from './public-path';
import { parsePublicPath } from './parse-public-path';

/**
 * Trả về public path với locale đã thay, remainder giữ nguyên từng byte.
 *
 * Thứ tự kiểm tra:
 *
 * 1. `locale` đích không có trong registry → `unsupported_locale` — kiểm tra
 *    target trước để lý do về locale **đích** không bao giờ bị che bởi lỗi của
 *    source;
 * 2. `parsePublicPath(pathname)`:
 *    - source là `root` → `not_localized` (đúng `/` không mang locale để đổi);
 *    - source là `invalid/unsupported_locale` (segment đầu không phải locale
 *      supported) → `not_localized` (source không mang locale để đổi — không
 *      dùng `unsupported_locale` cho source);
 *    - các lý do cấu trúc (`not_a_pathname`, `trailing_slash`, `empty_segment`)
 *      được trả nguyên vẹn (không có đường "sửa giúp" input hỏng);
 * 3. nguồn là `localized` → `'/' + locale + remainder`.
 *
 * Cùng locale là idempotent (kết quả bằng input); không bao giờ throw.
 */
export function switchLocale(pathname: string, locale: PublicLocale): PublicPathResult {
  if (!isPublicLocale(locale)) {
    return invalidPath('unsupported_locale');
  }

  const parsed = parsePublicPath(pathname);

  if (parsed.kind === 'root') {
    return invalidPath('not_localized');
  }

  if (parsed.kind === 'invalid') {
    return parsed.reason === 'unsupported_locale' ? invalidPath('not_localized') : parsed;
  }

  return localizedPath(locale, parsed.remainder);
}
