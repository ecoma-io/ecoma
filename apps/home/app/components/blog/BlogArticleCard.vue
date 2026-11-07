<!--
  Card article trong listing landing: cover, title, mô tả, meta và tag.

  Link duy nhất trỏ tới article là **title** (`one card, one link` — một link
  lặp lại cùng đích chỉ nhân bản accessible name). `readMore` là nhãn truy cập
  được của chính link title, không phải một link thứ hai.
-->
<script setup lang="ts">
import type { PublicLocale } from '../../i18n/index';
// Import tường minh: auto-import đăng ký `BlogsBlogTagList` (prefix thư mục),
// còn template dùng `BlogTagList` — không import thì SSR render rỗng im lặng.
import BlogTagList from '~/components/blog/BlogTagList.vue';
import { formatArticleDate } from '~/blog/blog-date';
import type { BlogArticleSummary } from '~/blog/blog-articles';
import type { BlogUiStrings } from '~/blog/blog-ui-strings';

const { article, locale, ui } =
  // oxlint-disable-next-line vue/max-props
  defineProps<{
    readonly article: BlogArticleSummary;
    /**
     * Locale của trang đang render card — truyền xuống từ route qua view cha,
     * cùng nguồn với mọi component khác trên trang (không tự parse lại
     * `route.path` với fallback im lặng, không snapshot không reactive).
     */
    readonly locale: PublicLocale;
    readonly ui: BlogUiStrings;
  }>();
</script>

<template>
  <article class="flex flex-col overflow-hidden rounded-lg border border-line bg-surface">
    <!--
      Cover: `aspect-video` + `object-cover` giữ tỉ lệ khung bất kể kích thước
      gốc; `loading="lazy"`/`decoding="async"` vì card nằm dưới fold của
      listing. Article không cover thì không render `<img>` — không bao giờ
      có hình hỏng hay placeholder rỗng.
    -->
    <img
      v-if="article.cover"
      :src="article.cover.src"
      :alt="article.cover.alt"
      class="aspect-video w-full object-cover"
      loading="lazy"
      decoding="async"
    />
    <div class="flex flex-1 flex-col p-5">
      <h3 class="text-lg font-semibold tracking-tight text-foam">
        <!--
          `NuxtLink` thay `<a href>`: client-side navigate giữa các article
          không tải lại cả bundle, payload prerender được dùng lại. HTML tĩnh
          vẫn render `<a href>` thật nên SEO/crawl không đổi.
        -->
        <NuxtLink
          :to="article.path"
          :aria-label="`${article.title} — ${ui.readMore}`"
          class="hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
        >
          {{ article.title }}
        </NuxtLink>
      </h3>
      <p class="mt-2 flex-1 text-sm leading-relaxed text-muted">
        {{ article.description }}
      </p>
      <p class="mt-3 text-xs text-faint">
        <time :datetime="article.date">{{ formatArticleDate(article.date, locale) }}</time>
        <span aria-hidden="true"> · </span>
        <span>{{ article.author }}</span>
      </p>
      <div class="mt-3">
        <BlogTagList :tags="article.tags" :label="ui.tags" />
      </div>
    </div>
  </article>
</template>
