<!--
  `PublicFooter` — shared public footer: brand, tagline và copyright. Theme
  tối theo design tokens (nền `bg-ink-deep`, viền `border-line`, chữ
  `text-muted`).

  Footer deterministic: không runtime fetch, không dependency backend, không
  Date (không hydration mismatch theo thời gian), không application-specific
  content. Chỉ chứa destination thực sự tồn tại (locale-root); không bịa
  Terms/Privacy/social để lấp layout.

  Không có `<nav>` bên trong footer: spec component (`public-shell.spec.ts`)
  ghim footer không chứa navigation landmark. Brand dùng chung `localeRootHref`
  với header nên hai bề mặt luôn lockstep.
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { PublicLocale } from '../../../i18n/index';
import { EcomaLogo } from '@ecoma-io/ui-ecoma-logo';
import { localeRootHref } from '../locale-root-href';
import { PUBLIC_FOOTER_TAGLINE } from '../public-navigation';
import type { PublicLayoutPathResult } from '../public-layout-path';

const { layout } = defineProps<{ readonly layout: PublicLayoutPathResult }>();

/** Brand về bề mặt root của locale hiện tại; `root`/`invalid` → `/`. */
const homeHref = computed<string>((): string => localeRootHref(layout));

/**
 * Locale của layout — quyết định ngôn ngữ tagline. Không có locale
 * (`root`/`invalid`) → tagline rỗng: footer không đoán locale, chỉ còn brand +
 * copyright (không locale-aware).
 */
const locale = computed<PublicLocale | undefined>((): PublicLocale | undefined => {
  if (layout.kind === 'locale-root') {
    return layout.locale;
  }
  return undefined;
});
</script>

<template>
  <footer class="border-t border-line bg-ink-deep text-muted">
    <!-- Container shell dùng chung: cùng bề rộng và gutters với header. -->
    <div class="mx-auto w-full max-w-9xl px-4 py-12 sm:px-6 lg:px-8 wide:px-12 ultrawide:px-16">
      <!-- Brand block: artwork logo qua `EcomaLogo`, cùng một cách tô màu với
           header. KHÔNG bọc plate nền: mark theo `fill-brand`, wordmark theo
           `fill-foam` nên đọc được trên nền footer tối mà không cần nền
           phụ. Sizing CSS-only (`h-6 w-auto` — logo là inline `<svg>` có
           `viewBox`, nên phía bên cạnh không có attribute để khớp và `w-auto`
           là bắt buộc); `block` bỏ descender gap của inline element. Accessible
           name đến từ `alt="ecoma.io"` mặc định của logo lib (render thành
           `aria-label`). -->
      <p>
        <a
          :href="homeHref"
          class="inline-block rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
        >
          <EcomaLogo class="block h-6 w-auto" />
        </a>
      </p>
      <p class="mt-3 max-w-sm text-sm leading-relaxed text-muted">
        {{ locale === undefined ? '' : PUBLIC_FOOTER_TAGLINE[locale] }}
      </p>

      <!-- Hàng copyright tách khỏi brand — không năm (deterministic). -->
      <div class="mt-6 pt-2">
        <p class="text-sm text-faint">© ecoma.io</p>
      </div>
    </div>
  </footer>
</template>
