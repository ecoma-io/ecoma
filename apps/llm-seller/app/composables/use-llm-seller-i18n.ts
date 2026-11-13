import { useI18n } from '#i18n';
import type { AppShellDirection } from '@ecoma-io/ui-app-shell';
import { computed, watchEffect, type ComputedRef } from 'vue';
import { getLlmSellerLocaleDefinition } from '../i18n/locale-registry';
import { useLlmSellerLocale } from './use-llm-seller-locale';

/**
 * Kết quả nối i18n với lựa chọn locale của app.
 */
export type LlmSellerI18nState = {
  /** BCP-47 cho `<html lang>` — khác `code` ở `zh-CN` (`zh-Hans`). */
  readonly language: ComputedRef<string>;
  /**
   * Chiều văn bản cho `<html dir>` và prop `dir` của shell — suy ra từ registry,
   * cùng nguồn với `language`.
   */
  readonly dir: ComputedRef<AppShellDirection>;
};

/**
 * Nối locale của app với `vue-i18n`.
 *
 * Gọi đúng một lần ở `app.vue`: đây là điểm **duy nhất** ghi `locale` của
 * composer. Trang chỉ đọc qua `useI18n()`, không tự set — nếu mỗi trang tự set
 * thì chúng tranh nhau quyền quyết định và trang set sau thắng, tức là quyết định
 * locale nằm ở thứ tự mount thay vì ở quy tắc đã chốt trong
 * `useLlmSellerLocale`.
 *
 * `watchEffect` chứ không phải set một lần: locale đổi được giữa phiên (đổi ở
 * language selector), và ngôn ngữ phải theo ngay.
 *
 * `dir` là thuộc tính của **ngôn ngữ nội dung**, không phải lựa chọn người dùng
 * (issue #213): shell không còn setting LTR/RTL, chiều văn bản đọc từ định nghĩa
 * locale đang chọn trong registry — cùng nguồn với `<html lang>`, nên thêm một
 * locale RTL (ar, he, fa…) chỉ cần khai `dir: 'rtl'` ở registry một chỗ, không
 * phải sửa app.vue hay shell.
 *
 * ⚠️ Composable này **không** gọi `useHead` cho thuộc tính document: app gộp
 * **toàn bộ** head vào **một** `useHead` ở `app.vue` — `lang`/`dir` của `<html>`
 * và script bootstrap color mode nằm trong cùng một object, nên kết quả không
 * phụ thuộc vào việc unhead có trộn head giữa hai lần gọi hay không. Vì vậy
 * composable trả `language` và `dir` về cho `app.vue` thay vì tự ghi head.
 *
 * ⚠️ `<html lang>` lấy `language` (BCP-47) chứ không lấy `code`. Ở `zh-CN` hai
 * cái khác nhau: `lang="zh-CN"` vẫn hợp lệ về cú pháp, nhưng screen reader và
 * công cụ dịch cần `zh-Hans` để hiểu đúng biến thể chữ Hán mà catalog viết.
 */
export function useLlmSellerI18n(): LlmSellerI18nState {
  const i18n = useI18n();
  const { preferred, language } = useLlmSellerLocale();

  watchEffect(() => {
    i18n.locale.value = preferred.value;
  });

  return {
    // `getLlmSellerLocaleDefinition` không thể trả `undefined` ở đây vì
    // `preferred` đã là `LlmSellerLocale`; fallback `'ltr'` vẫn được khai để
    // kiểu không dựa vào điều kiện không xảy ra — nếu registry và default lệch
    // nhau thì lỗi phải hiện ra, không phải trả `undefined` làm `<html dir>`
    // rỗng.
    dir: computed(() => getLlmSellerLocaleDefinition(preferred.value)?.dir ?? 'ltr'),
    language,
  };
}
