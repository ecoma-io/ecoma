<!--
  `PublicHeader` — shared public header: brand (artwork logo qua `EcomaLogo`
  của `@ecoma-io/ui-ecoma-logo`), global navigation (mega panel đa mục), locale switcher,
  CTA, mobile navigation. Theme tối theo design tokens (`bg-ink`, viền
  `border-line`, chữ `text-foam`/`text-muted`).

  Header **nhận state đã parse** từ `PublicShell` chứ không tự parse pathname
  và không tự resolve locale — parse chỉ xảy ra một lần, ở `PublicShell`.
  Locale switcher chỉ đổi locale qua `switchLocale` của `app/i18n` (không
  reimplement logic locale), không đọc session, không gọi Identity hay backend
  API nào: đây là navigation tĩnh.

  Availability của locale do app cấp qua prop `availableLocales` (resource-level
  — app biết resource hiện có những locale nào); header resolve qua
  `resolveLocaleContext`, không tự suy ra từ content hay application. Locale
  hiện tại luôn nằm trong context nên luôn được render; switcher không bao giờ
  dựng link tới locale ngoài context.

  Interactivity (mega panels, mobile menu, menu locale) là **disclosure state
  thuần client-interaction**: `openPanels` khởi tạo rỗng cố định, `mobileOpen` và
  `languageOpen` khởi tạo `false` cố định nên SSR và lần hydrate đầu render
  cùng một HTML (không hydration mismatch). Mỗi mega panel có một state độc lập
  theo `id` của nav item (data v2) — mở panel này không đóng panel kia tự động.
  Đóng hàng loạt xảy ra qua Escape/focus-out/click-outside. **Ngoại lệ:** menu
  locale và mobile panel **đóng chéo nhau** khi mở, vì cả hai cùng hiện ở mobile
  (menu locale không có `hidden md:flex`) và panel `absolute` của menu sẽ phủ lên
  các dòng nav của mobile panel; mega panel giữ độc lập vì chỉ tồn tại ở desktop.
  Listener click-outside chỉ được gắn trong `onMounted` (không bao giờ chạy trên
  server) và không ảnh hưởng dữ liệu render — URL, nav, locale vẫn
  deterministic. Không fetch, không `window` trong đường render.

  Menu locale là **dropdown**, không phải dãy pill nằm ngang: danh sách locale dài
  theo số ngôn ngữ nên nằm ngang sẽ đẩy nav và CTA ra khỏi viewport `h-16`. Menu
  liệt kê locale theo `PUBLIC_LOCALES` của `app/i18n` — thêm ngôn ngữ ở registry
  tự xuất hiện mục mới, không sửa component này. Menu luôn nằm trong DOM, đóng
  bằng `hidden`, nên `href`/`hreflang` của từng locale vẫn có trong HTML tĩnh
  prerender — crawler thấy đủ alternate link.

  **Đánh đổi no-JS (đã chọn, không phải sơ suất):** trigger menu là `<button>`
  không có destination, nên người dùng không có JS không mở được panel và mất
  khả năng đổi ngôn ngữ. Chấp nhận vì bề mặt này là site static prerender, khách
  là developer (luôn có JS), screen reader chạy kèm JS, và phần no-JS **có**
  hậu quả thật là SEO — phần đó được giữ nguyên: mọi `href`/`hreflang` vẫn nằm
  trong HTML prerender, nên invariant 21 (canonical + `hreflang` hai chiều) và
  `public-shell-ssr.spec.ts` không đổi. Không dùng `<details>/<summary>` chỉ để
  giữ no-JS: nó tạo cơ chế dismissal thứ hai trong cùng header, tách khỏi
  `closeDisclosures()` dùng chung, và phải tắt marker mặc định của `<summary>`.
  Nếu sau này cần bảo đảm no-JS thật sự, nó là quyết định áp dụng cho **cả**
  header chứ không phải vá riêng cho menu này.

  Render server-compatible: mọi href dựng qua builder của library; **global
  nav** luôn là `<a href>` thật (crawlable, no-JS vẫn điều hướng được) — kể cả
  trigger mega panel, theo pattern WAI-ARIA disclosure navigation (click thuần với
  JS bị chặn để toggle, `exact` guard chạy trước `prevent` để modifier-click
  đi thẳng href). Item nào có `groups` trong nav data thì render disclosure
  — không branch theo mount literal. **Menu locale là ngoại lệ** của nguyên tắc
  này (xem mục đánh đổi no-JS ở trên): nó cần JS để mở, đổi lại không làm mất
  link khỏi HTML tĩnh.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { PUBLIC_LOCALES, switchLocale, type PublicLocale } from '../../../i18n/index';
import { EcomaLogo } from '@ecoma-io/ui-ecoma-logo';
import { buildPublicPath } from '../build-public-path';
import { localeRootHref } from '../locale-root-href';
import { resolveLocaleContext, type PublicLocaleContext } from '../locale-context';
import { buildPublicNavigation, type PublicNavigationLink } from '../public-navigation';
import type { PublicLayoutPathResult } from '../public-layout-path';
import type { PublicMount } from '../mount-registry';

// Destructure `layout` và `availableLocales` từ `defineProps` (rule
// `vue/define-props-destructuring`): Vue 3.5 reactive props destructure rewrite
// thành accessor trên `props.*` nên tham chiếu trong computed/function luôn đọc
// prop hiện tại — đã được test `updates chrome reactively when the path prop changes` pin lại.
// Header cần đúng hai prop (parsed state + availability) — không gộp được thêm
// vì cả hai đều là input độc lập từ shell.
// oxlint-disable-next-line vue/max-props
const { layout, availableLocales = undefined } = defineProps<{
  readonly layout: PublicLayoutPathResult;
  readonly availableLocales?: readonly PublicLocale[];
}>();

/**
 * Tên hiển thị của mỗi locale cho switcher — dữ liệu trình bày thuộc về
 * layout; `app/i18n` chỉ sở hữu `code`/`hreflang`, không render UI.
 * Khai báo `Record<PublicLocale, string>` nên thêm locale mà thiếu tên là
 * lỗi type.
 */
const LOCALE_NAMES: Readonly<Record<PublicLocale, string>> = Object.freeze({
  en: 'English',
  vi: 'Tiếng Việt',
});

/**
 * Locale của pathname hiện tại, hoặc `undefined` ở `root`/`invalid`.
 *
 * `undefined` là trạng thái hợp lệ, không phải lỗi: `/` là
 * locale-resolution entry point nên không mang locale. Header ở trạng thái
 * này render không có locale-aware link — không bao giờ đoán locale.
 */
const locale = computed<PublicLocale | undefined>((): PublicLocale | undefined => {
  if (layout.kind === 'localized' || layout.kind === 'locale-root') {
    return layout.locale;
  }
  return undefined;
});

/**
 * Context availability của resource hiện tại — resolve `availableLocales` của
 * app với locale của pathname. `undefined` ở `root`/`invalid` (không có locale
 * thì không có context); khi có locale thì `current` luôn nằm trong
 * `availableLocales`.
 */
const localeContext = computed<PublicLocaleContext | undefined>(
  (): PublicLocaleContext | undefined =>
    locale.value === undefined ? undefined : resolveLocaleContext(locale.value, availableLocales),
);

/** Brand luôn về bề mặt root của locale hiện tại (dựng qua `buildPublicPath`). */
const homeHref = computed<string>((): string => localeRootHref(layout));

/** Global navigation đã resolve theo locale hiện tại; rỗng khi không có locale. */
const navigation = computed<readonly PublicNavigationLink[]>((): readonly PublicNavigationLink[] =>
  locale.value === undefined ? [] : buildPublicNavigation(locale.value),
);

/**
 * CTA của header — trỏ tới section getting-started của docs: destination
 * xác minh duy nhất có tính chất onboarding. Dựng qua `buildPublicPath`
 * (không concatenation); rỗng khi chưa có locale — header ở `root`/`invalid`
 * không đoán locale nên không render CTA.
 */
const cta = computed<{ readonly label: string; readonly href: string } | undefined>(() => {
  if (locale.value === undefined) {
    return undefined;
  }
  const built = buildPublicPath({ locale: locale.value, mount: 'docs', path: '/getting-started' });
  if (built.kind === 'invalid') {
    return undefined;
  }
  const label = locale.value === 'vi' ? 'Bắt đầu' : 'Get started';
  return Object.freeze({ label, href: built.path });
});

/** Một mục trong menu locale: link sang locale khác, giữ nguyên resource. */
type LocaleOption = {
  readonly target: PublicLocale;
  readonly hreflang: string;
  readonly name: string;
  readonly href: string;
  /** Locale của pathname hiện tại — hiển thị dạng text, không phải link tự trỏ. */
  readonly isCurrent: boolean;
};

/**
 * Danh sách locale **nằm trong context availability** của resource hiện tại, theo
 * thứ tự registry, đổi qua `switchLocale` của `app/i18n` — cùng resource path,
 * chỉ đổi segment locale.
 *
 * Menu liệt kê **mọi** locale của context, kể cả locale hiện tại: một mục `<a>`
 * cho từng locale khác, cộng một `<span aria-current="true">` cho locale đang
 * xem. Thứ tự theo registry (không dồn locale hiện tại lên đầu) để vị trí mục
 * đứng yên khi người dùng đổi ngôn ngữ — chỉ dấu hiệu active chuyển sang mục
 * khác. Locale ngoài `availableLocales` bị loại ở resolve nên không bao giờ sinh
 * link. Ở `root`/`invalid` không có gì để đổi → danh sách rỗng.
 *
 * Menu không liệt kê ngôn ngữ nào ngoài registry: danh sách duyệt `PUBLIC_LOCALES`,
 * nên thêm locale mới ở `app/i18n` tự xuất hiện mà không sửa component này.
 */
const localeOptions = computed<readonly LocaleOption[]>((): readonly LocaleOption[] => {
  const context = localeContext.value;
  // Guard `layout.kind` thu hẹp union để `layout.path` type-check được
  // (arm `invalid` không có `path`; `context === undefined` đã ngụ ý nó,
  // nhưng compiler không suy luận chéo qua computed).
  if (context === undefined || layout.kind === 'invalid') {
    return [];
  }
  const options: LocaleOption[] = [];
  for (const definition of PUBLIC_LOCALES) {
    // Ngoài context (app không liệt kê locale này cho resource) → không liệt kê.
    if (!context.availableLocales.includes(definition.code)) {
      continue;
    }
    const switched = switchLocale(layout.path, definition.code);
    if (switched.kind !== 'localized') {
      continue;
    }
    options.push({
      target: definition.code,
      hreflang: definition.hreflang,
      name: LOCALE_NAMES[definition.code],
      href: switched.path,
      isCurrent: definition.code === context.current,
    });
  }
  return options;
});

/**
 * Tên của locale hiện tại — nằm trong accessible name của trigger.
 *
 * Trigger chỉ có icon nên `sr-only` phải mang cả tên locale: nếu chỉ ghi
 * "Language" thì screen reader không cho biết trang đang ở ngôn ngữ nào khi
 * menu đang đóng — hồi quy so với dãy pill cũ hiện tên locale ngay trên
 * header. Suy ra từ `localeOptions` (nguồn đã lọc theo context) thay vì khai
 * báo lại map tên, nên không có hai nơi cùng nói tên locale.
 */
const currentLocaleName = computed<string | undefined>(
  (): string | undefined => localeOptions.value.find((option) => option.isCurrent)?.name,
);

/**
 * Trạng thái active của một mục navigation trên pathname hiện tại:
 * `page` khi pathname **dừng đúng** tại mount root (chính href của mục nav),
 * `true` khi pathname nằm dưới mount — resource của mount (`/en/blog/hello`
 * sáng `Blog`) hoặc mount lồng nhau (`docs/api` sáng `docs`). Không có
 * locale → `undefined`.
 */
const navCurrent = (mount: PublicMount, href: string): 'page' | 'true' | undefined => {
  if (layout.kind !== 'localized') {
    return undefined;
  }
  if (layout.mount === mount) {
    // Link trỏ mount root; có remainder nghĩa là đang ở trang con, không phải
    // chính link đó — 'page' sẽ sai semantics ARIA (`aria-current="page"`
    // phải là current page, không phải section). Trigger trỏ path riêng
    // (`/legal/privacy`) thì 'page' chỉ khi pathname dừng đúng tại đó.
    return layout.remainder === '' || layout.path === href ? 'page' : 'true';
  }
  if (layout.mount.startsWith(`${mount}/`)) {
    return 'true';
  }
  return undefined;
};

/**
 * Disclosure state — tập `id` của các panel đang mở, khởi tạo rỗng cố định ở
 * cả server lẫn client nên SSR HTML và lần render hydrate đầu giống hệt nhau
 * (không mismatch). Chỉ thay đổi sau tương tác của user. Mỗi nav item có
 * state độc lập theo `id` (data v2) — mở Docs không đóng Legal.
 */
const openPanels = ref<ReadonlySet<string>>(new Set<string>());
const mobileOpen = ref(false);

/**
 * Disclosure state của menu locale — cùng pattern disclosure thuần client với
 * `openPanels`/`mobileOpen`: khởi tạo `false` cố định ở server lẫn client nên
 * HTML SSR và lần render hydrate đầu giống hệt nhau. Chỉ đổi sau tương tác
 * của user; không nằm trên đường render, không ảnh hưởng URL/nav/locale.
 */
const languageOpen = ref(false);

/** Panel id DOM của menu locale — stable để `aria-controls` không đổi theo render. */
const LANGUAGE_PANEL_ID = 'public-header-language-panel';

/**
 * Mở/đóng menu locale, đóng chéo **mobile panel**.
 *
 * Menu locale hiện ở mọi breakpoint (không `hidden md:flex` như global nav)
 * còn mobile panel là `md:hidden`, nên ở mobile hai panel có thể cùng mở và
 * menu locale (`absolute top-full z-50`) sẽ phủ lên các dòng nav đầu của
 * mobile panel. Đóng chéo giữ hai bề mặt không chồng lên nhau.
 *
 * `openPanels` (mega panel) **không** đóng ở đây: mega panel chỉ tồn tại ở
 * desktop (`md:flex`), nên ở mobile nó không hiển thị và các disclosure của
 * nó vẫn độc lập như data v2 quy định.
 */
function toggleLanguage(): void {
  const next = !languageOpen.value;
  if (next) {
    mobileOpen.value = false;
  }
  languageOpen.value = next;
}

/** Panel id DOM của một item — stable, suy từ id của nav data. */
function panelId(id: string): string {
  return `public-header-panel-${id}`;
}

function isPanelOpen(id: string): boolean {
  return openPanels.value.has(id);
}

function togglePanel(id: string): void {
  const next = new Set(openPanels.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  openPanels.value = next;
}

/**
 * Mở/đóng mobile panel, đóng chéo **menu locale** (đối xứng với
 * `toggleLanguage`): hai panel cùng hiện ở mobile và sẽ chồng lên nhau nếu
 * không đóng chéo.
 */
function toggleMobile(): void {
  const next = !mobileOpen.value;
  if (next) {
    languageOpen.value = false;
  }
  mobileOpen.value = next;
}

/** Đóng mọi disclosure — gọi khi Escape hoặc focus rời header. */
function closeDisclosures(): void {
  openPanels.value = new Set<string>();
  mobileOpen.value = false;
  languageOpen.value = false;
}

/**
 * Đóng panel khi Escape được nhấn, focus rời khỏi header, hoặc click xảy ra
 * **ngoài** phần tử header. Hai handler đầu gắn trên chính phần tử template;
 * click-outside cần `document` nên chỉ gắn trong `onMounted` — không bao giờ
 * chạy trên server, không nằm trong đường render.
 *
 * Escape **trả focus về trigger** khi menu locale đang mở: đóng bằng `hidden`
 * khiến `display:none` và focus đang ở một mục trong menu rơi về `<body>`, mất
 * vị trí và người dùng phải Tab lại từ đầu — đúng điều WAI-ARIA disclosure
 * navigation cấm. Không trả focus khi focus đã rời hẳn header
 * (`relatedTarget === null`): lúc đó focus đang ở nơi khác trong document,
 * kéo nó về header sẽ cướp focus khỏi nơi người dùng vừa chuyển tới.
 */
function onHeaderKeydown(event: { key: string }): void {
  if (event.key !== 'Escape') {
    return;
  }
  const restoreFocus = languageOpen.value;
  closeDisclosures();
  if (restoreFocus) {
    languageTriggerElement.value?.focus();
  }
}

/**
 * Đóng disclosure khi focus rời khỏi chính disclosure đó, **không chỉ** khi
 * rời hẳn document.
 *
 * `relatedTarget === null` bắt được click ra vùng không focusable và tab
 * ra khỏi trang, nhưng không bắt được đường bàn phím thật: mở menu rồi Tab qua
 * mục cuối sẽ dừng ở CTA hoặc phần tử focusable đầu tiên của `<main>` —
 * `relatedTarget` khác `null` nên menu vẫn mở, nổi đè lên nội dung và không
 * còn cách nào đóng ngoài việc quay lại header bấm Escape.
 *
 * Vì vậy kiểm tra theo **quan hệ chứa**: focus mới nằm trong `<header>` mà
 * không nằm trong disclosure đang mở thì đóng nó. Mega panel giữ nguyên cách
 * cũ (`relatedTarget === null`) vì trigger của nó là `<a href>` thật — bấm là
 * điều hướng, không cần đóng panel khi focus chạy qua.
 */
function onHeaderFocusout(event: { relatedTarget: unknown }): void {
  if (event.relatedTarget === null) {
    closeDisclosures();
    return;
  }
  const header = headerElement.value;
  const next = event.relatedTarget;
  if (header === undefined || !(next instanceof Node)) {
    return;
  }
  if (!header.contains(next)) {
    return;
  }
  if (languageOpen.value && !languageElement.value?.contains(next)) {
    languageOpen.value = false;
  }
}

const headerElement = ref<HTMLElement | undefined>(undefined);
/** Trigger và vùng chứa menu locale — cần cho focus-return và kiểm tra chứa. */
const languageTriggerElement = ref<HTMLButtonElement | undefined>(undefined);
const languageElement = ref<HTMLElement | undefined>(undefined);

function onDocumentClick(event: { target: unknown }): void {
  const header = headerElement.value;
  if (header === undefined || !(event.target instanceof Node)) {
    return;
  }
  // Target bị detach giữa chừng khi event đang bubble (Vue v-if/v-else swap
  // icon hamburger ↔ close ngay trong handler mở menu) KHÔNG phải click ngoài
  // header — nếu không bỏ qua thì đúng trạng thái vừa mở bị đóng lại tức thì.
  if (!event.target.isConnected) {
    return;
  }
  if (!header.contains(event.target)) {
    closeDisclosures();
  }
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick);
});
</script>

<template>
  <header
    ref="headerElement"
    class="sticky top-0 z-40 border-b border-line bg-ink/95 backdrop-blur motion-safe:transition-shadow"
    @keydown="onHeaderKeydown"
    @focusout="onHeaderFocusout"
  >
    <!-- Skip link: phần tử focusable đầu tiên, ẩn cho đến khi focus
         (sr-only + focus:sr-none...), nhảy tới `#public-main` do shell render. -->
    <a
      href="#public-main"
      class="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-brand focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
      >{{ locale === 'vi' ? 'Tới nội dung chính' : 'Skip to content' }}</a
    >
    <!-- Container shell dùng chung — gutters và bề rộng khớp footer. -->
    <div
      class="mx-auto flex h-16 w-full max-w-9xl items-center gap-4 px-4 sm:px-6 lg:px-8 wide:px-12 ultrawide:px-16"
    >
      <!-- Brand: artwork logo thật qua `EcomaLogo` (`scope:shared`, mọi bounded
           context được phụ thuộc). Kích thước điều khiển bằng CSS (fallthrough
           `class` của logo lib): logo là inline `<svg>` có `viewBox`, nên chỉ
           đặt `h-*` và để `w-auto` co giãn theo — phía kia không có thuộc tính
           HTML nào để khớp nên `w-auto` là bắt buộc, đặt cả hai phía sẽ méo.
           `h-6` giữ logo cùng tầm thị giác với hàng navigation trong header
           `h-16`, không lấn spotlight; `block` bỏ descender gap của inline
           element. KHÔNG bọc plate nền: mark theo `fill-brand` và wordmark theo
           `fill-foam` nên đọc được trực tiếp trên nền header tối — plate trắng
           là cách vòng để giữ artwork byte-identical, không còn cần thiết.
           Accessible name đến từ `alt="ecoma.io"` mặc định của logo lib
           (render thành `aria-label` vì `<svg>` không có `alt`). -->
      <a
        :href="homeHref"
        class="shrink-0 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
      >
        <EcomaLogo class="block h-6 w-auto" />
      </a>

      <!-- Global navigation — desktop -->
      <nav
        v-if="navigation.length > 0"
        aria-label="Global"
        class="hidden items-center gap-1 md:flex"
      >
        <ul class="flex items-center gap-1">
          <li v-for="(link, navIndex) in navigation" :key="link.id" class="relative">
            <!--
              Item khai báo groups trong data render là disclosure (mega
              panel); item khác là link thường. Branch theo **data** của nav,
              không theo mount literal — thêm mount có panel là thay đổi dữ
              liệu, không phải sửa component.
            -->
            <template v-if="link.groups !== undefined">
              <!--
                Disclosure link theo pattern WAI-ARIA disclosure navigation:
                trigger vẫn là `<a href>` thật (mount root, hoặc triggerPath
                khi mount không có trang root — legal) nên no-JS và crawler
                luôn có link thật. `@click.exact.prevent`: guard `exact` chạy
                TRƯỚC `prevent` (withModifiers duyệt theo thứ tự khai báo) —
                click thuần bị chặn để toggle panel, click kèm modifier
                (Cmd/Ctrl/Shift/Alt — mở tab mới) đi native tới href.
                `aria-current` của mount đặt trên chính trigger (section
                semantics như link thường).
              -->
              <a
                :href="link.href"
                class="flex items-center gap-1 rounded-md px-3 py-2 text-sm font-medium text-muted hover:bg-surface hover:text-foam focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft aria-expanded:bg-surface aria-expanded:text-foam aria-[current]:bg-surface aria-[current]:text-foam"
                :aria-expanded="isPanelOpen(link.id)"
                :aria-current="navCurrent(link.mount, link.href)"
                :aria-controls="panelId(link.id)"
                @click.exact.prevent="togglePanel(link.id)"
              >
                {{ link.label }}
                <svg
                  class="size-4 motion-safe:transition-transform duration-150"
                  :class="isPanelOpen(link.id) ? 'rotate-180' : ''"
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                >
                  <path d="m4 6 4 4 4-4" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </a>
              <!--
                Mega panel: luôn trong DOM, đóng bằng `hidden` — surface bị
                display:none không nằm trong accessibility tree, không có link
                trùng cho screen reader. Cột đầu panel là link tới chính
                trigger path (mount root hoặc policy đầu); các cột còn lại là
                groups của item trong nav data.
              -->
              <div
                :id="panelId(link.id)"
                :hidden="!isPanelOpen(link.id)"
                class="absolute top-full z-50 pt-2 max-w-[calc(100vw-2rem)]"
                :class="navIndex === 0 ? 'left-0 -translate-x-6' : 'left-1/2 -translate-x-1/2'"
              >
                <div
                  class="grid gap-x-6 gap-y-1 rounded-card border border-line bg-surface p-5 shadow-[0_24px_70px_rgb(0_0_0/0.5)]"
                  :style="{
                    gridTemplateColumns: `repeat(${Math.min(link.groups.length, 3)}, minmax(11rem, 1fr))`,
                  }"
                >
                  <a
                    :href="link.href"
                    class="col-span-full rounded-md px-2 py-1.5 text-sm font-semibold text-foam hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
                    >{{ link.label }}</a
                  >
                  <div v-for="group in link.groups" :key="group.heading" class="min-w-32">
                    <p
                      class="mb-2 mt-3 text-xs font-semibold uppercase tracking-wide text-faint first:mt-0"
                    >
                      {{ group.heading }}
                    </p>
                    <ul>
                      <li v-for="entry in group.links" :key="entry.href">
                        <a
                          :href="entry.href"
                          class="block rounded-md px-2 py-1.5 text-sm text-muted hover:bg-surface-raised hover:text-foam focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
                          >{{ entry.label }}</a
                        >
                      </li>
                    </ul>
                  </div>
                </div>
              </div>
            </template>
            <a
              v-else
              :href="link.href"
              :aria-current="navCurrent(link.mount, link.href)"
              class="block rounded-md px-3 py-2 text-sm font-medium text-muted hover:bg-surface hover:text-foam focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft aria-[current]:bg-surface aria-[current]:text-foam"
              >{{ link.label }}</a
            >
          </li>
        </ul>
      </nav>

      <!-- Cụm phải: locale switcher, CTA, mobile toggle -->
      <div class="ml-auto flex items-center gap-2">
        <!-- Menu locale — dropdown thay cho dãy pill nằm ngang: danh sách
             locale dài theo số ngôn ngữ nên nằm ngang sẽ đẩy nav và CTA ra
             khỏi viewport `h-16`. Menu hiển thị ngay cả khi không có link
             switch nào (context chỉ có đúng locale hiện tại): locale hiện tại
             luôn được liệt kê dạng text. -->
        <nav
          v-if="localeContext !== undefined"
          ref="languageElement"
          aria-label="Language"
          class="relative"
        >
          <!--
            Trigger là `<button>` (không phải link): nó **chỉ** điều khiển
            disclosure, không có destination — giữ `type="button"` để không
            kích hoạt submit trong bất kỳ form nào bao quanh. `aria-expanded` +
            `aria-controls` nối trigger với panel.

            Nhãn trợ năng đặt bằng `sr-only` vì icon + chevron không mang chữ, và
            nó gồm **cả tên locale hiện tại**: trigger chỉ có icon nên nếu chỉ
            ghi "Language" thì screen reader không biết trang đang ở ngôn ngữ
            nào khi menu đóng. `sr-only` giữ layout `h-16` không đổi.
          -->
          <button
            ref="languageTriggerElement"
            type="button"
            class="flex items-center gap-1.5 rounded-full border border-line bg-surface p-2 text-muted hover:bg-surface-raised hover:text-foam focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft aria-expanded:bg-surface-raised aria-expanded:text-foam"
            :aria-expanded="languageOpen"
            :aria-controls="LANGUAGE_PANEL_ID"
            @click="toggleLanguage"
          >
            <span class="sr-only"
              >{{ locale === 'vi' ? 'Ngôn ngữ' : 'Language' }} — {{ currentLocaleName }}</span
            >
            <!-- Icon bán cầu: bề mặt tròn + 2 đường cong ngang + 1 dọc, cùng
                 ngôn ngữ hình với chevron/hamburger sẵn có trong file. -->
            <svg
              aria-hidden="true"
              class="size-4"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            >
              <circle cx="10" cy="10" r="7.5" />
              <path
                d="M2.5 10h15M10 2.5c2 2.2 3 4.7 3 7.5s-1 5.3-3 7.5c-2-2.2-3-4.7-3-7.5s1-5.3 3-7.5Z"
              />
            </svg>
            <svg
              aria-hidden="true"
              class="size-3 motion-safe:transition-transform duration-150"
              :class="languageOpen ? 'rotate-180' : ''"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            >
              <path d="m4 6 4 4 4-4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <!--
            Menu: luôn trong DOM, đóng bằng `hidden` — surface bị `display:none`
            không nằm trong accessibility tree, không có mục trùng cho screen
            reader. Giữ `href`/`hreflang` của từng locale trong HTML tĩnh
            prerender nên crawler vẫn thấy đủ alternate link dù menu đang đóng.
            Đổi lại, mở menu cần JS (đánh đổi no-JS đã chọn — xem comment đầu
            file; không phải vì quên mà vì đã cân).
          -->
          <div
            :id="LANGUAGE_PANEL_ID"
            :hidden="!languageOpen"
            class="absolute top-full right-0 z-50 pt-2"
          >
            <ul
              class="min-w-40 rounded-card border border-line bg-surface p-1 shadow-[0_24px_70px_rgb(0_0_0/0.5)]"
            >
              <li v-for="option in localeOptions" :key="option.target">
                <!--
                  Locale hiện tại là `<span aria-current="true">`, không phải
                  link tự trỏ — giữ đúng contract cũ của switcher: không có
                  link nào chỉ vào trang đang xem.
                -->
                <span
                  v-if="option.isCurrent"
                  :lang="option.target"
                  aria-current="true"
                  class="block rounded-md bg-surface-raised px-3 py-1.5 text-xs font-semibold text-foam"
                  >{{ option.name }}</span
                >
                <a
                  v-else
                  :href="option.href"
                  :lang="option.target"
                  :hreflang="option.hreflang"
                  class="block rounded-md px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-raised hover:text-foam focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
                  >{{ option.name }}</a
                >
              </li>
            </ul>
          </div>
        </nav>

        <!-- CTA — desktop; mobile có CTA tương đương trong panel -->
        <a
          v-if="cta !== undefined"
          :href="cta.href"
          class="hidden rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white shadow-[0_8px_24px_rgb(0_106_255/0.25)] hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft md:inline-flex"
          >{{ cta.label }}</a
        >

        <!-- Mobile toggle -->
        <button
          type="button"
          class="rounded-md p-2 text-muted hover:bg-surface hover:text-foam focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft md:hidden"
          :aria-expanded="mobileOpen"
          aria-controls="public-header-mobile-panel"
          @click="toggleMobile"
        >
          <span class="sr-only">{{ mobileOpen ? 'Close menu' : 'Open menu' }}</span>
          <svg
            v-if="!mobileOpen"
            aria-hidden="true"
            class="size-5"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <path d="M3 5h14M3 10h14M3 15h14" stroke-linecap="round" />
          </svg>
          <svg
            v-else
            aria-hidden="true"
            class="size-5"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <path d="m5 5 10 10M15 5 5 15" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Mobile panel — cùng dữ liệu nav, một bề mặt md:hidden; surface ẩn
         (display:none) không nằm trong accessibility tree. -->
    <div
      id="public-header-mobile-panel"
      :hidden="!mobileOpen"
      class="border-t border-line bg-ink md:hidden"
    >
      <div class="mx-auto w-full max-w-9xl space-y-1 px-4 py-4 sm:px-6">
        <nav v-if="navigation.length > 0" aria-label="Mobile">
          <ul class="space-y-1">
            <li v-for="link in navigation" :key="link.id">
              <a
                :href="link.href"
                :aria-current="navCurrent(link.mount, link.href)"
                class="block rounded-md px-3 py-2 text-sm font-medium text-muted hover:bg-surface hover:text-foam focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft aria-[current]:bg-surface aria-[current]:text-foam"
                >{{ link.label }}</a
              >
              <ul
                v-if="link.groups !== undefined"
                class="ml-3 mt-1 space-y-1 border-l border-line pl-3"
              >
                <template v-for="group in link.groups" :key="group.heading">
                  <li v-for="entry in group.links" :key="entry.href">
                    <a
                      :href="entry.href"
                      class="block rounded-md px-3 py-2 text-sm text-muted hover:bg-surface hover:text-foam focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
                      >{{ entry.label }}</a
                    >
                  </li>
                </template>
              </ul>
            </li>
          </ul>
        </nav>

        <a
          v-if="cta !== undefined"
          :href="cta.href"
          class="mt-3 block rounded-md bg-brand px-4 py-2.5 text-center text-sm font-semibold text-white hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
          >{{ cta.label }}</a
        >
      </div>
    </div>
  </header>
</template>
