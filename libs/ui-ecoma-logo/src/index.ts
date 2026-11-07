/**
 * Public API của `@ecoma-io/ui-ecoma-logo` — artwork brand logo của ecoma.io
 * dưới dạng Vue component dùng chung.
 *
 * Hiện chỉ chứa **primary horizontal logo** từ SVG nguồn; các biến thể khác
 * (stacked, symbol, wordmark riêng, colorway) chưa có thiết kế chính thức
 * nên không có ở đây. Chỉ export đúng những gì consumer cần: component render
 * logo và URL asset thô (khi consumer cần phần tử ảnh tự quản — favicon,
 * `<img src>`…). Lưu ý: URL là đường dẫn tương đối với origin và có hash theo
 * build — Open Graph image cần URL tuyệt đối ổn định nên phải do consumer tự
 * prefix origin/copy asset; helper nội bộ không nằm ở entrypoint này.
 */

export { default as EcomaLogo } from './lib/components/EcomaLogo.vue';
export { ECOMA_LOGO_HORIZONTAL_SVG_URL } from './lib/logo-asset';
