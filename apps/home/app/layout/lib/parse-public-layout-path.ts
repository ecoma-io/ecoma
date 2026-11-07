/**
 * `parsePublicLayoutPath` — đọc một public pathname và phân loại theo
 * topology: `root` / `locale-root` / `localized` / `invalid`.
 *
 * Phân tầng parsing (không duplicate parser của `app/i18n`):
 *
 * ```text
 * pathname → parsePublicPath()  → locale + remainder
 *          → (phần này)         → mount  + resource remainder
 * ```
 *
 * Toàn bộ kiểm tra cấu trúc (`?`/`#`, `//`, trailing slash, so khớp locale
 * chính xác từng byte) thuộc `parsePublicPath`; thư viện này chỉ match mount
 * trên remainder đã được kiểm chứng, nên không có đường "sửa giúp" input hỏng.
 */

import { parsePublicPath } from '../../i18n/index';
import { PUBLIC_MOUNTS } from './mount-registry';
import { invalidLayoutPath, type PublicLayoutPathResult } from './public-layout-path';

/**
 * Phân loại pathname theo đúng một thứ tự precedence (match đầu tiên thắng):
 *
 * 1. `parsePublicPath` trả `root` → `root` (`/` là parse state riêng);
 * 2. `parsePublicPath` trả `invalid` → pass-through typed reason nguyên vẹn;
 * 3. remainder rỗng (`/en`) → `locale-root` — bề mặt root public, không mount;
 * 4. remainder khớp một mount theo **full segment boundary**, deepest-first
 *    → `localized` với `remainder` là phần sau mount (có thể `''`);
 * 5. không khớp mount nào → `invalid` với `unknown_mount`.
 *
 * Mount matching không decode, không lowercase: `/en/blog%2Ffoo` (còn nguyên
 * `%2F`) không khớp mount `blog` — canonical URL của resource đó là
 * `/en/blog/foo` với slash thô. `/en/blogging` không bao giờ rơi vào `blog`;
 * `/en/docs/api` resolve `docs/api` trước `docs`.
 *
 * Resource path **sau mount là opaque**: `/en/docs/unknown` là `docs` +
 * `/unknown` hợp lệ — app sở hữu resource đó quyết định 404.
 *
 * Không bao giờ throw, kể cả khi input không phải string (guard runtime của
 * `parsePublicPath` trả `not_a_pathname`).
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

  // PUBLIC_MOUNTS đã sắp deepest-first — thử mount dài trước để mount lồng
  // nhau thắng mount cha.
  for (const definition of PUBLIC_MOUNTS) {
    const mountPrefix = `/${definition.path}`;
    if (parsed.remainder === mountPrefix) {
      return {
        kind: 'localized',
        locale: parsed.locale,
        mount: definition.path,
        path: parsed.path,
        remainder: '',
      };
    }
    if (parsed.remainder.startsWith(`${mountPrefix}/`)) {
      return {
        kind: 'localized',
        locale: parsed.locale,
        mount: definition.path,
        path: parsed.path,
        remainder: parsed.remainder.slice(mountPrefix.length),
      };
    }
  }

  return invalidLayoutPath('unknown_mount');
}
