<!--
  Cây navigation của docs — phần render dùng chung cho cả disclosure trên
  mobile và cột sticky trên desktop.

  Tách khỏi `DocsSidebar` vì hai bề mặt đó cần hai khối DOM khác nhau
  (`<details>` cho mobile, `<nav>` luôn hiện cho desktop) nhưng **cùng một
  cây**: render hai lần từ cùng một nguồn dữ liệu thì rẻ hơn việc dùng JS để
  chuyển đổi, và quan trọng hơn là SSR và hydrate cho ra HTML giống nhau. Bề
  mặt bị ẩn bằng `display:none` nên không xuất hiện trong accessibility tree —
  không có link trùng cho screen reader.

  Không tự query content: `items` là dữ liệu route đã resolve.
-->
<script setup lang="ts">
import type { ContentNavigationItem } from '@nuxt/content';

// Cây cần đúng ba input độc lập (dữ liệu, page hiện tại, nhãn a11y) — không
// gộp được thành một prop mà không dựng thêm một kiểu bao ngoài chỉ để lọt
// linter. Cùng cách xử lý như `PublicShell`/`PublicHeader` của `app/layout`.
// oxlint-disable-next-line vue/max-props
const { items, currentPath, label } = defineProps<{
  readonly items: readonly ContentNavigationItem[];
  readonly currentPath: string;
  readonly label: string;
}>();

/** Item có phải chính page đang xem — dùng cho `aria-current` và highlight. */
function isCurrent(path: string): boolean {
  return path === currentPath;
}
</script>

<template>
  <nav :aria-label="label">
    <ul class="space-y-1 text-sm">
      <li v-for="section in items" :key="section.path">
        <a
          :href="section.path"
          class="block rounded px-2 py-1 font-semibold hover:bg-surface hover:underline focus-visible:bg-surface"
          :class="isCurrent(section.path) ? 'bg-surface-raised text-foam' : 'text-foam'"
          :aria-current="isCurrent(section.path) ? 'page' : undefined"
          >{{ section.title }}</a
        >

        <ul v-if="section.children?.length" class="mt-1 space-y-1 border-l border-line pl-3">
          <!--
            Content đưa chính index page vào `children[0]` của section, nên
            child trùng `path` với section đã render ở trên — bỏ qua để không
            lặp link cùng một đích.
          -->
          <li v-for="child in section.children" :key="child.path">
            <template v-if="child.path !== section.path">
              <a
                :href="child.path"
                class="block rounded px-2 py-1 hover:bg-surface hover:underline focus-visible:bg-surface"
                :class="
                  isCurrent(child.path) ? 'bg-surface-raised font-semibold text-foam' : 'text-muted'
                "
                :aria-current="isCurrent(child.path) ? 'page' : undefined"
                >{{ child.title }}</a
              >
            </template>
          </li>
        </ul>
      </li>
    </ul>
  </nav>
</template>
