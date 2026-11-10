/**
 * Navigation cấp Public Web do `app/layout` sở hữu.
 *
 * Toàn bộ navigation mounted (mega panel docs/legal của header, các cột
 * footer, hàng legal) đã bị xoá cùng stack @nuxt/content (issue #72): header
 * chỉ còn brand + language switcher, footer chỉ còn brand + tagline. Module
 * này chỉ giữ tagline — dữ liệu tĩnh, frozen, không runtime fetch, không CMS
 * schema.
 */

import type { PublicLocale } from '../../i18n/index';

/**
 * Mô tả ngắn của brand trong footer — một câu, mô tả đúng bề mặt đang tồn
 * tại (public web hai locale), không hứa hẹn tính năng chưa có.
 */
export const PUBLIC_FOOTER_TAGLINE: Readonly<Record<PublicLocale, string>> = Object.freeze({
  en: 'The public surface of ecoma.io — English and Vietnamese, served from the edge.',
  vi: 'Bề mặt public của ecoma.io — English và tiếng Việt, phục vụ từ edge.',
});
