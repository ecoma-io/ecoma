<!--
  Override `ProseTable` của `@nuxtjs/mdc` (mặc định chỉ là `<table><slot /></table>`).

  Bảng Markdown có thể rộng hơn cột nội dung, và `overflow-x` **không** có tác
  dụng trên chính phần tử `<table>`: trình duyệt bỏ qua `overflow` cho
  `display: table`, nên cách sửa bằng CSS trên `table` chỉ là no-op. Cách còn
  lại — đặt `display: block` lên `<table>` — làm mất table semantics đối với
  một số screen reader (Safari/VoiceOver). Vì vậy bọc `<table>` trong một
  scroll container thật, giữ nguyên `<table>` là bảng thật.

  `@nuxtjs/mdc` tự đăng ký thư mục `components/mdc/` của app ở ưu tiên cao
  nhất, nên file này thay thế component prose mặc định mà không cần patch
  upstream (hook `components:dirs` trong `dist/module.mjs`). App hợp nhất chỉ
  được có **một** file `ProseTable.vue` — override này phục vụ mọi bề mặt
  content Markdown (docs lẫn blog), phần khác nhau giữa hai bề mặt trước đây
  chỉ là nhãn region, giờ resolve theo route hiện tại.
-->
<script setup lang="ts">
import { blogUiStrings } from '~/blog/blog-ui-strings';
import { parseBlogRoute } from '~/blog/blog-routing';
import { docsUiStrings } from '~/utils/docs-ui-strings';
import { parseDocsRoute } from '~/utils/docs-routing';

/**
 * Tên truy cập được của region cuộn, theo bề mặt và locale của trang.
 * `ProseTable` chỉ render bên trong content đã qua `validate` của route docs
 * hoặc blog, nên parse luôn thành công trên cả hai; parse hỏng là lỗi ở tầng
 * khác và phải **fail loudly** (throw, không fallback im lặng về một locale
 * hay bề mặt nào đó).
 */
const route = useRoute();
const tableLabel = computed(() => {
  const blog = parseBlogRoute(route.path);
  if (blog !== null) {
    return blogUiStrings(blog.locale).tableRegion;
  }
  const docs = parseDocsRoute(route.path);
  if (docs !== null) {
    return docsUiStrings(docs.locale).tableRegion;
  }
  throw new Error(`ProseTable rendered outside a content route: ${route.path}`);
});
</script>
<template>
  <!--
    `tabindex="0"`: scroll container ngang phải focus được bằng bàn phím —
    `<div>` trần không focusable, người dùng chỉ bàn phím không có cách cuộn
    tới cột bị cắt (WCAG 2.1.1). `role="region"` + `:aria-label` đặt tên cho
    vùng cuộn (WCAG 2.4.1), `focus-visible:outline-*` làm nổi vùng focus.
  -->
  <div
    tabindex="0"
    role="region"
    :aria-label="tableLabel"
    class="my-6 w-full max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft"
  >
    <table class="w-full text-sm">
      <slot />
    </table>
  </div>
</template>
