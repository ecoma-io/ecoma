import { HOME_DEFAULT_LOCALE } from '#shared/default-locale';
import { defineEventHandler, sendRedirect } from 'h3';

/**
 * `/` — locale-resolution entry point.
 *
 * Theo `docs/architecture/01-architecture.md` (A13) `/` **không serve content**:
 * nó resolve về locale mặc định bằng một redirect **server-side** 302. Chạy
 * ở Nitro route nên redirect có mặt trong response đầu tiên — không phụ
 * thuộc client, không hydration, không layout shift, và crawler nhận được
 * 302 mà không cần execute JavaScript.
 *
 * Đích là `/en` (locale-root surface), không phải `/` và không phải một
 * mount. URL được dựng từ `HOME_DEFAULT_LOCALE` nên đổi default locale là
 * đổi một chỗ duy nhất.
 *
 * `sendRedirect(event, location, 302)` là API redirect hiện hành của h3 đang
 * cài (h3 1.15.x); 302 (temporary) đúng semantics "locale-resolution entry
 * point" — đây không phải move vĩnh viễn của resource.
 */
export default defineEventHandler((event) => {
  return sendRedirect(event, `/${HOME_DEFAULT_LOCALE}`, 302);
});
