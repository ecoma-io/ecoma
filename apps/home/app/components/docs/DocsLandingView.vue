<!--
  Trang index của docs — bề mặt **khác** các document page.

  Route dùng chung `[locale]/docs/[[...slug]].vue` cho cả landing (`/en/docs`,
  `/vi/docs`) lẫn từng document, nên view phải tự biết mình đang ở đâu. Ở
  landing, thay vì render nội dung của `index.md` như một document bình thường,
  view render information architecture của toàn bộ docs: mỗi section là một card
  có title, description, vài entry link và link tới section index.

  Card được dựng từ chính content navigation đã lọc theo locale (`navigation` từ
  route) chứ không hard-code: nav tree đã có section (node cha) với `children` là
  các page con, và description lấy từ `description` của section index document.
  Nhờ vậy thêm section hay page trong content tree là landing tự cập nhật.

  `page` vẫn được dùng cho SEO và cho breadcrumb/nav của shell; đây mới là phần
  render khác đi.
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { ContentNavigationItem } from '@nuxt/content';
import type { PublicLocale } from '../../i18n/index';
import { PublicShell } from '../../layout/index';
import DocsNavTree from '~/components/docs/DocsNavTree.vue';
import DocsSidebar from '~/components/docs/DocsSidebar.vue';
import PublicBreadcrumbs from '~/components/PublicBreadcrumbs.vue';
import { docsUiStrings } from '~/utils/docs-ui-strings';
import type { DocsBreadcrumb } from '~/utils/docs-breadcrumbs';
import { getSectionCards } from '~/utils/docs-navigation';

/** Một card section trên landing — dữ liệu đã resolve từ content navigation. */
type SectionCard = {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  /** Các page con (không gồm chính section index) để làm entry link. */
  readonly entries: readonly { readonly path: string; readonly title: string }[];
};

// Landing ráp dữ liệu route đã resolved (locale, document, navigation,
// pathname, locale availability, breadcrumbs, description của section) thành
// lưới card — bảy input độc lập. Xem ghi chú tương ứng ở `DocsPageView`.
const {
  locale,
  page,
  navigation,
  currentPath,
  availableLocales,
  breadcrumbs,
  sectionDescriptions,
} =
  // oxlint-disable-next-line vue/max-props
  defineProps<{
    /** Locale đã được route validate từ registry — component không tự suy đoán. */
    readonly locale: PublicLocale;
    readonly page: import('@nuxt/content').DocsCollectionItem;
    readonly navigation: readonly ContentNavigationItem[];
    readonly currentPath: string;
    readonly availableLocales: readonly PublicLocale[];
    readonly breadcrumbs: readonly DocsBreadcrumb[];
    /** Description của từng section index, keyed by path — lấy từ content. */
    readonly sectionDescriptions: Readonly<Record<string, string>>;
  }>();

const ui = computed(() => docsUiStrings(locale));

/**
 * Card section dựng từ content navigation đã được route re-root
 * (`sidebarNavigation` = link landing + các section). Logic thuần nằm trong
 * `docs-navigation.ts` để unit test được phần "thêm section vào content là
 * landing tự cập nhật" mà không cần render component.
 */
const sections = computed<readonly SectionCard[]>(() =>
  getSectionCards(navigation, currentPath, sectionDescriptions),
);
</script>

<template>
  <PublicShell :path="currentPath" :available-locales="availableLocales">
    <div class="mx-auto w-full max-w-9xl px-4 py-6 lg:px-8 wide:px-12 ultrawide:px-16">
      <PublicBreadcrumbs :entries="breadcrumbs" :label="ui.breadcrumbs" />

      <div class="mt-4 lg:hidden">
        <DocsSidebar :items="navigation" :current-path="currentPath" :label="ui.documentation" />
      </div>

      <div class="mt-6 grid gap-6 lg:mt-8 lg:grid-cols-[16rem_1fr]">
        <aside class="hidden lg:block">
          <div class="sticky top-20">
            <DocsNavTree
              :items="navigation"
              :current-path="currentPath"
              :label="ui.documentation"
            />
          </div>
        </aside>

        <!--
          `PublicShell` đã render landmark `<main>` bọc slot này, nên ở đây chỉ
          dùng `<div>` — xem ghi chú tương ứng ở `DocsPageView`.
        -->
        <div class="min-w-0">
          <!--
            Landing giữ heading + intro của `index.md` (đó là phần "Ecoma
            Documentation / short introduction" mà spec yêu cầu) nhưng **không**
            render phần thân như một document: thay vào đó là lưới card section.
          -->
          <article>
            <header class="mb-8">
              <h1 class="text-3xl font-bold tracking-tight text-foam">{{ page.title }}</h1>
              <p v-if="page.description" class="mt-2 max-w-2xl text-lg text-muted">
                {{ page.description }}
              </p>
            </header>

            <h2 class="mb-4 text-xl font-semibold tracking-tight text-foam">
              {{ ui.sections }}
            </h2>
            <ul class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <li
                v-for="section in sections"
                :key="section.path"
                class="flex flex-col rounded-lg border border-line p-5"
              >
                <!--
                  Link tiêu đề là link **duy nhất** trỏ tới section index: một
                  footer link lặp lại cùng đích chỉ nhân bản accessible name
                  mà không thêm thông tin cho ai đang điều hướng bằng screen
                  reader.
                -->
                <h3 class="text-lg font-semibold text-foam">
                  <a :href="section.path" class="hover:underline focus-visible:underline">
                    {{ section.title }}
                  </a>
                </h3>
                <p v-if="section.description" class="mt-2 text-sm text-muted">
                  {{ section.description }}
                </p>
                <ul v-if="section.entries.length > 0" class="mt-4 space-y-1 text-sm">
                  <li v-for="entry in section.entries" :key="entry.path">
                    <a
                      :href="entry.path"
                      class="text-muted hover:text-foam hover:underline focus-visible:underline"
                    >
                      {{ entry.title }}
                    </a>
                  </li>
                </ul>
              </li>
            </ul>
          </article>
        </div>
      </div>
    </div>
  </PublicShell>
</template>
