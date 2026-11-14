<script setup lang="ts">
/**
 * Trạng thái "app quản trị chưa khả dụng" — BFF chưa cấu hình được (thiếu
 * cấu hình OIDC / control plane / DB) hoặc trang thiếu biến cấu hình bắt buộc.
 *
 * Deliberate duplication của `PactBrokerUnavailableState` (module boundary cấm
 * import chéo giữa app). Khác `RemoteCacheAppErrorState` ở ngữ cảnh: đây
 * **không** phải lỗi của một lần tải mà là trạng thái của cả trang — retry
 * trong phiên không đổi kết quả khi nguyên nhân là cấu hình deployment. Vì vậy
 * không có nút retry.
 */
const {
  title,
  body,
  // oxlint-disable-next-line vue/max-props
} = defineProps<{
  readonly title: string;
  readonly body: string;
}>();
</script>

<template>
  <div
    class="rounded-lg border border-border bg-muted/40 px-4 py-6"
    role="status"
    data-testid="remote-cache-app-unavailable"
  >
    <p class="text-sm font-semibold">{{ title }}</p>
    <p class="mt-1 text-sm text-muted-foreground">{{ body }}</p>
  </div>
</template>
