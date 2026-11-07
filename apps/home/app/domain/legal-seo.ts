/**
 * SEO payload cho bề mặt legal — mirror của `blog-seo.ts` cho mount `legal`.
 *
 * Quy tắc pin ở đây:
 *
 * - `lang` lấy từ registry locale (`hreflang`), **không** phải locale code:
 *   `vi` → `vi-VN`.
 * - canonical luôn là URL tuyệt đối của chính pathname hiện tại, dưới
 *   production origin (`~/domain/home-origin`) — không đọc host request.
 * - hreflang chỉ sinh cho locale **có bản dịch thật** — tập
 *   `availableLocales` do route resolve bằng query content, không suy đoán.
 *   Locale thiếu bản dịch không được quảng bá hreflang hỏng. Khác bản cũ
 *   (alternates phủ toàn bộ registry giả định mọi policy có cả hai locale) —
 *   hợp lệ cho registry cũ vì nó type-enforce cặp đầy đủ; với content Markdown
 *   thì bản dịch thiếu là trạng thái hợp lệ, hreflang sai sẽ quảng bá 404.
 * - origin là hằng số policy của Home; hàm thuần, không đọc `Date`/request.
 */

import {
  getLocaleDefinition,
  PUBLIC_LOCALES,
  switchLocale,
  type PublicLocale,
} from '../i18n/index';
import { toProductionUrl } from './home-origin';

/** Một `<link rel="alternate" hreflang=…>` cho một locale khác của resource. */
export type LegalAlternateLink = {
  readonly rel: 'alternate';
  readonly hreflang: string;
  readonly href: string;
};

/** Toàn bộ metadata SEO của một trang legal. */
export type LegalSeo = {
  /** Giá trị `lang` cho `<html>` — BCP-47 (`vi-VN`), không phải locale code. */
  readonly lang: string;
  /** `<title>` localized. */
  readonly title: string;
  /** `meta[name=description]` localized. */
  readonly description: string;
  /** Canonical URL tuyệt đối của chính trang — luôn self-canonical. */
  readonly canonicalUrl: string;
  /** `alternate` hreflang chỉ cho các locale có bản dịch thật (kèm self-reference). */
  readonly alternates: readonly LegalAlternateLink[];
};

/**
 * Dựng SEO payload cho trang legal `pathname` của `locale`.
 *
 * `availableLocales` là tập locale thực sự có văn bản ở cùng resource (route
 * resolve bằng query) — luôn chứa chính `locale`. Title ở đây đã là title
 * frontmatter của văn bản (route truyền thẳng); landing truyền title surface.
 */
export function buildLegalSeo(input: {
  readonly pathname: string;
  readonly locale: PublicLocale;
  readonly title: string;
  readonly description: string;
  readonly availableLocales: readonly PublicLocale[];
}): LegalSeo {
  const alternates: LegalAlternateLink[] = [];
  for (const definition of PUBLIC_LOCALES) {
    if (!input.availableLocales.includes(definition.code)) {
      continue;
    }
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

  return {
    lang: getLocaleDefinition(input.locale)?.hreflang ?? input.locale,
    title: input.title,
    description: input.description,
    canonicalUrl: toProductionUrl(input.pathname),
    alternates,
  };
}
