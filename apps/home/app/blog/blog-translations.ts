/**
 * Logic thuần của translation availability cho blog — tách khỏi route để
 * test được đúng 5 scenario regression của Finding 1 mà không cần dựng Nuxt
 * runtime hay SQLite query.
 *
 * `translationAvailability` trong route gọi helper này với kết quả query
 * `where('path', 'IN', candidates)`; helper là **hàm thuần** trên
 * (isLanding, candidates, existingPaths) nên mọi case — blog trống hai locale,
 * chỉ EN, chỉ VI, landing switch, article switch — test được trên data tĩnh.
 */

import { PUBLIC_LOCALES, type PublicLocale } from '../i18n/index';
import { buildPublicPath } from '../layout/index';

/**
 * Cặp `{ locale, path }` cho **một** resource trên **mọi** registry locale —
 * nguồn suy ra duy nhất của cả ba helper dưới đây.
 *
 * `path` là candidate của query `where('path', 'IN', …)`; `locale` là phần tử
 * của tập availability. Ba hàm export cùng chạy trên danh sách này nên
 * candidate dùng để query và candidate dùng để lọc `existingPaths` không bao
 * giờ tách nhau — sửa contract (buildPublicPath/PUBLIC_LOCALES) chỉ cần đúng
 * một chỗ.
 */
function blogLocalizedEntries(
  remainder?: string,
): readonly { locale: PublicLocale; path: string }[] {
  return PUBLIC_LOCALES.flatMap((definition) => {
    const built = buildPublicPath({
      locale: definition.code,
      mount: 'blog',
      ...(remainder === undefined ? {} : { path: remainder }),
    });
    return built.kind === 'localized' ? [{ locale: definition.code, path: built.path }] : [];
  });
}

/** Tập locale có landing của mount `blog` — landing là route tĩnh của mount, tồn tại ở mọi registry locale. */
export function blogLandingAvailableLocales(): readonly PublicLocale[] {
  return blogLocalizedEntries().map((entry) => entry.locale);
}

/**
 * Path của **mọi registry locale** cho mount `blog` — dùng để so khớp inventory
 * path thật với locale mà nó thuộc về, thay vì parse `path` bằng tay. Parse tay
 * dễ lệch với `buildPublicPath` ở đúng trường hợp quan trọng nhất: cột bắt đầu
 * bằng `<locale>` của một locale khác (`/en/blog/...` **không** phải bài của
 * `end`), nên đoán sai thì `/en/blog` tưởng `vi` có bài và lại phát alternate
 * `vi-VN` — đúng lỗi policy này sinh ra để chặn.
 */
export function blogLocalePaths(): readonly { locale: PublicLocale; path: string }[] {
  return blogLocalizedEntries().map((entry) => ({ locale: entry.locale, path: entry.path }));
}

/**
 * Tập locale **thực sự có bài** của mount blog — khác `blogLandingAvailableLocales`
 * ở đúng một điểm: landing tồn tại ở mọi locale, còn *nội dung* thì không.
 *
 * Cần cho SEO alternate: `/en/blog` có bài (nên không phải landing fallback),
 * nhưng nếu `/vi/blog` rỗng thì `/vi/blog` chính là surface fallback — và quảng
 * bá `vi-VN` trỏ tới nó là khai báo một chiều. Định nghĩa "có bài published" ở
 * đây phải trùng **đúng** điều kiện mà route dùng cho `isFallbackDiscovery`
 * (landing mà inventory rỗng), nếu không hai nơi sẽ phán quyết khác nhau về
 * cùng một landing và lại quay về khai báo hreflang sai.
 *
 * Nhận **collection path thật** (`select('path')` không lọc theo path để gọn
 * payload) chứ không nhận `ReadonlySet` đã lọc: `Set` không serialize qua payload
 * prerender của Nuxt — `useAsyncData` trả về `["Set"]`, tập rỗng, và mọi quyết
 * định SEO trên landing rơi về "không locale nào có bài".
 */
export function blogLandingArticleLocales(
  articlePaths: readonly string[],
): readonly PublicLocale[] {
  return blogLocalePaths()
    .filter((entry) => articlePaths.some((path) => path.startsWith(`${entry.path}/`)))
    .map((entry) => entry.locale);
}

/**
 * Tập locale có bản dịch của resource `remainder` — suy từ tập path tồn tại
 * trong content.
 *
 * Locale không sinh được candidate path hợp lệ (topology từ chối) hoặc
 * candidate không nằm trong `existingPaths` thì không có bản dịch — điều này
 * giữ bất biến "không bao giờ sinh URL switch cho bản dịch không tồn tại".
 */
export function blogArticleAvailableLocales(
  remainder: string,
  existingPaths: ReadonlySet<string>,
): readonly PublicLocale[] {
  return blogLocalizedEntries(remainder)
    .filter((entry) => existingPaths.has(entry.path))
    .map((entry) => entry.locale);
}

/**
 * Candidate path của **mọi registry locale** cho resource `remainder` — đầu
 * vào của query `where('path', 'IN', candidates)`.
 *
 * Export riêng để test khẳng định tập candidate không phụ thuộc content (một
 * article chỉ có EN vẫn sinh candidate VI — VI bị loại ở bước khớp
 * `existingPaths`, không phải ở bước dựng candidate).
 */
export function blogTranslationCandidates(remainder: string): readonly string[] {
  return blogLocalizedEntries(remainder).map((entry) => entry.path);
}

/**
 * Tập locale dùng cho **SEO alternate** — tách khỏi
 * `availableLocales` của locale switcher vì hai khái niệm này **không** cùng
 * nghĩa.
 *
 * `availableLocales` trả lời "switcher có nên link tới locale này không?" —
 * landing là route tĩnh của mount nên tồn tại ở **mọi** registry locale, kể cả
 * locale chưa có bài nào; switcher vẫn phải dẫn người đọc tới landing khám phá
 * của locale đó. Suy availability từ số bài sẽ làm switcher biến mất đúng
 * lúc landing là surface duy nhất còn lại.
 *
 * Hàm này trả lời "locale này có **bản dịch thật** của resource này không?" —
 * và đó mới là điều kiện để phát `hreflang`. Landing fallback **không phải**
 * bản dịch của landing locale kia: nó chỉ là surface khám phá các bài English,
 * tự nó phát `noindex, follow` và không phát alternate nào (xem `blog-seo.ts`).
 * Nếu `/en/blog` vẫn quảng bá `vi-VN` trỏ tới `/vi/blog`, cluster thành một
 * khai báo **một chiều**: một phía nói "hai trang này là bản dịch của nhau",
 * phía kia nói "tôi không có bản dịch nào" — crawler không hợp nhất được, và
 * tín hiệu ngôn ngữ của `/vi/blog` lại là tiếng Anh.
 *
 * Nói ngắn gọn: **switcher theo route, hreflang theo content**. Landing có bài
 * thật thì hai tập trùng nhau và hành vi cũ giữ nguyên; chỉ khi locale rỗng thì
 * chúng tách ra.
 *
 * Hàm thuần nên policy này test được không cần dựng Nuxt runtime — trạng thái
 * English-first (`fallbackDiscovery`) là đầu vào, không phải thứ phải dựng DB
 * mới quan sát được.
 */
export function blogSeoAlternateLocales(input: {
  /** Landing fallback: locale hiện tại không có bài published nào. */
  readonly fallbackDiscovery: boolean;
  /** Locale của trang đang render. */
  readonly locale: PublicLocale;
  /**
   * Loại resource mà `switcherLocales` đang mô tả.
   *
   * Ba loại có **ba** câu hỏi khác nhau về "có bản dịch thật không", và gộp
   * chúng là lỗi:
   *
   * - `landing`: "locale này có bài **nào** không" — landing của locale rỗng là
   *   surface fallback, không phải bản dịch. Đây là chỗ duy nhất cần lọc
   *   `switcherLocales` theo content.
   * - `article`: `switcherLocales` **đã** là tập locale có bản dịch của chính
   *   bài đó (suy từ `where('path','IN',candidates)`). Lọc thêm theo "có bài
   *   nào" là vô nghĩa và nguy hiểm — locale có bản dịch của bài này thì chắc
   *   chắn có ít nhất một bài.
   * - `series`: route đã trả `[locale]` vì series page là route cục bộ theo
   *   locale, không quảng bá bản dịch chéo.
   */
  readonly kind: 'landing' | 'article' | 'series';
  /** Locale switcher availability (suy từ route, không từ content). */
  readonly switcherLocales: readonly PublicLocale[];
  /**
   * Locale **thực sự có bài** của blog (`blogLandingArticleLocales` trên tập
   * path đã query). Chỉ đọc khi `kind === 'landing'`.
   *
   * Input này tồn tại vì trang landing **không** phải fallback cũng cần biết:
   * `/en/blog` có bài nên `fallbackDiscovery` là `false`, nhưng nó vẫn phải loại
   * `vi` khỏi alternate khi `/vi/blog` rỗng — nếu không, chính `/en/blog` phát
   * `hreflang="vi-VN"` trỏ tới một landing fallback tự khai "không có bản dịch".
   */
  readonly articleLocales?: readonly PublicLocale[];
}): readonly PublicLocale[] {
  // Fallback: chỉ locale hiện tại, và `buildBlogSeo` còn bỏ hết alternate qua
  // cờ `fallbackDiscovery`. Cả hai lớp cùng nhau — lớp ở đây giữ tập locale
  // không tràn ra ngoài trang hiện tại, cờ trong helper giữ chính sách robots.
  if (input.fallbackDiscovery) {
    return [input.locale];
  }
  // Chỉ landing mới cần lọc theo content (xem `kind`). Article và series đã
  // mang đúng tập bản dịch từ `switcherLocales`.
  const withContent =
    input.kind === 'landing'
      ? input.switcherLocales.filter((locale) => (input.articleLocales ?? []).includes(locale))
      : input.switcherLocales;
  // Trang hiện tại luôn được giữ: landing non-fallback theo định nghĩa đã có bài
  // nên nó có mặt, nhưng guard này giữ đúng bất biến "self-referential
  // alternate" ngay cả khi caller đưa vào một tập rỗng (cluster một phía vẫn
  // phải trỏ về chính nó theo khuyến nghị hreflang của Google).
  return withContent.includes(input.locale) ? withContent : [input.locale, ...withContent];
}
