import type { PactBrokerLocale } from './locale-registry';
import en from './locales/en';
import type { MessageTree } from './locales/messages';
import vi from './locales/vi';
import zhCN from './locales/zh-CN';

/**
 * Message map của `pact-broker-app` — **một** nguồn message cho cả ba locale.
 *
 * ⚠️ `vue-i18n.config.ts` là macro của Nuxt (`defineI18nConfig`) nên test không
 * import được nó; bản đồ nằm ở đây — file thuần, không macro — để app **và**
 * `tests/nuxt-globals.ts` dùng cùng một object. Nhờ đó thêm một locale là lỗi
 * compile ở cả hai nơi.
 *
 * Locale không khai `file` ở `nuxt.config.ts` là cố ý: khai thêm sẽ tạo ra
 * nguồn message thứ hai cho cùng một locale, và hai cây key sẽ trôi khỏi nhau.
 *
 * ⚠️ Kiểu `Record<PactBrokerLocale, …>` là chốt chặn: thêm một locale vào
 * `PACT_BROKER_LOCALE_DEFINITIONS` mà quên nối catalog của nó vào đây là **lỗi
 * compile**, chứ không phải một locale im lặng render ra key thô ở production.
 */
export const pactBrokerMessages: Record<PactBrokerLocale, MessageTree<typeof en>> = {
  en,
  vi,
  'zh-CN': zhCN,
};
