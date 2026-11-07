<!--
  Route duy nhất phục vụ toàn bộ content của Legal Center:
  `apps/home/app/pages/[locale]/legal/[[...slug]].vue`

  Route này **validate bằng chính pathname thô** qua `isLegalRoute` (dựng trên
  `parsePublicLayoutPath` của module `app/layout`), rồi chỉ nhận
  `kind === 'localized' && mount === 'legal'`. Nguồn pathname khác nhau theo
  môi trường: trên server h3 percent-decode request path **trước** khi
  vue-router nhìn thấy (nên `to.path` đã bị decode), trong khi
  `useRequestURL().pathname` vẫn là byte gốc trên wire; client thì `to.path`
  giữ nguyên encoding. `validate` chọn nguồn theo môi trường, nhờ vậy URL
  không canonical (`/%65n/legal/...`) bị từ chối thay vì được phục vụ dạng đã
  decode. Sau `validate`, mọi pathname vào được setup đều canonical nên phần
  còn lại của route dùng thẳng `route.path`. `isLegalRoute` nhận:

  - `/en/legal`, `/vi/legal`, `/en/legal/privacy` — hợp lệ;
  - `/fr/legal`, `/EN/legal`, `/en/legal/`, `/en/docs` — bị `validate` từ chối;
  - `/en/legal/unknown` hợp lệ về topology, nhưng ở **production** bị chặn
    ngay ở tầng Nitro middleware (`server/middleware/prerendered-content-404.ts`,
    trước cả renderer): draft và path lạ không bao giờ có mặt trong manifest,
    nên middleware 404 trước khi query chạy. Staging thì draft nằm trong
    manifest nên được phục vụ bình thường.

  Route này chỉ sở hữu mount `legal`; `/en/docs` và `/en/blog` có route riêng.

  Toàn bộ dữ liệu của trang được resolve ở **route** (query, availability,
  SEO); component view chỉ render — không component nào tự query, SSR và
  hydrate nhìn thấy đúng cùng một dữ liệu.

  Query dùng `path(route.path)` — key ổn định cho SSR. Draft gate là **cờ
  build** (`legalIncludeDrafts()` đọc `NUXT_PUBLIC_LEGAL_INCLUDE_DRAFTS` một
  lần lúc build): production build loại draft ngay trong query listing lẫn
  document, staging build giữ draft để preview. Không có đường nào production
  phục vụ draft — HTML draft không bao giờ được prerender ra output production.
-->
<script setup lang="ts">
import type { PublicLocale } from '../../../i18n/index';
import { PUBLIC_LOCALES } from '../../../i18n/index';
import { buildPublicPath } from '../../../layout/index';
// Import tường minh (không auto-import): auto-import đăng ký component với
// prefix thư mục, nên tên ngắn trong template không resolve được — SSR render
// rỗng im lặng lúc prerender (đã xác minh trên bản apps/blogs cũ).
import LegalLandingView from '~/components/legal/LegalLandingView.vue';
import LegalDocumentView from '~/components/legal/LegalDocumentView.vue';
import {
  legalCategoryOrder,
  groupLegalDocumentsByCategory,
  filterLegalDocumentsByPublication,
  legalAvailableLocales,
  orderLegalDocumentsByStem,
  type LegalDocumentRecord,
} from '~/domain/legal-collection';
import type { LegalBreadcrumb } from '~/domain/legal-navigation';
import { buildLegalSidebar, legalBreadcrumbs } from '~/domain/legal-navigation';
import { legalIncludeDrafts } from '~/domain/legal-build-mode';
import { legalUiStrings } from '~/domain/legal-ui-strings';
import { buildLegalSeo } from '~/domain/legal-seo';
import { isLegalRoute, parseLegalRoute } from '~/domain/legal-locale';

definePageMeta({
  /**
   * Nguồn pathname khác nhau theo môi trường — cùng pattern mọi route content
   * của app (xem comment đầu file). Validate chỉ topology + pathname thô;
   * "path lạ phải 404 trước khi query" thuộc Nitro middleware gate.
   */
  validate: (to) => {
    const rawPathname = import.meta.server ? useRequestURL().pathname : to.path;
    return isLegalRoute(rawPathname);
  },
});

const route = useRoute();

/**
 * Locale của pathname đã được `validate` chấp nhận — không suy từ
 * `params.locale` (string thô của router, không phải locale đã validate).
 */
const layout = computed(() => parseLegalRoute(route.path));
const locale = computed<PublicLocale>(() => layout.value?.locale ?? 'en');

/** Phần pathname còn lại sau `<locale>/legal` — `''` nghĩa là landing. */
const remainder = computed(() => layout.value?.remainder ?? '');
const isLegalLanding = computed(() => remainder.value === '');

/** Slug của trang hiện tại — `undefined` ở landing. */
const slug = computed(() => (remainder.value === '' ? undefined : remainder.value.slice(1)));

/**
 * Cờ draft-preview của **build** — đọc một lần, không đổi giữa các request.
 * Production: `false` → mọi query dưới đây loại draft ngay ở tầng dữ liệu.
 */
const includeDrafts = legalIncludeDrafts();

/**
 * Danh sách văn bản của **locale hiện tại** sau publication gate — nguồn dùng
 * chung cho landing (grouped listing) và detail (related, availability).
 *
 * `.select(...)` chỉ lấy đúng các cột được map bên dưới — kéo cột `body` (AST
 * Markdown đầy đủ) vào listing là payload cache vô ích; body chỉ cần ở document
 * query riêng bên dưới.
 */
const { data: documents } = await useAsyncData(`legal:documents:${locale.value}`, async () => {
  const records = await queryCollection('legal')
    .select(
      'stem',
      'path',
      'title',
      'description',
      'category',
      'status',
      'reviewStatus',
      'version',
      'effectiveDate',
    )
    .where('path', 'LIKE', `/${locale.value}/legal/%`)
    // Không `.order(...)`: `stem` là cột hệ thống do Nuxt Content sinh ra nên
    // type của `.order()` không nhận. Thứ tự editorial **không** dựa vào thứ
    // tự builder trả về — nó sort tường minh bằng
    // `orderLegalDocumentsByStem` ở dưới, cùng cách blog sort bằng
    // `orderArticlesByDateDesc` thay vì tin thứ tự query.
    .all();
  // `stem` giữ prefix ordering mà `path` đã mất (`1.privacy`), nên nó chỉ dùng ở
  // bước sort và bị bỏ ngay sau đó: nó không thuộc `LegalDocumentRecord` vì chỉ
  // sort dùng tới, còn breadcrumb/sidebar/related chỉ cần `path`/`title`. Bọc nó
  // vào object trả về nghĩa là nó đi kèm record vào `_payload.json` của **mọi**
  // trang legal dù không consumer nào đọc.
  //
  // Publication gate chạy ở tầng dữ liệu, trước mọi consumer — cả landing lẫn
  // detail không bao giờ nhìn thấy draft của build production. Predicate gọi
  // **hàm domain** `filterLegalDocumentsByPublication` chứ không viết lại tại
  // đây: nó là lớp thứ hai trên dữ liệu đã bị `content.config.ts` lọc, và viết
  // lại biểu thức ở route nghĩa là hai nơi phải khớp nhau — sửa một nơi mà
  // quên nơi kia thì lớp còn lại im lặng. Lọc trên `records` của query (đã
  // select `status`) chứ không trên kết quả map.
  //
  // Gate chạy **trước** bước map: nếu map trước rồi mới lọc thì kết quả map đã chứa
  // draft ở giữa đường đi. Predicate không phụ thuộc thứ tự nên lọc trước hay sau
  // `orderLegalDocumentsByStem` cho cùng kết quả.
  return orderLegalDocumentsByStem(filterLegalDocumentsByPublication(records, includeDrafts)).map(
    (record) =>
      ({
        path: record.path,
        slug: record.path.split('/').pop() ?? '',
        title: record.title ?? '',
        description: record.description ?? '',
        category: record.category,
        status: record.status,
        reviewStatus: record.reviewStatus,
        version: record.version ?? '',
        effectiveDate: record.effectiveDate ?? null,
        locale: locale.value === 'vi' ? 'vi' : 'en',
      }) satisfies LegalDocumentRecord,
  );
});

const documentsForLocale = computed<readonly LegalDocumentRecord[]>(() => documents.value ?? []);

/**
 * Document của pathname hiện tại (detail) — nguồn nội dung duy nhất của trang.
 * Landing không query document. Query `.path(route.path)` — path collection
 * khớp thẳng public URL.
 */
const { data: page } = await useAsyncData(`legal:page:${route.path}`, () =>
  isLegalLanding.value ? Promise.resolve(null) : queryCollection('legal').path(route.path).first(),
);

/**
 * Record metadata của document hiện tại lấy từ listing (đã qua gate) — nguồn
 * cho related/labels; `undefined` khi landing hoặc khi document không qua gate
 * (draft ở production — nhưng middleware gate đã chặn trước khi tới đây).
 */
const currentDocument = computed<LegalDocumentRecord | undefined>(() =>
  slug.value === undefined
    ? undefined
    : documentsForLocale.value.find((document) => document.slug === slug.value),
);

/**
 * 404 cho detail khi **không** dựng được trang: document query về `null`
 * (path lạ/đã bị loại khỏi output) hoặc metadata không map được từ listing —
 * một trang rỗng HTTP 200 là tệ hơn 404 vì nó vẫn bị index.
 */
if (!isLegalLanding.value && (page.value === null || currentDocument.value === undefined)) {
  throw createError({ statusCode: 404, statusMessage: 'Legal document not found' });
}

/**
 * Related documents của trang hiện tại — resolve từ `related` (slug) sang
 * record trong cùng locale, giữ thứ tự khai báo; slug không tồn tại hoặc
 * không qua gate bị bỏ khỏi danh sách (link hỏng tệ hơn là ít link).
 */
const relatedDocuments = computed<readonly LegalDocumentRecord[]>(() => {
  const current = currentDocument.value;
  if (current === undefined) {
    return [];
  }
  const relatedSlugs = (page.value as { related?: readonly string[] } | null)?.related ?? [];
  return relatedSlugs
    .map((relatedSlug) =>
      documentsForLocale.value.find((document) => document.slug === relatedSlug),
    )
    .filter((document): document is LegalDocumentRecord => document !== undefined);
});

/**
 * Locale nào thực sự có bản dịch của **resource này**.
 *
 * **Landing** (`/en/legal`, `/vi/legal`): route tĩnh của mount — tồn tại ở
 * **mọi locale của registry**, độc lập với số văn bản. Suy từ registry, không
 * từ query — cùng lập luận với blog landing.
 *
 * **Document**: một locale được coi là có bản dịch khi query trả về văn bản ở
 * đúng candidate path của locale đó. Candidate path dựng qua `buildPublicPath`
 * cho từng registry locale — không ghép chuỗi. **Không fabricate**: locale
 * thiếu bản dịch không bao giờ xuất hiện trong switcher hay hreflang.
 */
const { data: translationAvailability } = await useAsyncData(
  `legal:translations:${route.path}`,
  async () => {
    if (isLegalLanding.value) {
      return PUBLIC_LOCALES.map((definition) => definition.code);
    }
    const candidates = PUBLIC_LOCALES.flatMap((definition) => {
      const built = buildPublicPath({
        locale: definition.code,
        mount: 'legal',
        path: `/${slug.value ?? ''}`,
      });
      return built.kind === 'localized' && built.path !== route.path
        ? [{ locale: definition.code, path: built.path }]
        : [];
    });
    if (candidates.length === 0) {
      return [];
    }
    const records = await queryCollection('legal')
      .select('path')
      .where(
        'path',
        'IN',
        candidates.map((candidate) => candidate.path),
      )
      .all();
    const existingPaths = new Set(records.map((record) => record.path));
    return legalAvailableLocales(candidates, existingPaths);
  },
);

const availableLocales = computed<readonly PublicLocale[]>(
  () => translationAvailability.value ?? [],
);

/** Grouped listing cho landing — theo thứ tự category khai báo. */
const groupedDocuments = computed(() => groupLegalDocumentsByCategory(documentsForLocale.value));

/** Thứ tự category hiển thị landing — hằng của domain, không đổi theo route. */
const categoryOrder = legalCategoryOrder();

/** UI copy đã resolve cho locale hiện tại. */
const ui = computed(() => legalUiStrings(locale.value));

/**
 * Public path của landing Legal Center — nguồn duy nhất cho mọi link "về tổng
 * quan" (sidebar `Overview`, mắt đầu breadcrumb, link cuối trang detail).
 * Dựng qua builder, không ghép chuỗi.
 *
 * `undefined` khi builder không trả `localized`. Cố ý **không** fallback sang
 * `route.path` như docs-lite: ở đây `route.path` ở trang văn bản là **chính
 * trang đang đọc**, nên fallback đó biến mắt `Overview` và mắt breadcrumb đầu
 * thành self-link trỏ về chính mình. Thay vào đó anchor tổng quan bị bỏ hẳn
 * (cùng cách `buildDocsBreadcrumbs` xử lý `docsRootPath` rỗng).
 */
const legalRoot = computed(() => buildPublicPath({ locale: locale.value, mount: 'legal' }));

/**
 * Anchor "về tổng quan" — `undefined` khi không resolve được. Phân biệt với
 * `route.path`: shell nhận `route.path` (pathname của **trang đang xem**),
 * còn `legalRootPath` là link quay về landing và bị bỏ hẳn khi rỗng.
 */
const legalRootPath = computed(() =>
  legalRoot.value.kind === 'localized' ? legalRoot.value.path : undefined,
);

/**
 * Sidebar điều hướng — dùng **chung** cho landing và detail để cả hai bề mặt
 * có cùng một cấu trúc điều hướng.
 *
 * Xây từ `documentsForLocale` — cùng listing đã qua publication gate mà
 * landing dùng — nên **không có query riêng** cho nav và không có registry thứ
 * hai để lệch với listing. Nhờ đó draft không thể lọt vào sidebar ở production:
 * nó đã bị gate loại trước khi dữ liệu này tồn tại.
 *
 * `currentPath` là pathname hiện tại: ở landing khớp `legalRootPath` nên mắt
 * `Overview` mang `aria-current="page"`; ở detail khớp path của văn bản đang
 * đọc.
 */
const sidebar = computed(() =>
  buildLegalSidebar({
    legalRootPath: legalRootPath.value,
    currentPath: route.path,
    legalRootTitle: ui.value.legal,
    categoryOrder,
    categoryLabels: { policy: ui.value.policies, terms: ui.value.terms },
    grouped: groupedDocuments.value,
  }),
);

/**
 * Breadcrumb của **cả hai** bề mặt — landing một mắt, detail `Legal Center →
 * Document`.
 *
 * Nhóm category **không** thành mắt breadcrumb vì legal không có URL cho từng
 * nhóm (xem `legal-navigation.ts`).
 *
 * Landing cũng đi qua computed này thay vì tự dựng mắt của riêng nó: route là
 * nơi duy nhất resolve breadcrumb cho cả hai bề mặt, nên đổi nhãn hay nguồn path
 * không thể làm hai bề mặt lệch nhau.
 */
const breadcrumbs = computed<readonly LegalBreadcrumb[]>(() => {
  const current = currentDocument.value;
  // `currentDocument` là `undefined` chỉ ở landing, và detail đã throw 404 ở
  // trên khi thiếu document — nên nhánh dưới đây **có** render, ở landing.
  if (current === undefined) {
    return [{ path: route.path, title: ui.value.legal }];
  }
  return legalBreadcrumbs({
    legalRootPath: legalRootPath.value,
    legalRootTitle: ui.value.legal,
    current,
  });
});

/**
 * Description SEO của landing — câu surface theo locale, không mượn mô tả
 * của văn bản đầu tiên (mô tả đó thuộc văn bản, không thuộc Legal Center).
 */
const LANDING_DESCRIPTIONS: Readonly<Record<'en' | 'vi', string>> = Object.freeze({
  en: 'Policies and terms that govern the ecoma.io platform and its services.',
  vi: 'Các chính sách và điều khoản chi phối nền tảng ecoma.io và các dịch vụ của nó.',
});

/**
 * SEO: cùng contract với mọi surface content — `lang` từ registry, canonical
 * tuyệt đối dưới production origin, hreflang chỉ cho locale có bản dịch thật.
 * Landing dùng title/description surface; document dùng frontmatter.
 */
const seo = computed(() =>
  buildLegalSeo({
    pathname: route.path,
    locale: locale.value,
    title: isLegalLanding.value ? ui.value.legal : (currentDocument.value?.title ?? ''),
    description: isLegalLanding.value
      ? LANDING_DESCRIPTIONS[locale.value === 'vi' ? 'vi' : 'en']
      : (currentDocument.value?.description ?? ''),
    availableLocales: availableLocales.value,
  }),
);

useHead(() => ({
  htmlAttrs: { lang: seo.value.lang },
  title: seo.value.title,
  meta: [{ name: 'description', content: seo.value.description }],
  link: [
    { rel: 'canonical' as const, href: seo.value.canonicalUrl },
    ...seo.value.alternates.map((alternate) => ({
      rel: 'alternate' as const,
      hreflang: alternate.hreflang,
      href: alternate.href,
    })),
  ],
}));
</script>

<template>
  <LegalLandingView
    v-if="isLegalLanding"
    :path="route.path"
    :grouped="groupedDocuments"
    :available-locales="availableLocales"
    :sidebar="sidebar"
    :breadcrumbs="breadcrumbs"
    :ui="ui"
  />
  <LegalDocumentView
    v-else-if="currentDocument && page"
    :path="route.path"
    :page="page"
    :summary="currentDocument"
    :related="relatedDocuments"
    :available-locales="availableLocales"
    :sidebar="sidebar"
    :breadcrumbs="breadcrumbs"
    :ui="ui"
  />
</template>
