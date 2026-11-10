/**
 * `buildPublicPath` — canonical constructor cho public URL.
 *
 * Mọi public URL dựng qua hàm này; caller **không** bao giờ tự concatenate
 * `/${locale}/...`.
 *
 * Không có logic ghép path riêng: hàm ủy quyền cho `localizePath` (kiểu cấu
 * trúc, chống double-localize) của `app/i18n` rồi qua `parsePublicLayoutPath`
 * của chính thư viện này — nên với input hợp lệ, kết quả build **là đúng**
 * kết quả parse của URL vừa dựng và invariant `parse(build(x)) ≡ build(x)`
 * đúng by construction; input bị reject trả `invalid` kèm typed reason.
 */

import { isPublicLocale, localizePath } from '../../i18n/index';
import {
  invalidLayoutPath,
  type PublicLayoutPathInput,
  type PublicLayoutPathResult,
} from './public-layout-path';
import { parsePublicLayoutPath } from './parse-public-layout-path';

/**
 * Dựng public path từ `{ locale }` (locale-root) dưới dạng kết quả phân biệt
 * — không string trần, không throw.
 *
 * Thứ tự kiểm tra (precedence, match đầu tiên thắng):
 *
 * 0. `input` là `null`/`undefined` (`unsupported_locale`) — guard runtime cho
 *    JS caller; contract "không throw" áp cho mọi input class;
 * 1. `locale` không có trong registry (`unsupported_locale`) — guard runtime
 *    cho caller đi qua cast;
 * 2. qua `localizePath` rồi `parsePublicLayoutPath` để trả kết quả canonical —
 *    với input hợp lệ, kết quả build **là đúng** kết quả parse của URL vừa
 *    dựng (input bị reject trả `invalid`, không thuộc invariant này).
 *
 * `build` không bao giờ trả `root` — input luôn mang locale.
 */
export function buildPublicPath(input: PublicLayoutPathInput): PublicLayoutPathResult {
  if (input === null || input === undefined) {
    return invalidLayoutPath('unsupported_locale');
  }

  if (!isPublicLocale(input.locale)) {
    return invalidLayoutPath('unsupported_locale');
  }

  const localized = localizePath(input.locale, '/');
  if (localized.kind === 'invalid') {
    return invalidLayoutPath(localized.reason);
  }
  return parsePublicLayoutPath(localized.path);
}
