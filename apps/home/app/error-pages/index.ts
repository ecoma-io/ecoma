/**
 * Public API của `error-pages` — shared UI cho HTTP error pages.
 *
 * Bề mặt chủ động nhỏ: hai component trang lỗi, hợp đồng nội dung của chúng
 * và stage visual chỉ nằm private. Library là pure presenter — không biết
 * Nuxt, locale, routing, HTTP status; consumer (app) sở hữu mọi quyết định
 * về thời điểm sử dụng, HTTP status và nội dung đã localize.
 *
 * Tài liệu chi tiết: README.md của project.
 */

export { default as NotFoundPage } from './lib/components/NotFoundPage.vue';
export { default as ForbiddenPage } from './lib/components/ForbiddenPage.vue';
export type { ErrorPageContent, ErrorPageAction } from './lib/error-page-content';
