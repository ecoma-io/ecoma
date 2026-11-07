<script setup lang="ts">
/**
 * Thông báo kết quả của một thao tác ghi — `saved` / `not-saved`.
 *
 * ⚠️ Component này tồn tại để làm một điều khó hơn nhiều so với việc hiện chữ
 * "Saved": nó **phải** được render từ `Result` của adapter, không phải từ một
 * biến "đã bấm nút". Yêu cầu "không hiện trạng thái thành công bền vững nếu lưu
 * hỏng" chỉ kiểm được khi thành công phải đi qua đường có kiểu.
 *
 * `role="status"` + `aria-live="polite"`: thay đổi trạng thái lưu là tin không
 * gấp — người dùng đang bận thao tác, không cần bị cắt ngang để nghe "đã lưu".
 */
// oxlint-disable-next-line vue/max-props
const { tone, message } = defineProps<{
  readonly tone: 'success' | 'danger';
  readonly message: string;
}>();
</script>

<template>
  <p
    class="mt-3 rounded-field border px-3 py-2 text-sm"
    :class="
      tone === 'success'
        ? 'border-success bg-success-soft text-success'
        : 'border-danger bg-danger-soft text-danger'
    "
    role="status"
    aria-live="polite"
    data-testid="account-result"
    :data-tone="tone"
  >
    {{ message }}
  </p>
</template>
