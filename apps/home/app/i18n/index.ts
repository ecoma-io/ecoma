/**
 * Public API của `app/i18n` — locale dimension cho public URL `ecoma.io`.
 *
 * Chỉ export đúng những gì consumer cần: registry locale, kiểu kết quả và ba
 * phép xử lý pathname. Helper nội bộ không nằm ở entrypoint này.
 */

export {
  PUBLIC_LOCALES,
  getLocaleDefinition,
  isPublicLocale,
  type PublicLocale,
  type PublicLocaleDefinition,
} from './lib/locale-registry';
export type { PublicPathReason, PublicPathResult } from './lib/public-path';
export { parsePublicPath } from './lib/parse-public-path';
export { localizePath } from './lib/localize-path';
export { switchLocale } from './lib/switch-locale';
