/**
 * SEO payload cho một trang Home — pure, **derive hoàn toàn** từ registry
 * locale của `app/i18n` và public URL constructor của `app/layout`.
 *
 * Tách khỏi page để phần metadata kiểm chứng được **không cần** Nuxt runtime:
 * `useHead` chỉ là lớp vận chuyển kết quả của hàm này vào `<head>`; mọi quyết
 * định (lang nào, canonical URL nào, alternate nào) nằm ở đây và được test
 * trực tiếp bằng Vitest.
 *
 * Không có bảng locale thứ hai: `lang`/`hreflang` đọc từ
 * `getLocaleDefinition()` (`en` → `en`, `vi` → `vi-VN`) và alternate được
 * sinh bằng cách duyệt chính `PUBLIC_LOCALES`.
 *
 * **Mọi URL là tuyệt đối dưới production origin** (`home-origin.ts`): pathname
 * vẫn do `buildPublicPath` dựng (nguồn topology duy nhất), nhưng canonical và
 * `hreflang` bắt buộc phải tuyệt đối — xem `HOME_PRODUCTION_ORIGIN` để biết vì
 * sao origin không được lấy từ request.
 */

import { getLocaleDefinition, PUBLIC_LOCALES, type PublicLocale } from '../i18n/index';
import { buildPublicPath } from '../layout/index';
import { toProductionUrl } from './home-origin';

/**
 * Một `<link rel="alternate" hreflang=…>` cho một locale khác của resource.
 *
 * `rel` là literal `'alternate'` (không phải `string`) vì unhead phân biệt
 * alternate-language link với các loại link khác bằng chính literal đó —
 * để `string` sẽ mất type discrimination và trường `hreflang` không được nhận.
 *
 * `href` là URL **tuyệt đối** dưới production origin: `hreflang` là khai báo
 * cho crawler về một resource trên một hostname cụ thể, nên một href tương đối
 * sẽ bị resolve theo hostname đang phục vụ — đúng thứ mà `home-origin.ts` loại
 * trừ.
 */
export type HomeAlternateLink = {
  readonly rel: 'alternate';
  readonly hreflang: string;
  readonly href: string;
};

/** Toàn bộ metadata SEO của một trang Home. */
export type HomeSeo = {
  /** Giá trị `lang` cho `<html>` — BCP-47 (`vi-VN`), không phải locale code. */
  readonly lang: string;
  /** `<title>` localized. */
  readonly title: string;
  /** `meta[name=description]` localized. */
  readonly description: string;
  /**
   * Canonical URL **tuyệt đối** của chính trang (`https://ecoma.io/en`) —
   * luôn self-canonical, luôn dưới production origin.
   */
  readonly canonicalUrl: string;
  /** Hai chiều `en` ↔ `vi-VN` để crawler biết các biến thể ngôn ngữ. */
  readonly alternates: readonly HomeAlternateLink[];
};

/**
 * URL tuyệt đối của locale-root surface cho một locale trong registry
 * (`https://ecoma.io/en`, `https://ecoma.io/vi`).
 *
 * Pathname dựng qua `buildPublicPath` (không ghép chuỗi) — nguồn duy nhất của
 * locale-root path; origin do `toProductionUrl` áp, cũng qua `new URL`. Nhánh
 * `invalid` là bất khả với locale đã thuộc registry — ném lỗi thay vì fallback
 * để một thay đổi registry sau này không âm thầm sinh ra URL sai.
 */
function localeRootUrl(locale: PublicLocale): string {
  const built = buildPublicPath({ locale });
  if (built.kind === 'invalid') {
    throw new Error(`Unbuildable public path for locale "${locale}"`);
  }
  return toProductionUrl(built.path);
}

/**
 * Dựng SEO payload cho trang Home của `locale`.
 *
 * `canonicalUrl` **luôn** là locale-root surface của chính locale đó, không
 * bao giờ là `/` (`/` chỉ là locale-resolution entry point, không serve
 * content) và không bao giờ trỏ sang locale khác. `alternates` phủ **toàn bộ**
 * registry nên `hreflang` luôn hai chiều — kể cả self-reference: trang `/en`
 * khai `/vi` **và** chính `/en`, đúng yêu cầu của Google về `hreflang` hai
 * chiều kèm self-referencing.
 *
 * Hàm thuần theo `(locale, content)`: không đọc request, không đọc hostname,
 * không `Date`/random — cùng input luôn cho cùng payload, ở mọi environment.
 */
export function buildHomeSeo(
  locale: PublicLocale,
  content: { title: string; description: string },
): HomeSeo {
  return {
    lang: getLocaleDefinition(locale)?.hreflang ?? locale,
    title: content.title,
    description: content.description,
    canonicalUrl: localeRootUrl(locale),
    alternates: PUBLIC_LOCALES.map((definition) => ({
      rel: 'alternate' as const,
      hreflang: definition.hreflang,
      href: localeRootUrl(definition.code),
    })),
  };
}
