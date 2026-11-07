/**
 * Thuần dữ liệu trên records của collection `legal` — tách khỏi route để
 * test được grouping/draft-gate/translation trên data tĩnh mà không cần dựng
 * Nuxt runtime hay SQLite query.
 *
 * Route gọi `queryCollection('legal')` rồi đưa records vào các hàm thuần ở
 * đây: cùng input cho cùng output, không đọc request, không `Date.now()`.
 *
 * Record đầu vào là structural subset của `LegalCollectionItem` (@nuxt/content)
 * — chỉ các cột thực sự được query (`.select(...)`) — nên hàm dùng được cả
 * trên payload đầy đủ lẫn payload đã select cột.
 */

/** Nhóm hiển thị trên landing — phải khớp enum `category` của `legalSchema`. */
export type LegalCategory = 'policy' | 'terms';

/** Trạng thái xuất bản — phải khớp enum `status` của `legalSchema`. */
export type LegalPublicationStatus = 'draft' | 'published';

/** Record tối thiểu mà domain functions cần từ một query collection `legal`. */
export type LegalDocumentRecord = {
  /** Path đầy đủ — `/en/legal/privacy`, do prefix của collection đảm bảo. */
  readonly path: string;
  /** Slug — phần sau `/<locale>/legal/`, không prefix số ordering. */
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly category: LegalCategory;
  readonly status: LegalPublicationStatus;
  readonly reviewStatus: 'unreviewed' | 'reviewed';
  readonly version: string;
  /** ISO date hoặc `null` khi không khai — draft chưa chốt hiệu lực. */
  readonly effectiveDate: string | null;
  /** Locale code của văn bản — segment đầu của `path`. */
  readonly locale: 'en' | 'vi';
};

/** Thứ tự category hiển thị trên landing — policy trước terms. */
const CATEGORY_ORDER: readonly LegalCategory[] = ['policy', 'terms'];

/**
 * Slug hợp lệ của collection: chữ thường + gạch nối, khớp cách mọi slug
 * hiện tại được đặt. Dùng cho validation dữ liệu seed ở test — schema zod
 * không nhìn được tên file.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** Tách slug từ path collection (`/en/legal/privacy` → `privacy`). */
export function legalSlugFromPath(path: string): string {
  const prefix = /^\/(?:en|vi)\/legal\//u;
  if (!prefix.test(path)) {
    throw new Error(`Not a legal collection path: "${path}"`);
  }
  return path.replace(prefix, '');
}

/** Locale code của một legal path (`/vi/legal/x` → `vi`). */
export function legalLocaleFromPath(path: string): 'en' | 'vi' {
  const match = /^\/(en|vi)\/legal\//u.exec(path);
  if (match === null) {
    throw new Error(`Not a legal collection path: "${path}"`);
  }
  return match[1] as 'en' | 'vi';
}

/**
 * Lọc danh sách records theo **gate xuất bản của build**.
 *
 * `includeDrafts: false` (production) chỉ giữ `published`; `true` (staging)
 * giữ cả draft. Gate được quyết định **một lần ở build** qua
 * `legalIncludeDrafts()` (xem `legal-build-mode.ts`) và truyền vào đây —
 * domain không tự đọc env, giữ hàm thuần và test được cả hai nhánh.
 *
 * **Đây KHÔNG phải cổng chặn draft chính, và không thay thế được cổng đó.**
 * Cổng thật nằm ở `content.config.ts`: `exclude` loại `*.draft.md` khỏi source
 * của collection `legal`, nên draft không bao giờ có mặt trong content database
 * — không HTML, không payload dump, không manifest entry, và không tới được
 * route. Đó mới là lớp khiến trong production **không thể** chứa draft.
 *
 * Hàm này là lớp **thứ hai trên dữ liệu đã lọc**: route
 * `pages/[locale]/legal/[[...slug]].vue` gọi nó trên `records` của query rồi mới
 * `orderLegalDocumentsByStem`. Route phải tự lọc vì `documents` còn dùng cho
 * landing, related và availability — nó không thể tin
 * rằng mọi consumer đã lọc. Đây là **hai lớp, không phải hai cách làm cùng một
 * việc**: đổi cổng `content.config.ts` mà quên predicate ở route thì draft vẫn bị
 * chặn, chỉ là chặn muộn hơn. Giữ hai lớp thì đổi một lớp không làm lộ draft.
 *
 * Predicate **chỉ tồn tại ở đây**: route không viết lại
 * `includeDrafts || status === 'published'`, nên sửa biểu thức này là sửa cả hai
 * lớp theo một đường. Đây là lý do hàm được export và có test — nếu nó chỉ tồn
 * tại cho test thì nó không ghim được điều gì.
 */
export function filterLegalDocumentsByPublication<T extends Pick<LegalDocumentRecord, 'status'>>(
  documents: readonly T[],
  includeDrafts: boolean,
): readonly T[] {
  return documents.filter((document) => includeDrafts || document.status === 'published');
}

/** Khoá của thứ tự editorial — `stem` của item `legal` (`en/legal/1.privacy`). */
export type LegalStemmed = {
  readonly stem: string;
};

/**
 * Sort records theo **thứ tự editorial** của tên file — `stem` giữ nguyên
 * prefix số (`1.privacy`, `2.terms`), và prefix đó là ý nghĩa của thứ tự.
 *
 * Sort tường minh ở đây thay vì dựa vào thứ tự của query: `stem` là cột hệ
 * thống nên `.order()` không nhận, còn thứ tự mà builder trả về khi không
 * `orderBy` là hành vi của thư viện, không phải hợp đồng của collection này —
 * không có gì pin nó. Cùng lập luận và cùng cách làm như `orderArticlesByDateDesc`
 * của blog.
 *
 * `localeCompare(..., { numeric: true })` xử lý sorting có số: so chữ thuần sẽ
 * đảo `10.` và `2.` ngay khi collection vượt 9 văn bản.
 *
 * `stem` là field riêng, **không** nằm trong `LegalDocumentRecord`: chỉ route
 * cần nó để sort, còn breadcrumb/sidebar/related chỉ cần `path`/`title`.
 */
export function orderLegalDocumentsByStem<T extends LegalStemmed>(documents: readonly T[]): T[] {
  return documents.toSorted((a, b) => a.stem.localeCompare(b.stem, 'en', { numeric: true }));
}

/**
 * Group records theo category, theo đúng thứ tự
 * `CATEGORY_ORDER`; category rỗng vẫn được trả về (landing hiển thị nhóm rỗng
 * thay vì tự biến mất — danh sách seed hiện luôn có cả hai).
 * Bên trong mỗi nhóm giữ nguyên thứ tự của `documents` truyền vào — vì vậy
 * caller phải sort trước bằng `orderLegalDocumentsByStem`.
 *
 * Không chỉ landing dùng: sau PR này đây là nguồn duy nhất cho **sidebar**
 * (`buildLegalSidebar` của `legal-navigation.ts` nhận đúng `grouped` này), nên
 * thứ tự nhóm và việc giữ nhóm rỗng là bất biến của **bề mặt điều hướng** chứ
 * không riêng landing. Breadcrumb thì **không** đi qua đây — `legalBreadcrumbs`
 * chỉ nhận record của văn bản đang đọc, vì legal không có URL cho từng nhóm.
 */
export function groupLegalDocumentsByCategory<T extends Pick<LegalDocumentRecord, 'category'>>(
  documents: readonly T[],
): Readonly<Record<LegalCategory, readonly T[]>> {
  const grouped = {
    policy: [] as T[],
    terms: [] as T[],
  } satisfies Record<LegalCategory, T[]>;
  for (const document of documents) {
    grouped[document.category].push(document);
  }
  return grouped;
}

/** Danh sách category theo thứ tự hiển thị landing. */
export function legalCategoryOrder(): readonly LegalCategory[] {
  return CATEGORY_ORDER;
}

/**
 * Tập slug **duy nhất** trong danh sách records — duplicate slug là lỗi dữ
 * liệu seed (hai file cùng slug ở cùng locale tạo hai path khác nhau chỉ khi
 * khác thư mục, nhưng hai file `en/legal/privacy.md` và `en/legal/privacy/`
 * + `index.md` sẽ đè nhau). Trả về các cặp (slug, locale) bị trùng; rỗng
 * nghĩa là dữ liệu sạch.
 */
export function duplicateLegalSlugs(
  documents: readonly Pick<LegalDocumentRecord, 'path' | 'locale'>[],
): readonly { readonly locale: 'en' | 'vi'; readonly slug: string }[] {
  const seen = new Set<string>();
  const duplicates: { readonly locale: 'en' | 'vi'; readonly slug: string }[] = [];
  for (const document of documents) {
    const slug = legalSlugFromPath(document.path);
    const key = `${document.locale}/${slug}`;
    if (seen.has(key)) {
      duplicates.push({ locale: document.locale, slug });
      continue;
    }
    seen.add(key);
  }
  return duplicates;
}

/** Record tối thiểu cho validation related references — path + locale + related. */
export type LegalRelatedCheckRecord = {
  readonly path: string;
  readonly locale: 'en' | 'vi';
  readonly related?: readonly string[];
};

/**
 * Kiểm tra mọi reference `related` trỏ tới slug **tồn tại trong cùng locale**.
 * Trả về các cặp (slug nguồn, slug đích bị thiếu); rỗng nghĩa là liên kết
 * xanh. Reference là slug, không path: cùng locale của văn bản nguồn.
 */
export function brokenLegalRelatedReferences(
  documents: readonly LegalRelatedCheckRecord[],
): readonly { readonly from: string; readonly to: string; readonly locale: 'en' | 'vi' }[] {
  const slugsByLocale = new Map<'en' | 'vi', Set<string>>();
  for (const document of documents) {
    const slug = legalSlugFromPath(document.path);
    const slugs = slugsByLocale.get(document.locale) ?? new Set<string>();
    slugs.add(slug);
    slugsByLocale.set(document.locale, slugs);
  }
  const broken: { readonly from: string; readonly to: string; readonly locale: 'en' | 'vi' }[] = [];
  for (const document of documents) {
    const from = legalSlugFromPath(document.path);
    for (const to of document.related ?? []) {
      if (!SLUG_PATTERN.test(to) || !slugsByLocale.get(document.locale)?.has(to)) {
        broken.push({ from, to, locale: document.locale });
      }
    }
  }
  return broken;
}

/**
 * Tập locale thực sự có văn bản ở slug cho trước — nguồn duy nhất của locale
 * switcher và hreflang. **Không fabricate**: locale không nằm trong tập này
 * không được link tới, kể cả khi slug đó tồn tại ở locale khác.
 *
 * `candidates` là mọi path build được cho slug ở mọi registry locale (route
 * dựng bằng `buildPublicPath`); `existingPaths` là tập path query trả về.
 */
export function legalAvailableLocales(
  candidates: readonly { readonly locale: 'en' | 'vi'; readonly path: string }[],
  existingPaths: ReadonlySet<string>,
): readonly ('en' | 'vi')[] {
  return candidates
    .filter((candidate) => existingPaths.has(candidate.path))
    .map((candidate) => candidate.locale);
}
