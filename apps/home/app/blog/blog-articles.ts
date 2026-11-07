/**
 * Logic thuần của listing blog: thứ tự article, selection featured, related và
 * pager (previous/next) — tách khỏi route/component để test được mọi bất
 * biến mà không cần dựng Nuxt runtime.
 *
 * Bất biến được pin ở đây:
 *
 * - **Locale isolation**: mọi hàm nhận một danh sách article **đã lọc theo
 *   locale** ở tầng query (`where('path', 'LIKE', '/<locale>/blog/%')`); các
 *   hàm này không bao giờ trộn article hai locale, và related/pager loại chính
 *   article hiện tại ra khỏi kết quả.
 * - **Deterministic ordering**: mới nhất trước, so `date` giảm dần; hai article
 *   cùng ngày (EN/VI cùng ngày hoặc demo data trùng ngày) được phá hoài bằng
 *   `stem` tăng dần — so theo **collation có số** (`localeCompare numeric`),
 *   nên prefix ordering (`en/blog/2.x` đứng trước `en/blog/10.x`) đúng ngay
 *   khi một locale vượt quá 9 article; `stem` là đường dẫn content ổn định và
 *   không trùng, nên sort toàn phần luôn xác định.
 * - **Featured fallback**: article featured đầu tiên theo cùng thứ tự được
 *   chọn; khi không article nào `featured === true`, bài mới nhất được dùng
 *   thay thế — landing luôn có một hero, nhưng Hero không bao giờ rỗng và
 *   không bao giờ bị suy từ dữ liệu ngoài danh sách đã lọc.
 * - **Pager theo trục thời gian**: "previous" là bài **cũ hơn** liền trước,
 *   "next" là bài **mới hơn** liền sau trong danh sách đã sort — hàm
 *   `pickAdjacentArticles` ở dưới là nguồn duy nhất của cặp này.
 */

/**
 * Cover đã chuẩn hóa của một article — cặp URL public + alt text.
 *
 * `cover` trong database đã được `nuxt-content-assets` rewrite thành URL
 * public (`/assets/...`) tại thời điểm build, nên helper này chỉ còn việc
 * chuẩn hóa cặp giá trị: cover không URL hoặc không alt thì coi như không có
 * cover — component không bao giờ render `<img>` thiếu src hay thiếu alt.
 */
export type BlogArticleCover = {
  /** URL public của ảnh cover (đã resolve), ví dụ `/assets/cover-x.svg`. */
  readonly src: string;
  /** Alt text bắt buộc — informative image không được thiếu mô tả. */
  readonly alt: string;
};

/** Dữ liệu listing tối thiểu của một article — mọi hàm thuần dưới đây chạy trên shape này. */
export type BlogArticleSummary = {
  /** Path public canonical, ví dụ `/en/blog/url-model`. */
  readonly path: string;
  /** Stem content, ví dụ `en/blog/1.url-model` — tie-break của ordering. */
  readonly stem: string;
  readonly title: string;
  readonly description: string;
  /** Ngày xuất bản, ISO `YYYY-MM-DD` — so theo chuỗi là so theo thời gian. */
  readonly date: string;
  /** Ngày sửa có thực chất — `undefined` khi bài chưa bao giờ sửa đáng kể. */
  readonly updatedAt?: string;
  readonly author: string;
  readonly tags: readonly string[];
  readonly featured: boolean;
  /** Cover đã chuẩn hóa — `undefined` khi article không có cover hợp lệ. */
  readonly cover?: BlogArticleCover;
  /** Identity biên tập ổn định — `undefined` cho bài demo không tham gia reference/series. */
  readonly articleId?: string;
  /** Series membership — khai cùng `seriesOrder` (schema refine bắt cặp này). */
  readonly seriesId?: string;
  /** Vị trí biên tập trong series — khai cùng `seriesId`. */
  readonly seriesOrder?: number;
  /** Phân loại nội dung — controlled vocabulary; demo bài không khai. */
  readonly contentType?:
    | 'theory'
    | 'research-review'
    | 'experiment'
    | 'benchmark'
    | 'interactive-demo';
  /** Độ sâu đọc — hint hiển thị, không tham gia ordering nào. */
  readonly level?: 'foundational' | 'intermediate' | 'advanced';
  /** Reference `articleId` cần đọc trước — resolve thành URL ở route, không phải URL. */
  readonly prerequisiteIds?: readonly string[];
  /** Reference `articleId` liên quan chọn tay — song song với related-by-tag. */
  readonly relatedArticleIds?: readonly string[];
  /** Reviewer metadata — chỉ render khi có tên thật (schema bắt `name` min 1). */
  readonly reviewer?: { readonly name: string; readonly title?: string };
};

/**
 * Chuẩn hóa cặp trường `cover`/`coverAlt` thô từ database thành cover hiển
 * thị được. `undefined` khi thiếu URL, thiếu alt, hoặc alt rỗng — cả ba đều
 * nghĩa là "không có cover hiển thị được", thay vì render hình hỏng.
 */
export function normalizeArticleCover(
  cover: string | undefined,
  coverAlt: string | undefined,
): BlogArticleCover | undefined {
  // Hai nhánh cùng một invariant, nên cùng chuẩn `trim()`: cover chỉ toàn
  // khoảng trắng cũng không được lọt qua làm `src="   "`.
  if (typeof cover !== 'string' || cover.trim() === '') {
    return undefined;
  }
  if (typeof coverAlt !== 'string' || coverAlt.trim() === '') {
    return undefined;
  }
  return { src: cover, alt: coverAlt };
}

/**
 * Sắp article theo thứ tự hiển thị: `date` giảm dần, tie-break `stem` tăng.
 *
 * Trả về mảng mới — không mutate input (caller có thể re-use danh sách gốc cho
 * featured query).
 */
export function orderArticlesByDateDesc(
  articles: readonly BlogArticleSummary[],
): BlogArticleSummary[] {
  return articles.toSorted((a, b) => {
    if (a.date !== b.date) {
      return a.date < b.date ? 1 : -1;
    }
    // Tie-break so `stem` theo **collation có số**: prefix ordering trong tên
    // thư mục (`2.x` trước `10.x`) là ý nghĩa editorial của prefix, so chữ
    // thuần sẽ đảo hai bài đó ngay khi một locale vượt 9 bài cùng ngày.
    return a.stem.localeCompare(b.stem, 'en', { numeric: true });
  });
}

/**
 * Chọn article featured: article `featured === true` đầu tiên theo thứ tự hiển
 * thị, hoặc fallback là bài mới nhất khi không có article nào featured.
 *
 * Trả `undefined` cho danh sách rỗng — landing không render hero khi blog
 * trống, thay vì tự chế một hero không có article.
 */
export function pickFeaturedArticle(
  articles: readonly BlogArticleSummary[],
): BlogArticleSummary | undefined {
  if (articles.length === 0) {
    return undefined;
  }
  const ordered = orderArticlesByDateDesc(articles);
  return ordered.find((article) => article.featured) ?? ordered[0];
}

/**
 * Related articles: cùng **tag đầu tiên** của article hiện tại, cùng locale
 * (danh sách input đã lọc theo locale), loại chính article hiện tại, mới nhất
 * trước, giới hạn `limit`.
 *
 * Chọn "tag đầu tiên" (`tags[0]`) làm tiêu chí **duy nhất**: thứ tự tag trong
 * frontmatter mang ý nghĩa (tag đầu là chủ đề chính). Hàm **không** fallback
 * sang tag phụ — một article chỉ chung tag phụ của article hiện tại sẽ không
 * bao giờ xuất hiện trong related, kể cả khi không có ứng viên nào chia tag
 * chính (trường hợp đó trả `[]`).
 */
export function pickRelatedArticles(
  articles: readonly BlogArticleSummary[],
  current: BlogArticleSummary,
  limit: number,
): BlogArticleSummary[] {
  // `.at(0)` thay vì `[0]`: `at` luôn mang `| undefined` trong kiểu trả về
  // bất kể cờ `noUncheckedIndexedAccess` — guard dưới đây đúng ở mọi cấu hình
  // tsconfig, không thành dead branch khi cờ tắt.
  const primaryTag = current.tags.at(0);
  if (primaryTag === undefined) {
    return [];
  }
  return orderArticlesByDateDesc(articles)
    .filter((article) => article.path !== current.path && article.tags.includes(primaryTag))
    .slice(0, limit);
}

/** Cặp điều hướng pager của article hiện tại — mỗi phía `undefined` ở biên danh sách. */
export type BlogAdjacentArticles = {
  /** Bài **cũ hơn** liền trước theo thời gian — `undefined` khi article là bài cũ nhất. */
  readonly previous: { readonly path: string; readonly title: string } | undefined;
  /** Bài **mới hơn** liền sau theo thời gian — `undefined` khi article là bài mới nhất. */
  readonly next: { readonly path: string; readonly title: string } | undefined;
};

/**
 * Cặp previous/next của article hiện tại trên **danh sách đã sort** của
 * `orderArticlesByDateDesc` (mới nhất trước).
 *
 * Ngữ nghĩa theo **trục thời gian** — cách blog đọc hiểu "bài trước/bài sau":
 *
 * - `previous` là bài **cũ hơn** liền trước (trong danh sách mới-nhất-trước,
 *   phần tử ngay **sau** article hiện tại);
 * - `next` là bài **mới hơn** liền sau (phần tử ngay **trước** article hiện
 *   tại).
 *
 * Bài cũ nhất không có `previous`, bài mới nhất không có `next` — biên danh
 * sách cho `undefined`, không bọc vòng. Article hiện tại không bao giờ xuất
 * hiện trong cặp, và vì input là danh sách đã lọc theo locale, cặp này không
 * bao giờ nhảy sang locale khác.
 */
export function pickAdjacentArticles(
  articles: readonly BlogArticleSummary[],
  current: BlogArticleSummary,
): BlogAdjacentArticles {
  const index = articles.findIndex((article) => article.path === current.path);
  if (index < 0) {
    return { previous: undefined, next: undefined };
  }
  const older = articles[index + 1];
  const newer = articles[index - 1];
  return {
    previous: older ? { path: older.path, title: older.title } : undefined,
    next: newer ? { path: newer.path, title: newer.title } : undefined,
  };
}

/**
 * Tags hiển thị của một article: dedupe (schema `z.array(z.string())` không
 * ràng buộc unique — frontmatter có tag lặp thì `v-for :key="tag"` sinh
 * duplicate key và Vue patch DOM sai), trim và loại chuỗi rỗng.
 *
 * Gọi ở **tầng map route** (một lần trên dữ liệu thô), không trong component —
 * component nhận danh sách đã sạch, `:key="tag"` luôn an toàn.
 */
export function articleDisplayTags(tags: readonly string[] | undefined): readonly string[] {
  if (tags === undefined) {
    return [];
  }
  return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag !== ''))];
}
