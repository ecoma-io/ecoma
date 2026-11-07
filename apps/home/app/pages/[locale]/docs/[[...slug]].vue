<!--
  Route duy nhất phục vụ toàn bộ content của docs:
  `apps/home/app/pages/[locale]/docs/[[...slug]].vue`

  Route này **validate bằng chính pathname thô** qua `isDocsRoute` (dựng trên
  `parsePublicLayoutPath` của module `app/layout`), rồi chỉ nhận
  `kind === 'localized' && mount === 'docs'`. Nguồn pathname khác nhau theo môi
  trường: trên server h3 percent-decode request path **trước** khi vue-router
  nhìn thấy (nên `to.path` đã bị decode), trong khi `useRequestURL().pathname`
  vẫn là byte gốc trên wire; client thì `to.path` giữ nguyên encoding.
  `validate` chọn nguồn theo môi trường, nhờ vậy URL không canonical
  (`/%65n/docs/...`) bị từ chối thay vì được phục vụ dưới dạng đã decode. Sau
  `validate`, mọi pathname vào được setup đều canonical nên phần còn lại của
  route dùng thẳng `route.path`. `isDocsRoute` nhận:

  - `/en/docs`, `/vi/docs`, `/en/docs/getting-started`, `/vi/docs/foo/bar` —
    hợp lệ;
  - `/fr/docs`, `/EN/docs`, `/en/docs/`, `/en/blog` — bị `validate` từ chối;
  - `/en/docs/api` và `/en/docs/api/foo` resolve thành mount `docs/api` nên bị
    từ chối — boundary của `api-reference` không bị docs chiếm;
  - `/en/docs/unknown` hợp lệ về topology, nhưng ở **production** bị chặn ngay
    ở tầng Nitro middleware (`server/middleware/prerendered-content-404.ts`,
    trước cả renderer): Worker không có database runtime nào cho content, path
    lạ phải 404 trước khi query chạy.

  Toàn bộ dữ liệu của trang được resolve ở **route** (query, navigation,
  breadcrumbs, prev/next, SEO); component `DocsPageView` chỉ render. Nhờ vậy
  không component nào tự query và SSR/hydrate nhìn thấy đúng cùng một dữ liệu.

  Query dùng `path(route.path)` — key ổn định cho SSR, không tự dựng lại URL từ
  `params.slug`. Query trước hết cho document; không có document thì 404 luôn,
  không render trang rỗng.
-->
<script setup lang="ts">
import type { ContentNavigationItem } from '@nuxt/content';
import { PUBLIC_LOCALES, type PublicLocale } from '../../../i18n/index';
import { buildPublicPath } from '../../../layout/index';
import { findPageBreadcrumb } from '@nuxt/content/utils';
import DocsLandingView from '~/components/docs/DocsLandingView.vue';
import DocsPageView from '~/components/docs/DocsPageView.vue';
import { docsUiStrings } from '~/utils/docs-ui-strings';
import { getSidebarItems } from '~/utils/docs-navigation';
import { buildDocsBreadcrumbs } from '~/utils/docs-breadcrumbs';
import { buildDocsSeo } from '~/utils/docs-seo';
import { isDocsRoute, parseDocsRoute } from '~/utils/docs-routing';

definePageMeta({
  /**
   * Nguồn pathname khác nhau theo môi trường, giống pattern của
   * `apps/home/app/pages/[locale]/index.vue`: trên server h3 đã percent-decode
   * request path trước khi `validate` nhìn thấy (nên `to.path` là bản đã
   * decode), còn `useRequestURL().pathname` đọc từ `originalUrl` — byte gốc
   * chưa decode. Client thì `to.path` giữ nguyên encoding. Validate đúng pathname
   * thô để URL không canonical (`/%65n/docs/...`) bị từ chối thay vì được phục vụ.
   *
   * Chốt "path lạ phải 404 trước khi query" không nằm ở đây nữa mà ở tầng
   * Nitro middleware (`server/middleware/prerendered-content-404.ts`) — app
   * code bị Vite bundle trước prerender nên không thể đọc manifest sau
   * prerender (chi tiết `modules/prerendered-content-manifest.ts`).
   * `validate` giữ đúng một trách nhiệm: topology + pathname thô.
   */
  validate: (to) => {
    const rawPathname = import.meta.server ? useRequestURL().pathname : to.path;
    return isDocsRoute(rawPathname);
  },
});

const route = useRoute();

/**
 * Locale của pathname đã được `validate` chấp nhận: `parseDocsRoute` trả layout
 * docs (locale đã kiểm tra trong registry, mount đúng `docs`), nên ở đây không
 * cần suy đoán lại từ `params` (`params.locale` là string thô của router, không
 * phải locale đã validate).
 */
const layout = computed(() => parseDocsRoute(route.path));
const locale = computed<PublicLocale>(() => layout.value?.locale ?? 'en');

/** Document của pathname hiện tại — nguồn nội dung duy nhất của trang. */
const { data: page } = await useAsyncData(`docs:page:${route.path}`, () =>
  queryCollection('docs').path(route.path).first(),
);

if (page.value === null) {
  throw createError({ statusCode: 404, statusMessage: 'Document not found' });
}

/**
 * Cây navigation của collection, **lọc theo locale hiện tại** — dùng chung cho
 * sidebar, breadcrumbs và kiểm tra tồn tại của bản dịch. Query một lần cho mỗi
 * locale nên điều hướng qua lại giữa các page cùng locale không query lại.
 */
const { data: navigation } = await useAsyncData(`docs:navigation:${locale.value}`, () =>
  queryCollectionNavigation('docs').where('path', 'LIKE', `/${locale.value}/%`),
);

/**
 * Description của các section index, keyed by path — dùng cho card trên docs
 * landing. Lấy từ chính content (`description` ở frontmatter) nên landing không
 * phải hard-code mô tả của section; query riêng vì `queryCollectionNavigation`
 * chỉ trả metadata điều hướng (title/path), không mang `description`.
 *
 * Chỉ landing cần dữ liệu này: trên landing (`remainder === ''`) mới query,
 * còn document page trả `{}` ngay — bề mặt dùng nhiều nhất của docs không trả
 * tiền cho một query nó không render. Cache key theo pathname (không phải
 * locale) để hai mức bề mặt không giành nhau một entry.
 */
const { data: sectionDescriptions } = await useAsyncData(
  `docs:section-descriptions:${route.path}`,
  async () => {
    if ((layout.value?.remainder ?? '') !== '') {
      return {};
    }
    const records = await queryCollection('docs')
      .select('path', 'description')
      .where('path', 'LIKE', `/${locale.value}/docs/%`)
      .all();
    return Object.fromEntries(records.map((record) => [record.path, record.description ?? '']));
  },
);

/** Navigation của locale hiện tại — đã lọc ở tầng query, không lọc lại ở UI. */
const navigationForLocale = computed<readonly ContentNavigationItem[]>(
  () => navigation.value ?? [],
);

/**
 * Cây sidebar: link tới landing (`Overview`) rồi đến từng section. Logic thuần
 * nằm trong `docs-navigation.ts` (đã unit test) — route chỉ nối dữ liệu, và
 * không lộ node `locale` (`/en`, vốn không phải page docs) ra UI.
 */
const sidebarNavigation = computed<readonly ContentNavigationItem[]>(() =>
  getSidebarItems(locale.value, navigationForLocale.value),
);

/** Phần pathname còn lại sau `<locale>/docs` — dùng để nhận diện landing. */
const remainder = computed(() => layout.value?.remainder ?? '');
/** Đúng khi đang ở `/en/docs` hoặc `/vi/docs` — không có segment tài liệu nào. */
const isDocsLanding = computed(() => remainder.value === '');

/**
 * Tổ tiên của page hiện tại trong cây navigation — `findPageBreadcrumb` của Nuxt
 * Content, không hard-code breadcrumb cho từng page. Cây đầu vào đã lọc theo
 * locale nên breadcrumb không bao giờ trộn hai locale.
 */
const ancestorCrumbs = computed<readonly ContentNavigationItem[]>(() =>
  findPageBreadcrumb([...navigationForLocale.value], route.path, { current: true }),
);

/**
 * Chuỗi breadcrumb cuối cùng: entry `Docs` trỏ về docs landing, rồi các tổ tiên
 * từ content tree. Mục cuối là page hiện tại (lấy từ chính document, không phải
 * từ navigation) để nhãn luôn khớp tiêu đề trang.
 *
 * Thuật toán nằm trong `docs-breadcrumbs.ts` (đã unit test): nó chèn entry
 * `Docs`, lọc bỏ locale-root (`/en`) và mọi crumb ngoài docs tree theo pathname
 * (không phụ thuộc ngôn ngữ), và luôn kết thúc bằng page hiện tại.
 */
const breadcrumbs = computed<readonly { path: string; title: string }[]>(() => {
  const docsRoot = buildPublicPath({ locale: locale.value, mount: 'docs' });
  return buildDocsBreadcrumbs({
    docsRootPath: docsRoot.kind === 'localized' ? docsRoot.path : undefined,
    docsRootTitle: docsUiStrings(locale.value).documentation,
    ancestorCrumbs: ancestorCrumbs.value,
    currentPath: route.path,
    currentTitle: page.value?.title ?? '',
  });
});

/**
 * Locale nào thực sự có bản dịch của **resource này** — suy ra từ chính content
 * tree, không phải giả định. Resource được định danh bằng pathname bỏ segment
 * locale; một locale được coi là có bản dịch khi tồn tại document ở đúng đường
 * dẫn đó. Nhờ vậy locale switcher của `PublicShell` chỉ link tới bản dịch có
 * thật, và một page chỉ có tiếng Anh không hiện link tiếng Việt hỏng.
 *
 * Một **round-trip duy nhất** cho mọi locale: dựng trước candidate path của
 * từng registry locale rồi truy một lần với `where('path', 'IN', paths)` —
 * thay vì một query `.first()` mỗi locale. Locale nào có path trong kết quả là
 * locale đó có bản dịch. Candidate path bị builder từ chối (topology — ví dụ
 * remainder rơi vào mount lồng nhau) đơn giản không nằm trong `IN`, tức locale
 * đó không có bản dịch của resource.
 */
const { data: translationAvailability } = await useAsyncData(
  `docs:translations:${route.path}`,
  async () => {
    const resourceRemainder = layout.value?.remainder ?? '';
    const candidates = PUBLIC_LOCALES.flatMap((definition) => {
      const built = buildPublicPath({
        locale: definition.code,
        mount: 'docs',
        path: resourceRemainder,
      });
      return built.kind === 'localized' ? [built.path] : [];
    });
    // `IN ()` không phải SQL hợp lệ: không candidate nào thì không query —
    // không locale nào có bản dịch.
    if (candidates.length === 0) {
      return [];
    }
    const records = await queryCollection('docs')
      .select('path')
      .where('path', 'IN', candidates)
      .all();
    const existingPaths = new Set(records.map((record) => record.path));
    return PUBLIC_LOCALES.flatMap((definition) => {
      const built = buildPublicPath({
        locale: definition.code,
        mount: 'docs',
        path: resourceRemainder,
      });
      return built.kind === 'localized' && existingPaths.has(built.path) ? [definition.code] : [];
    });
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
 * Document liền trước / liền sau **trong cùng locale**.
 *
 * `queryCollectionItemSurroundings` chạy trên cây đã lọc theo locale, nên cặp
 * prev/next không bao giờ nhảy sang locale khác hay ra ngoài docs tree; hai giá
 * trị đã ở dạng `{ path, title }` hoặc `null` ở biên.
 */
const { data: surroundings } = await useAsyncData(`docs:surroundings:${route.path}`, () =>
  queryCollectionItemSurroundings('docs', route.path, { fields: ['title'] }).where(
    'path',
    'LIKE',
    `/${locale.value}/%`,
  ),
);

const previous = computed(() => {
  const item = surroundings.value?.[0];
  return item ? { path: item.path, title: item.title } : undefined;
});
const nextPage = computed(() => {
  const item = surroundings.value?.[1];
  return item ? { path: item.path, title: item.title } : undefined;
});

/**
 * SEO: `lang` từ registry locale (hreflang `vi-VN` chứ không phải code `vi`),
 * title theo template `<page title> · Ecoma Documentation`, description từ
 * frontmatter, canonical là URL hiện tại, và alternate hreflang cho **mọi
 * locale có bản dịch thật** — dựng qua `switchLocale`, không ghép chuỗi. Toàn
 * bộ thuật toán nằm trong `docs-seo.ts` (đã unit test).
 */
const seo = computed(() =>
  buildDocsSeo({
    pathname: route.path,
    locale: locale.value,
    title: page.value?.title,
    description: page.value?.description,
    availableLocales: availableLocales.value,
  }),
);

useHead(() => ({
  htmlAttrs: { lang: seo.value.lang },
  title: seo.value.title,
  // Description rỗng thì **không** emit meta — meta `content=""` là metadata
  // sai (các crawler hiện trích snippet từ nội dung khi thiếu description) và
  // prerendered HTML sẽ mang rác tĩnh khó thay sau khi deploy.
  meta:
    seo.value.description === '' ? [] : [{ name: 'description', content: seo.value.description }],
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
  <DocsLandingView
    v-if="page && isDocsLanding"
    :locale="locale"
    :page="page"
    :navigation="sidebarNavigation"
    :current-path="route.path"
    :available-locales="availableLocales"
    :breadcrumbs="breadcrumbs"
    :section-descriptions="sectionDescriptions ?? {}"
  />
  <DocsPageView
    v-else-if="page"
    :locale="locale"
    :page="page"
    :navigation="sidebarNavigation"
    :current-path="route.path"
    :available-locales="availableLocales"
    :breadcrumbs="breadcrumbs"
    :previous="previous"
    :next="nextPage"
  />
</template>
