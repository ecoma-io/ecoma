<script setup lang="ts">
import { ref } from 'vue';
import { PublicShell } from '../../layout/index';
import { parseHomeLocaleRoot } from '~/domain/home-locale';
import { buildHomeSeo } from '~/domain/home-seo';
import { HOME_CONTENT } from '~/domain/home-content';
import { useHomeMotion } from '~/domain/home-motion';

/**
 * Route `/en` và `/vi` — locale-root surface của Home.
 *
 * File-based route `[locale]/index.vue` chỉ khớp pathname **một segment** sau
 * `/`, nên `/en/foo` không bao giờ vào được page này. Việc còn lại là bảo
 * đảm segment đó là một **locale hợp lệ** và **không** có gì khác lạ trong
 * pathname (`/en/`, `/EN`, `/%65n`).
 *
 * Thứ tự `validate` rồi mới tới `setup`: route bị `validate` từ chối trả 404
 * và component không render, nên mọi truy cập vào content bên dưới đã được
 * bảo đảm locale hợp lệ.
 */
definePageMeta({
  /**
   * Chỉ nhận pathname là locale-root của Home.
   *
   * Nguồn pathname khác nhau theo môi trường, và đây là điểm **quan trọng
   * nhất** của cả route. Trên server, `to.path` đã bị **percent-decode**
   * trước khi `validate` nhìn thấy nó: `/%65n` đến đây dưới dạng `/en`.
   * Dùng `to.path` ở đó sẽ hợp lệ hoá một URL **không** canonical và biến
   * `%65n` thành đường vòng qua strict canonicality.
   *
   * Việc decode **không** do vue-router: `router.resolve('/%65n').path` giữ
   * nguyên `/%65n` trên cả vue-router 4.6.4 (dependency gốc) lẫn 5.3.1 (bản
   * Nuxt bundle) — đã kiểm chứng trực tiếp (chỉ `params` được decode:
   * `params.locale === 'en'`). Chuỗi thật trong SSR là:
   *
   * 1. h3 chuẩn hoá request path khi vào app: `createAppEventHandler` tính
   *    `_decodePath(event.node.req.url)` (percent-decode phần path, giữ nguyên
   *    query) rồi gán vào `event._path` — và getter `event.path` đọc chính
   *    `_path` đó (`h3/dist/index.mjs`). Nên **`event.path` là pathname đã
   *    decode**, còn `event.node.req.originalUrl` (byte gốc trên wire) thì
   *    không;
   * 2. Nitro dựng `ssrContext` từ path đó: `createSSRContext(event)` đặt
   *    `ssrContext.url = encodeEventPath(event.path)`
   *    (`@nuxt/nitro-server/dist/runtime/utils/renderer/app.mjs`), tức từ
   *    pathname **đã decode** ở bước 1;
   * 3. plugin router của Nuxt lấy `initialURL = nuxtApp.ssrContext.url` rồi
   *    `router.push(initialURL)` (`nuxt/dist/pages/runtime/plugins/router.js`)
   *    — vì vue-router không decode, `to.path` mang đúng giá trị đã decode
   *    từ bước 1.
   *
   * `useRequestURL()` trên server đọc `event.node.req.originalUrl` trước
   * `event.path` (`h3` `getRequestURL`: `event.node.req.originalUrl ||
   * event.path`, cộng `useRequestURL` của Nuxt gọi thẳng `getRequestURL`),
   * nên `.pathname` của nó vẫn là **byte gốc chưa decode** — đúng thứ cần cho
   * strict canonicality, và đã kiểm chứng bằng probe: request
   * `/%65n` cho `useRequestURL().pathname === '/%65n'` nhưng `event.path` và
   * `to.path` trong `validate` đều là `/en`.
   *
   * Trên client, path đến từ `window.location` qua `createCurrentLocation`
   * của Nuxt (không qua h3), nên `to.path` giữ nguyên encoding — `to.path` là
   * nguồn **thô** ở đó.
   *
   * Vì vậy server lấy pathname thô từ request URL gốc chưa bị h3 chuẩn hoá
   * (`useRequestURL().pathname`), còn client dùng `to.path`. Hai nguồn này
   * được chọn đúng theo từng môi trường thay vì dùng chung một nguồn đã bị
   * decode ở một phía.
   *
   * Kiểm tra luôn đi qua `parseHomeLocaleRoot` → `parsePublicPath` của
   * `app/i18n` với so khớp exact: không decode, không lowercase, không
   * strip slash, nên `/%65n`, `/EN`, `/Vi`, `/en/` và mọi pathname có
   * remainder đều bị từ chối mà không cần bảng locale thứ hai.
   */
  validate: (to) => {
    const rawPathname = import.meta.server ? useRequestURL().pathname : to.path;
    return parseHomeLocaleRoot(rawPathname) !== undefined;
  },
});

const route = useRoute();

/**
 * Locale của trang — parse lại từ pathname, không đọc `route.params.locale`.
 *
 * `route.params.locale` là dữ liệu đã decode của router; pathname mới là
 * nguồn chân lý của URL. `validate` đã chặn mọi pathname không phải
 * locale-root, nên nhánh `undefined` ở đây thuần phòng thủ: nó biến "locale
 * không xác định" thành 404 thay vì fallback âm thầm sang `en` — fallback
 * kiểu đó sẽ phục vụ nội dung của một locale dưới URL của locale khác, và
 * tạo ra một URL không self-canonical.
 */
const locale = parseHomeLocaleRoot(route.path);
if (locale === undefined) {
  throw createError({ statusCode: 404, statusMessage: 'Page Not Found' });
}

const content = HOME_CONTENT[locale];
const seo = buildHomeSeo(locale, content);

/* Root `/` không emit SEO metadata — `/` chỉ là locale-resolution entry point,
 * không serve content (`docs/architecture/01-architecture.md` A13), và `<head>`
 * của nó thuộc về redirect 302 tới `/en`, không phải một trang.
 *
 * `canonical` và `hreflang` là URL tuyệt đối dưới production origin
 * (`~/domain/home-origin`) — không phải pathname tương đối, và không phải
 * origin của request đang phục vụ. Xem `buildHomeSeo` để biết vì sao. */
useHead({
  htmlAttrs: { lang: seo.lang },
  title: seo.title,
  meta: [{ name: 'description', content: seo.description }],
  link: [{ rel: 'canonical', href: seo.canonicalUrl }, ...seo.alternates],
});

/**
 * Motion — GSAP hero timeline + scroll reveal, client-only. Root ref bọc cả
 * trang; composable tự chạy lifecycle `onMounted`/`onBeforeUnmount` bên trong
 * (một mount duy nhất của page) nên server không chạy gì: mọi
 * `data-hero`/`data-reveal` render hiển thị đầy đủ trong HTML SSR.
 */
const motionRoot = ref<HTMLElement | undefined>(undefined);
useHomeMotion(motionRoot);
</script>

<template>
  <!--
    `PublicShell` là nguồn duy nhất của header/footer; Home chỉ đưa pathname
    hiện tại vào đó (`route.path`, không phải `route.fullPath`) để shell tự
    parse một lần. `route.path` không chứa query/hash nên luôn có dạng
    pathname mà `parsePublicLayoutPath` nhận.

    Không truyền `availableLocales`: Home tồn tại ở **mọi** locale của registry,
    nên mặc định của shell (toàn bộ registry) mới là đúng — không resource
    nào của Home bị giới hạn locale.

    Cấu trúc bám mockup tham chiếu (hero → intro → platform → developers);
    mọi câu nói chỉ mô tả bề mặt đang tồn tại — không số liệu, không
    placeholder, không link tới bề mặt đã bị xoá.
  -->
  <PublicShell :path="route.path">
    <div ref="motionRoot">
      <!-- Hero -->
      <section class="relative overflow-hidden">
        <div aria-hidden="true" class="hero-glow pointer-events-none absolute inset-0"></div>
        <div aria-hidden="true" class="hero-grid pointer-events-none absolute inset-0"></div>
        <div
          class="relative mx-auto w-full max-w-9xl px-4 pb-16 pt-20 sm:px-6 sm:pt-28 lg:px-8 wide:px-12 ultrawide:px-16"
        >
          <p
            data-hero="eyebrow"
            class="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-brand-soft"
          >
            <span aria-hidden="true" class="size-1.5 rounded-full bg-brand"></span>
            {{ content.eyebrow }}
          </p>
          <h1
            data-hero="heading"
            class="mt-5 max-w-3xl text-5xl font-extrabold leading-[1.02] tracking-tight text-foam sm:text-6xl"
          >
            {{ content.heading }}
          </h1>
          <p data-hero="description" class="mt-6 max-w-2xl text-lg leading-relaxed text-muted">
            {{ content.description }}
          </p>
          <ul
            data-hero="proofs"
            class="mt-10 flex flex-wrap gap-x-8 gap-y-2 border-t border-line pt-6 text-sm text-muted"
          >
            <li v-for="proof in content.heroProofs" :key="proof" class="flex items-center gap-2">
              <span aria-hidden="true" class="size-1 rounded-full bg-brand"></span>
              {{ proof }}
            </li>
          </ul>
        </div>
      </section>

      <!-- Intro -->
      <section
        data-reveal
        class="mx-auto w-full max-w-9xl border-t border-line px-4 py-12 text-muted sm:px-6 lg:px-8 wide:px-12 ultrawide:px-16"
      >
        <p v-for="paragraph in content.intro" :key="paragraph">{{ paragraph }}</p>
      </section>

      <!-- Platform points -->
      <section
        data-reveal
        class="mx-auto w-full max-w-9xl border-t border-line px-4 py-12 sm:px-6 lg:px-8 wide:px-12 ultrawide:px-16"
      >
        <h2 class="text-2xl font-semibold tracking-tight text-foam">
          {{ content.platformLabel }}
        </h2>
        <ul class="mt-6 grid gap-3 sm:grid-cols-2">
          <li
            v-for="point in content.platformPoints"
            :key="point"
            class="rounded-lg border border-line bg-surface p-4 text-sm leading-relaxed text-muted"
          >
            {{ point }}
          </li>
        </ul>
      </section>

      <!-- Developers -->
      <section
        data-reveal
        class="mx-auto w-full max-w-9xl border-t border-line px-4 py-16 sm:px-6 lg:px-8 wide:px-12 ultrawide:px-16"
      >
        <div class="grid items-center gap-10 lg:grid-cols-2">
          <div>
            <p class="text-xs font-bold uppercase tracking-[0.14em] text-faint">
              {{ content.developersLabel }}
            </p>
            <h2 class="mt-3 text-3xl font-bold tracking-tight text-foam sm:text-4xl">
              {{ content.developersHeading }}
            </h2>
            <p class="mt-3 max-w-xl text-muted">{{ content.developersDescription }}</p>
            <ul class="mt-8 space-y-3 text-sm text-muted">
              <li
                v-for="point in content.developersPoints"
                :key="point"
                class="flex items-start gap-3"
              >
                <span
                  aria-hidden="true"
                  class="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand"
                ></span>
                {{ point }}
              </li>
            </ul>
          </div>
          <!-- Code window: giả terminal thuần trình bày, nội dung từ
               HOME_CONTENT (không hardcode), SSR render đầy đủ. -->
          <div class="dev-terminal" role="img" :aria-label="content.developersTerminal.label">
            <div class="dev-terminal-bar">
              <span aria-hidden="true" class="dev-terminal-dot"></span>
              <span aria-hidden="true" class="dev-terminal-dot"></span>
              <span aria-hidden="true" class="dev-terminal-dot"></span>
            </div>
            <div class="dev-terminal-body text-muted">
              <p
                v-for="line in content.developersTerminal.lines"
                :key="line"
                class="whitespace-pre"
              >
                {{ line }}
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  </PublicShell>
</template>
