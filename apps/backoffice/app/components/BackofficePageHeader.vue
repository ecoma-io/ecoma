<script setup lang="ts">
/**
 * Tiêu đề trang + mô tả — khối lặp lại ở bốn trang prototype của backoffice.
 *
 * ⚠️ `<h1>` **một** mỗi trang, và nó là heading đầu tiên trong `<main>`. Shell
 * không render heading nào khác, nên thứ tự heading trên mọi trang là `h1` → `h2`
 * (các khối con) → `h3`. Trang nào có hai `h1` sẽ phá đường điều hướng bằng
 * heading mà screen reader đọc bằng phím H.
 *
 * `description` là `<p>` dưới `<h1>`, không phải `aria-describedby` trỏ ngược: mô
 * tả dài hơn một câu thì `aria-describedby` đọc lại một đoạn văn bị đọc hai lần
 * (một lần khi vào phần tử, một lần khi rời điểm neo).
 *
 * Màu lấy từ token của shell (`text-foreground` / `text-muted-foreground`), không
 * tự đặt: đây là primitive dùng chung cho bốn trang, và shell có **một** bảng
 * màu. `--color-foam` của app là token **của logo** (`EcomaLogo`), không phải màu
 * chữ — dùng nó ở đây sẽ trộn hai khái niệm trong một tên.
 */
const { title, description = undefined } =
  // oxlint-disable-next-line vue/max-props
  defineProps<{
    readonly title: string;
    readonly description?: string;
  }>();
</script>

<template>
  <div class="mb-6">
    <h1 class="text-2xl font-semibold tracking-tight" data-testid="backoffice-page-title">
      {{ title }}
    </h1>
    <p v-if="description" class="mt-2 max-w-2xl text-sm text-muted-foreground">
      {{ description }}
    </p>
  </div>
</template>
