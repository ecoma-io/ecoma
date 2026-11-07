import type { PublicLocale } from '../i18n/index';

/**
 * Series metadata và logic điều hướng series của blog — tách khỏi
 * route/component để test được mọi bất biến mà không cần dựng Nuxt runtime.
 *
 * Bất biến được pin ở đây:
 *
 * - **Series metadata là danh mục biên tập, không suy từ bài**: tiêu đề và mô
 *   tả của một series tồn tại ở đúng một nơi (`SERIES_META`) — không nhân bản
 *   vào frontmatter của từng bài (trùng lặp sẽ trôi theo bài, không có nguồn
 *   sự thật). Bài chỉ khai `seriesId` + `seriesOrder` trỏ vào danh mục.
 * - **Series không có bài published không tồn tại với người đọc**: mọi helper
 *   dưới đây chạy trên danh sách bài đã query; series chỉ xuất hiện khi có ít
 *   nhất một bài thật. Roadmap tương lai (series chưa có bài nào) nằm ngoài
 *   UI — không bao giờ render trang series rỗng chỉ vì metadata khai sẵn.
 * - **Thứ tự học tập độc lập với ngày đăng**: sort trong series là theo
 *   `seriesOrder` tăng dần, không phải theo `date`; tie-break `path` tăng để
 *   luôn xác định (hai bài cùng order trong một series là lỗi contract — bắt
 *   ở test — nhưng sort không được rơi vào hành vi không xác định vì thế).
 */

/**
 * Danh mục series công khai của blog — nguồn sự thật duy nhất cho title và
 * mô tả của series.
 *
 * Một series chỉ xuất hiện ở đây khi biên tập đã viết xong metadata hiển thị
 * thật; thêm roadmap series vào đây **không** làm trang series xuất hiện (UI
 * chỉ render series có bài published), nhưng vẫn là dữ liệu chết — thêm entry
 * cùng lúc với bài đầu tiên của series đó. `Record` thuần để `in SERIES_META`
 * ở schema refine không đụng prototype key (`constructor` v.v. — dùng
 * `Object.hasOwn` ở consumer nếu cần check an toàn hơn; các key ở đây do
 * chính repo kiểm soát nên `in` là đủ và rẻ).
 *
 * Sáu series dưới đây là curriculum AI/ML/LLM của Ecoma, mỗi series một mốc
 * trong lộ trình: nền toán → ML cổ điển và tối ưu → mô hình ngôn ngữ và
 * transformer → tiền huấn luyện và scaling → suy luận và thích ứng mô hình →
 * đánh giá và RAG. **Id phải khớp** `SERIES_CATALOG` trong
 * `tests/curriculum-contract.ts` — danh mục đó là nguồn sự thật cho *vị trí*
 * bài trong series, và `curriculum-contract.spec.ts` assert hai danh mục có
 * cùng tập id, nên thêm series vào một chỗ mà quên chỗ kia sẽ đỏ test chứ
 * không lặng lẽ lệch.
 *
 * Id series còn bị route giới hạn bằng `[a-z0-9-]+` (xem `[[...slug]].vue`) vì
 * route `/blog/series/<id>` phân biệt article với series overview bằng regex
 * đó; id có chữ hoa hoặc gạch dưới sẽ không bao giờ khớp route.
 */
export const SERIES_META = {
  'mathematical-foundations': {
    title: 'Mathematical foundations',
    description:
      'The linear algebra, calculus, probability and information theory that the rest of the curriculum assumes without restating.',
  },
  'classical-machine-learning': {
    title: 'Classical machine learning and optimization',
    description:
      'Generalization, loss functions, gradient descent, the bias-variance trade-off, and the embeddings that bridge symbols to geometry.',
  },
  'language-modeling': {
    title: 'Language modeling and transformers',
    description:
      'How text becomes tokens, why models predict the next token, where sequence order enters attention, and how a transformer block is assembled.',
  },
  pretraining: {
    title: 'Pretraining and scaling',
    description:
      'The training loop end to end, the empirical scaling relationships, data curation, and the three axes of distributed training.',
  },
  inference: {
    title: 'Inference and model adaptation',
    description:
      'Prefill and decode, the memory cost of long contexts, quantization, supervised fine-tuning, and preference optimization.',
  },
  'evaluation-and-rag': {
    title: 'Evaluation and RAG',
    description:
      'Metrics, benchmarks, retrieval-augmented generation, embedding search, reranking, and reproducible experiments.',
  },
} as const;

/** Metadata hiển thị của một series. */
export type SeriesMeta = {
  readonly title: string;
  readonly description: string;
};

/** Bài của series đã resolve — shape tối thiểu mọi hàm dưới đây chạy trên đó. */
export type SeriesArticle = {
  /** Path public canonical của bài, ví dụ `/en/blog/<slug>`. */
  readonly path: string;
  /** Tiêu đề hiển thị — `BlogArticleSummary` luôn có; shape tối thiểu có thể thiếu. */
  readonly title?: string;
  /** Series ID khai trong frontmatter — `undefined` khi bài không thuộc series. */
  readonly seriesId?: string;
  /** Vị trí biên tập trong series — khai cùng `seriesId`. */
  readonly seriesOrder?: number;
};

/**
 * Danh sách entry series (id + metadata) có ít nhất một bài trong danh sách
 * input, theo thứ tự id tăng dần để render xác định.
 *
 * Series trong `SERIES_META` mà không bài nào published **không** xuất hiện —
 * đây là đường duy nhất quyết định "series nào tồn tại với người đọc", và nó
 * suy từ content, không từ danh mục.
 */
export function seriesWithArticles(articles: readonly SeriesArticle[]): {
  id: string;
  meta: SeriesMeta;
}[] {
  const present = new Set<string>();
  for (const article of articles) {
    if (article.seriesId !== undefined) {
      present.add(article.seriesId);
    }
  }
  return Object.keys(SERIES_META)
    .filter((id) => present.has(id))
    .toSorted()
    .map((id) => ({ id, meta: getSeriesMeta(id) as SeriesMeta }));
}

/**
 * Metadata của một series theo ID — `undefined` khi ID không có trong danh
 * mục (route dùng nó làm nguồn `seriesId` validate: ID lạ không phải series
 * page, mà là article path không tồn tại → 404).
 */
export function getSeriesMeta(id: string): SeriesMeta | undefined {
  return id in SERIES_META
    ? (SERIES_META[id as keyof typeof SERIES_META] as SeriesMeta)
    : undefined;
}

/** Một series đủ điều kiện render lên landing, kèm URL thật của trang overview. */
export type SeriesLandingEntry = {
  readonly id: string;
  readonly meta: SeriesMeta;
  /**
   * URL overview **của locale thật sự có bài của series này**.
   *
   * Không phải `/${locale}/blog/series/${id}` vô điều kiện: landing fallback
   * (locale chưa có bài nào) liệt kê series của inventory English, và series
   * đó có thể chưa có bản ở locale của landing — link `/vi/blog/series/x` khi
   * series chỉ có bài EN là link 404, tệ hơn là không hiện series.
   */
  readonly path: string;
  /** Số bài của series trong inventory đang liệt kê. */
  readonly articleCount: number;
};

/**
 * Các series render lên **landing discovery**, kèm URL đúng cho từng series.
 *
 * Trách nhiệm chính của hàm này là chọn **locale của trang overview theo
 * content**, không theo locale của landing:
 *
 * - Series có bài ở `inventory` → link tới `/${inventory.locale}/blog/series/<id>`.
 * - Series **không** có bài ở `inventory` nhưng có bài ở `fallbackInventory` →
 *   link tới `/${fallbackInventory.locale}/blog/series/<id>`. Đây là nhánh
 *   English-first: landing `/vi/blog` (chưa có bài tiếng Việt) vẫn dẫn người
 *   đọc tới series thật, ở đúng nơi series tồn tại.
 *
 * Số bài đếm trên inventory **mà series thuộc về**, không phải inventory thứ
 * nhất tình cờ có: series có 2 bài EN và 0 bài VI thì card trên landing `/vi`
 * phải ghi "2 bài viết" — đếm trên danh sách rỗng sẽ ra 0, tức quảng bá một
 * series rỗng ở nơi nó không rỗng.
 *
 * `fallbackInventory` là tuỳ chọn: landing có bài thật thì chỉ có một inventory
 * và mọi series đều thuộc locale của nó.
 *
 * Thứ tự id tăng dần (kế thừa từ `seriesWithArticles`) nên render xác định.
 */
export function seriesLandingEntries(
  inventory: readonly SeriesArticle[],
  inventoryLocale: PublicLocale,
  fallbackInventory?: {
    readonly articles: readonly SeriesArticle[];
    readonly locale: PublicLocale;
  },
): SeriesLandingEntry[] {
  const countById = (articles: readonly SeriesArticle[], id: string): number =>
    articles.filter((article) => article.seriesId === id).length;

  // Tập series ứng viên là **hợp** của hai inventory, không chỉ inventory đầu:
  // landing fallback có inventory rỗng, mà series cần liệt kê lại chính là
  // những series chỉ tồn tại ở inventory dự phòng. Lọc theo `inventory` đơn
  // thuần sẽ cho `[]` và landing fallback mất hẳn khối series.
  const candidates = seriesWithArticles([...inventory, ...(fallbackInventory?.articles ?? [])]);

  const entries: SeriesLandingEntry[] = [];
  for (const { id, meta } of candidates) {
    const own = countById(inventory, id);
    if (own > 0) {
      entries.push({
        id,
        meta,
        articleCount: own,
        path: seriesPath(inventoryLocale, id),
      });
      continue;
    }
    // Series chỉ có bài ở inventory dự phòng: URL và số bài lấy từ **đó**.
    // Không có bài ở đâu thì không có card — xem `filter` cuối hàm.
    const fallback = fallbackInventory;
    const fallbackCount = fallback === undefined ? 0 : countById(fallback.articles, id);
    if (fallback === undefined || fallbackCount === 0) {
      continue;
    }
    entries.push({
      id,
      meta,
      articleCount: fallbackCount,
      path: seriesPath(fallback.locale, id),
    });
  }
  return entries;
}

/** URL overview của series `id` ở `locale`. */
function seriesPath(locale: PublicLocale, id: string): string {
  return `/${locale}/blog/series/${id}`;
}

/**
 * Bài của **một** series, theo thứ tự học tập (`seriesOrder` tăng dần,
 * tie-break `path` tăng — luôn xác định).
 *
 * Generic trên shape phần tử: caller giữ nguyên type giàu của mình
 * (`BlogArticleSummary`) mà không cast — hàm chỉ đọc các field của
 * `SeriesArticle`.
 *
 * Trả về mảng mới — không mutate input.
 */
export function orderArticlesBySeriesOrder<T extends SeriesArticle>(
  articles: readonly T[],
  seriesId: string,
): T[] {
  return articles
    .filter((article) => article.seriesId === seriesId)
    .toSorted((a, b) => {
      const orderDelta = (a.seriesOrder ?? 0) - (b.seriesOrder ?? 0);
      if (orderDelta !== 0) {
        return orderDelta;
      }
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
}

/**
 * Vị trí của một bài trong thứ tự học tập của series nó thuộc.
 *
 * Trả `undefined` khi bài không khai series — article view không render khối
 * series cho bài ngoài series, thay vì tự đoán.
 */
export function seriesNeighbors<T extends SeriesArticle>(
  articles: readonly T[],
  current: T,
):
  | { readonly id: string; readonly previous: T | undefined; readonly next: T | undefined }
  | undefined {
  if (current.seriesId === undefined) {
    return undefined;
  }
  const ordered = orderArticlesBySeriesOrder(articles, current.seriesId);
  const index = ordered.findIndex((article) => article.path === current.path);
  if (index < 0) {
    return undefined;
  }
  return {
    id: current.seriesId,
    previous: index > 0 ? ordered[index - 1] : undefined,
    next: index < ordered.length - 1 ? ordered[index + 1] : undefined,
  };
}
