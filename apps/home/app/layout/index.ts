/**
 * Public API của `app/layout` — public shell, global navigation, public
 * mount topology và locale availability context cho bề mặt public `ecoma.io`.
 *
 * Chỉ export đúng những gì consumer cần: registry mount, kiểu kết quả, hai
 * phép xử lý pathname, model navigation, context locale availability và ba
 * component shell. Helper nội bộ (`invalidLayoutPath`,
 * `PUBLIC_MOUNT_DEFINITIONS`) không nằm ở entrypoint này — consumer import
 * locale dimension trực tiếp từ `app/i18n` khi cần.
 */

export {
  PUBLIC_MOUNTS,
  PUBLIC_MOUNTS_IN_DECLARATION_ORDER,
  getMountDefinition,
  isPublicMount,
  type PublicMount,
  type PublicMountDefinition,
} from './lib/mount-registry';
export type {
  PublicLayoutPathInput,
  PublicLayoutPathReason,
  PublicLayoutPathResult,
} from './lib/public-layout-path';
export { parsePublicLayoutPath } from './lib/parse-public-layout-path';
export { buildPublicPath } from './lib/build-public-path';
export { resolveLocaleContext, type PublicLocaleContext } from './lib/locale-context';
export {
  PUBLIC_NAVIGATION,
  PUBLIC_FOOTER_GROUPS,
  PUBLIC_FOOTER_TAGLINE,
  buildPublicNavigation,
  buildPublicFooterGroups,
  buildPublicFooterLegal,
  type PublicNavigationItem,
  type PublicNavigationLink,
  type PublicNavigationGroup,
  type PublicFooterGroup,
  type PublicFooterLink,
  type PublicFooterLinkResolved,
} from './lib/public-navigation';
export { default as PublicShell } from './lib/components/PublicShell.vue';
export { default as PublicHeader } from './lib/components/PublicHeader.vue';
export { default as PublicFooter } from './lib/components/PublicFooter.vue';
