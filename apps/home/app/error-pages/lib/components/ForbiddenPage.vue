<!--
  `ForbiddenPage` — bề mặt dùng chung cho HTTP 403 (Forbidden).

  Khác 404 ở **ngữ nghĩa**: người dùng đã được xác thực (hoặc không cần xác
  thực) nhưng không có quyền truy cập tài nguyên. Vì vậy:
  - không render bất kỳ hint nào về việc đăng nhập/đăng ký — đó là phạm vi
    của 401/auth flow, rơi vào đây là lộ thông tin không cần thiết;
  - CTA nên trỏ tới bề mặt an toàn mà người dùng có quyền xem — consumer tự
    quyết, library không giả định destination.

  Library không biết trang này có thật sự được phục vụ với HTTP 403 hay
  không: app quyết định seam nào (middleware, `createError`, error handler)
  emit status đó. Nếu consumer chưa có flow 403 thật, component vẫn dùng
  được ở cấp component (preview, story, test) — không tạo route giả để
  "chạy được" 403.
-->
<script setup lang="ts">
import type { ErrorPageContent } from '../error-page-content';
import ErrorPageStage from './ErrorPageStage.vue';

// Destructure `content` (rule `vue/define-props-destructuring`) — một prop
// duy nhất: mọi thứ còn lại là copy đã localize của consumer.
const { content } = defineProps<{
  readonly content: ErrorPageContent;
}>();
</script>

<template>
  <ErrorPageStage :content="content">
    <template #status>
      <!-- Mã số là hằng số ngữ nghĩa của component (403 = Forbidden) —
           không làm prop để tránh trang "403" lại hiện mã khác. -->
      <span aria-hidden="true">403</span>
    </template>
  </ErrorPageStage>
</template>
