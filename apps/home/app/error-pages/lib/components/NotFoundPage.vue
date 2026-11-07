<!--
  `NotFoundPage` — bề mặt dùng chung cho HTTP 404 (Not Found).

  Trách nhiệm phân định rõ:
  - **Library** trình bày trang: một `<h1>`, mô tả, CTA về/đi tiếp, stage
    visual dùng chung. Không biết locale, không biết URL hiện tại, không tự
    quyết HTTP status.
  - **Consumer** (app) quyết định: lỗi nào là 404 (Nuxt `validate` /
    `createError` / catch-all route), nội dung localized, và CTA trỏ đi đâu.
    HTTP status 404 do seam của app emit — component này KHÔNG đặt status.

  Không render banner bảo mật hay hint chứng thực — 404 là thông báo điều
  hướng, không phải thông báo truy cập.
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
      <!-- Ngôn ngữ trang là nội dung của consumer; mã số là hằng số ngữ nghĩa
           của component (404 = Not Found) — không làm prop để tránh trang
           "404" lại hiện mã khác. -->
      <span aria-hidden="true">404</span>
    </template>
  </ErrorPageStage>
</template>
