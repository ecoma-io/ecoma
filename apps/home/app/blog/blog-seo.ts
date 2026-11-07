/**
 * Dựng head/SEO của một blog page — tách khỏi route để test được các bất biến
 * về `lang`, canonical, hreflang mà không cần dựng Nuxt runtime.
 *
 * Quy tắc đang được pin ở đây:
 *
 * - `lang` lấy từ registry locale (`hreflang`), **không** phải locale code:
 *   `vi` → `vi-VN`. Đây là điểm dễ sai nhất khi ai đó "tối ưu" bằng cách
 *   truyền thẳng `locale` vào `htmlAttrs.lang`.
 * - canonical luôn là URL của **pathname hiện tại** (không phải landing, không
 *   phải bản dịch) — mỗi URL tự canonical chính nó.
 * - hreflang chỉ sinh cho locale **có bản dịch thật** và đi qua `switchLocale`
 *   của `app/i18n`, không ghép chuỗi `/${locale}${...}` thủ công.
 * - origin là hằng số `ecoma.io` (`./blog-origin`): không đọc host của
 *   request nên kết quả deterministic và không phụ thuộc môi trường preview.
 * - title rỗng/thiếu thì phát `Ecoma Blog` (brand + tên bề mặt, đúng một lần);
 *   title thật đi qua template `<title> · Ecoma Blog` — không bao giờ sinh
 *   separator lơ lửng hay lặp tên bề mặt (`Blog · Ecoma Blog`).
 */

import {
  PUBLIC_LOCALES,
  getLocaleDefinition,
  switchLocale,
  type PublicLocale,
} from '../i18n/index';
import { toProductionUrl } from './blog-origin';
import { blogUiStrings } from './blog-ui-strings';

/** Một link `alternate` hreflang đã dựng sẵn cho `useHead`. */
export type BlogAlternateLink = {
  readonly rel: 'alternate';
  readonly hreflang: string;
  readonly href: string;
};

/** Head đã resolve của một blog page. */
export type BlogSeo = {
  /** Giá trị `htmlAttrs.lang` — lấy từ registry (`en`, `vi-VN`). */
  readonly lang: string;
  /** `document.title`. */
  readonly title: string;
  /**
   * `description` từ frontmatter (rỗng nếu page không khai báo).
   *
   * Chuỗi rỗng là contract có chủ ý: route bỏ hẳn thẻ meta description khi giá
   * trị rỗng, thay vì phát một thẻ rỗng. Việc bỏ thẻ thuộc route, không phải hàm
   * thuần này.
   */
  readonly description: string;
  /** URL tuyệt đối canonical của chính pathname hiện tại. */
  readonly canonical: string;
  /** Link `alternate` cho các locale có bản dịch thật. */
  readonly alternates: readonly BlogAlternateLink[];
  /**
   * Giá trị thẻ meta robots cho page — `undefined` khi **không** emit thẻ nào
   * (mọi page bình thường). Chỉ landing fallback (`noIndex === true`) nhận
   * `noindex, follow`.
   */
  readonly robots: string | undefined;
};

/**
 * Head của một blog page.
 *
 * `availableLocales` là tập locale **thực sự có document** ở cùng resource
 * path (route resolve bằng query, không phải suy đoán); truyền vào thay vì để
 * hàm tự query giữ cho hàm thuần và test được. Locale không nằm trong tập này
 * không sinh hreflang — một page chỉ có tiếng Anh sẽ không quảng bá bản dịch
 * tiếng Việt 404.
 *
 * `fallbackDiscovery` chỉ đúng cho **landing fallback** — locale hiện tại
 * không có article nào nên landing chỉ còn là surface khám phá các bài
 * English. Page như vậy **không phải bản dịch** của landing locale kia:
 * hreflang chéo (EN ⇄ VI) sẽ quảng bá một "bản dịch" không tồn tại, và landing
 * content không khớp ngôn ngữ đang bị index sẽ lấy tín hiệu ngôn ngữ sai.
 * Policy: giữ self-canonical (URL thật vẫn tồn tại, không redirect), phát
 * `noindex, follow` và **bỏ toàn bộ alternate** — crawler vẫn đi tiếp theo
 * link bài English, nhưng không index surface trung gian này.
 */
export function buildBlogSeo(input: {
  readonly pathname: string;
  readonly locale: PublicLocale;
  readonly title: string | undefined;
  readonly description: string | undefined;
  readonly availableLocales: readonly PublicLocale[];
  /** True khi page là landing fallback (locale hiện tại không có bài published). */
  readonly fallbackDiscovery?: boolean;
}): BlogSeo {
  const strings = blogUiStrings(input.locale);

  const alternates: BlogAlternateLink[] = [];
  if (!input.fallbackDiscovery) {
    for (const definition of PUBLIC_LOCALES) {
      if (!input.availableLocales.includes(definition.code)) {
        continue;
      }
      // `switchLocale` (không ghép chuỗi): giữ nguyên phần resource và chỉ đổi
      // segment locale, đúng contract của `app/i18n`.
      const switched = switchLocale(input.pathname, definition.code);
      if (switched.kind !== 'localized') {
        continue;
      }
      alternates.push({
        rel: 'alternate',
        hreflang: definition.hreflang,
        href: toProductionUrl(switched.path),
      });
    }
  }

  return {
    // `hreflang` của registry, không phải `locale` code: `vi` → `vi-VN`.
    lang: getLocaleDefinition(input.locale)?.hreflang ?? input.locale,
    // Title rỗng/thiếu thì phát đúng một lần `Ecoma Blog` — template đầy đủ
    // lặp tên bề mặt hai lần (`Blog · Ecoma Blog`), thừa và giống hệt nhau ở
    // mọi locale, mất tín hiệu locale cho crawler. `trim()` vì frontmatter
    // `"  Tiêu đề  "` không được lọt vào title.
    title: input.title?.trim()
      ? `${input.title.trim()} · Ecoma ${strings.blog}`
      : `Ecoma ${strings.blog}`,
    description: input.description ?? '',
    canonical: toProductionUrl(input.pathname),
    alternates,
    // Landing fallback: `noindex, follow` — self-canonical giữ nguyên phía trên.
    robots: input.fallbackDiscovery ? 'noindex, follow' : undefined,
  };
}
