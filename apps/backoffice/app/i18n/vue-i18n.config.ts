import { backofficeMessages } from './catalogs';
import { DEFAULT_BACKOFFICE_LOCALE } from './locale-registry';

/**
 * Cấu hình `vue-i18n` cho `backoffice`.
 *
 * Message map nằm ở `./catalogs.ts` (file thuần, không macro) để test import cùng
 * một object — xem chú thích ở đó.
 *
 * ⚠️ `missingWarn`/`fallbackWarn` **bật**: `fallbackLocale` chỉ là lớp chống
 * trải rỗng, không phải cơ chế che lỗi. Một key thiếu phải ồn ào trong dev và
 * trong test thay vì lặng lẽ hiện tên key trên trang — `catalogs.spec.ts` lo
 * phần cấu trúc, còn hai cờ này bắt phần **runtime** (key dựng động, key gõ sai).
 *
 * `legacy: false` là mặc định của `vue-i18n` v11 nhưng khai tường minh: mode
 * legacy không hỗ trợ Composition API mà shell và trang của app này đều dùng.
 *
 * ⚠️ **Không** set `locale` ở đây. Locale được quyết định ở
 * `useBackofficeI18n()` (đọc lựa chọn của người dùng rồi ghi vào composer); đặt
 * sẵn ở đây là khai một locale thứ hai cho cùng một quyết định — và quyết định
 * đó đã nằm ở `DEFAULT_BACKOFFICE_LOCALE`.
 */
export default defineI18nConfig(() => ({
  legacy: false,
  globalInjection: true,
  fallbackLocale: DEFAULT_BACKOFFICE_LOCALE,
  missingWarn: true,
  fallbackWarn: true,
  messages: backofficeMessages,
}));
