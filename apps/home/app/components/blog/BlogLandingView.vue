<!--
  Trang landing của blog — `/en/blog`, `/vi/blog`.

  Route dùng chung `[[...slug]].vue` cho cả landing lẫn article, nên view nhận
  dữ liệu đã resolve từ route và chỉ render. Hero là article featured (hoặc
  fallback bài mới nhất — logic trong `blog-articles.ts`), dưới đó là listing
  các article còn lại mới nhất trước, và khối series (chỉ series có bài
  published — route suy từ content, không phải danh mục).
-->
<script setup lang="ts">
// Import tường minh (không phụ thuộc auto-import): component test mount SFC
// này ngoài Nuxt runtime (`@vitejs/plugin-vue` thuần) — same pattern với
// PublicShell của app/layout.
import { computed } from 'vue';
import type { PublicLocale } from '../../i18n/index';
import { PublicShell, buildPublicPath } from '../../layout/index';
import BlogArticleCard from '~/components/blog/BlogArticleCard.vue';
import BlogTagList from '~/components/blog/BlogTagList.vue';
import { formatArticleDate } from '~/blog/blog-date';
import type { BlogArticleSummary } from '~/blog/blog-articles';
import type { BlogUiStrings } from '~/blog/blog-ui-strings';
import type { SeriesMeta } from '~/blog/blog-series';

const { locale, featured, secondaryLeads, rest, fallback, series, availableLocales } =
  // oxlint-disable-next-line vue/max-props
  defineProps<{
    /** Locale đã được route validate từ registry — component không tự suy đoán. */
    readonly locale: PublicLocale;
    /** Article featured (hoặc fallback bài mới nhất) — vắng khi blog rỗng. */
    readonly featured: BlogArticleSummary | undefined;
    /**
     * Lead phụ đứng cạnh hero ở `wide:`/`ultrawide:` — hai bài mới nhất ngay sau
     * featured, **chỉ hiện tiêu đề**. Route đã cắt chúng khỏi `rest`, nên mỗi
     * bài chỉ xuất hiện một lần trên trang (một link duy nhất).
     *
     * Render ở **mọi** bề rộng, không ẩn ở ngưỡng hẹp: vì route đã cắt chúng
     * khỏi `rest`, ẩn đi là mất bài hoàn toàn khỏi landing dưới 1600px. Dưới
     * `wide:` khối nằm ngay dưới hero như danh sách tiêu đề xếp dọc. Giữ nó
     * trong DOM ở mọi bề rộng cũng là điều kiện để prerender đi theo link
     * (`crawlLinks` đọc HTML thô).
     */
    readonly secondaryLeads: readonly BlogArticleSummary[];
    /** Các article còn lại sau hero, mới nhất trước. */
    readonly rest: readonly BlogArticleSummary[];
    /**
     * Landing đang ở trạng thái **fallback discovery**: locale hiện tại không
     * có bài published — listing là các bài English. Route resolve trạng thái
     * này (component không tự đếm); khi `true`, thông báo `ui.fallbackNotice`
     * được render trên listing để người đọc biết bài bên dưới là tiếng Anh.
     */
    readonly fallback: boolean;
    /**
     * Series có ít nhất một bài published ở locale này — route suy từ content
     * (`seriesWithArticles`), nên danh sách rỗng là bình thường và khối không
     * render. Link của mỗi series là đường crawler prerender tới trang overview.
     */
    readonly series: readonly {
      readonly id: string;
      readonly meta: SeriesMeta;
      readonly path: string;
      readonly articleCount: number;
    }[];
    /** Locale thực sự có bản dịch của landing — input cho locale switcher. */
    readonly availableLocales: readonly PublicLocale[];
    readonly ui: BlogUiStrings;
  }>();

/**
 * Landing path canonical của mount — dựng qua builder của `app/layout`
 * thay vì concatenate `/${locale}/blog`, để landing đi đúng cùng contract
 * topology với mọi path public khác của app. Bọc trong `computed()` để track
 * prop `locale`: `PublicShell` có contract phản ứng khi `path` đổi, và
 * client-side navigate `/en/blog` → `/vi/blog` tái dùng instance component
 * này (cùng route record, chỉ đổi param) — path tính một lần lúc setup sẽ
 * giữ nguyên locale cũ trong khi nội dung đã sang locale mới.
 */
const currentPath = computed<string>(() => {
  const built = buildPublicPath({ locale, mount: 'blog' });
  return built.kind === 'localized' ? built.path : '/';
});
</script>

<template>
  <PublicShell :path="currentPath" :available-locales="availableLocales">
    <div class="mx-auto w-full max-w-9xl px-4 py-10 lg:px-8 wide:px-12 ultrawide:px-16">
      <!--
        Hero chỉ render khi có article featured (hoặc fallback). Blog rỗng vẫn
        là landing hợp lệ: tiêu đề + listing rỗng, không hero rỗng — và "tiêu
        đề" ở đây là `<h1>` thật: blog rỗng cũng không được mất heading cấp
        một (hierarchy cho screen reader + tín hiệu chủ đề cho SEO), nên
        `ui.blog` làm h1 fallback khi không có hero.
      -->
      <h1 v-if="!featured" class="text-3xl font-bold tracking-tight text-foam sm:text-4xl">
        {{ ui.blog }}
      </h1>
      <!--
        Khối featured. Từ `wide:` (1600px) chia hai cột — lead lớn bên trái, hai
        lead phụ chỉ có tiêu đề xếp dọc bên phải. Dưới `wide:` là **một** lead
        lớn như hiện tại, kèm danh sách tiêu đề của hai lead phụ ngay dưới nó
        (xem ghi chú ở khối phụ — hai bài đó không được ẩn ở ngưỡng hẹp).

        Grid bắt đầu ở `wide:` chứ không phải `lg:`/`2xl:`: container là
        `max-w-9xl` (1536px), nên ở `wide:` nội dung còn ~1440px — đủ hai cột
        mà **không** phải nới `max-w`, tức không đụng tới mọi landing khác.

        Hai lead phụ nằm trong DOM ở **mọi** bề rộng, không render theo điều
        kiện JS: prerender đi theo link trong HTML thô (`crawlLinks: true` ở
        `nitro.config.ts`), nên bài chỉ tồn tại ở breakpoint rộng sẽ không bao
        giờ được prerender — mất cả link cho crawler lẫn cho người đọc.
      -->
      <div
        v-if="featured"
        class="wide:grid wide:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] wide:items-start wide:gap-8"
      >
        <article>
          <!--
            Nhãn chỉ khi article hero thực sự `featured: true` — fallback bài
            mới nhất không phải featured, gắn nhãn đó là nói dối người đọc.
          -->
          <p
            v-if="featured.featured"
            class="text-sm font-semibold uppercase tracking-wide text-faint"
          >
            {{ ui.featured }}
          </p>
          <!--
            Cover của hero: phần tử LCP của landing, `fetchpriority="high"` để
            browser ưu tiên tải ngay; `aspect-video` + `object-cover` giữ tỉ lệ
            khung bất kể kích thước gốc. Featured không cover thì không render
            `<img>` — không hình hỏng.

            `max-w-4xl` giữ bề rộng cover của bố cục một cột như hiện tại; từ
            `wide:` cột lead rộng hơn giới hạn đó (~938px), nên `wide:max-w-none`
            cho cover lấp đầy cột — bỏ giới hạn chỉ ở ngưỡng có hai cột, mọi
            bề rộng dưới đó giữ nguyên bố cục cũ.
          -->
          <img
            v-if="featured.cover"
            :src="featured.cover.src"
            :alt="featured.cover.alt"
            class="mt-4 aspect-video w-full max-w-4xl rounded-lg object-cover wide:max-w-none"
            fetchpriority="high"
          />
          <h1 class="mt-2 text-3xl font-bold tracking-tight text-foam sm:text-4xl">
            <a
              :href="featured.path"
              :aria-label="`${featured.title} — ${ui.readMore}`"
              class="hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
            >
              {{ featured.title }}
            </a>
          </h1>
          <p class="mt-3 max-w-2xl text-lg leading-relaxed text-muted">
            {{ featured.description }}
          </p>
          <p class="mt-3 text-sm text-faint">
            <time :datetime="featured.date">{{ formatArticleDate(featured.date, locale) }}</time>
            <span aria-hidden="true"> · </span>
            <span>{{ ui.writtenBy }} {{ featured.author }}</span>
          </p>
          <div class="mt-3">
            <BlogTagList :tags="featured.tags" :label="ui.tags" />
          </div>
        </article>

        <!--
          Hai lead phụ: **chỉ tiêu đề**, không cover / mô tả / meta — để cột
          phải là mục lục ngang của phần đầu trang, không cạnh tranh sự chú ý
          với lead lớn.

          Khối này render ở **MỌI** bề rộng, không ẩn dưới `wide:`. Route đã cắt
          hai bài này ra khỏi `rest`, nên `hidden` ở ngưỡng hẹp sẽ khiến chúng
          **không xuất hiện ở đâu cả** trên landing — mất cả link cho crawler lẫn
          cho người đọc ở mọi màn dưới 1600px. Dưới `wide:` wrapper không phải
          grid nên khối nằm ngay dưới hero như một danh sách tiêu đề xếp dọc;
          từ `wide:` nó thành cột thứ hai. Bố cục dưới `wide:` vì thế **không**
          y hệt trước đây (có thêm danh sách tiêu đề này) — đánh đổi có chủ đích
          để không mất bài.

          `<h2>` chứ không phải `<h3>`: đây là nhánh ngang hàng với lead trong
          khối featured, không phải con của lead. Landing vẫn đúng **một**
          `<h1>` — tiêu đề bài featured.

          Link là **tiêu đề duy nhất** trỏ tới bài (`one card, one link`), cùng
          pattern với `BlogArticleCard`.
        -->
        <div
          v-if="secondaryLeads.length > 0"
          data-secondary-leads
          class="mt-6 flex flex-col gap-6 wide:mt-0"
        >
          <h2
            v-for="lead in secondaryLeads"
            :key="lead.path"
            class="border-t border-line pt-4 text-xl font-semibold leading-snug tracking-tight text-foam"
          >
            <NuxtLink
              :to="lead.path"
              :aria-label="`${lead.title} — ${ui.readMore}`"
              class="hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
            >
              {{ lead.title }}
            </NuxtLink>
          </h2>
        </div>
      </div>

      <section class="mt-12">
        <h2 class="text-xl font-semibold tracking-tight text-foam">{{ ui.latest }}</h2>
        <!--
          Fallback discovery: locale này chưa có bài — listing là các bài
          English. Thông báo đứng **trước** listing để người đọc không nhầm
          bài tiếng Anh là thiếu sản phẩm của locale họ đang đọc.
        -->
        <p v-if="fallback" class="mt-3 max-w-2xl text-base leading-relaxed text-muted">
          {{ ui.fallbackNotice }}
        </p>
        <ul class="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <li v-for="article in rest" :key="article.path">
            <BlogArticleCard :article="article" :locale="locale" :ui="ui" />
          </li>
        </ul>
      </section>

      <!--
        Khối series: chỉ render khi có ít nhất một series có bài published ở
        locale này (route đã lọc — series chưa có bài không bao giờ xuất hiện,
        nên không link chết tới trang series 404). Link đến overview là phần tử
        đầu tiên của card — `one card, one link`, cùng pattern với article card.
      -->
      <section v-if="series.length > 0" class="mt-12">
        <h2 class="text-xl font-semibold tracking-tight text-foam">{{ ui.series }}</h2>
        <ul class="mt-6 grid gap-6 sm:grid-cols-2">
          <li v-for="entry in series" :key="entry.id" class="rounded-lg border border-line p-5">
            <h3 class="text-lg font-semibold tracking-tight text-foam">
              <NuxtLink
                :to="entry.path"
                class="hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
              >
                {{ entry.meta.title }}
              </NuxtLink>
            </h3>
            <p class="mt-2 text-sm leading-relaxed text-muted">
              {{ entry.meta.description }}
            </p>
            <p class="mt-3 text-xs font-semibold uppercase tracking-wide text-faint">
              {{ entry.articleCount }} {{ ui.articlesUnit }}
            </p>
          </li>
        </ul>
      </section>
    </div>
  </PublicShell>
</template>
