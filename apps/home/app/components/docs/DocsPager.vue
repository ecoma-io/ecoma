<!--
  Previous / next navigation của docs — hai link tới document liền trước và liền
  sau trong **cùng locale**.

  Nhận cặp đã resolve từ route: route gọi `queryCollectionItemSurroundings` và
  lọc theo tiền tố locale hiện tại, nên `previous`/`next` không bao giờ nhảy
  sang locale khác hay ra ngoài docs tree.

  `rel="prev"`/`rel="next"` là gợi ý điều hướng tuần tự cho crawler; nhãn
  `Previous`/`Next` đã localized. Mục không tồn tại render khoảng trống để
  layout hai cột không xô lệch khi ở đầu hoặc cuối chuỗi.

  `<nav>` ở đây cần **tên truy cập được** (`labels.pagination`): trên một trang
  docs có nhiều landmark `nav` (global của shell, language, breadcrumb, sidebar,
  TOC), nên một `nav` không tên chỉ được đọc là "navigation" và người dùng
  screen reader không biết đó là điều hướng nào.
-->
<script setup lang="ts">
// Hai hướng điều hướng (`previous`/`next`) cộng nhãn localized của chúng —
// `labels` không gộp vào từng hướng được vì cả hai hướng dùng chung một nguồn
// chuỗi. Cùng cách xử lý như `PublicShell`/`PublicHeader`.
// oxlint-disable-next-line vue/max-props
const { previous, next, labels } = defineProps<{
  /** Document liền trước, hoặc `undefined` nếu đang ở đầu chuỗi. */
  readonly previous: { readonly path: string; readonly title: string } | undefined;
  /** Document liền sau, hoặc `undefined` nếu đang ở cuối chuỗi. */
  readonly next: { readonly path: string; readonly title: string } | undefined;
  /** Nhãn localized cho hai hướng, cộng tên truy cập được của `<nav>`. */
  readonly labels: {
    readonly previous: string;
    readonly next: string;
    readonly pagination: string;
  };
}>();
</script>

<template>
  <nav
    :aria-label="labels.pagination"
    class="mt-10 grid gap-4 border-t border-line pt-6 sm:grid-cols-2"
  >
    <div>
      <a
        v-if="previous"
        :href="previous.path"
        rel="prev"
        class="group block rounded border border-line p-4 hover:border-brand hover:bg-surface focus-visible:bg-surface"
      >
        <span class="block text-xs font-semibold uppercase tracking-wide text-faint">
          {{ labels.previous }}
        </span>
        <span class="mt-1 block font-medium text-foam group-hover:underline">
          {{ previous.title }}
        </span>
      </a>
    </div>
    <div>
      <a
        v-if="next"
        :href="next.path"
        rel="next"
        class="group block rounded border border-line p-4 hover:border-brand hover:bg-surface focus-visible:bg-surface sm:text-right"
      >
        <span class="block text-xs font-semibold uppercase tracking-wide text-faint">
          {{ labels.next }}
        </span>
        <span class="mt-1 block font-medium text-foam group-hover:underline">
          {{ next.title }}
        </span>
      </a>
    </div>
  </nav>
</template>
