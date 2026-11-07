<!--
  Error page của home — bề mặt duy nhất render lỗi HTTP của app.

  Nuxt render file này cho mọi `createError` thoát ra từ page: route
  `[locale]/index.vue` đã từ chối mọi pathname không phải locale-root bằng
  `validate` (→ 404) và ném 404 phòng thủ khi locale không parse được ở
  setup. Trang lỗi thay `app.vue`, nên phải tự lo chrome: `PublicShell` giữ
  header/footer/nav nhất quán với landing.

  Nguồn pathname: trên server, Nuxt render trang lỗi qua pipeline nội bộ
  `/__nuxt_error` — pathname của request h3 lúc đó là của request nội bộ,
  còn URL người dùng nằm trong `error.url` (nitro error handler forward URL
  gốc qua query, đã strip baseURL); client dùng `window.location` qua chính
  hàm fallback. Chi tiết ở comment trên `errorPathname`. Parse thất bại thì
  rơi về locale mặc định của app (`HOME_DEFAULT_LOCALE`), không bao giờ
  render trộn hai locale.

  Chỉ 404 được map sang shared page (`app/error-pages` là pure presenter;
  app sở hữu quyết định map). 401/500/unknown giữ fallback mặc định của Nuxt
  — không mở rộng map lỗi.
-->
<script setup lang="ts">
import { NotFoundPage, type ErrorPageContent } from './error-pages/index';
import { PublicShell, buildPublicPath } from './layout/index';
import { parsePublicPath, type PublicLocale } from './i18n/index';
import type { NuxtError } from '#app';
import { HOME_CONTENT } from '~/domain/home-content';
import { HOME_DEFAULT_LOCALE } from '#shared/default-locale';

const { error } = defineProps<{
  readonly error: NuxtError;
}>();

/**
 * Nitro đính kèm URL gốc của request lỗi vào error object khi forward qua
 * pipeline `/__nuxt_error` (`errorObject.url = withoutBase(...)`) — field
 * này có ở runtime nhưng type `NuxtError` của Nuxt không khai báo. Kiểu cấu
 * trúc cục bộ thay vì cast `as never`/`as any`.
 */
type ErrorWithUrl = NuxtError & { readonly url?: unknown };

/**
 * Locale cho trang lỗi — parse locale segment đầu của pathname request lỗi
 * qua `parsePublicPath` (chuẩn strict canonicality của `app/i18n`: không
 * decode, không lowercase, không repair).
 *
 * Nguồn pathname phải phân biệt môi trường:
 *
 * - **Server error render**: Nuxt render trang lỗi qua pipeline
 *   `/__nuxt_error?...` — `useRequestURL().pathname` lúc này là pathname của
 *   request lỗi **nội bộ** (`/__nuxt_error`), không phải URL người dùng.
 *   URL thật nằm trong `error.url` — nitro error handler đã strip baseURL
 *   trước khi forward (chỉ còn pathname + search + hash).
 * - **Client** (hydration lẫn navigation error): `error.url` không được
 *   đảm bảo (lỗi phát sinh client-side qua `createError` không có `.url`);
 *   `useRequestURL().pathname` đọc `window.location` — đúng URL hiện tại.
 *
 * `new URL(raw, base)` chấp nhận cả pathname thuần lẫn full URL. Mọi
 * pathname không canonical (`/%65n/...`, `/EN/...`, `//`) rơi về default —
 * trang lỗi không repair URL.
 */
const errorPathname: string = (() => {
  const withUrl = error as ErrorWithUrl;
  const raw =
    typeof withUrl.url === 'string' && withUrl.url.length > 0
      ? withUrl.url
      : useRequestURL().pathname;
  return new URL(raw, 'http://localhost').pathname;
})();
const errorLocale: PublicLocale = (() => {
  const parsed = parsePublicPath(errorPathname);
  return parsed.kind === 'localized' ? parsed.locale : HOME_DEFAULT_LOCALE;
})();

const content = HOME_CONTENT[errorLocale];

/**
 * CTA về locale-root của chính locale đang render — người dùng ở `/vi/foo`
 * nhận "Về trang chủ" trỏ `/vi`, không bị kéo về `en`.
 *
 * `buildPublicPath({ locale })` (không mount) trả `locale-root` — kind
 * `localized` không bao giờ xảy ra với input này; chỉ `invalid` là lỗi thật.
 * String concat thủ công `/${locale}` chỉ là fallback cuối cùng khi builder
 * reject (registry locale hỏng ở runtime) — contract của `buildPublicPath`
 * cấm caller tự ghép path trong luồng chính.
 */
const homeRoot = buildPublicPath({ locale: errorLocale });
const homeHref = homeRoot.kind === 'invalid' ? `/${errorLocale}` : homeRoot.path;

/** Nội dung đã localize cho trang 404 — hằng số theo locale, deterministic. */
const notFoundContent: ErrorPageContent = {
  title: content.notFoundTitle,
  description: content.notFoundDescription,
  primaryAction: { label: content.notFoundCta, href: homeHref },
};

/** 404 thật sự — các status khác giữ fallback mặc định của Nuxt. */
const isNotFound = computed(() => error.status === 404);

/** `<title>` của trang lỗi — cùng chuỗi với `<h1>`. */
useHead({ title: notFoundContent.title });
</script>

<template>
  <PublicShell v-if="isNotFound" :path="homeHref">
    <NotFoundPage :content="notFoundContent" />
  </PublicShell>
  <!--
    Status khác 404 (500, 401…): KHÔNG map sang shared error page — giữ fallback
    mặc định của Nuxt, đúng ranh giới của task (không mở rộng map lỗi).
  -->
  <main v-else class="grid min-h-dvh place-items-center bg-ink px-4 py-16">
    <div class="text-center">
      <h1 class="text-2xl font-bold text-foam">
        {{ error.status ?? error.statusCode }} — {{ error.statusText ?? error.statusMessage }}
      </h1>
      <p class="mt-2 text-sm text-muted">{{ error.message }}</p>
    </div>
  </main>
</template>
