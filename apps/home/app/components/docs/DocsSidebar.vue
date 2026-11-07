<!--
  Wrapper của **bề mặt mobile** — bọc `DocsNavTree` trong `PublicNavDisclosure`.
  Caller bọc nó trong `mt-4 lg:hidden` và render `DocsNavTree` riêng trong
  `<aside class="hidden lg:block">`, nên component này không tự lo ẩn/hiện theo
  breakpoint.

  Khung disclosure tách ra dùng chung với Legal vì nó không biết gì về cấu trúc
  dữ liệu: nó chỉ đặt `<details>`, còn cây render bởi slot.

  **Kiểu link chưa thống nhất — cố ý để nguyên.** `PublicBreadcrumbs` đi bằng
  `NuxtLink` còn `DocsNavTree` render `<a :href>`, nên click sidebar docs vẫn full
  page reload trong khi click breadcrumb đi client-side. Đổi `DocsNavTree` sang
  `NuxtLink` là thay đổi render path của docs, nằm ngoài phạm vi PR này.
-->
<script setup lang="ts">
import type { ContentNavigationItem } from '@nuxt/content';
import PublicNavDisclosure from '~/components/PublicNavDisclosure.vue';
import DocsNavTree from './DocsNavTree.vue';

// Ba input độc lập (cây navigation, page hiện tại, nhãn a11y) — xem ghi chú tương
// ứng ở `DocsNavTree`.
// oxlint-disable-next-line vue/max-props
const { items, currentPath, label } = defineProps<{
  readonly items: readonly ContentNavigationItem[];
  readonly currentPath: string;
  readonly label: string;
}>();
</script>

<template>
  <PublicNavDisclosure :label="label">
    <DocsNavTree :items="items" :current-path="currentPath" :label="label" />
  </PublicNavDisclosure>
</template>
