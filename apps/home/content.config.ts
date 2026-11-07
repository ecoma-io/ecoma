import { defineCollection, defineContentConfig, z } from '@nuxt/content';
import { SERIES_META } from './app/blog/blog-series';
import { isIsoCalendarDate } from './app/blog/blog-date';

import { legalIncludeDrafts } from './app/domain/legal-build-mode';

/**
 * Field ngày ISO của schema — một **factory** dùng chung cho `date`,
 * `updatedAt` và `effectiveDate`.
 *
 * Vì sao factory thay vì viết `refine` tay ở từng field: cả ba field đều
 * mang đúng một định nghĩa "ngày lịch có thật", và định nghĩa đó đã nằm ở
 * `isIsoCalendarDate` (helper thuần, dùng chung với view). Viết lại regex +
 * `Date.parse` ở từng chỗ là ba cơ hội để lệch khỏi định nghĩa đó — và lệch
 * đúng kiểu đã xảy ra: `Date.parse` chấp nhận `2026-02-31` vì JS roll ngày
 * không tồn tại sang ngày có thật thay vì từ chối.
 *
 * `field` chỉ dùng cho **thông điệp lỗi** — không có nó, ba field lỗi giống
 * nhau và người sửa frontmatter không biết lỗi nằm ở đâu.
 */
function isoCalendarDateSchema(field: string): z.ZodEffects<z.ZodString, string> {
  return z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u, { message: `${field} phải có dạng YYYY-MM-DD` })
    .refine((value) => isIsoCalendarDate(value), {
      message: `${field} phải là một ngày có thật trong lịch (YYYY-MM-DD)`,
    });
}

/**
 * Content config của `apps/home` — bề mặt public hợp nhất.
 *
 * Ba collection, đúng ba bề mặt content của `ecoma.io`:
 *
 * - `docs` — documentation tree (landing, section index, leaf page); mọi page
 *   của documentation nằm trong đó, không tách collection theo section:
 *   section chỉ là một directory trong content tree, và navigation suy ra từ
 *   chính tree đó.
 * - `blog` — article list phẳng (không có section lồng nhau như docs), điều
 *   hướng previous/next chạy trên danh sách phẳng các article của cùng locale.
 * - `legal` — danh sách phẳng các văn bản pháp lý (policy, terms); không có
 *   tree lồng nhau, điều hướng là landing grouped theo category.
 *
 * Mỗi collection giữ nguyên semantic source của app cũ sở hữu nó: `docs` từ
 * `apps/docs/content.config.ts`, `blog` từ `apps/blogs/content.config.ts`
 * (schema + source không đổi). Content path khớp thẳng public URL ở cả hai:
 * `defineLocalSource`-style glob với `prefix` bằng đúng phần cố định trước
 * wildcard, giữ nguyên segment locale trong stem, nên item id
 * `en/docs/getting-started/installation` → path
 * `/en/docs/getting-started/installation`. Không có map locale thủ công ở đâu.
 *
 * `docs/api` không có content và không có route: mount đó là boundary của
 * `api-reference` (mount lồng nhau, deepest-first trong `PUBLIC_MOUNTS`) —
 * `parsePublicLayoutPath` từ chối nó trước khi bất kỳ collection nào được query.
 */

/**
 * Schema của collection `blog` — nguyên văn từ `apps/blogs` cũ.
 *
 * Trường `cover` là **reference asset tương đối** (ví dụ
 * `../../../assets/cover-url-model.svg`) — `nuxt-content-assets` walk toàn bộ
 * frontmatter (`walkMeta`) và rewrite mọi value khớp asset index thành URL
 * public tại thời điểm build, nên ở runtime `cover` đã là `/assets/...`,
 * không phải path tương đối nữa.
 */
const blogSchema = z
  .object({
    /** Tiêu đề hiển thị của article — dùng cho listing, SEO title và pager. */
    title: z.string(),
    /** Mô tả ngắn một dòng — meta description, card listing và excerpt. */
    description: z.string(),
    /**
     * Ngày xuất bản, ISO date (`YYYY-MM-DD`).
     *
     * Dùng `z.string()` chứ không `z.date()`: frontmatter parse ra
     * **string**, và adapter sqlite lưu cột DATE trả về string khi query —
     * khai báo `z.date()` sẽ lệch kiểu giữa schema và runtime. Regex pin đúng
     * hình dạng dữ liệu để sort theo string là sort theo thời gian.
     *
     * Điều kiện "là ngày có thật" gọi `isIsoCalendarDate` — helper thuần dùng
     * chung với view (`app/blog/blog-date.ts`), nên định nghĩa ngày hợp lệ ở
     * tầng build và tầng runtime là **một**. `Date.parse` một mình không đủ:
     * JS **roll over** ngày ngoài lịch thay vì từ chối chúng (`2026-02-31`
     * parse thành `2026-03-03`, không phải `NaN`) — ngày đó lọt vào DB, xếp
     * sai thứ tự editorial và phát sai `datePublished` mà không có lỗi nào báo.
     */
    date: isoCalendarDateSchema('date'),
    /** Tên tác giả của article. */
    author: z.string(),
    /** Tags chủ đề — dùng cho badge trên card và article. Tag archive không thuộc slice này. */
    tags: z.array(z.string()),
    /** Đánh dấu article ứng viên featured trên landing. */
    featured: z.boolean(),
    /**
     * Cover image — **tùy chọn**, reference tương đối tới asset dùng chung
     * `content/assets/` (graphic cover language-neutral, một bản duy nhất).
     * `nuxt-content-assets` rewrite value thành URL public `/assets/...` lúc
     * build; article không khai báo cover render không hình, không bao giờ sinh
     * `<img>` hỏng. Alt text đi kèm trong `coverAlt` — hai trường đi cùng nhau
     * để informative image không bao giờ thiếu mô tả.
     */
    cover: z.string().optional(),
    /** Mô tả alt của cover — bắt buộc khi bài khai `cover` (refine ở dưới). */
    coverAlt: z.string().min(1).optional(),
    /**
     * Identity ổn định, độc lập locale và URL — "bài học thuật số 7" là một
     * khái niệm biên tập, còn `/en/blog/<slug>` chỉ là địa chỉ vật lý của một
     * bản dịch. Mọi liên kết trong content (prerequisites, related, series
     * membership) diễn đạt bằng ID này, được resolve thành URL thật ở render —
     * đổi slug hay thứ tự biên tập không phá liên kết cũ.
     *
     * Tùy chọn: 12 bài demo không bị ép nhận metadata research. Hai bài cùng
     * khai một `articleId` là lỗi dữ liệu — refine ở dưới chặn ở build.
     */
    articleId: z.string().min(1).optional(),
    /**
     * Series membership — `seriesId` phải nằm trong `SERIES_META` (danh mục
     * series công khai, duy nhất trong `app/blog/blog-series.ts`) và **đi cùng**
     * `seriesOrder` (refine ở dưới): một nửa cặp là dữ liệu mù — thứ tự học
     * tập không dựng được từ bài thiếu order, và membership không mô tả được
     * nếu order lơ lửng không series.
     */
    seriesId: z.string().min(1).optional(),
    /** Vị trí biên tập trong series — 1-based, không buộc liền kề (series có thể có khoảng trống chủ ý). */
    seriesOrder: z.number().int().min(1).optional(),
    /**
     * Phân loại bài — controlled vocabulary của content học thuật. Demo bài
     * không khai trường này và **không bao giờ** bị consumer coi là research
     * chỉ vì nó trông "nghiêm túc": chỉ `research-review`/`benchmark`/
     * `experiment` mới kích hoạt kiểm tra trích dẫn (xem contract test).
     */
    contentType: z
      .enum(['theory', 'research-review', 'experiment', 'benchmark', 'interactive-demo'])
      .optional(),
    /** Độ sâu đọc — input cho UI hint tương lai, không ảnh hưởng thứ tự nào. */
    level: z.enum(['foundational', 'intermediate', 'advanced']).optional(),
    /**
     * `articleId` của các bài **cần đọc trước** — reference theo identity,
     * resolve thành URL cùng locale của bản dịch bài đó ở render. Tham chiếu
     * tới ID không tồn tại trong content published là lỗi contract (bắt ở
     * test), không âm thầm render link chết.
     */
    prerequisites: z.array(z.string().min(1)).optional(),
    /** `articleId` của các bài liên quan được chọn tay — overlap với related-by-tag là hợp lệ (hai cơ chế song song). */
    relatedArticleIds: z.array(z.string().min(1)).optional(),
    /**
     * Ngày sửa đổi có thực chất, ISO `YYYY-MM-DD` — cùng helper và cùng định
     * nghĩa với `date` (`isIsoCalendarDate`), nên hai trường không thể lệch
     * nhau về việc ngày nào được chấp nhận. Hiển thị cạnh ngày xuất bản khi có;
     * thiếu nghĩa là chưa bao giờ sửa có thực chất, không fallback về `date`.
     */
    updatedAt: isoCalendarDateSchema('updatedAt').optional(),
    /**
     * Metadata reviewer — chỉ có nghĩa khi có **tên thật**. `reviewer` rỗng
     * hoàn toàn tương đương không reviewer: không thể "tự cho peers-review"
     * bằng một field rỗng. UI chỉ render khi name không rỗng.
     */
    reviewer: z
      .object({
        /** Tên reviewer — rỗng thì toàn bộ metadata bị coi là không tồn tại. */
        name: z.string().min(1),
        /** Vai trò/credential hiển thị cạnh tên (tùy chọn). */
        title: z.string().optional(),
      })
      .optional(),
  })
  // Cặp `cover`/`coverAlt` đi cùng nhau: khai cover mà thiếu alt vẫn pass
  // từng field một cách riêng lẻ, rồi hậu quả bị che ở runtime
  // (`normalizeArticleCover` trả `undefined` — cover biến mất im lặng), còn
  // consumer mới đọc thẳng `cover` (sitemap, OG image) sẽ sinh `<img>` thiếu
  // alt. Content là editorial — người viết không phải developer — nên vi phạm
  // a11y phải **fail ở build**, không âm thầm.
  .refine((article) => article.cover === undefined || article.coverAlt !== undefined, {
    message: 'coverAlt là bắt buộc khi bài khai báo cover',
    path: ['coverAlt'],
  })
  // `seriesId` và `seriesOrder` đi cùng nhau: một nửa cặp là dữ liệu mù —
  // order không gắn series không dựng được thứ tự học tập, series không order
  // không mô tả được membership. Lỗi được pin vào trường đang thiếu.
  .refine((article) => (article.seriesId === undefined) === (article.seriesOrder === undefined), {
    message: 'seriesId và seriesOrder phải khai cùng nhau',
    path: ['seriesId'],
  })
  // Bài khai series phải thuộc danh mục series công khai: series chỉ tồn tại
  // khi có title/description thật trong `SERIES_META` — trang series rỗng hay
  // series "đường" không bao giờ được sinh từ frontmatter lạc loềng.
  .refine((article) => article.seriesId === undefined || article.seriesId in SERIES_META, {
    message: 'seriesId phải là một series đã khai báo trong SERIES_META',
    path: ['seriesId'],
  })
  // Ngày sửa có thực chất không đứng trước ngày xuất bản — một `updatedAt`
  // sớm hơn `date` là dữ liệu biên tập sai dù từng trường một đều hợp lệ.
  // So **chuỗi** là an toàn ở đây vì cả hai đều đã qua `isIsoCalendarDate`:
  // định dạng `YYYY-MM-DD` cố định 4-2-2 nên thứ tự lexicographic trùng thứ
  // tự thời gian. `Date.parse` sẽ làm lại đúng cái so sánh đó nhưng lại mở lại
  // lớp lỗi roll-over mà helper vừa chặn.
  .refine((article) => article.updatedAt === undefined || article.updatedAt >= article.date, {
    message: 'updatedAt không được sớm hơn date',
    path: ['updatedAt'],
  });

/**
 * Schema của collection `legal` — văn bản pháp lý của `ecoma.io`.
 *
 * Bốn bất biến thiết kế:
 *
 * - **Trạng thái xuất bản và trạng thái review là hai trục độc lập**
 *   (`status` ≠ `reviewStatus`): một văn bản có thể đã được pháp lý review
 *   mà vẫn draft (đợi hiệu lực), hoặc published mà review còn thiếu (không
 *   được phép xảy ra ở production — `legalCollectionDocuments` chặn ở tầng
 *   query build-time). Conflating hai trục làm mất chính xác khả năng biểu
 *   diễn đó.
 * - **`status` là dữ liệu, không phải access control**: production không
 *   filter draft lúc request — văn bản draft không bao giờ vào manifest
 *   prerender của build production (cơ chế build-time ở `nitro.config.ts` +
 *   middleware gate `server/middleware/prerendered-content-404.ts`), nên
 *   route không bao giờ nhìn thấy nó để render.
 * - **`effectiveDate` tùy chọn và phải là ngày có thật** — cùng helper
 *   `isoCalendarDateSchema` với `date` của `blogSchema`: frontmatter parse ra
 *   string nên khai `z.date()` lệch kiểu giữa schema và runtime, và
 *   `Date.parse` một mình chấp nhận `2026-02-31`. Ba field ngày của app dùng
 *   chung một định nghĩa để chúng không thể lệch nhau.
 * - **`related` là slug trong cùng collection, không phải path**: slug là
 *   định danh ổn định khi locale tree tách hai bản dịch; validity (slug tồn
 *   tại) không enforce được ở schema vì schema nhìn một file một lần —
 *   `tests/legal-content-contract.spec.ts` chặn cross-file ở unit test.
 */
const legalSchema = z
  .object({
    /** Tiêu đề hiển thị — listing card, `<h1>` của trang và SEO title. */
    title: z.string().min(1),
    /** Mô tả ngắn một dòng — meta description và excerpt trên landing. */
    description: z.string().min(1),
    /** Nhóm hiển thị trên Legal Center landing — enum đóng, grouped theo giá trị này. */
    category: z.enum(['policy', 'terms']),
    /** Loại văn bản — phân biệt policy vận hành với hợp đồng điều khoản. */
    docType: z.enum(['policy', 'terms-of-service', 'supplemental-terms']),
    /** Trạng thái xuất bản — giá trị duy nhất production phục vụ là `published`. */
    status: z.enum(['draft', 'published']),
    /** Trạng thái review pháp lý — độc lập với `status`; `unreviewed` chưa qua rà soát. */
    reviewStatus: z.enum(['unreviewed', 'reviewed']),
    /** Phiên bản văn bản — chuỗi theo semantic tuỳ văn bản (`1.0`), tăng khi nội dung thay đổi materially. */
    version: z.string().min(1),
    /** Ngày hiệu lực, ISO date — tùy chọn; văn bản draft chưa chốt hiệu lực thì không khai. */
    effectiveDate: isoCalendarDateSchema('effectiveDate').optional(),
    /** Phạm vi áp dụng — bề mặt platform/service nào văn bản chi phối. */
    scope: z.string().min(1),
    /** Slug các văn bản liên quan trong cùng collection — tùy chọn, không path không URL. */
    related: z.array(z.string().min(1)).optional(),
  })
  .refine((document) => document.status === 'draft' || document.effectiveDate !== undefined, {
    message: 'effectiveDate là bắt buộc khi văn bản published',
    path: ['effectiveDate'],
  });

export default defineContentConfig({
  collections: {
    legal: defineCollection({
      type: 'page',
      source: [
        // Hai source `en/**`/`vi/**` với prefix bằng toàn bộ phần cố định của
        // glob — cùng lý do với collection `blog` bên dưới: prefix là string
        // **override** phần cố định module tự suy ra, đặt thiếu segment sẽ cắt
        // mất `legal` khỏi mọi `path`/`stem` trong database.
        //
        // `exclude` draft là **access control của production build**, không
        // phải UI filter: loại draft khỏi source loại chúng khỏi content
        // database trước cả prerender — không HTML, không payload collection
        // dump, không manifest entry. Quy ước đặt tên: template chưa công bố
        // dùng hậu tố `.draft.md` (status frontmatter `draft` vẫn là nguồn
        // sự thật của semantic — hậu tố chỉ là cơ chế loại khỏi build).
        // Chỉ đúng chuỗi `"true"` của `NUXT_PUBLIC_LEGAL_INCLUDE_DRAFTS`
        // (xem `app/domain/legal-build-mode.ts`) là staging build giữ draft;
        // mọi giá trị khác/thiếu → draft bị loại, route draft 404 qua gate
        // `prerendered-content-404.ts`. Staging vẫn hiện nhãn Draft + review
        // status; noindex staging do `NITRO_PUBLIC_NO_INDEX` đảm nhiệm.
        {
          include: 'en/legal/**',
          prefix: '/en/legal',
          exclude: legalIncludeDrafts() ? [] : ['en/legal/*.draft.md'],
        },
        {
          include: 'vi/legal/**',
          prefix: '/vi/legal',
          exclude: legalIncludeDrafts() ? [] : ['vi/legal/*.draft.md'],
        },
      ],
      schema: legalSchema,
    }),
    docs: defineCollection({
      type: 'page',
      source: [
        // Hai source `en/docs/**` và `vi/docs/**` là cách duy nhất khai báo
        // content localized mà content path khớp thẳng public URL. Không có
        // map locale thủ công ở đâu.
        //
        // Glob phải bó trong `docs/`: include `en/**` (bản trước đây) nuốt
        // LUÔN `en/legal/**` và `en/blog/**` — hai collection cùng đọc một
        // file, và cây navigation của docs (payload `_payload.json` nhúng
        // `docs:navigation`) mang theo node Blog/Legal kèm mọi văn bản legal,
        // trong đó có draft. Draft lộ qua payload của docs là rò rỉ access
        // control dù landing/detail đã filter — dữ liệu phải không tồn tại
        // trong database của collection nào không sở hữu nó.
        { include: 'en/docs/**', prefix: '/en/docs' },
        { include: 'vi/docs/**', prefix: '/vi/docs' },
      ],
    }),
    blog: defineCollection({
      type: 'page',
      source: [
        // Lưu ý `prefix` là string **override** phần cố định mà module tự suy
        // ra từ glob (`fixed` trước `*`), không phải thêm đoạn mới: đặt `/en`
        // ở đây sẽ cắt mất segment `blog` khỏi mọi `path`/`stem` trong
        // database. Prefix phải là toàn bộ phần cố định của glob.
        { include: 'en/blog/**', prefix: '/en/blog' },
        { include: 'vi/blog/**', prefix: '/vi/blog' },
        // Graphic **language-neutral** dùng chung hai locale (một SVG diagram
        // không có chữ không cần duplicate cho từng locale). Prefix `/assets`
        // biến reference tương đối `../../assets/energy-flow.svg` từ
        // `en/blog/x.md` thành URL public `/assets/energy-flow.svg` — đúng
        // một bản duy nhất trên trang, không nhân đôi theo số locale.
        // Reference từ article đi lên một tầng (`en/blog/<slug>/` →
        // `en/blog/`) rồi sang `assets/`, thứ tự tham chiếu không đổi theo
        // locale nên Markdown hai bản đọc cùng một asset.
        { include: 'assets/**', prefix: '/assets' },
      ],
      schema: blogSchema,
    }),
  },
});
