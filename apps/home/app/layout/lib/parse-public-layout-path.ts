/**
 * `parsePublicLayoutPath` — đọc một public pathname và phân loại theo
 * topology: `root` / `locale-root` / `invalid`.
 *
 * Phân tầng parsing (không duplicate parser của `app/i18n`):
 *
 * ```text
 * pathname → parsePublicPath()  → locale + remainder
 *          → (phần này)         → phân loại bề mặt
 * ```
 *
 * Toàn bộ kiểm tra cấu trúc (`?`/`#`, `//`, trailing slash, so khớp locale
 * chính xác từng byte) thuộc `parsePublicPath`; thư viện này chỉ phân loại
 * trên remainder đã được kiểm chứng, nên không có đường "sửa giúp" input hỏng.
 */

import { parsePublicPath } from '../../i18n/index';
import { invalidLayoutPath, type PublicLayoutPathResult } from './public-layout-path';

/**
 * Phân loại pathname theo đúng một thứ tự precedence (match đầu tiên thắng):
 *
 * 1. `parsePublicPath` trả `root` → `root` (`/` là parse state riêng);
 * 2. `parsePublicPath` trả `invalid` → pass-through typed reason nguyên vẹn;
 * 3. remainder rỗng (`/en`) → `locale-root` — bề mặt nội dung public duy nhất;
 * 4. remainder khác rỗng → `invalid` với `unknown_mount` — mọi bề mặt mounted
 *    (docs, blog, legal) đã bị xoá cùng stack @nuxt/content (issue #72); URL
 *    cũ nhận 404 qua validate thay vì còn bề mặt phục vụ.
 *
 * Không decode, không lowercase: `/en/docs%2Ffoo` không được "sửa giúp" thành
 * URL hợp lệ nào — nó vẫn là invalid. Không bao giờ throw, kể cả khi input
 * không phải string (guard runtime của `parsePublicPath` trả `not_a_pathname`).
 */
export function parsePublicLayoutPath(pathname: string): PublicLayoutPathResult {
  const parsed = parsePublicPath(pathname);

  if (parsed.kind === 'root') {
    return { kind: 'root', path: '/' };
  }

  if (parsed.kind === 'invalid') {
    return invalidLayoutPath(parsed.reason);
  }

  if (parsed.remainder === '') {
    return { kind: 'locale-root', locale: parsed.locale, path: parsed.path };
  }

  return invalidLayoutPath('unknown_mount');
}
