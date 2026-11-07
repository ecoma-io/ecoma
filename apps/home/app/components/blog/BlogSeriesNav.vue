<!--
  Điều hướng series của một article — khối "bài trước/sau trong chuỗi" tách
  biệt rõ với pager thời gian (`previous`/`next` của route): hai `<nav>` mang
  hai accessible name khác nhau, hai ngữ nghĩa khác nhau (thứ tự học tập của
  series ≠ trục thời gian của blog).

  Bài không thuộc series không render gì (`neighbors` `undefined`) — component
  không tự đoán membership từ dữ liệu khác.
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { BlogUiStrings } from '~/blog/blog-ui-strings';
import type { SeriesMeta } from '~/blog/blog-series';

// oxlint-disable-next-line vue/max-props
const { seriesId, meta, previous, next, ui } = defineProps<{
  /** Series ID của article hiện tại — bài ngoài series không render component này. */
  readonly seriesId: string;
  /** Metadata hiển thị của series (từ `SERIES_META`). */
  readonly meta: SeriesMeta;
  /** Bài liền trước trong thứ tự học tập — `undefined` ở đầu series. */
  readonly previous:
    | { readonly path: string; readonly title: string; readonly seriesOrder?: number }
    | undefined;
  /** Bài liền sau trong thứ tự học tập — `undefined` ở cuối series. */
  readonly next:
    | { readonly path: string; readonly title: string; readonly seriesOrder?: number }
    | undefined;
  readonly ui: BlogUiStrings;
}>();

const headingId = computed(() => `series-${seriesId}`);
</script>

<template>
  <section :aria-labelledby="headingId" class="mt-10 rounded-lg border border-line bg-surface p-5">
    <h2 :id="headingId" class="text-sm font-semibold uppercase tracking-wide text-faint">
      {{ ui.series }}: {{ meta.title }}
    </h2>
    <nav
      v-if="previous || next"
      :aria-label="`${ui.series}: ${meta.title}`"
      class="mt-4 flex flex-col gap-3 sm:flex-row sm:justify-between"
    >
      <div v-if="previous" class="sm:max-w-[48%]">
        <p class="text-xs uppercase tracking-wide text-faint">{{ ui.seriesPrevious }}</p>
        <NuxtLink
          :to="previous.path"
          class="text-sm font-medium text-foam hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
        >
          {{ previous.title }}
        </NuxtLink>
      </div>
      <div v-if="next" class="sm:max-w-[48%] sm:text-right">
        <p class="text-xs uppercase tracking-wide text-faint">{{ ui.seriesNext }}</p>
        <NuxtLink
          :to="next.path"
          class="text-sm font-medium text-foam hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
        >
          {{ next.title }}
        </NuxtLink>
      </div>
    </nav>
  </section>
</template>
