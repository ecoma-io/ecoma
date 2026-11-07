<!--
  `PublicFooter` — shared public footer: brand, mô tả, link groups, hàng legal
  và copyright. Theme tối theo design tokens (nền kế thừa `bg-ink` của body,
  viền `border-line`, chữ `text-muted`).

  Footer deterministic: không runtime fetch, không dependency backend, không
  Date (không hydration mismatch theo thời gian), không application-specific
  content. Dữ liệu link đến từ `PUBLIC_FOOTER_GROUPS` + `buildPublicFooterLegal`
  (tĩnh, frozen, chung nguồn `LEGAL_POLICY_LINKS` với header) — chỉ chứa
  destination thực sự tồn tại; không bịa Terms/Privacy/social để lấp layout.

  Không có `<nav>` bên trong footer: spec component (`public-shell.spec.ts`)
  ghim footer không chứa navigation landmark — các cột link là heading + list,
  không phải điều hướng cấp trang. Hàng legal cũng là heading nhỏ + list, cùng
  quy ước. Mọi href đi qua builder của library (không string concat); brand
  dùng chung `localeRootHref` với header nên hai bề mặt luôn lockstep.
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { PublicLocale } from '../../../i18n/index';
import { EcomaLogo } from '@ecoma-io/ui-ecoma-logo';
import { localeRootHref } from '../locale-root-href';
import {
  buildPublicFooterGroups,
  buildPublicFooterLegal,
  PUBLIC_FOOTER_TAGLINE,
} from '../public-navigation';
import type { PublicLayoutPathResult } from '../public-layout-path';

const { layout } = defineProps<{ readonly layout: PublicLayoutPathResult }>();

/** Brand về bề mặt root của locale hiện tại; `root`/`invalid` → `/`. */
const homeHref = computed<string>((): string => localeRootHref(layout));

/**
 * Locale của layout — quyết định ngôn ngữ heading/link text. Không có locale
 * (`root`/`invalid`) → groups rỗng: footer không đoán locale, chỉ còn brand +
 * copyright (không locale-aware).
 */
const locale = computed<PublicLocale | undefined>((): PublicLocale | undefined => {
  if (layout.kind === 'localized' || layout.kind === 'locale-root') {
    return layout.locale;
  }
  return undefined;
});

/**
 * Footer groups đã resolve theo locale — heading + link text theo đúng locale
 * của trang; rỗng khi layout chưa mang locale.
 */
const groups = computed(() =>
  locale.value === undefined ? [] : buildPublicFooterGroups(locale.value),
);

/** Hàng legal đã resolve — rỗng khi layout chưa mang locale. */
const legalLinks = computed(() =>
  locale.value === undefined ? [] : buildPublicFooterLegal(locale.value),
);
</script>

<template>
  <footer class="border-t border-line bg-ink-deep text-muted">
    <!-- Container shell dùng chung: cùng bề rộng và gutters với header. -->
    <div class="mx-auto w-full max-w-9xl px-4 py-12 sm:px-6 lg:px-8 wide:px-12 ultrawide:px-16">
      <div class="flex flex-col gap-10 md:flex-row md:justify-between">
        <!-- Brand block: artwork logo qua `EcomaLogo`, cùng một cách tô màu với
             header. KHÔNG bọc plate nền: mark theo `fill-brand`, wordmark theo
             `fill-foam` nên đọc được trên nền footer tối mà không cần nền
             phụ. Sizing CSS-only (`h-6 w-auto` — logo là inline `<svg>` có
             `viewBox`, nên phía bên cạnh không có attribute để khớp và `w-auto`
             là bắt buộc); `block` bỏ descender gap của inline element. Accessible
             name đến từ `alt="ecoma.io"` mặc định của logo lib (render thành
             `aria-label`). -->
        <div class="max-w-sm">
          <p>
            <a
              :href="homeHref"
              class="inline-block rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
            >
              <EcomaLogo class="block h-6 w-auto" />
            </a>
          </p>
          <p class="mt-3 text-sm leading-relaxed text-muted">
            {{ locale === undefined ? '' : PUBLIC_FOOTER_TAGLINE[locale] }}
          </p>
        </div>

        <!-- Link groups: heading + list, không phải nav -->
        <div v-if="groups.length > 0" class="grid grid-cols-2 gap-8 sm:gap-12 md:flex md:gap-16">
          <div v-for="group in groups" :key="group.heading" class="min-w-0">
            <h3 class="text-sm font-semibold text-foam">{{ group.heading }}</h3>
            <ul class="mt-4 space-y-2 text-sm">
              <li v-for="link in group.links" :key="link.href">
                <a
                  :href="link.href"
                  class="text-muted transition-colors duration-150 hover:text-foam focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
                  >{{ link.label }}</a
                >
              </li>
            </ul>
          </div>
        </div>
      </div>

      <!--
        Hàng legal: cùng nguồn policy links với header (nguồn duy nhất), render
        theo quy ước heading + list của footer (không `<nav>` landmark). Chỉ
        render khi có locale — footer không đoán locale.
      -->
      <div v-if="legalLinks.length > 0" class="mt-10 border-t border-line pt-6">
        <h3 class="text-xs font-semibold uppercase tracking-wide text-faint">
          {{ locale === 'vi' ? 'Pháp lý' : 'Legal' }}
        </h3>
        <ul class="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <li v-for="legalLink in legalLinks" :key="legalLink.href">
            <a
              :href="legalLink.href"
              class="text-faint transition-colors duration-150 hover:text-foam focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
              >{{ legalLink.label }}</a
            >
          </li>
        </ul>
      </div>

      <!-- Hàng copyright tách khỏi link groups — không năm (deterministic). -->
      <div class="mt-6 pt-2">
        <p class="text-sm text-faint">© ecoma.io</p>
      </div>
    </div>
  </footer>
</template>
