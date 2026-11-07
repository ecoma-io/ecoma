<!--
  Table of contents của một blog article — cùng nguồn dữ liệu với `DocsToc`
  (`page.body.toc` của content renderer, không parse Markdown lần hai), nhưng
  trình bày cho cột đọc hẹp của blog: khối đứng trên đầu bài, không cột phải.

  `links[].id` chính là id anchor mà `<ContentRenderer>` gắn lên heading
  (`anchorLinks` bật h2/h3/h4), nên href chỉ cần ghép `#` + id.

  Chỉ render khi có đủ heading để việc điều hướng hữu ích (`MIN_LINKS`): bài
  ngắn với một heading là TOC thừa — lặp lại cấu trúc của chính bài đọc.
  Mobile dùng disclosure gốc (`<details>`), desktop luôn hiện.
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { Toc } from '@nuxt/content';

// oxlint-disable-next-line vue/max-props
const { toc, label } = defineProps<{
  readonly toc: Toc | undefined;
  readonly label: string;
}>();

/**
 * Ngưỡng hữu ích: dưới đây là bài ngắn không cần TOC (tránh khối rỗng hoặc
 * lặp lại chính article). Docs cũng dùng cấu trúc 2 cấp này.
 */
const MIN_LINKS = 3;

/** Cấp heading đưa vào TOC — giới hạn ở h2 để TOC blog gọn trong cột đọc. */
const links = computed(() => (toc?.links ?? []).filter((link) => link.depth === 2));

const useful = computed(() => links.value.length >= MIN_LINKS);
</script>

<template>
  <details v-if="useful" class="group rounded-lg border border-line bg-surface p-4" open>
    <summary class="cursor-pointer text-xs font-semibold uppercase tracking-wide text-faint">
      {{ label }}
    </summary>
    <nav :aria-label="label" class="mt-3">
      <ul class="space-y-1 text-sm">
        <li v-for="link in links" :key="link.id">
          <a
            :href="`#${link.id}`"
            class="block rounded px-2 py-1 text-muted hover:bg-surface-raised hover:text-foam hover:underline focus-visible:bg-surface-raised"
            >{{ link.text }}</a
          >
        </li>
      </ul>
    </nav>
  </details>
</template>
