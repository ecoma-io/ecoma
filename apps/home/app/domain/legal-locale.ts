/**
 * Strict parse cho bề mặt legal của Home: một pathname chỉ hợp lệ về
 * **topology** khi nó là `/<locale>/legal/<slug>` (hoặc landing
 * `/<locale>/legal`).
 *
 * Cùng cấu trúc với `parseBlogRoute`: seam dùng chung giữa
 * `definePageMeta({ validate })` và phần render — một nguồn duy nhất cho luật
 * "đâu là trang legal". Không tự phân tích locale: toàn bộ luật cấu trúc
 * (`?`/`#`, `//`, trailing slash, so khớp locale exact từng byte) thuộc
 * `parsePublicPath` của `app/i18n`, mount matching thuộc
 * `parsePublicLayoutPath` của `app/layout`; phần thêm của app chỉ là khớp
 * segment `legal`.
 *
 * Slug **không** được validate theo tập slug tại đây: với content Markdown,
 * "slug nào tồn tại" là câu hỏi của content query, không của registry tĩnh.
 * Topology valid + content query trống → route tự 404 (production: middleware
 * gate chặn trước bằng manifest, không bao giờ tới đây).
 *
 * Không decode, không lowercase, không repair: `/%6Cegal`, `/Legal`,
 * `/en/legal/` (trailing slash) bị từ chối.
 */

import type { PublicLocale } from '../i18n/index';
import { parsePublicLayoutPath } from '../layout/index';

/** Pathname đã được xác nhận thuộc bề mặt legal. */
export type LegalRouteLayout = {
  /** Locale đã validate trong registry. */
  readonly locale: PublicLocale;
  /** Public path đầy đủ của pathname (không trailing slash). */
  readonly path: string;
  /** Phần sau `<locale>/legal` — `''` khi ở landing. */
  readonly remainder: string;
};

/**
 * Phân loại một pathname thành layout legal, hoặc `null` nếu không thuộc.
 *
 * Legal là **danh sách phẳng các văn bản** — đúng một segment slug sau mount,
 * khác docs (tree nhiều segment) và blog (route catch-all): `/en/legal/a/b`
 * không phải URL legal, từ chối tại đây thay vì để content query trả `null`
 * rồi 404 muộn. `null` được dùng thay vì throw vì đây là câu hỏi "route này
 * có phục vụ pathname đó không" — câu trả lời phủ định là luồng bình thường.
 */
export function parseLegalRoute(pathname: string): LegalRouteLayout | null {
  const layout = parsePublicLayoutPath(pathname);
  if (layout.kind !== 'localized' || layout.mount !== 'legal') {
    return null;
  }
  // remainder rỗng (landing) hoặc đúng một segment slug — không có gì sâu hơn.
  if (layout.remainder !== '' && !/^\/[^/]+$/u.test(layout.remainder)) {
    return null;
  }
  return { locale: layout.locale, path: layout.path, remainder: layout.remainder };
}

/** Đúng khi pathname thuộc legal — dùng trực tiếp cho `definePageMeta.validate`. */
export function isLegalRoute(pathname: string): boolean {
  return parseLegalRoute(pathname) !== null;
}
