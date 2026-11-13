import { useI18n } from '#i18n';
import { watchEffect, type ComputedRef } from 'vue';
import { useLlmConsoleLocale } from './use-llm-console-locale';

/**
 * Kết quả nối i18n với lựa chọn locale của app.
 */
export type LlmConsoleI18nState = {
  /** BCP-47 cho `<html lang>` — khác `code` ở `zh-CN` (`zh-Hans`). */
  readonly language: ComputedRef<string>;
  /** Hướng chữ của locale đang dùng, cho `<html dir>` và prop `dir` của shell. */
  readonly dir: ComputedRef<'ltr' | 'rtl'>;
};

/**
 * Nối locale của app với `vue-i18n`.
 *
 * Gọi đúng một lần ở `app.vue`: đây là điểm **duy nhất** ghi `locale` của
 * composer. Trang chỉ đọc qua `useI18n()`, không tự set — nếu mỗi trang tự set
 * thì chúng tranh nhau quyền quyết định và trang set sau thắng, tức là quyết định
 * locale nằm ở thứ tự mount thay vì ở quy tắc đã chốt trong
 * `useLlmConsoleLocale`.
 *
 * `watchEffect` chứ không phải set một lần: locale đổi được giữa phiên (đổi ở
 * language selector), và ngôn ngữ phải theo ngay.
 *
 * ⚠️ Composable này **không** gọi `useHead` cho các thuộc tính document: app gộp
 * **toàn bộ** vào **một** `useHead` ở `app.vue` — `lang`/`dir` của `<html>` (hai
 * thuộc tính của cùng ngôn ngữ, cùng tra từ một definition trong registry) và
 * script bootstrap của color mode. Gộp vào cùng object thì kết quả không phụ
 * thuộc vào việc unhead có trộn `htmlAttrs` giữa hai lần gọi hay không. Vì vậy
 * composable trả `language` và `dir` về cho `app.vue` thay vì tự ghi head.
 *
 * ⚠️ `<html lang>` lấy `language` (BCP-47) chứ không lấy `code`. Ở `zh-CN` hai
 * cái khác nhau: `lang="zh-CN"` vẫn hợp lệ về cú pháp, nhưng screen reader và
 * công cụ dịch cần `zh-Hans` để hiểu đúng biến thể chữ Hán mà catalog viết.
 *
 * ⚠️ `dir` **không** đọc từ cookie hay tuỳ chọn nào của người dùng: hướng chữ là
 * thuộc tính của ngôn ngữ nội dung, nên nó đổi theo locale tại cùng một lần tra
 * registry với `language` (issue #213).
 */
export function useLlmConsoleI18n(): LlmConsoleI18nState {
  const i18n = useI18n();
  const { preferred, language, dir } = useLlmConsoleLocale();

  watchEffect(() => {
    i18n.locale.value = preferred.value;
  });

  return { language, dir };
}
