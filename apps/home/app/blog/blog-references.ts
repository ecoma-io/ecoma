/**
 * Resolve reference biên tập (`articleId`) thành URL thật của một locale —
 * logic thuần của prerequisite/related-link, tách khỏi route để test được mọi
 * nhánh fallback mà không cần dựng Nuxt runtime.
 *
 * Bất biến được pin ở đây:
 *
 * - **Không bao giờ sinh URL 404**: tham chiếu tới `articleId` không tồn tại
 *   trong content published **bị bỏ**, không render link chết. Đây là khác
 *   biệt cốt lõi với link theo slug trong Markdown: slug chết là lỗi tác giả
 *   mà build không nhìn ra (bắt ở contract test); còn reference theo ID được
 *   resolve qua bảng ánh xạ thật từ DB, nên "không có trong bảng" là tín hiệu
 *   đúng để ẩn link.
 * - **Fallback về English là policy hiển thị, không phải implicit**: khi bản
 *   dịch locale hiện tại không có, reference resolve về URL **của bản English
 *   gốc** — người đọc vi vẫn đến được bài, URL luôn là URL thật đã prerender
 *   (không link hỏng, không redirect loop). Trang fallback `/vi/blog` đã
 *   khai báo rõ bài đang là tiếng Anh nên không làm người đọc bất ngờ.
 * - **Reference theo identity, không theo URL**: bảng ánh xạ dựng từ cặp
 *   (`articleId` → path theo từng locale) query từ DB; đổi slug không phá
 *   reference, hai locale cùng `articleId` tự trỏ nhau.
 * - **Nhãn link là title của bài, lấy từ content**: một link mà nhãn là URL
 *   thô (`/en/blog/attention-from-vectors-to-probabilities`) là link của
 *   kỹ thuật, không phải của một bài đọc dành cho người đọc. Title đi cùng
 *   path trong **một** lần tra identity, nên nhãn không thể lệch khỏi đích.
 */

import type { PublicLocale } from '../i18n/index';

/** Một entry của bảng ánh xạ identity — `articleId` tồn tại ở một locale cụ thể dưới path cụ thể. */
export type ArticleIdentityRecord = {
  readonly articleId: string;
  readonly locale: PublicLocale;
  readonly path: string;
  /**
   * Title hiển thị của bài ở locale của entry này — nguồn **duy nhất** của
   * link label.
   *
   * Bắt buộc, không phải tuỳ chọn: nhãn link phải là tiêu đề bài, và tiêu đề
   * chỉ tồn tại ở content. Suy ra title từ slug (`8.tokenization-…` →
   * "Tokenization …") là đoán — nó sai với mọi title biên tập lệch slug, và
   * lệch im lặng. `''` nghĩa là document không có title dùng được; xem
   * `resolveReferences` để biết xử lý.
   */
  readonly title: string;
};

/**
 * URL đích của một reference đã resolve, kèm tín hiệu nguồn để test/UI pin
 * hành vi fallback.
 */
export type ResolvedReference =
  | { readonly kind: 'same-locale'; readonly path: string; readonly title: string }
  | { readonly kind: 'english-fallback'; readonly path: string; readonly title: string }
  | { readonly kind: 'missing' };

/** Một reference đã resolve đủ để render một link có nhãn đúng. */
export type RenderableReference = {
  /** URL public thật của bài được trỏ tới (đã prerender). */
  readonly path: string;
  /** Title hiển thị của link — lấy từ content, không suy từ slug. */
  readonly title: string;
  /**
   * Đích đang là bản **English** trong khi trang hiện tại không phải English.
   *
   * Đây là tín hiệu **hiển thị**, không phải suy luận từ locale: nó được đặt
   * bởi nhánh `english-fallback` của `resolveArticleReference` (`kind`), tức
   * là "bản dịch locale hiện tại không có, ta trỏ sang bản gốc". View dùng nó
   * để gắn nhãn "bài này viết bằng tiếng Anh" — người đọc `/vi/...` không bị
   * dẫn tới một trang tiếng Anh mà không có tín hiệu nào.
   */
  readonly isEnglishFallback: boolean;
};

/**
 * Resolve một `articleId` sang URL và title hiển thị cho locale `locale`.
 *
 * Thứ tự ưu tiên: bản dịch cùng locale → bản English (fallback policy) →
 * không resolve được (`missing` — caller bỏ link). English được dùng làm
 * fallback cho cả locale EN (identity EN lookup trùng nhánh same-locale vì
 * bản EN luôn khớp chính nó).
 *
 * `title` đi cùng kết quả chứ không phải tra sau ở consumer: cùng một lần
 * tra cứu identity đã biết bài nào được trỏ tới, lấy title ở đó rẻ hơn và
 * không thể lệch — hai nơi tra cùng bảng bằng hai tiêu chí khác nhau là cách
 * một link render ra title của bài khác.
 */
export function resolveArticleReference(
  records: readonly ArticleIdentityRecord[],
  articleId: string,
  locale: PublicLocale,
): ResolvedReference {
  const sameLocale = records.find(
    (record) => record.articleId === articleId && record.locale === locale,
  );
  if (sameLocale !== undefined) {
    return { kind: 'same-locale', path: sameLocale.path, title: sameLocale.title };
  }
  const english = records.find(
    (record) => record.articleId === articleId && record.locale === 'en',
  );
  if (english !== undefined) {
    return { kind: 'english-fallback', path: english.path, title: english.title };
  }
  return { kind: 'missing' };
}

/**
 * Resolve một danh sách `articleId` thành danh sách reference **render được**
 * (path + title), bỏ các ID không tồn tại — "tham chiếu hỏng không render link
 * chết".
 *
 * Ba quy tắc giữ nguyên từ `resolveReferencePaths`, áp cho shape giàu hơn:
 *
 * - **Bỏ ID không tồn tại**: `missing` không mang path nên caller không sinh
 *   link; đây là khác biệt cốt lõi với link theo slug trong Markdown.
 * - **Dedupe theo path**: hai ID resolve cùng một URL (dữ liệu sai trỏ trùng)
 *   không nhân bản link trong UI.
 * - **Giữ thứ tự input**: thứ tự khai `prerequisites` là ý định biên tập.
 *
 * Một entry có **title rỗng** cũng bị loại, cùng lý do: link không nhãn hiện
 * dạng URL thô — đúng thứ `BlogArticleView` phải tránh. `title` rỗng chỉ xảy
 * ra với document hỏng, nên việc bỏ link là hành vi an toàn hơn là render một
 * nhãn rỗng cho người đọc.
 */
export function resolveReferences(
  records: readonly ArticleIdentityRecord[],
  articleIds: readonly string[],
  locale: PublicLocale,
): RenderableReference[] {
  const references: RenderableReference[] = [];
  for (const id of articleIds) {
    const resolved = resolveArticleReference(records, id, locale);
    if (resolved.kind === 'missing' || resolved.title.trim() === '') {
      continue;
    }
    const path = resolved.path;
    if (references.some((reference) => reference.path === path)) {
      continue;
    }
    references.push({
      path,
      title: resolved.title.trim(),
      isEnglishFallback: resolved.kind === 'english-fallback',
    });
  }
  return references;
}

/**
 * Chuẩn hóa danh sách reference ID thô từ DB: trim, loại rỗng, dedupe — cùng
 * pattern với `articleDisplayTags` (schema `z.array(z.string())` không ràng
 * buộc unique; caller nhận danh sách đã sạch để không bị duplicate link).
 *
 * `null` được đối xử như `undefined`: sqlite trả `NULL` thành `null` runtime
 * cho cột optional (khai báo `optional()` trong zod là kiểu type-level, không
 * rewrite giá trị DB), nên hàm phải tự bình thường hóa cả hai — gọi `.map` trên
 * `null` là crash cả trang, và crash này từng biến mất toàn bộ article khỏi
 * prerender (landing rơi nhánh rỗng, crawler hết link để đi).
 */
export function normalizeReferenceIds(
  ids: readonly string[] | null | undefined,
): readonly string[] {
  if (ids === null || ids === undefined) {
    return [];
  }
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id !== ''))];
}
