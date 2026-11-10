/**
 * Public API của `app/layout` — public shell, public path model và locale
 * availability context cho bề mặt public `ecoma.io`.
 *
 * Chỉ export đúng những gì consumer cần: kiểu kết quả, hai phép xử lý
 * pathname, tagline footer, context locale availability và ba component
 * shell. Helper nội bộ (`invalidLayoutPath`) không nằm ở entrypoint này —
 * consumer import locale dimension trực tiếp từ `app/i18n` khi cần.
 *
 * Navigation mounted đã bị xoá cùng stack @nuxt/content (issue #72): header
 * chỉ còn brand + language switcher, footer chỉ còn brand + tagline.
 */

export type {
  PublicLayoutPathInput,
  PublicLayoutPathReason,
  PublicLayoutPathResult,
} from './lib/public-layout-path';
export { parsePublicLayoutPath } from './lib/parse-public-layout-path';
export { buildPublicPath } from './lib/build-public-path';
export { resolveLocaleContext, type PublicLocaleContext } from './lib/locale-context';
export { PUBLIC_FOOTER_TAGLINE } from './lib/public-navigation';
export { default as PublicShell } from './lib/components/PublicShell.vue';
export { default as PublicHeader } from './lib/components/PublicHeader.vue';
export { default as PublicFooter } from './lib/components/PublicFooter.vue';
