<!--
  Table of contents của một document — lấy từ `page.body.toc` của content,
  **không** parse Markdown lại.

  `toc` do content renderer sinh ra và `links[].id` chính là id anchor mà
  `<ContentRenderer>` gắn lên heading, nên href chỉ cần ghép `#` + id: không có
  hệ thống heading parser thứ hai, cũng không có nguy cơ anchor lệch.

  Component tự chịu trách nhiệm trạng thái "không có heading": không render gì
  khi `links` rỗng, để page không hiện một cột TOC trống.

  Mobile dùng disclosure gốc (`<details>`/`<summary>`), desktop luôn hiện —
  cùng một cây link, không có state client.
-->
<script setup lang="ts">
import type { Toc } from '@nuxt/content';

// `toc` là dữ liệu từ content renderer, `label` là nhãn a11y — hai input độc
// lập, xem ghi chú ở `DocsNavTree`.
// oxlint-disable-next-line vue/max-props
const { toc, label } = defineProps<{
  readonly toc: Toc | undefined;
  readonly label: string;
}>();

/**
 * Cấp heading đưa vào TOC. Content parse với `depth: 2` nên `links` thường chỉ
 * có h2; lọc theo `depth` để nếu content cấu hình sâu hơn thì vẫn giới hạn ở
 * mức đọc được, và để nhánh `h3` không tự xuất hiện ngoài ý muốn.
 */
const MAX_DEPTH = 3;

/** Danh sách link phẳng, giữ nguyên thứ tự document. */
const links = computed(() => (toc?.links ?? []).filter((link) => link.depth <= MAX_DEPTH));

/**
 * Link ở cấp con (h3) — render lùi vào trong để thể hiện phân cấp mà không cần
 * thêm một component đệ quy chỉ cho hai cấp.
 */
function isNested(depth: number): boolean {
  return depth > 2;
}
</script>

<template>
  <details v-if="links.length > 0" class="lg:block" open>
    <summary class="cursor-pointer rounded border border-line px-3 py-2 font-semibold lg:hidden">
      {{ label }}
    </summary>
    <div class="mt-3 lg:mt-0">
      <nav :aria-label="label">
        <!-- `summary` ở trên là heading của mobile — nhãn in lại chỉ dành cho desktop. -->
        <p class="mb-2 hidden text-xs font-semibold uppercase tracking-wide text-faint lg:block">
          {{ label }}
        </p>
        <ul class="space-y-1 border-l border-line text-sm">
          <li v-for="link in links" :key="link.id" :class="isNested(link.depth) ? 'pl-6' : 'pl-3'">
            <a
              :href="`#${link.id}`"
              class="block rounded px-2 py-1 text-muted hover:bg-surface hover:text-foam hover:underline focus-visible:bg-surface"
              >{{ link.text }}</a
            >
          </li>
        </ul>
      </nav>
    </div>
  </details>
</template>
