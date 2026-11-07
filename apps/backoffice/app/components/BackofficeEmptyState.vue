<script setup lang="ts">
/**
 * Trạng thái rỗng — "không có gì ở đây" khác hẳn "đang tải".
 *
 * Cố ý **không** có nút hành động: nơi cần hành động (ví dụ thêm email, tạo
 * privacy request) thì caller đặt nó ở trên form, đúng chỗ người dùng đã ở.
 * Nhúng một nút vào khung rỗng là cách dễ dẫn tới hai nút trùng chức năng trên
 * cùng một trang.
 */
const { message } = defineProps<{
  /** Câu mô tả trạng thái rỗng, đã localized. */
  readonly message: string;
}>();
</script>

<template>
  <div
    class="rounded-lg border border-border bg-background px-4 py-8 text-center text-sm text-muted-foreground"
    data-testid="backoffice-empty"
  >
    {{ message }}
  </div>
</template>
