import { useI18n } from '#i18n';
import { useHead } from '#app';
import { watchEffect } from 'vue';
import { useAccountLocale } from './use-account-locale';

/**
 * Nối locale của app với `vue-i18n` và với `<html lang>`.
 *
 * Gọi đúng một lần ở `app.vue`: đây là điểm **duy nhất** ghi `locale` của
 * composer. Mỗi trang chỉ đọc qua `useI18n()`, không tự set — nếu mỗi trang tự
 * set thì chúng tranh nhau quyền quyết định, và trang nào set sau là thắng: quyết
 * định locale sẽ nằm ở "trang set sau cùng" thay vì ở quy tắc đã chốt trong
 * `useAccountLocale`.
 *
 * `watchEffect` chứ không phải set một lần: locale đổi được giữa phiên (đổi ở
 * selector, hoặc nạp preference đã lưu của tài khoản), và ngôn ngữ phải theo.
 *
 * ⚠️ `<html lang>` lấy `language` (BCP-47) chứ không lấy `code`. Ở `zh-CN` hai
 * cái khác nhau: `lang="zh-CN"` vẫn hợp lệ về cú pháp, nhưng screen reader và
 * công cụ dịch đọc nó là một biến thể khác với `zh-Hans` mà catalog này viết.
 */
export function useAccountI18n(): void {
  const i18n = useI18n();
  const { preferred, language } = useAccountLocale();

  watchEffect(() => {
    i18n.locale.value = preferred.value;
  });

  useHead({ htmlAttrs: { lang: language } });
}
