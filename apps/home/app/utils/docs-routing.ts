/**
 * Nhận diện pathname thuộc bề mặt docs — tách khỏi route để test được ma trận
 * hợp lệ/không hợp lệ mà không cần dựng Nuxt runtime.
 *
 * Route chỉ có một file (`pages/[locale]/docs/[[...slug]].vue`) nhưng
 * `validate` của Nuxt nhận **pathname thật** (`route.path`), không phải params
 * của router. Vì vậy điều kiện "pathname này có thuộc docs không" được biểu
 * diễn một lần ở đây, dùng đúng `parsePublicLayoutPath` của `app/layout` —
 * không tự parse chuỗi, không tự so segment.
 *
 * Chỉ `kind === 'localized' && mount === 'docs'` được nhận:
 *
 * - `/en/docs`, `/vi/docs`, `/en/docs/getting-started`, `/vi/docs/foo/bar` —
 *   hợp lệ;
 * - `/fr/docs`, `/EN/docs`, `/en/docs/`, `/en/blog` — `parsePublicLayoutPath`
 *   từ chối cấu trúc/locale/mount nên trả `null`;
 * - `/en/docs/api`, `/en/docs/api/foo` — resolve thành mount `docs/api` (mount
 *   deepest-first) nên cũng trả `null`: docs không bao giờ chiếm boundary của
 *   `api-reference`;
 * - `/en/docs/unknown` — **hợp lệ về topology** (resource path sau mount là
 *   opaque), route chạy tiếp rồi 404 vì content không tồn tại.
 */

import type { PublicLocale } from '../i18n/index';
import { parsePublicLayoutPath } from '../layout/index';

/** Pathname đã được xác nhận thuộc bề mặt docs. */
export type DocsRouteLayout = {
  /** Locale đã validate trong registry. */
  readonly locale: PublicLocale;
  /** Public path đầy đủ của pathname (không trailing slash). */
  readonly path: string;
  /** Phần sau `<locale>/docs` — `''` khi ở docs landing. */
  readonly remainder: string;
};

/**
 * Phân loại một pathname thành layout docs, hoặc `null` nếu không thuộc docs.
 *
 * `null` được dùng thay vì throw vì đây là câu hỏi "route này có phục vụ
 * pathname đó không" — câu trả lời phủ định là luồng bình thường (Nuxt sẽ thử
 * route khác rồi 404), không phải lỗi.
 */
export function parseDocsRoute(pathname: string): DocsRouteLayout | null {
  const layout = parsePublicLayoutPath(pathname);
  if (layout.kind !== 'localized' || layout.mount !== 'docs') {
    return null;
  }
  return { locale: layout.locale, path: layout.path, remainder: layout.remainder };
}

/**
 * Đúng khi pathname thuộc docs — dùng trực tiếp cho `definePageMeta.validate`.
 *
 * Tách khỏi `parseDocsRoute` để `validate` không phải tự so `kind`/`mount`, và
 * để test khẳng định đúng biểu thức mà route dùng.
 */
export function isDocsRoute(pathname: string): boolean {
  return parseDocsRoute(pathname) !== null;
}
