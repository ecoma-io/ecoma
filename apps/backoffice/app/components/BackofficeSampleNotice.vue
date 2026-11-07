<script setup lang="ts">
/**
 * Sample data notice — nói rõ dữ liệu đang hiển thị là prototype, không phải dữ
 * liệu thật.
 *
 * ⚠️ Banner này là **một phần của hợp đồng adapter**, không phải trang trí:
 * `BackofficeDataAdapter.isPreview` (`app/backoffice-data/types.ts`) nói dữ liệu
 * đến từ fixture, và hợp đồng đó viết rằng UI **bắt buộc** hiển thị banner chừng
 * nào cờ còn `true`. Vì vậy điều kiện hiển thị nằm ngay trong component này —
 * đọc cờ từ chính adapter mà trang đang dùng — thay vì để bốn trang tự nhớ
 * `v-if`. Một trang quên `v-if` là một trang nói dối; một component tự đọc cờ
 * thì không có chỗ nào để quên.
 *
 * ⚠️ Câu chữ **không** hardcode ở đây: nó là prop bắt buộc, và bốn trang truyền
 * `prototype.notice.body` đã dịch. Một chuỗi tiếng Anh viết thẳng trong template
 * sẽ nằm giữa giao diện tiếng Việt khi người dùng đổi ngôn ngữ — và không test
 * nào bắt được, vì banner vẫn "hiển thị đúng".
 *
 * `role="note"` không tồn tại; một `<p>` có ngữ nghĩa đoạn văn là đủ, không cần
 * `role="alert"` (đây không phải thông tin mới cần đọc ngay như lỗi).
 */
import { useBackofficeAdapter } from '../composables/use-backoffice-adapter';

const { message } = defineProps<{
  /** Câu thông báo đã localized. */
  readonly message: string;
}>();

const isPreview = useBackofficeAdapter().isPreview;
</script>

<template>
  <p
    v-if="isPreview"
    class="mb-4 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
    data-testid="backoffice-sample-notice"
  >
    {{ message }}
  </p>
</template>
