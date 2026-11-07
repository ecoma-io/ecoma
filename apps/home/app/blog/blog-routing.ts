/**
 * Nhận diện pathname thuộc bề mặt blog — tách khỏi route để test được ma trận
 * hợp lệ/không hợp lệ mà không cần dựng Nuxt runtime.
 *
 * Route chỉ có một file (`pages/[locale]/blog/[[...slug]].vue`) nhưng
 * `validate` của Nuxt nhận **pathname thật** (`route.path`), không phải params
 * của router. Vì vậy điều kiện "pathname này có thuộc blog không" được biểu
 * diễn một lần ở đây, dùng đúng `parsePublicLayoutPath` của `app/layout` —
 * không tự parse chuỗi, không tự so segment.
 *
 * Chỉ `kind === 'localized' && mount === 'blog'` được nhận:
 *
 * - `/en/blog`, `/vi/blog`, `/en/blog/foo`, `/vi/blog/foo/bar` — hợp lệ;
 * - `/fr/blog`, `/EN/blog`, `/en/blog/`, `/en/docs` — `parsePublicLayoutPath`
 *   từ chối cấu trúc/locale/mount nên trả `null`;
 * - `/en/blogging` — không khớp mount `blog` trên full segment boundary, cũng
 *   trả `null`;
 * - `/en/blog/unknown` — **hợp lệ về topology** (resource path sau mount là
 *   opaque), route chạy tiếp rồi 404 vì content không tồn tại.
 */

import type { PublicLocale } from '../i18n/index';
import { parsePublicLayoutPath } from '../layout/index';

/** Pathname đã được xác nhận thuộc bề mặt blog. */
export type BlogRouteLayout = {
  /** Locale đã validate trong registry. */
  readonly locale: PublicLocale;
  /** Public path đầy đủ của pathname (không trailing slash). */
  readonly path: string;
  /** Phần sau `<locale>/blog` — `''` khi ở blog landing. */
  readonly remainder: string;
};

/**
 * Phân loại một pathname thành layout blog, hoặc `null` nếu không thuộc blog.
 *
 * `null` được dùng thay vì throw vì đây là câu hỏi "route này có phục vụ
 * pathname đó không" — câu trả lời phủ định là luồng bình thường (Nuxt sẽ thử
 * route khác rồi 404), không phải lỗi.
 */
export function parseBlogRoute(pathname: string): BlogRouteLayout | null {
  const layout = parsePublicLayoutPath(pathname);
  if (layout.kind !== 'localized' || layout.mount !== 'blog') {
    return null;
  }
  return { locale: layout.locale, path: layout.path, remainder: layout.remainder };
}

/**
 * Đúng khi pathname thuộc blog — dùng trực tiếp cho `definePageMeta.validate`.
 *
 * Tách khỏi `parseBlogRoute` để `validate` không phải tự so `kind`/`mount`, và
 * để test khẳng định đúng biểu thức mà route dùng.
 */
export function isBlogRoute(pathname: string): boolean {
  return parseBlogRoute(pathname) !== null;
}
