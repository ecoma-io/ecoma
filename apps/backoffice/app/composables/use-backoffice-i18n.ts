import { useI18n } from '#i18n';
import { watchEffect, type ComputedRef } from 'vue';
import { useBackofficeLocale } from './use-backoffice-locale';

/**
 * Kết quả nối i18n với lựa chọn locale của app.
 */
export type BackofficeI18nState = {
  /** BCP-47 cho `<html lang>` — khác `code` ở `zh-CN` (`zh-Hans`). */
  readonly language: ComputedRef<string>;
};

/**
 * Nối locale của app với `vue-i18n`.
 *
 * Gọi đúng một lần ở `app.vue`: đây là điểm **duy nhất** ghi `locale` của
 * composer. Trang chỉ đọc qua `useI18n()`, không tự set — nếu mỗi trang tự set
 * thì chúng tranh nhau quyền quyết định và trang set sau thắng, tức là quyết định
 * locale nằm ở thứ tự mount thay vì ở quy tắc đã chốt trong
 * `useBackofficeLocale`.
 *
 * `watchEffect` chứ không phải set một lần: locale đổi được giữa phiên (đổi ở
 * language selector), và ngôn ngữ phải theo ngay.
 *
 * ⚠️ Composable này **không** gọi `useHead` cho `<html lang>`, khác
 * `useAccountI18n` của `apps/account`. Lý do là backoffice gộp **toàn bộ** thuộc
 * tính document vào **một** `useHead` ở `app.vue`: shell trả về `class`/`dir` của
 * `<html>` và `color-*` của `<body>` qua `appShellHeadAttributes`, còn `lang` là
 * việc của app — gộp vào cùng object thì kết quả không phụ thuộc vào việc unhead
 * có trộn `htmlAttrs` giữa hai lần gọi hay không. Vì vậy composable trả
 * `language` về cho `app.vue` thay vì tự ghi head.
 *
 * ⚠️ `<html lang>` lấy `language` (BCP-47) chứ không lấy `code`. Ở `zh-CN` hai
 * cái khác nhau: `lang="zh-CN"` vẫn hợp lệ về cú pháp, nhưng screen reader và
 * công cụ dịch cần `zh-Hans` để hiểu đúng biến thể chữ Hán mà catalog viết.
 */
export function useBackofficeI18n(): BackofficeI18nState {
  const i18n = useI18n();
  const { preferred, language } = useBackofficeLocale();

  watchEffect(() => {
    i18n.locale.value = preferred.value;
  });

  return { language };
}
