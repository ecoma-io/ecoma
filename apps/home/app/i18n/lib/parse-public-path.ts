/**
 * `parsePublicPath` — đọc một public pathname và phân loại thành ba state:
 * `root` / `localized` / `invalid`.
 *
 * Không normalize, không repair, không đoán locale: input không hợp lệ trả về
 * typed reason. Root `/` có nhánh riêng ngay sau kiểm tra cấu trúc — nếu để
 * nhánh này sau kiểm tra trailing-slash thì `/` sẽ bị đọc nhầm thành
 * `trailing_slash`.
 */

import {
  hasPathnameShape,
  invalidPath,
  localizedPath,
  splitFirstSegment,
  type PublicPathResult,
} from './public-path';
import { isPublicLocale } from './locale-registry';

/**
 * Phân loại pathname theo đúng một thứ tự precedence (match đầu tiên thắng):
 *
 * 1. không có cấu trúc pathname (`not_a_pathname`);
 * 2. đúng `/` (`root`);
 * 3. đoạn rỗng `//` (`empty_segment`) — kiểm tra trước trailing-slash để `//`
 *    không bao giờ bị gộp vào trailing hay coi là root;
 * 4. trailing slash (`trailing_slash`);
 * 5. segment đầu tiên là locale supported (`localized`) hay không
 *    (`unsupported_locale`) — so khớp **chính xác**, không lowercase, không
 *    decode: `/enabled`, `/en-US`, `/EN`, `/%65n` đều không phải `en`.
 */
export function parsePublicPath(pathname: string): PublicPathResult {
  if (!hasPathnameShape(pathname)) {
    return invalidPath('not_a_pathname');
  }

  if (pathname === '/') {
    return { kind: 'root', path: '/' };
  }

  if (pathname.includes('//')) {
    return invalidPath('empty_segment');
  }

  if (pathname.endsWith('/')) {
    return invalidPath('trailing_slash');
  }

  const { segment, remainder } = splitFirstSegment(pathname);
  if (!isPublicLocale(segment)) {
    return invalidPath('unsupported_locale');
  }

  return localizedPath(segment, remainder);
}
