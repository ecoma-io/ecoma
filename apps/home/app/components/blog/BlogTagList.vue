<!--
  Danh sách tag của một article — badge thuần hiển thị (không link: tag archive
  routing nằm ngoài scope của slice này).

  `<ul>` + `aria-label` từ UI strings: vùng tag là một danh sách có nghĩa cho
  screen reader, không phải chuỗi chữ rời.
-->
<script setup lang="ts">
// oxlint-disable-next-line vue/max-props
defineProps<{
  /** Tags của article — thứ tự giữ nguyên từ frontmatter. */
  readonly tags: readonly string[];
  /** Nhãn truy cập được cho danh sách (`blogUiStrings().tags`). */
  readonly label: string;
}>();
</script>

<template>
  <!--
    Ẩn hẳn khi không còn tag: danh sách có nhãn nhưng rỗng khiến screen reader
    đọc nhãn rồi dừng ở vùng trống. Dedupe/trim diễn ra ở tầng dữ liệu
    (`articleDisplayTags` trong `blog-articles.ts`, gọi ở route) — component
    nhận danh sách đã sạch nên `:key="tag"` luôn an toàn.
  -->
  <ul v-if="tags.length > 0" :aria-label="label" class="flex flex-wrap items-center gap-2">
    <li
      v-for="tag in tags"
      :key="tag"
      class="rounded-full bg-surface-raised px-2.5 py-0.5 text-xs font-medium text-muted"
    >
      {{ tag }}
    </li>
  </ul>
</template>
