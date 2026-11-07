/**
 * Chính sách locale mặc định của `home` — policy riêng của application
 * (`docs/architecture/01-architecture.md` A13: chính sách resolve `/` thuộc về
 * caller, không thuộc `app/i18n` hay `app/layout`).
 *
 * `en` là default locale **explicit** của Home — không bao giờ là
 * `PUBLIC_LOCALES[0]`, vì thứ tự registry không phải chính sách sản phẩm.
 * Nếu sau này `PUBLIC_LOCALES` đổi thứ tự, đây vẫn phải là `en`.
 *
 * Chia sẻ giữa `server/routes/index.get.ts` (redirect `/` → `/{default}`) và
 * `app/pages/[locale]/index.vue` (nơi cần giữ một nơi duy nhất khai báo) qua
 * alias `#shared` của Nuxt 4 (`shared/` directory).
 */

export const HOME_DEFAULT_LOCALE = 'en' as const;
