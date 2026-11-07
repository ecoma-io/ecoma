<script setup lang="ts">
/**
 * Khung trạng thái tải — nền tảng của bốn trạng thái mà **mọi** trang dữ liệu của
 * app phải có (loading / empty / error / success).
 *
 * Ba trạng thái kia đi qua các component khác (`AccountEmptyState`,
 * `AccountErrorState`, `AccountStatusMessage`); trạng thái tải gom vào đây vì
 * nó không có nội dung để hiển thị — chỉ một thông báo đang tải và một
 * `aria-busy` để screen reader biết vùng đó đang thay đổi.
 *
 * ⚠️ `aria-busy="true"` là phần quan trọng nhất: một vùng đang tải mà không có nó
 * sẽ bị screen reader đọc như nội dung rỗng, và người dùng không biết là app
 * treo hay là app không có gì để hiện.
 */
const { label } = defineProps<{
  /** Thông báo tải, đã localized. */
  readonly label: string;
}>();
</script>

<template>
  <div
    class="flex items-center gap-3 rounded-card border border-line bg-surface-raised px-4 py-6 text-sm text-muted"
    role="status"
    aria-live="polite"
    aria-busy="true"
    data-testid="account-loading"
  >
    <span
      class="size-4 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-brand"
      aria-hidden="true"
    />
    <span>{{ label }}</span>
  </div>
</template>
