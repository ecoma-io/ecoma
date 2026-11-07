<script setup lang="ts">
/**
 * Trạng thái "broker chưa khả dụng" — BFF chưa cấu hình được để nói chuyện với
 * API (thiếu base URL / token, hoặc API trả 503 fail-closed).
 *
 * Khác `PactBrokerErrorState` ở ngữ cảnh: đây **không** phải lỗi của một lần tải
 * mà là trạng thái của cả dashboard — retry trong phiên không đổi kết quả khi
 * nguyên nhân là cấu hình deployment. Vì vậy không có nút retry: một nút không
 * bao giờ sửa được nguyên nhân chỉ dạy người dùng bấm vô ích.
 *
 * Câu chữ lấy từ catalog (`states.unavailable*`), trung tâm theo chế độ — không
 * đoán nguyên nhân cụ thể, vì người dùng không thể hành động trên thông tin đó.
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
    data-testid="pact-broker-unavailable"
  >
    <p class="text-sm font-semibold">{{ title }}</p>
    <p class="mt-1 text-sm text-muted-foreground">{{ body }}</p>
  </div>
</template>
