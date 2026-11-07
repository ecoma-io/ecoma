<!--
  Breadcrumbs dùng chung cho mọi bề mặt public có chuỗi đường dẫn (docs,
  legal) — component **thuần render**: nhận `entries` đã resolve đầy đủ từ
  route, không tự biết gì về content hay route.

  Nhận `entries` theo thứ tự từ gốc xuống, **gồm cả page hiện tại ở cuối**:
  route lắp chuỗi đó (docs dùng `findPageBreadcrumb` của Nuxt Content, legal
  dựng từ grouped listing), component chỉ render — không có logic dựng
  breadcrumb thứ hai ở đây.

  Cấu trúc `nav` + `<ol>` — mẫu chuẩn cho breadcrumb. Mọi mục trừ mục cuối là
  link tới một pathname thật, mục cuối là page hiện tại nên mang
  `aria-current="page"`. Dấu phân cách `aria-hidden` để screen reader không đọc
  chúng thành nội dung.

  Link dùng `NuxtLink`, **không** phải `<a href>`: trên trang legal, sidebar và
  cột nội dung đã đi bằng client-side routing, để breadcrumb ép full page
  reload thì mất prefetch và reset scroll — đúng lợi ích PR này vừa thêm. Mắt
  cuối trỏ về chính trang đang đọc nên với `NuxtLink` nó là no-op phía client.
  HTML prerender không đổi (`NuxtLink` vẫn render `<a href>`), nên SEO và crawl
  giữ nguyên.

  **Mắt cuối render thành link là quyết định giữ nguyên, không phải sơ suất.**
  Ở bề mặt landing chuỗi chỉ có **một** mắt (`/{locale}/legal` là chính trang
  đang đọc), nên cả breadcrumb là một link tự tham chiếu. WAI-ARIA APG khuyến
  nghị mắt cuối là văn bản tĩnh thay vì link, và đó là hướng đúng nếu muốn đổi.
  Đổi ở đây sẽ kéo theo assertion `aria-current` trong `static-output.spec.ts`
  (đang neo vào thẻ `<a>` của landmark breadcrumb) và phải áp cho **cả docs**,
  nên nó là một thay đổi a11y chung chứ không còn thuộc phạm vi một PR về legal.
  Quan trọng hơn: docs landing **đã** làm đúng như vậy từ trước PR này — cùng
  một mắt tự tham chiếu, cùng `aria-current="page"` trên thẻ `<a>` — nên giữ
  nguyên là giữ hai bề mặt nói chung một ngôn ngữ.

  Vì sao tách ra khỏi Docs: docs và legal đều chỉ có một danh sách phẳng
  `{path,title}[]` — không đọc cây navigation, không biết gì về content. Tách phần
  thuần này ra cho cả hai dùng **một** component thay vì hai bản chép nhau, trong
  khi logic dựng chuỗi vẫn nằm ở domain của từng bề mặt
  (`buildDocsBreadcrumbs` / `legalBreadcrumbs`).
-->
<script setup lang="ts">
// `entries` là dữ liệu, `label` là nhãn a11y của `<nav>` — hai input độc lập
// được mô tả ngay dưới đây.
// oxlint-disable-next-line vue/max-props
const { entries, label } = defineProps<{
  /**
   * Chuỗi breadcrumb từ gốc xuống, mục cuối là page hiện tại — mỗi mục là một
   * pathname hợp lệ kèm nhãn hiển thị.
   *
   * **Đây là hợp đồng cấu trúc, và nó phải được canh bằng compiler chứ không bằng
   * lời.** Component này cố ý độc lập với từng bề mặt — nó không import type của
   * docs lẫn legal — nên nó không thể dùng `DocsBreadcrumb` hay `LegalBreadcrumb`
   * mà không biến một component chung thành phụ thuộc của cả hai miền. Hai
   * module domain khai type riêng nhưng **cùng shape**, và vì structural typing
   * thêm/bớt field ở một type không làm hỏng typecheck ở đây — hợp đồng có thể
   * trôi trong im lặng. Ghim bằng assertion kiểu ở `public-shell-parts.spec.ts` —
   * nơi cả hai producer được import — chứ không phải ở đây, vì một alias/const cục
   * bộ không dùng sẽ bị `noUnusedLocals` của repo báo.
   */
  readonly entries: readonly { readonly path: string; readonly title: string }[];
  /** Nhãn của `<nav>` breadcrumb, đã localized. */
  readonly label: string;
}>();
</script>

<template>
  <nav v-if="entries.length > 0" :aria-label="label">
    <ol class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
      <li v-for="(entry, index) in entries" :key="entry.path" class="flex items-center gap-x-2">
        <span v-if="index > 0" aria-hidden="true">/</span>
        <NuxtLink
          :to="entry.path"
          class="hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          :class="index === entries.length - 1 ? 'font-medium text-foam' : undefined"
          :aria-current="index === entries.length - 1 ? 'page' : undefined"
          >{{ entry.title }}</NuxtLink
        >
      </li>
    </ol>
  </nav>
</template>
