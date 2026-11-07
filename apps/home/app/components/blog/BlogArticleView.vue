<!--
  Trang article của blog — `/en/blog/<slug>`, `/vi/blog/<slug>`.

  Cột đọc hẹp giữ nguyên: TOC là khối đứng trên đầu bài (không phải cột phải
  kiểu docs), điều hướng nằm ở hai đầu đường đọc (về landing, trước/sau theo
  thời gian, trước/sau theo series, related). Shell dùng chung vẫn đảm bảo một
  landmark `<main>`, skip link và global nav có tên.
-->
<script setup lang="ts">
// Import tường minh (không phụ thuộc auto-import): component test mount SFC
// này ngoài Nuxt runtime (`@vitejs/plugin-vue` thuần) — same pattern với
// PublicShell của app/layout.
import { computed } from 'vue';
import type { PublicLocale } from '../../i18n/index';
import { PublicShell, buildPublicPath } from '../../layout/index';
import type { BlogCollectionItem, Toc } from '@nuxt/content';
import { ContentRenderer } from '#components';
import BlogTagList from '~/components/blog/BlogTagList.vue';
import BlogArticleToc from '~/components/blog/BlogArticleToc.vue';
import BlogSeriesNav from '~/components/blog/BlogSeriesNav.vue';
import { formatArticleDate } from '~/blog/blog-date';
import type { BlogArticleSummary } from '~/blog/blog-articles';
import type { BlogUiStrings } from '~/blog/blog-ui-strings';
import type { SeriesMeta } from '~/blog/blog-series';
import type { RenderableReference } from '~/blog/blog-references';

const {
  locale,
  page,
  summary,
  related,
  curatedRelated,
  prerequisites,
  previous,
  next,
  availableLocales,
  series,
  ui,
} =
  // oxlint-disable-next-line vue/max-props
  defineProps<{
    /** Locale đã được route validate từ registry — component không tự suy đoán. */
    readonly locale: PublicLocale;
    /** Document đầy đủ đã query từ collection `blog` (body Markdown rendered). */
    readonly page: BlogCollectionItem;
    /** Summary đã map từ frontmatter — nguồn cho meta, tag. */
    readonly summary: BlogArticleSummary;
    /** Related articles cùng tag chính, đã loại chính article này. */
    readonly related: readonly BlogArticleSummary[];
    /**
     * Related chọn tay, resolve từ `relatedArticleIds` ở route.
     *
     * Mang **title** cùng path: nhãn link là tiêu đề bài, không phải URL —
     * một link mà chữ hiển thị là `/en/blog/attention-from-…` là link của kỹ
     * thuật, không phải của một bài đọc. Rỗng khi bài không khai.
     */
    readonly curatedRelated: readonly RenderableReference[];
    /** Prerequisites, resolve từ `prerequisites` ở route — rỗng khi bài không khai. */
    readonly prerequisites: readonly RenderableReference[];
    /** Bài cũ hơn liền trước — `undefined` ở biên (bài cũ nhất). */
    readonly previous: { readonly path: string; readonly title: string } | undefined;
    /** Bài mới hơn liền sau — `undefined` ở biên (bài mới nhất). */
    readonly next: { readonly path: string; readonly title: string } | undefined;
    /** Locale thực sự có bản dịch của article — input cho locale switcher. */
    readonly availableLocales: readonly PublicLocale[];
    /**
     * Điều hướng series của bài — `undefined` khi bài không thuộc series nào
     * (khối series không render). Route resolve từ `SERIES_META` + danh sách
     * bài cùng series; component chỉ hiển thị.
     */
    readonly series:
      | {
          readonly id: string;
          readonly meta: SeriesMeta;
          readonly previous: { readonly path: string; readonly title: string } | undefined;
          readonly next: { readonly path: string; readonly title: string } | undefined;
        }
      | undefined;
    readonly ui: BlogUiStrings;
  }>();

/**
 * Link về blog landing — dựng qua builder của `app/layout`, không
 * concatenate. Bọc `computed()` để track prop `locale`: client-side navigate
 * giữa hai locale tái dùng instance component này, path tính một lần lúc
 * setup sẽ trỏ landing cũ trong khi nội dung đã sang locale mới.
 */
const blogRoot = computed(() => buildPublicPath({ locale, mount: 'blog' }));

/** TOC của bài — dữ liệu do content renderer sinh lúc build, không parse lại. */
const toc = computed<Toc | undefined>(() => page.body?.toc);
</script>

<template>
  <PublicShell :path="summary.path" :available-locales="availableLocales">
    <div class="mx-auto w-full max-w-3xl px-4 py-10 lg:px-8">
      <!--
        Tiêu đề của article do chính Markdown sở hữu (`# Heading` ở đầu mỗi
        document), nên view **không** render thêm một `<h1>` nữa: hai `<h1>`
        cùng nội dung vừa lặp chữ trên màn hình vừa phá heading hierarchy.
        `summary.title` vẫn được dùng cho SEO và `<title>` — metadata, không
        phải nội dung hiển thị lần hai.
      -->
      <p class="text-sm text-faint">
        <time :datetime="summary.date">{{ formatArticleDate(summary.date, locale) }}</time>
        <!--
          Ngày sửa có thực chất chỉ hiển thị khi frontmatter khai — không
          fallback về ngày xuất bản (hai ngày khác nghĩa). Cạnh đó là reviewer
          khi có tên thật; thiếu reviewer không bao giờ render khối rỗng hay
          nhãn giả.
        -->
        <template v-if="summary.updatedAt">
          <span aria-hidden="true"> · </span>
          <span>{{ ui.updated }}</span>
          <time :datetime="summary.updatedAt">{{
            formatArticleDate(summary.updatedAt, locale)
          }}</time>
        </template>
        <span aria-hidden="true"> · </span>
        <span>{{ ui.writtenBy }} {{ summary.author }}</span>
        <template v-if="summary.reviewer">
          <span aria-hidden="true"> · </span>
          <span
            >{{ ui.reviewedBy }} {{ summary.reviewer.name
            }}<template v-if="summary.reviewer.title">
              ({{ summary.reviewer.title }})</template
            ></span
          >
        </template>
      </p>

      <div class="mt-2">
        <BlogTagList :tags="summary.tags" :label="ui.tags" />
      </div>

      <!--
        Prerequisites của bài research — resolve từ `articleId` ở route thành
        `{path, title}`; chỉ những ID resolve được mới tới đây (link chết không
        sinh từ phía này). Rỗng thì không render khối.
      -->
      <nav v-if="prerequisites.length > 0" :aria-label="ui.prerequisites" class="mt-6">
        <p class="text-xs font-semibold uppercase tracking-wide text-faint">
          {{ ui.prerequisites }}
        </p>
        <ul class="mt-2 space-y-1 text-sm">
          <li v-for="reference in prerequisites" :key="reference.path">
            <NuxtLink
              :to="reference.path"
              class="text-foam underline hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
            >
              {{ reference.title }}
            </NuxtLink>
            <span v-if="reference.isEnglishFallback" class="text-faint">
              ({{ ui.englishLabel }})
            </span>
          </li>
        </ul>
      </nav>

      <!--
        Cover của article: nằm trên khối nội dung ở tỉ lệ full-cột đọc — đây
        là phần tử LCP của trang, nên `loading="eager"` + `fetchpriority="high"`
        (lazy trên LCP image là anti-pattern: browser chỉ bắt đầu tải khi phần
        tử gần viewport). `decoding="async"` giữ lại — giải mã bất đồng bộ
        không chặn render. Article không cover thì không render `<img>`.
      -->
      <img
        v-if="summary.cover"
        :src="summary.cover.src"
        :alt="summary.cover.alt"
        class="mt-6 aspect-video w-full rounded-lg object-cover"
        loading="eager"
        fetchpriority="high"
        decoding="async"
      />

      <!--
        TOC đứng giữa meta và nội dung — khối disclosure duy nhất của cột đọc
        hẹp (không copy layout ba cột của docs). Bài ngắn không đạt ngưỡng
        heading thì component không render gì.
      -->
      <div class="mt-6">
        <BlogArticleToc :toc="toc" :label="ui.tableOfContents" />
      </div>

      <!--
        `PublicShell` đã render landmark `<main>` bọc slot này, nên ở đây chỉ
        dùng `<div>`: lồng `<main>` trong `<main>` là HTML không hợp lệ và làm
        hỏng landmark cho screen reader.
      -->
      <div class="blog-content mt-8">
        <ContentRenderer :value="page" />
      </div>

      <!--
        Điều hướng series — tách hoàn toàn khỏi pager thời gian bên dưới: hai
        `<nav>` hai accessible name, hai ngữ nghĩa (thứ tự học tập ≠ mới/cũ).
      -->
      <BlogSeriesNav
        v-if="series"
        :series-id="series.id"
        :meta="series.meta"
        :previous="series.previous"
        :next="series.next"
        :ui="ui"
      />

      <p class="mt-10">
        <NuxtLink
          v-if="blogRoot.kind === 'localized'"
          :to="blogRoot.path"
          class="text-sm font-medium text-muted hover:text-foam hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
        >
          ← {{ ui.allPosts }}
        </NuxtLink>
      </p>

      <!--
        Cặp prev/next chỉ chứa article **cùng locale** (query đã lọc ở tầng SQL,
        xem route). Ngữ nghĩa theo trục thời gian: "previous" = bài cũ hơn,
        "next" = bài mới hơn — nguồn là `pickAdjacentArticles` trong
        `blog-articles.ts`. `<nav>` mang tên riêng để không trùng accessible
        name với global nav của shell.
      -->
      <nav
        v-if="previous || next"
        :aria-label="ui.pagination"
        class="mt-8 flex flex-col gap-3 border-t border-line pt-6 sm:flex-row sm:justify-between"
      >
        <div v-if="previous" class="sm:max-w-[48%]">
          <p class="text-xs uppercase tracking-wide text-faint">{{ ui.previous }}</p>
          <NuxtLink
            :to="previous.path"
            class="text-sm font-medium text-foam hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
          >
            {{ previous.title }}
          </NuxtLink>
        </div>
        <div v-if="next" class="sm:max-w-[48%] sm:text-right">
          <p class="text-xs uppercase tracking-wide text-faint">{{ ui.next }}</p>
          <NuxtLink
            :to="next.path"
            class="text-sm font-medium text-foam hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
          >
            {{ next.title }}
          </NuxtLink>
        </div>
      </nav>

      <section v-if="related.length > 0 || curatedRelated.length > 0" class="mt-12">
        <h2 class="text-lg font-semibold tracking-tight text-foam">{{ ui.related }}</h2>
        <ul class="mt-4 space-y-3">
          <!--
            Related chọn tay (`relatedArticleIds` resolve theo identity) đứng
            trước related theo tag — curation của tác giả có ưu tiên cao hơn
            heuristic. Resolve ở route; ID không resolve được không tới đây
            (không link chết).
          -->
          <li v-for="reference in curatedRelated" :key="reference.path">
            <p class="text-sm">
              <NuxtLink
                :to="reference.path"
                class="font-medium text-foam hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
              >
                {{ reference.title }}
              </NuxtLink>
              <span v-if="reference.isEnglishFallback" class="text-faint">
                ({{ ui.englishLabel }})
              </span>
            </p>
          </li>
          <li v-for="article in related" :key="article.path">
            <p class="text-sm">
              <NuxtLink
                :to="article.path"
                class="font-medium text-foam hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
              >
                {{ article.title }}
              </NuxtLink>
              <span class="text-faint"> — {{ article.description }}</span>
            </p>
          </li>
        </ul>
      </section>
    </div>
  </PublicShell>
</template>
