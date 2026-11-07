<!--
  Route duy nhất phục vụ toàn bộ content của blog:
  `apps/home/app/pages/[locale]/blog/[[...slug]].vue`

  Route này **validate bằng chính pathname thô** qua `isBlogRoute` (dựng trên
  `parsePublicLayoutPath` của module `app/layout`), rồi chỉ nhận
  `kind === 'localized' && mount === 'blog'`. Nguồn pathname khác nhau theo môi
  trường: trên server h3 percent-decode request path **trước** khi vue-router
  nhìn thấy (nên `to.path` đã bị decode), trong khi `useRequestURL().pathname`
  vẫn là byte gốc trên wire; client thì `to.path` giữ nguyên encoding.
  `validate` chọn nguồn theo môi trường, nhờ vậy URL không canonical
  (`/%65n/blog/...`) bị từ chối thay vì được phục vụ dưới dạng đã decode. Sau
  `validate`, mọi pathname vào được setup đều canonical nên phần còn lại của
  route dùng thẳng `route.path`. `isBlogRoute` nhận:

  - `/en/blog`, `/vi/blog`, `/en/blog/foo`, `/vi/blog/foo/bar` — hợp lệ;
  - `/fr/blog`, `/EN/blog`, `/en/blog/`, `/en/docs`, `/en/blogging` — bị
    `validate` từ chối;
  - `/en/blog/unknown` hợp lệ về topology, nhưng ở **production** bị chặn ngay
    ở tầng Nitro middleware (`server/middleware/prerendered-content-404.ts`,
    trước cả renderer): Worker không có database runtime nào cho content, path
    lạ phải 404 trước khi query chạy.

  Route này chỉ sở hữu mount `blog`; `/en/docs` và `/en/legal` có route riêng
  trong cùng app, và `/` là locale-resolution entry point — route này không
  phục vụ chúng.

  Toàn bộ dữ liệu của trang được resolve ở **route** (query, featured, related,
  prev/next, SEO); component view chỉ render. Nhờ vậy không component nào tự
  query và SSR/hydrate nhìn thấy đúng cùng một dữ liệu.

  Query dùng `path(route.path)` — key ổn định cho SSR, không tự dựng lại URL từ
  `params.slug`. Query trước hết cho document; landing không có document ở
  `/en/blog` (chỉ article có file content), nên landing được nhận diện qua
  `remainder === ''` và **không** query document.

  Ordering dùng số prefix trong tên file (`1.url-model`): `path` bị strip prefix
  còn `stem` giữ nguyên, nên prev/next theo `stem ASC` vừa tôn trọng thứ tự
  editorial vừa deterministic.
-->
<script setup lang="ts">
import type { PublicLocale } from '../../../i18n/index';
import { PUBLIC_LOCALES } from '../../../i18n/index';
import BlogArticleView from '~/components/blog/BlogArticleView.vue';
// Import tường minh (không auto-import): auto-import đăng ký component với
// prefix thư mục (`BlogBlogLandingView`), nên tên ngắn trong template không
// resolve được — SSR render rỗng im lặng (đã xác minh trên bản apps/blogs cũ).
import BlogLandingView from '~/components/blog/BlogLandingView.vue';
import BlogSeriesLandingView from '~/components/blog/BlogSeriesLandingView.vue';
import {
  articleDisplayTags,
  normalizeArticleCover,
  pickAdjacentArticles,
  pickFeaturedArticle,
  pickRelatedArticles,
  orderArticlesByDateDesc,
  type BlogArticleSummary,
} from '~/blog/blog-articles';
import {
  blogArticleAvailableLocales,
  blogLandingArticleLocales,
  blogLandingAvailableLocales,
  blogSeoAlternateLocales,
  blogTranslationCandidates,
} from '~/blog/blog-translations';
import { blogUiStrings } from '~/blog/blog-ui-strings';
import { buildBlogSeo } from '~/blog/blog-seo';
import {
  getSeriesMeta,
  orderArticlesBySeriesOrder,
  seriesLandingEntries,
  seriesNeighbors,
} from '~/blog/blog-series';
import {
  normalizeReferenceIds,
  resolveReferences,
  type ArticleIdentityRecord,
  type RenderableReference,
} from '~/blog/blog-references';
import { isBlogRoute, parseBlogRoute } from '~/blog/blog-routing';

definePageMeta({
  /**
   * Nguồn pathname khác nhau theo môi trường, giống pattern của
   * `apps/home/app/pages/[locale]/index.vue`: trên server h3 đã percent-decode
   * request path trước khi `validate` nhìn thấy (nên `to.path` là bản đã
   * decode), còn `useRequestURL().pathname` đọc từ `originalUrl` — byte gốc
   * chưa decode. Client thì `to.path` giữ nguyên encoding. Validate đúng pathname
   * thô để URL không canonical (`/%65n/blog/...`) bị từ chối thay vì được phục vụ.
   *
   * Chốt "path lạ phải 404 trước khi query" không nằm ở đây nữa mà ở tầng
   * Nitro middleware (`server/middleware/prerendered-content-404.ts`) — app
   * code bị Vite bundle trước prerender nên không thể đọc manifest sau
   * prerender (chi tiết `modules/prerendered-content-manifest.ts`).
   * `validate` giữ đúng một trách nhiệm: topology + pathname thô.
   */
  validate: (to) => {
    const rawPathname = import.meta.server ? useRequestURL().pathname : to.path;
    return isBlogRoute(rawPathname);
  },
});

const route = useRoute();

/**
 * Locale của pathname đã được `validate` chấp nhận: `parseBlogRoute` trả layout
 * blog (locale đã kiểm tra trong registry, mount đúng `blog`), nên ở đây không
 * cần suy đoán lại từ `params` (`params.locale` là string thô của router, không
 * phải locale đã validate).
 */
const layout = computed(() => parseBlogRoute(route.path));
const locale = computed<PublicLocale>(() => layout.value?.locale ?? 'en');

/** Phần pathname còn lại sau `<locale>/blog` — `''` nghĩa là landing. */
const remainder = computed(() => layout.value?.remainder ?? '');
const isBlogLanding = computed(() => remainder.value === '');

/**
 * Route series overview — remainder khớp `series/<id>` với `id` nằm trong
 * `SERIES_META`. Chú ý remainder **giữ dấu `/` đầu** (contract của
 * `parsePublicLayoutPath`: `/en/blog/series/x` → remainder `/series/x`).
 * Series ID không có trong danh mục là topology 404 (route dưới); series có
 * trong danh mục nhưng chưa có bài published cũng 404 (query dưới) — series
 * rỗng không bao giờ có trang, bất kể metadata khai sẵn.
 */
const seriesId = computed<string | undefined>(() => {
  const match = /^\/series\/([^/]+)$/u.exec(remainder.value);
  const candidate = match?.[1];
  return candidate !== undefined && getSeriesMeta(candidate) !== undefined ? candidate : undefined;
});
const isSeriesPage = computed(() => seriesId.value !== undefined);

/** Metadata của series hiện tại — luôn xác định khi `isSeriesPage`. */
const seriesMeta = computed(() =>
  seriesId.value !== undefined ? getSeriesMeta(seriesId.value) : undefined,
);

/**
 * Article của pathname hiện tại — nguồn nội dung duy nhất của article page.
 * Không chạy trên landing hay series page: `/en/blog` và
 * `/en/blog/series/<id>` không có document nào (chỉ article có file content),
 * và cố query `.path(...)` cho path không có file sẽ trả `null` vô nghĩa.
 */
const { data: page } = await useAsyncData(`blog:page:${route.path}`, () =>
  isBlogLanding.value || isSeriesPage.value
    ? Promise.resolve(null)
    : queryCollection('blog').path(route.path).first(),
);

/**
 * Bọc một field optional của summary vào spread, **loại hẳn key** khi giá trị
 * rỗng — thay vì gán `?? undefined`.
 *
 * Vì sao `?? undefined` không đạt: `undefined` là một **giá trị** nên key vẫn có
 * mặt trên object. Qua `_payload.json` nó thành node `-1` của devalue và
 * hydrate trả lại `undefined` — tức `'cover' in summary` là **đúng** trên client
 * với bài không hề khai cover, và mọi kiểm tra "field này có tồn tại không" viết
 * bằng `in` sẽ cho kết quả sai. Key vắng mặt thì `in`, `v-if` và cả hai nơi
 * (server render, client hydrate) đều tự đúng.
 *
 * `null` từ sqlite và `undefined` từ adapter đều rơi vào nhánh bỏ qua, nên
 * handler không phân biệt hai nguồn đó.
 */
function optionalField<K extends string, V>(
  key: K,
  value: V | null | undefined,
): Record<K, V> | Record<string, never> {
  return value === null || value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * Toàn bộ article của **locale hiện tại**, mới nhất trước — dùng chung cho
 * landing (hero + listing) và article page (related, pager).
 *
 * Lọc theo locale ở **tầng query** (`path` LIKE `/<locale>/blog/%`), không lọc
 * lại ở UI: `path` của mọi item trong collection luôn bắt đầu bằng segment
 * locale (`/en/blog/...`), nên pattern này khớp đúng tập article của locale và
 * không bao giờ trộn hai locale.
 *
 * `.select(...)` chỉ lấy đúng các cột được map bên dưới — thiếu cột nào thì
 * listing/featured/related/pager không dùng, kể cả cột `body` (AST Markdown
 * đầy đủ, nặng nhất collection). `apps/docs` dùng cùng pattern cho query
 * cùng dạng; kéo cả bảng chỉ làm payload cache và memory lớn vô ích.
 */
const { data: articles } = await useAsyncData(`blog:articles:${locale.value}`, async () => {
  const records = await queryCollection('blog')
    .select(
      'path',
      'stem',
      'title',
      'description',
      'date',
      'author',
      'tags',
      'featured',
      'cover',
      'coverAlt',
      'articleId',
      'seriesId',
      'seriesOrder',
      'contentType',
      'level',
      'prerequisites',
      'relatedArticleIds',
      'updatedAt',
      'reviewer',
    )
    .where('path', 'LIKE', `/${locale.value}/blog/%`)
    .all();
  const summaries: BlogArticleSummary[] = records.map((record) => ({
    path: record.path,
    stem: record.stem,
    title: record.title ?? '',
    description: record.description ?? '',
    date: record.date ?? '',
    author: record.author ?? '',
    // Dedupe/trim/loại tag rỗng ở tầng dữ liệu — component nhận danh sách đã
    // sạch nên `v-for :key` không bao giờ gặp duplicate key.
    tags: articleDisplayTags(record.tags),
    featured: record.featured ?? false,
    // Metadata research — mọi trường đều tùy chọn; demo bài không khai thì
    // **key vắng mặt** trong summary (không đặt giá trị giả `[]`/`''`/key
    // null). sqlite trả `NULL` thành `null` runtime cho mọi cột optional.
    // `seriesOrder` còn bị adapter lưu/đọc dưới dạng **string** (`"1"`) dù
    // schema khai number, nên phải coerce tường minh để sort theo số không
    // phải so chuỗi.
    ...optionalField('cover', normalizeArticleCover(record.cover, record.coverAlt)),
    ...optionalField('articleId', record.articleId),
    ...optionalField('seriesId', record.seriesId),
    ...optionalField(
      'seriesOrder',
      record.seriesOrder === null || record.seriesOrder === undefined
        ? undefined
        : Number(record.seriesOrder),
    ),
    ...optionalField('contentType', record.contentType),
    ...optionalField('level', record.level),
    // Reference ID đi qua chuẩn hóa (trim/dedupe/loại rỗng) — cùng pattern
    // với tags; resolve URL thật diễn ra dưới, trên bảng identity đã query.
    prerequisiteIds: normalizeReferenceIds(record.prerequisites),
    relatedArticleIds: normalizeReferenceIds(record.relatedArticleIds),
    ...optionalField('updatedAt', record.updatedAt),
    ...optionalField('reviewer', record.reviewer),
  }));
  return orderArticlesByDateDesc(summaries);
});

const articlesForLocale = computed<readonly BlogArticleSummary[]>(() => articles.value ?? []);

/**
 * Landing có phải **fallback discovery** không: locale hiện tại không có bài
 * published nào. Chỉ landing mới rơi vào trạng thái này — article/series page
 * không tồn tại đã 404. Landing EN (locale có bài) không bao giờ fallback.
 */
const isFallbackDiscovery = computed(
  () => isBlogLanding.value && articlesForLocale.value.length === 0,
);

/**
 * Inventory English — nguồn dự phòng **duy nhất** của landing khi locale hiện
 * tại chưa có bài. Query riêng thay vì lọc lại từ `articles`: query của
 * `articlesForLocale` gắn theo `locale.value` và chỉ có một key cache, nên
 * inventory English phải là một `useAsyncData` riêng (đổi locale thì nó vẫn
 * hit cache EN thay vì phải query lại).
 *
 * **Key phải khác `blog:articles:${locale.value}`.** Trên route `/en/**` hai
 * chuỗi đó bằng nhau, còn hai handler có shape khác nhau (`select` 9 cột ở đây
 * vs 18 cột ở kia). `useAsyncData` gộp theo key và **key đã có cache thì handler
 * sau ăn luôn cache của handler trước** (`execute` trả `cachedData` trước khi
 * gọi handler) — nên trên `/en/**` key này chỉ mang **một** trong hai shape,
 * tùy cái nào được đăng ký trước, và shape còn lại là đọc nhầm. Đổi thứ tự hai
 * dòng code cũng đổi shape, đó là loại bug im lặng: HTML prerender vẫn đúng (chạy
 * server-side) nên test đọc HTML không bắt được, chỉ lộ ở payload hydrate.
 *
 * Hệ quả thứ hai của việc gộp key: handler thứ hai **không bao giờ chạy** trên
 * `/en/**`, nên `englishArticles` ở đây là 18 cột chứ không phải 9 — vô hại vì
 * chỉ đọc `seriesId` trong `seriesLandingEntries`, và cũng là lý do đừng thêm
 * cột vào query này khi chưa cần.
 *
 * Chỉ được đọc ở nhánh fallback — bao giờ trộn kết quả này vào `currentArticle`,
 * `related`, `adjacent` hay điều kiện 404: những thứ đó phục vụ **URL detail**,
 * vốn phải locale-specific (xem bất biến ở `landingInventory`).
 */
const { data: englishArticles } = await useAsyncData(
  'blog:articles:en:fallback-inventory',
  async () => {
    const records = await queryCollection('blog')
      .select(
        'path',
        'stem',
        'title',
        'description',
        'date',
        'author',
        'tags',
        'featured',
        'seriesId',
      )
      .where('path', 'LIKE', '/en/blog/%')
      .all();
    return orderArticlesByDateDesc(
      records.map((record) => ({
        path: record.path,
        stem: record.stem,
        title: record.title ?? '',
        description: record.description ?? '',
        date: record.date ?? '',
        author: record.author ?? '',
        tags: articleDisplayTags(record.tags),
        featured: record.featured ?? false,
        ...optionalField('seriesId', record.seriesId),
      })),
    );
  },
);

const englishInventory = computed<readonly BlogArticleSummary[]>(() => englishArticles.value ?? []);

/**
 * Inventory dùng cho **landing discovery** — tách khỏi `articlesForLocale` một
 * cách tường minh, đây là ranh giới quan trọng nhất của route.
 *
 * - Landing có bài ở locale → inventory là inventory của locale đó.
 * - Landing fallback (locale chưa có bài) → inventory là English.
 *
 * Featured, listing và khối series lấy từ đây, nên `/vi/blog` khi chưa có bài
 * tiếng Việt vẫn **hiển thị** các bài English thật: card trỏ tới path English
 * đã prerender, thông báo `ui.fallbackNotice` giải thích trạng thái. Trước đây
 * cả ba lấy từ danh sách rỗng nên landing rơi về trạng thái rỗng — phát hiện ra
 * fallback rồi không có gì để hiển thị.
 *
 * Cố ý **không** mutate hay ghi đè `articlesForLocale`: danh sách theo locale là
 * nguồn duy nhất cho `currentArticle`, related, pager và điều kiện 404. URL
 * detail vẫn locale-specific — `/vi/blog/<slug>` không tồn tại thì 404, không
 * render bằng bài English. Chỉ **khám phá** (landing) mới có fallback.
 */
const landingInventory = computed<readonly BlogArticleSummary[]>(() =>
  isFallbackDiscovery.value ? englishInventory.value : articlesForLocale.value,
);

/**
 * Article hiện tại (article page) — suy ra từ danh sách đã lọc theo locale để
 * summary/related/pager dùng đúng một nguồn dữ liệu.
 */
const currentArticle = computed<BlogArticleSummary | undefined>(() =>
  articlesForLocale.value.find((article) => article.path === route.path),
);

/**
 * 404 cho article page khi **không** dựng được nội dung: document query về
 * `null`, hoặc document có mà summary không map được (query listing lệch) —
 * cả hai đều không render được trang article hoàn chỉnh, và một trang rỗng
 * HTTP 200 (chỉ còn head SEO) là tệ hơn 404: nó vẫn bị index.
 *
 * Series page 404 khi series **không có bài published nào** ở locale hiện tại
 * (series không có trong `SERIES_META` đã bị loại ở `seriesId`computed — thành
 * article path không tồn tại → `page` null → 404 ở cùng nhánh). Series có bài
 * ở locale khác nhưng không ở locale này vẫn 404 — mỗi locale phục vụ content
 * của locale đó, không fallback trang khung rỗng.
 */
const seriesArticles = computed<readonly BlogArticleSummary[]>(() => {
  const id = seriesId.value;
  return id !== undefined ? orderArticlesBySeriesOrder(articlesForLocale.value, id) : [];
});

if (
  !isBlogLanding.value &&
  (page.value === null || currentArticle.value === undefined) &&
  // Series page hợp lệ chỉ khi có ít nhất một bài published ở locale này —
  // một `<ol>` rỗng HTTP 200 là trang series "trống rưỡi" đúng những gì
  // contract cấm (series chỉ tồn tại với người đọc khi có bài thật).
  (isSeriesPage.value ? seriesArticles.value.length === 0 : true)
) {
  throw createError({ statusCode: 404, statusMessage: 'Article not found' });
}

/** Hero của landing — featured, fallback bài mới nhất, `undefined` khi blog rỗng. */
const featuredArticle = computed(() => pickFeaturedArticle(landingInventory.value));

/**
 * Series hiện lên landing — suy ra từ content (bài thật), không phải từ
 * `SERIES_META`: series chưa có bài không xuất hiện, nên khối này không bao giờ
 * quảng bá một trang 404. Đây cũng là **đường duy nhất** crawler prerender tới
 * trang series overview (seed chỉ chứa hai landing; crawler đi theo link trong
 * HTML).
 *
 * Nhánh fallback dùng `seriesLandingEntries` với inventory English làm dự phòng:
 * series chỉ có bài EN phải liệt kê ở đây (kèm link `/en/blog/series/<id>`),
 * vì link `/vi/blog/series/<id>` sẽ 404. Xem helper để biết URL được chọn thế
 * nào theo locale thật sự có bài.
 */
const landingSeries = computed(() =>
  isFallbackDiscovery.value
    ? seriesLandingEntries([], locale.value, {
        articles: englishInventory.value,
        locale: 'en',
      })
    : seriesLandingEntries(articlesForLocale.value, locale.value),
);

/** Listing còn lại sau hero — khi không render hero thì là toàn bộ danh sách. */
const restArticles = computed<readonly BlogArticleSummary[]>(() => {
  const list = landingInventory.value;
  const featured = featuredArticle.value;
  if (!featured) {
    return list;
  }
  return list.filter((article) => article.path !== featured.path);
});

/**
 * Số lead phụ đứng cạnh hero ở `wide:`/`ultrawide:`.
 *
 * Hằng số nằm ở route (nơi cắt danh sách) chứ không ở view: view nhận danh
 * sách **đã cắt** và không được tự quyết định lấy bao nhiêu — cùng pattern với
 * `pickRelatedArticles(…, 3)` ở nhánh article.
 */
const SECONDARY_LEAD_LIMIT = 2;

/**
 * Lead phụ hiển thị cạnh hero ở màn rộng — hai bài **mới nhất ngay sau**
 * featured, theo cùng thứ tự hiển thị đã dùng cho `rest`.
 *
 * Cắt khỏi `rest` (xem `listedArticles`) để mỗi bài chỉ có **một** link trên
 * trang: lead phụ và card listing trỏ cùng một đích, lặp lại chỉ nhân bản
 * accessible name mà không thêm thông tin cho người đọc bằng screen reader.
 */
const secondaryLeads = computed<readonly BlogArticleSummary[]>(() =>
  restArticles.value.slice(0, SECONDARY_LEAD_LIMIT),
);

/** Listing dưới khối featured — đã trừ lead phụ nên không lặp link. */
const listedArticles = computed<readonly BlogArticleSummary[]>(() =>
  restArticles.value.slice(SECONDARY_LEAD_LIMIT),
);

/**
 * Related articles của article hiện tại — cùng tag chính, cùng locale, đã loại
 * article hiện tại (bất biến trong `pickRelatedArticles`).
 */
const relatedArticles = computed<readonly BlogArticleSummary[]>(() => {
  const current = currentArticle.value;
  return current ? pickRelatedArticles(articlesForLocale.value, current, 3) : [];
});

/**
 * Locale nào thực sự có bản dịch của **resource này**.
 *
 * **Landing** (`/en/blog`, `/vi/blog`): route tĩnh của mount — tồn tại ở
 * **mọi locale của registry**, độc lập với việc locale đó có article hay
 * không. Blog rỗng vẫn là landing hợp lệ (empty state), và landing của locale
 * kia vẫn là đích switch hợp lệ. Availability của landing vì vậy được suy
 * thẳng từ registry (`PUBLIC_LOCALES` + `buildPublicPath`), **không** từ số
 * article query được — suy từ article sẽ làm switcher biến mất đúng khi blog
 * đang trống, tức chính lúc landing là surface duy nhất còn lại.
 *
 * **Article**: một locale được coi là có bản dịch khi tồn tại article ở đúng
 * đường dẫn đó trong content — suy từ chính content, không phải giả định.
 * Nhờ vậy locale switcher của `PublicShell` chỉ link tới bản dịch có thật,
 * và một article chỉ có tiếng Anh không hiện link tiếng Việt hỏng. Không
 * bao giờ sinh URL switch cho bản dịch không tồn tại.
 *
 * Round-trip duy nhất cho mọi locale ở nhánh article: dựng trước candidate
 * path của từng registry locale rồi truy một lần với `where('path', 'IN',
 * paths)` — thay vì một query `.first()` mỗi locale. Candidate path bị
 * builder từ chối (topology — ví dụ remainder rơi vào mount lồng nhau) đơn
 * giản không nằm trong `IN`, tức locale đó không có bản dịch của resource.
 */
const { data: translationAvailability } = await useAsyncData(
  `blog:translations:${route.path}`,
  async () => {
    // Landing: mọi locale của registry đều có landing route — không query.
    if (isBlogLanding.value) {
      return blogLandingAvailableLocales();
    }
    // Series page: route là cục bộ theo locale — không quảng bá series page
    // của locale khác qua switcher (series có thể có bài ở EN mà chưa ở VI;
    // một switch link tới trang 404 là vi phạm bất biến của shell).
    if (isSeriesPage.value) {
      return [locale.value];
    }
    const resourceRemainder = remainder.value;
    const candidates = blogTranslationCandidates(resourceRemainder);
    // `IN ()` không phải SQL hợp lệ: không candidate nào thì không query —
    // không locale nào có bản dịch.
    if (candidates.length === 0) {
      return [];
    }
    const records = await queryCollection('blog')
      .select('path')
      .where('path', 'IN', candidates)
      .all();
    const existingPaths = new Set(records.map((record) => record.path));
    return blogArticleAvailableLocales(resourceRemainder, existingPaths);
  },
);

/**
 * Locale context truyền cho shell: locale hiện tại luôn nằm trong context (do
 * `resolveLocaleContext` bảo đảm), cộng các locale có bản dịch thật.
 */
const availableLocales = computed<readonly PublicLocale[]>(
  () => translationAvailability.value ?? [],
);

/**
 * Inventory **cả hai locale** — chỉ dùng cho quyết định SEO alternate.
 *
 * Đây là phần dữ liệu duy nhất trong route **không** phục vụ render: nó không
 * quyết định card nào hiện, series nào hiện, hay bài nào 404. Nó chỉ trả lời
 * "landing của locale X có phải landing thật (có bài) hay landing fallback?",
 * để `/en/blog` không quảng bá `hreflang="vi-VN"` trỏ tới một `/vi/blog` mà
 * chính nó khai là không có bản dịch.
 *
 * Query `LIKE` **một lệnh cho mỗi locale của registry**, không phải `IN`:
 * `where('path','IN', ['/en/blog/%','/vi/blog/%'])` là SQL sai ý nghĩa ở đây —
 * `IN` so bằng `=`, nên `%/blog/%` được so với path thật và **không khớp dòng
 * nào**. Kết quả là inventory rỗng, mọi landing rơi về "không locale nào có
 * bài", và `/en/blog` im lặng mất alternate `vi-VN`. `LIKE` mới là toán tử có
 * `%`. Tránh `LIKE '/%/blog/%'` cũng không được: `_` là wildcard một ký tự đúng
 * nghĩa, ý định "mọi locale" phải đến từ registry chứ không từ wildcard.
 *
 * Cần cả hai locale chứ không chỉ EN: khi `/vi/blog` đang render, chính `/en/blog`
 * mới là locale cần được kiểm tra có bài hay không — dùng EN vừa là dự phòng
 * vừa là landing đích.
 *
 * **Key cache gắn theo `route.path`, không dùng một key chung.** Key chung thì
 * landing prerender trước sẽ đóng băng kết quả inventory vào payload của nó,
 * landing kia đọc lại đúng payload đó và tưởng locale kia không có bài — kết
 * quả là `/en/blog` im lặng bỏ alternate `vi-VN` trong khi `/vi/blog` vẫn quảng
 * bá `en`. Cluster hreflang thành khai báo một chiều, đúng thứ policy này sinh
 * ra để chặn. Inventory là dữ liệu *theo trang*, nên cache cũng phải theo trang.
 */
const { data: localizedArticlePaths } = await useAsyncData(
  `blog:article-locale-inventory:${route.path}`,
  async () => {
    const perLocale = await Promise.all(
      PUBLIC_LOCALES.map(async (definition) => {
        const records = await queryCollection('blog')
          .select('path')
          .where('path', 'LIKE', `/${definition.code}/blog/%`)
          .all();
        return records.map((record) => record.path);
      }),
    );
    // Mảng, **không phải `Set`**: payload prerender của Nuxt không serialize
    // `Set` — nó ghi thành `["Set"]`, tức tập rỗng, và mọi quyết định SEO trên
    // landing rơi về "không locale nào có bài". Lỗi này im lặng: trang vẫn dựng,
    // chỉ mất alternate. Xem `blogLandingArticleLocales`.
    return perLocale.flat();
  },
);

const landingArticleLocales = computed<readonly PublicLocale[]>(() =>
  blogLandingArticleLocales(localizedArticlePaths.value ?? []),
);

/**
 * Locale dùng cho **SEO alternate** — tách khỏi `availableLocales` của
 * locale switcher vì hai khái niệm này **không** cùng nghĩa: switcher theo
 * route (landing tồn tại ở mọi locale), hreflang theo content (chỉ locale có
 * bài thật). Policy đầy đủ và lý do nằm ở `blogSeoAlternateLocales`.
 */
const seoLocales = computed<readonly PublicLocale[]>(() =>
  blogSeoAlternateLocales({
    fallbackDiscovery: isFallbackDiscovery.value,
    locale: locale.value,
    kind: isBlogLanding.value ? 'landing' : isSeriesPage.value ? 'series' : 'article',
    switcherLocales: availableLocales.value,
    articleLocales: landingArticleLocales.value,
  }),
);

/**
 * Bảng identity `articleId` → path — nguồn resolve mọi reference biên tập
 * (prerequisites, related) thành URL thật trước khi render.
 *
 * Query **hai locale trong một lần** (`LIKE '/%/blog/%'` không dùng — SQL LIKE
 * với `_` là wildcard một ký tự đúng nghĩa, nhưng ý định "mọi locale" được
 * diễn đạt tường minh bằng IN trên hai prefix registry): reference fallback
 * về English khi bản dịch locale hiện tại không có, nên bảng phủ cả hai
 * locale. Trên landing/series vẫn chạy — chi phí một select 4 cột là nhỏ và
 * giữ code path duy nhất.
 *
 * `title` nằm trong bảng này vì **nhãn link phải là title của bài** (không phải
 * URL): cùng một lần tra identity đã biết bài nào được trỏ tới, lấy title ở
 * đó rẻ hơn và không thể lệch — tra title ở consumer là một nguồn sự thật thứ
 * hai cho cùng một câu hỏi.
 */
const { data: identityRecords } = await useAsyncData('blog:identity-records', async () => {
  const records = await queryCollection('blog')
    .where('path', 'LIKE', '/%/blog/%')
    .select('articleId', 'path', 'title')
    .all();
  const mapped: ArticleIdentityRecord[] = [];
  for (const record of records) {
    if (record.articleId === null || record.articleId === undefined) {
      continue;
    }
    const articleLocale = (/^\/(en|vi)\//u.exec(record.path)?.[1] ?? 'en') as PublicLocale;
    mapped.push({
      articleId: record.articleId,
      locale: articleLocale,
      path: record.path,
      title: record.title ?? '',
    });
  }
  return mapped;
});

const identityTable = computed<readonly ArticleIdentityRecord[]>(() => identityRecords.value ?? []);

/**
 * Prerequisites và curated related của article hiện tại — resolve
 * **một lần ở route** thành `{path, title}` theo policy fallback (same-locale →
 * English), bỏ ID không tồn tại. Component chỉ nhận tham chiếu đã validate —
 * không bao giờ sinh link 404 dù frontmatter tham chiếu sai.
 */
const prerequisiteReferences = computed<readonly RenderableReference[]>(() => {
  const current = currentArticle.value;
  if (current === undefined) {
    return [];
  }
  return resolveReferences(identityTable.value, current.prerequisiteIds ?? [], locale.value);
});

const curatedRelatedReferences = computed<readonly RenderableReference[]>(() => {
  const current = currentArticle.value;
  if (current === undefined) {
    return [];
  }
  return resolveReferences(identityTable.value, current.relatedArticleIds ?? [], locale.value);
});

/**
 * Cặp previous/next của article page — nguồn duy nhất là
 * `pickAdjacentArticles` (trong `blog-articles.ts`, unit test): ngữ nghĩa theo
 * trục thời gian ("previous" = cũ hơn, "next" = mới hơn), biên danh sách cho
 * `undefined`, không bọc vòng, không bao giờ chứa chính article hiện tại.
 *
 * Không dùng `queryCollectionItemSurroundings` ở đây: hàm đó sort theo `stem`
 * trên **toàn collection** mà không lọc được theo locale ở tầng SQL theo cách
 * bảo đảm thứ tự editorial (cây navigation trộn hai locale trước khi lọc), và
 * landing `index.md` của từng article cũng lọt vào sequence. Danh sách phẳng
 * đã sort trong tay là đúng nguồn duy nhất cho pager của blog phẳng.
 */
const adjacentArticles = computed(() => {
  const current = currentArticle.value;
  return current ? pickAdjacentArticles(articlesForLocale.value, current) : undefined;
});

/**
 * Điều hướng series của article hiện tại — `undefined` khi bài không thuộc
 * series (component không render khối). Prev/next là hàng xóm trong **thứ tự
 * học tập** (`seriesOrder`), không phải thời gian; title lấy từ summary của
 * từng bài hàng xóm trong locale hiện tại.
 */
const currentArticleSeries = computed(() => {
  const current = currentArticle.value;
  if (current?.seriesId === undefined) {
    return undefined;
  }
  const meta = getSeriesMeta(current.seriesId);
  if (meta === undefined) {
    return undefined;
  }
  const neighbors = seriesNeighbors(articlesForLocale.value, current);
  return {
    id: current.seriesId,
    meta,
    previous:
      neighbors?.previous !== undefined
        ? { path: neighbors.previous.path, title: neighbors.previous.title ?? '' }
        : undefined,
    next:
      neighbors?.next !== undefined
        ? { path: neighbors.next.path, title: neighbors.next.title ?? '' }
        : undefined,
  };
});

/**
 * SEO: `lang` từ registry locale (hreflang `vi-VN` chứ không phải code `vi`),
 * title theo template `<article title> · Ecoma Blog`, description từ
 * frontmatter, canonical là URL hiện tại, và alternate hreflang cho locale có
 * **bản dịch thật** (`seoLocales`, không phải availability của switcher).
 *
 * Title/description theo **loại trang**, mỗi loại một nguồn:
 *
 * - **Article**: `title`/`description` frontmatter của chính bài.
 * - **Series overview**: `SERIES_META` của series — trang này **không có
 *   document** trong collection (chỉ article có file content), nên lấy
 *   `page.value` ở đây luôn rơi về `null` và title rơi về `Ecoma Blog`, mô tả
 *   rỗng. Một series là chương trình đọc có tên và có mô tả riêng; phát
 *   metadata chung của blog cho nó là mất thông tin mà `SERIES_META` đã có.
 * - **Landing**: không có title frontmatter, `buildBlogSeo` phát
 *   `Ecoma Blog` (brand + bề mặt, đúng một lần).
 *
 * Landing fallback (`/vi/blog` không có bài) phát `noindex, follow` và bỏ
 * alternate — policy đầy đủ trong `blog-seo.ts` (đã unit test).
 */
const seo = computed(() =>
  buildBlogSeo({
    pathname: route.path,
    locale: locale.value,
    title: currentArticle.value?.title ?? seriesMeta.value?.title ?? page.value?.title,
    description:
      currentArticle.value?.description ?? seriesMeta.value?.description ?? page.value?.description,
    availableLocales: seoLocales.value,
    fallbackDiscovery: isFallbackDiscovery.value,
  }),
);

useHead(() => ({
  htmlAttrs: { lang: seo.value.lang },
  title: seo.value.title,
  // Description rỗng thì **không** emit meta — meta `content=""` là metadata
  // sai (các crawler hiện trích snippet từ nội dung khi thiếu description) và
  // prerendered HTML sẽ mang rác tĩnh khó thay sau khi deploy.
  meta: [
    ...(seo.value.description === ''
      ? []
      : [{ name: 'description' as const, content: seo.value.description }]),
    // Robots chỉ emit khi page ở trạng thái đặc biệt (landing fallback) —
    // mọi page bình thường không mang thẻ robots nào.
    ...(seo.value.robots ? [{ name: 'robots' as const, content: seo.value.robots }] : []),
  ],
  link: [
    { rel: 'canonical' as const, href: seo.value.canonical },
    ...seo.value.alternates.map((alternate) => ({
      rel: 'alternate' as const,
      hreflang: alternate.hreflang,
      href: alternate.href,
    })),
  ],
}));
</script>

<template>
  <BlogSeriesLandingView
    v-if="seriesId !== undefined && seriesMeta !== undefined"
    :locale="locale"
    :series-id="seriesId"
    :meta="seriesMeta"
    :articles="seriesArticles"
    :available-locales="[locale]"
    :ui="blogUiStrings(locale)"
  />
  <BlogLandingView
    v-else-if="isBlogLanding"
    :locale="locale"
    :featured="featuredArticle"
    :secondary-leads="secondaryLeads"
    :rest="listedArticles"
    :fallback="isFallbackDiscovery"
    :series="landingSeries"
    :available-locales="availableLocales"
    :ui="blogUiStrings(locale)"
  />
  <BlogArticleView
    v-else-if="currentArticle && page"
    :locale="locale"
    :page="page"
    :summary="currentArticle"
    :related="relatedArticles"
    :curated-related="curatedRelatedReferences"
    :prerequisites="prerequisiteReferences"
    :previous="adjacentArticles?.previous"
    :next="adjacentArticles?.next"
    :available-locales="availableLocales"
    :series="currentArticleSeries"
    :ui="blogUiStrings(locale)"
  />
</template>
