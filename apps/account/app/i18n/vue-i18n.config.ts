import en from './locales/en';
import vi from './locales/vi';
import zhCN from './locales/zh-CN';
import { DEFAULT_ACCOUNT_LOCALE, type AccountLocale } from './locale-registry';
import type { MessageTree } from './locales/messages';

/**
 * Message map của `account` — **một** nguồn message cho cả ba locale.
 *
 * ⚠️ Kiểu `Record<AccountLocale, …>` là chốt chặn: thêm một locale vào
 * `ACCOUNT_LOCALE_DEFINITIONS` mà quên nối catalog của nó vào đây là **lỗi
 * compile**, chứ không phải một locale im lặng render ra key thô ở production.
 *
 * Locale không khai `file` ở `nuxt.config.ts` là cố ý: khai thêm sẽ tạo ra
 * nguồn message thứ hai cho cùng một locale, và hai cây key sẽ trôi khỏi nhau.
 */
/**
 * ⚠️ Kiểu là `MessageTree<…>`, **không** phải `Record<string, unknown>`: kiểu
 * rộng đó không kiểm được cây key và làm `vue-i18n` từ chối cả config (yêu cầu
 * `LocaleMessageValue`). `AccountMessages` là `en` đã widen — đủ để `vi` và
 * `zh-CN` cùng kiểu mà không đòi bản dịch trùng nguyên văn tiếng Anh.
 */
export const accountMessages: Record<AccountLocale, MessageTree<typeof en>> = {
  en,
  vi,
  'zh-CN': zhCN,
};

/**
 * Cấu hình `vue-i18n` cho `account`.
 *
 * ⚠️ `missingWarn`/`fallbackWarn` **bật**: `fallbackLocale: 'en'` chỉ là lớp
 * chống trải rỗng, không phải cơ chế che lỗi. Một key thiếu phải ồn ào trong dev
 * và trong test thay vì lặng lẽ hiện tên key trên trang — catalog parity test lo
 * phần cấu trúc, còn hai cờ này bắt phần **runtime** (key dựng động, key gõ sai).
 *
 * `legacy: false` là mặc định của `vue-i18n` v11 nhưng khai tường minh: mode
 * legacy không hỗ trợ Composition API mà mọi component của app này dùng.
 *
 * ⚠️ **Không** set `locale` ở đây. Module tự ghi đè nó bằng locale đã lưu hoặc
 * `defaultLocale`; đặt sẵn ở đây là khai một locale thứ hai cho cùng một quyết
 * định, và quyết định đó đã nằm ở `DEFAULT_ACCOUNT_LOCALE`.
 */
export default defineI18nConfig(() => ({
  legacy: false,
  globalInjection: true,
  fallbackLocale: DEFAULT_ACCOUNT_LOCALE,
  missingWarn: true,
  fallbackWarn: true,
  messages: accountMessages,
}));
