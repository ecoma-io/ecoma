<script setup lang="ts">
import { computed } from 'vue';
import type { ContentNavigationItem } from '@nuxt/content';
import type { PublicLocale } from '../../i18n/index';
import { PublicShell } from '../../layout/index';
import { ContentRenderer } from '#components';
import DocsNavTree from '~/components/docs/DocsNavTree.vue';
import DocsSidebar from '~/components/docs/DocsSidebar.vue';
import DocsToc from '~/components/docs/DocsToc.vue';
import PublicBreadcrumbs from '~/components/PublicBreadcrumbs.vue';
import DocsPager from '~/components/docs/DocsPager.vue';
import { docsUiStrings } from '~/utils/docs-ui-strings';
import type { DocsBreadcrumb } from '~/utils/docs-breadcrumbs';

// View này là **nơi ráp dữ liệu route đã resolved** vào layout 3 cột, nên nó
// nhận đúng tám input độc lập (locale, document, navigation, pathname hiện
// tại, locale availability, breadcrumbs, prev, next). Gộp chúng thành một
// object bao ngoài chỉ để lọt linter sẽ làm mất type của từng prop tại call
// site mà không tăng tính đóng gói — cùng cách xử lý như
// `PublicShell`/`PublicHeader`.
const { locale, page, navigation, currentPath, availableLocales, breadcrumbs, previous, next } =
  // oxlint-disable-next-line vue/max-props
  defineProps<{
    /** Locale đã được route validate từ registry — component không tự suy đoán. */
    readonly locale: PublicLocale;
    /** Document đã query từ collection `docs` (type do route suy ra). */
    readonly page: import('@nuxt/content').DocsCollectionItem;
    readonly navigation: readonly ContentNavigationItem[];
    readonly currentPath: string;
    readonly availableLocales: readonly PublicLocale[];
    readonly breadcrumbs: readonly DocsBreadcrumb[];
    readonly previous: { readonly path: string; readonly title: string } | undefined;
    readonly next: { readonly path: string; readonly title: string } | undefined;
  }>();

const ui = computed(() => docsUiStrings(locale));
/** TOC do content renderer sinh — có thể vắng nếu page không có heading. */
const toc = computed(() => page.body?.toc);
</script>

<template>
  <PublicShell :path="currentPath" :available-locales="availableLocales">
    <div class="mx-auto w-full max-w-9xl px-4 py-6 lg:px-8 wide:px-12 ultrawide:px-16">
      <PublicBreadcrumbs :entries="breadcrumbs" :label="ui.breadcrumbs" />

      <div class="mt-4 lg:hidden">
        <DocsSidebar :items="navigation" :current-path="currentPath" :label="ui.documentation" />
      </div>

      <div class="mt-6 grid gap-6 lg:mt-8 lg:grid-cols-[16rem_1fr_16rem]">
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
          dùng `<div>`: lồng `<main>` trong `<main>` là HTML không hợp lệ và làm
          hỏng landmark cho screen reader (hai vùng `main` cùng tồn tại).
        -->
        <div class="min-w-0">
          <!--
            Tiêu đề của page do chính Markdown sở hữu (`# Heading` ở đầu mỗi
            document), nên view **không** render thêm một `<h1>` nữa: hai `<h1>`
            cùng nội dung vừa lặp chữ trên màn hình vừa phá heading hierarchy.
            `page.title`/`page.description` vẫn được dùng cho navigation, TOC và
            SEO meta — chúng là metadata, không phải nội dung hiển thị lần hai.
          -->
          <article class="docs-content">
            <ContentRenderer :value="page" />
          </article>

          <DocsPager :previous="previous" :next="next" :labels="ui" />
        </div>

        <aside class="hidden lg:block">
          <div class="sticky top-20">
            <DocsToc v-if="toc" :toc="toc" :label="ui.onThisPage" />
          </div>
        </aside>
      </div>

      <div class="mt-6 lg:hidden">
        <DocsToc v-if="toc" :toc="toc" :label="ui.onThisPage" />
      </div>
    </div>
  </PublicShell>
</template>
