<!--
  Trang overview của một series — `/<locale>/blog/series/<id>`, render từ route
  blog catch-all khi remainder khớp `series/<id>`.

  Route đã bảo đảm: series tồn tại trong `SERIES_META` **và** có ít nhất một
  bài published (ngược lại là 404 từ route, không tới được đây) — component
  không tự kiểm tra lại, chỉ render danh sách theo thứ tự học tập.

  Đây KHÔNG phải listing thời gian: thứ tự là `seriesOrder` (lộ trình đọc), số
  vị trí được hiển thị để người đọc thấy tầm quan hệ giữa các bài.
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { PublicLocale } from '../../i18n/index';
import { PublicShell } from '../../layout/index';
import { formatArticleDate } from '~/blog/blog-date';
import type { BlogArticleSummary } from '~/blog/blog-articles';
import type { BlogUiStrings } from '~/blog/blog-ui-strings';
import type { SeriesMeta } from '~/blog/blog-series';

// oxlint-disable-next-line vue/max-props
const { locale, seriesId, meta, articles, availableLocales, ui } = defineProps<{
  /** Locale đã được route validate từ registry. */
  readonly locale: PublicLocale;
  /** Series ID — đã qua validate route (nằm trong `SERIES_META`). */
  readonly seriesId: string;
  /** Metadata hiển thị của series. */
  readonly meta: SeriesMeta;
  /** Bài của series theo thứ tự học tập (`seriesOrder` tăng). */
  readonly articles: readonly BlogArticleSummary[];
  /**
   * Locale switcher chỉ được quảng bá locale thực sự có trang series này —
   * series overview tồn tại per locale theo content, không phải bản dịch
   * một-một của nhau. Truyền `[locale]` từ route: thiếu nó, `PublicShell`
   * suy từ registry và switcher render link tới series page của locale khác
   * (chưa có bài published → 404) — và prerender crawler bám theo link đó.
   */
  readonly availableLocales: readonly PublicLocale[];
  readonly ui: BlogUiStrings;
}>();

const headingId = computed(() => `series-overview-${seriesId}`);
</script>

<template>
  <PublicShell :path="`/${locale}/blog/series/${seriesId}`" :available-locales="availableLocales">
    <div class="mx-auto w-full max-w-3xl px-4 py-10 lg:px-8">
      <header>
        <p class="text-sm font-semibold uppercase tracking-wide text-faint">{{ ui.series }}</p>
        <h1 class="mt-2 text-3xl font-bold tracking-tight text-foam sm:text-4xl">
          {{ meta.title }}
        </h1>
        <p class="mt-3 max-w-2xl text-lg leading-relaxed text-muted">
          {{ meta.description }}
        </p>
      </header>

      <section class="mt-10" :aria-labelledby="headingId">
        <h2 :id="headingId" class="text-xl font-semibold tracking-tight text-foam">
          {{ ui.seriesContents }}
        </h2>
        <ol class="mt-6 space-y-4">
          <li
            v-for="(article, index) in articles"
            :key="article.path"
            class="border-b border-line pb-4 last:border-b-0"
          >
            <p class="text-xs font-semibold uppercase tracking-wide text-faint">
              {{ index + 1 }}<span aria-hidden="true"> · </span
              ><time :datetime="article.date">{{ formatArticleDate(article.date, locale) }}</time>
            </p>
            <h3 class="mt-1 text-lg font-semibold tracking-tight text-foam">
              <!--
                Link duy nhất trỏ tới article là title (`one card, one link`,
                same pattern với `BlogArticleCard`).
              -->
              <NuxtLink
                :to="article.path"
                class="hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
              >
                {{ article.title }}
              </NuxtLink>
            </h3>
            <p class="mt-1 text-sm leading-relaxed text-muted">
              {{ article.description }}
            </p>
          </li>
        </ol>
      </section>
    </div>
  </PublicShell>
</template>
