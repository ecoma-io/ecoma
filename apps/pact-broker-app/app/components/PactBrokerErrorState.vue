<script setup lang="ts">
import { Button } from '@ecoma-io/ui-app-shell';

/**
 * Trạng thái lỗi — lỗi tải dữ liệu, khác với lỗi của một thao tác ghi.
 *
 * Thông điệp kỹ thuật từ lớp dữ liệu được hiện **kèm** dạng chi tiết nhỏ in đậm,
 * không thay bằng tiếng Anh: nếu chỉ hiện `states.errorBody`, một người dùng gặp
 * lỗi contract không có gì để báo cáo cho support, và người đọc log không thấy
 * app đã từng nói những gì.
 *
 * ⚠️ `role="alert"` chứ không phải `role="status"`: đây là thông tin **mới** và
 * quan trọng, cần đọc ngay, không phải thông báo lịch sự chen vào hàng đợi.
 *
 * ⚠️ `detail`/`retryLabel`/`onRetry` là prop optional nên phải khai default ở phần
 * destructure (không dùng `withDefaults`: nó đụng `define-props-destructuring`).
 *
 * ⚠️ `vue/max-props` của repo đặt ngưỡng 1, và prop ở đây **không** phải cấu
 * hình — chúng là nội dung hiển thị mà component này được sinh ra để render. Gom
 * chúng vào một object `state` sẽ chỉ đổi hình thức, còn việc ghép object ở mỗi
 * chỗ gọi thì làm mất kiểu tại điểm dùng. Các component cùng loại trong app này
 * dùng cùng cách bỏ qua.
 */
const {
  title,
  body,
  detail = undefined,
  retryLabel = undefined,
  onRetry = undefined,
  // oxlint-disable-next-line vue/max-props
} = defineProps<{
  readonly title: string;
  readonly body: string;
  /** Chi tiết kỹ thuật từ lớp dữ liệu — có thể rỗng. */
  readonly detail?: string;
  /** Nhãn của nút thử lại; bỏ trắng để không render nút. */
  readonly retryLabel?: string;
  readonly onRetry?: () => void;
}>();
</script>

<template>
  <div
    class="rounded-lg border border-destructive bg-destructive/10 px-4 py-4"
    role="alert"
    data-testid="pact-broker-error"
  >
    <p class="text-sm font-semibold text-destructive">{{ title }}</p>
    <p class="mt-1 text-sm">{{ body }}</p>
    <p
      v-if="detail"
      class="mt-2 font-mono text-xs break-all text-muted-foreground"
      data-testid="pact-broker-error-detail"
    >
      {{ detail }}
    </p>
    <Button
      v-if="retryLabel && onRetry"
      variant="outline"
      size="sm"
      class="mt-3"
      data-testid="pact-broker-error-retry"
      @click="onRetry"
    >
      {{ retryLabel }}
    </Button>
  </div>
</template>
