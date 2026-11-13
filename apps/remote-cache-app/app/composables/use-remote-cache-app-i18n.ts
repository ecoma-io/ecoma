import { useI18n } from '#i18n';
import { watchEffect, computed, type ComputedRef } from 'vue';
import { getRemoteCacheAppLocaleDefinition } from '../i18n/locale-registry';
import { useRemoteCacheAppLocale } from './use-remote-cache-app-locale';

/**
 * Kết quả nối i18n với lựa chọn locale của app.
 */
export type RemoteCacheAppI18nState = {
  /** BCP-47 cho `<html lang>` — khác `code` ở `zh-CN` (`zh-Hans`). */
  readonly language: ComputedRef<string>;
  /** Chiều văn bản cho `<html dir>` và prop `dir` của shell — suy ra từ registry. */
  readonly dir: ComputedRef<'ltr' | 'rtl'>;
};

/**
 * Nối locale của app với `vue-i18n`.
 *
 * Gọi đúng một lần ở `app.vue`: đây là điểm **duy nhất** ghi `locale` của
 * composer. Trang chỉ đọc qua `useI18n()`, không tự set — nếu mỗi trang tự set
 * thì chúng tranh nhau quyền quyết định và trang set sau thắng, tức là quyết định
 * locale nằm ở thứ tự mount thay vì ở quy tắc đã chốt trong
 * `useRemoteCacheAppLocale`.
 *
 * `watchEffect` chứ không phải set một lần: locale đổi được giữa phiên (đổi ở
 * language selector), và ngôn ngữ phải theo ngay.
 *
 * ⚠️ Composable này **không** gọi `useHead`: app gộp **toàn bộ** thuộc tính
 * document vào **một** `useHead` ở `app.vue` — `lang`/`dir` của `<html>` và
 * script bootstrap của color mode đều nằm trong cùng object trả về, nên kết quả
 * không phụ thuộc vào việc unhead có trộn head giữa hai lần gọi hay không. Vì
 * vậy composable trả `language` và `dir` về cho `app.vue` thay vì tự ghi head.
 *
 * ⚠️ `<html lang>` lấy `language` (BCP-47) chứ không lấy `code`. Ở `zh-CN` hai
 * cái khác nhau: `lang="zh-CN"` vẫn hợp lệ về cú pháp, nhưng screen reader và
 * công cụ dịch cần `zh-Hans` để hiểu đúng biến thể chữ Hán mà catalog viết.
 *
 * ⚠️ `dir` cũng suy ra từ **cùng** registry đó (issue #213): nó là thuộc tính
 * của ngôn ngữ nội dung, không phải lựa chọn người dùng — không có setting
 * LTR/RTL nào. Fallback `'ltr'` cùng hình dạng với fallback `'en'` của
 * `language`: `preferred` đã là `RemoteCacheAppLocale` (union suy ra từ chính
 * registry) nên lệch registry/default là lỗi compile, còn lookup runtime không
 * thể miss — fallback chỉ để kiểu không dựa vào điều kiện không xảy ra, không
 * phải đường xử lý lỗi im lặng.
 */
export function useRemoteCacheAppI18n(): RemoteCacheAppI18nState {
  const i18n = useI18n();
  const { preferred, language } = useRemoteCacheAppLocale();

  watchEffect(() => {
    i18n.locale.value = preferred.value;
  });

  const dir = computed<'ltr' | 'rtl'>(
    () => getRemoteCacheAppLocaleDefinition(preferred.value)?.dir ?? 'ltr',
  );

  return { language, dir };
}
