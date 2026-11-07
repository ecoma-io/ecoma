<!--
  Sidebar của Legal Center ở **mobile** — bọc cây nav phẳng có nhóm
  (`LegalNav`) trong `PublicNavDisclosure`. Caller (`LegalLayout`) bọc nó trong
  `mt-4 lg:hidden` và render `LegalNav` riêng trong
  `<aside class="hidden lg:block">` cho cột desktop, nên component này không tự
  lo ẩn/hiện theo breakpoint — xem `PublicNavDisclosure`.

  Khung disclosure dùng chung với `DocsSidebar`: nó không biết gì về cấu trúc
  dữ liệu, chỉ đặt `<details>`, còn cây do slot render. Vì sao vẫn giữ wrapper
  riêng cho legal: đây là wrapper của bề mặt mobile, được `LegalLayout.vue`
  import dưới tên `LegalSidebarDisclosure` để phân biệt với cột `<aside>`
  desktop — logic ghép khung disclosure + cây nav không lặp lại ở hai bề mặt.

  Không tự query content: `sidebar` là dữ liệu route đã resolve, đã qua
  publication gate của build.
-->
<script setup lang="ts">
import PublicNavDisclosure from '~/components/PublicNavDisclosure.vue';
import type { LegalSidebarNav } from '../../domain/legal-navigation';
import LegalNav from './LegalNav.vue';

// oxlint-disable-next-line vue/max-props
const { sidebar, label } = defineProps<{
  /** Sidebar đã dựng từ grouped listing của route. */
  readonly sidebar: LegalSidebarNav;
  /**
   * Accessible name của `<nav>` cây điều hướng **và** tiêu đề `<summary>` của
   * disclosure — hai chỗ phải cùng chuỗi, xem `PublicNavDisclosure`. Không phải
   * nhãn nhóm category: nhóm do `LegalNav` render bằng `<p>` từ
   * `sidebar.groups[].title`, không liên quan prop này.
   */
  readonly label: string;
}>();
</script>

<template>
  <PublicNavDisclosure :label="label">
    <LegalNav :sidebar="sidebar" :label="label" />
  </PublicNavDisclosure>
</template>
