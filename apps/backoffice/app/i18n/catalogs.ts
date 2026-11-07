import type { BackofficeLocale } from './locale-registry';
import en from './locales/en';
import type { MessageTree } from './locales/messages';
import vi from './locales/vi';
import zhCN from './locales/zh-CN';

/**
 * Message map của `backoffice` — **một** nguồn message cho cả ba locale.
 *
 * ⚠️ `vue-i18n.config.ts` là macro của Nuxt (`defineI18nConfig`) nên test không import
 * được nó; bản đồ nằm ở đây — file thuần, không macro — để app **và**
 * `tests/nuxt-globals.ts` dùng cùng một object. Nhờ đó thêm một locale là lỗi compile
 * ở cả hai nơi: trước đây test giữ một bản sao với catalog chép tay, nên locale thứ
 * tư thêm vào `BACKOFFICE_LOCALE_DEFINITIONS` vẫn để test xanh trên `en` cũ.
 *
 * Locale không khai `file` ở `nuxt.config.ts` là cố ý: khai thêm sẽ tạo ra
 * nguồn message thứ hai cho cùng một locale, và hai cây key sẽ trôi khỏi nhau.
 *
 * ⚠️ Kiểu `Record<BackofficeLocale, …>` là chốt chặn: thêm một locale vào
 * `BACKOFFICE_LOCALE_DEFINITIONS` mà quên nối catalog của nó vào đây là **lỗi
 * compile**, chứ không phải một locale im lặng render ra key thô ở production.
 *
 * ⚠️ Kiểu là `MessageTree<…>`, **không** phải `Record<string, unknown>`: kiểu
 * rộng đó không kiểm được cây key và làm `vue-i18n` từ chối cả config (yêu cầu
 * `LocaleMessageValue`). `MessageTree<typeof en>` là `en` đã widen — đủ để `vi` và
 * `zh-CN` cùng kiểu mà không đòi bản dịch trùng nguyên văn tiếng Anh.
 */
export const backofficeMessages: Record<BackofficeLocale, MessageTree<typeof en>> = {
  en,
  vi,
  'zh-CN': zhCN,
};
