<!--
  `PublicShell` — khung chung của mọi public page:

  ```text
  ┌───────────────────────┐
  │      PublicHeader     │
  ├───────────────────────┤
  │                       │
  │   slot: nội dung app  │
  │                       │
  ├───────────────────────┤
  │      PublicFooter     │
  └───────────────────────┘
  ```

  Shell là chỗ **duy nhất** parse pathname (qua `parsePublicLayoutPath`) rồi
  truyền state đã parse vào Header/Footer — component không parse lần thứ
  hai, không tự resolve locale. Nhận `path` dạng string để app chỉ cần trỏ
  pathname hiện tại vào; không phụ thuộc vue-router, không import Nuxt.

  Nhận thêm `availableLocales` (tùy chọn) — resource-level input cho locale
  switcher: app báo locale nào thực sự tồn tại của resource hiện tại, shell
  chỉ forwarding xuống Header, không tự suy ra từ content/application.

  Render thuần SSR/SSG: slot tĩnh, không fetch, không hydration state.
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { PublicLocale } from '../../../i18n/index';
import { parsePublicLayoutPath } from '../parse-public-layout-path';
import type { PublicLayoutPathResult } from '../public-layout-path';
import PublicHeader from './PublicHeader.vue';
import PublicFooter from './PublicFooter.vue';

// Destructure `path` và `availableLocales` (rule `vue/define-props-destructuring`):
// Vue 3.5 rewrite thành accessor trên `props.*` nên `layout` recompute khi prop
// đổi — test `updates chrome reactively when the path prop changes` pin lại hành vi này.
// Shell cần đúng hai prop (pathname + availability) — không gộp được thêm
// vì cả hai đều là input độc lập của app.
// oxlint-disable-next-line vue/max-props
const { path, availableLocales = undefined } = defineProps<{
  readonly path: string;
  readonly availableLocales?: readonly PublicLocale[];
}>();

/** Kết quả parse một lần cho mỗi `path` — truyền xuống toàn bộ shell. */
const layout = computed<PublicLayoutPathResult>((): PublicLayoutPathResult =>
  parsePublicLayoutPath(path),
);
</script>

<template>
  <!--
    `<main>` mang `id="public-main"` làm mục tiêu skip-link của header — shell
    tự render target, app không phải tự đặt id. Skip link nằm trong
    `PublicHeader` (phần tử focusable đầu tiên của trang).
  -->
  <PublicHeader :layout="layout" :available-locales="availableLocales" />
  <main id="public-main">
    <slot />
  </main>
  <PublicFooter :layout="layout" />
</template>
