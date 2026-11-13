import { useI18n } from '#i18n';
import { computed, watchEffect, type ComputedRef } from 'vue';
import {
  getPactBrokerLocaleDefinition,
  type PactBrokerLocaleDefinition,
} from '../i18n/locale-registry';
import { usePactBrokerLocale } from './use-pact-broker-locale';

/**
 * Kết quả nối i18n với lựa chọn locale của app.
 */
export type PactBrokerI18nState = {
  /** BCP-47 cho `<html lang>` — khác `code` ở `zh-CN` (`zh-Hans`). */
  readonly language: ComputedRef<string>;
  /** Hướng chữ cho `<html dir>` và shell — thuộc tính của ngôn ngữ, xem `dir` của registry. */
  readonly dir: ComputedRef<PactBrokerLocaleDefinition['dir']>;
};

/**
 * Nối locale của app với `vue-i18n`.
 *
 * Gọi đúng một lần ở `app.vue`: đây là điểm **duy nhất** ghi `locale` của
 * composer. Trang chỉ đọc qua `useI18n()`, không tự set — nếu mỗi trang tự set
 * thì chúng tranh nhau quyền quyết định và trang set sau thắng, tức là quyết định
 * locale nằm ở thứ tự mount thay vì ở quy tắc đã chốt trong
 * `usePactBrokerLocale`.
 *
 * `watchEffect` chứ không phải set một lần: locale đổi được giữa phiên (đổi ở
 * language selector), và ngôn ngữ phải theo ngay.
 *
 * ⚠️ Composable này **không** gọi `useHead` cho `<html lang>`/`<html dir>`: app
 * gộp **toàn bộ** thuộc tính document vào **một** `useHead` ở `app.vue` — `lang`
 * và `dir` cùng là việc của app (class `dark` trên `<html>` thì script bootstrap
 * của shell đặt, unhead **không** quản lý nó), gộp vào cùng object thì kết quả
 * không phụ thuộc vào việc unhead có trộn `htmlAttrs` giữa hai lần gọi hay không.
 * Vì vậy composable trả `language` và `dir` về cho `app.vue` thay vì tự ghi head.
 *
 * ⚠️ `<html lang>` lấy `language` (BCP-47) chứ không lấy `code`. Ở `zh-CN` hai
 * cái khác nhau: `lang="zh-CN"` vẫn hợp lệ về cú pháp, nhưng screen reader và
 * công cụ dịch cần `zh-Hans` để hiểu đúng biến thể chữ Hán mà catalog viết.
 *
 * ⚠️ `dir` suy ra từ definition của locale đang dùng trong registry — cùng một
 * nguồn với `language`, đúng hợp đồng của issue #213: hướng văn bản là thuộc
 * tính của ngôn ngữ nội dung, không phải lựa chọn của người dùng.
 */
export function usePactBrokerI18n(): PactBrokerI18nState {
  const i18n = useI18n();
  const { preferred, language } = usePactBrokerLocale();

  watchEffect(() => {
    i18n.locale.value = preferred.value;
  });

  return {
    language,
    // Cùng hình dạng fallback với `language` ở `use-pact-broker-locale.ts`
    // (`?.dir ?? 'ltr'` cạnh `?.language ?? 'en'`): `preferred` đã được
    // validator thu hẹp thành `PactBrokerLocale`, và union locale suy ra từ
    // chính registry nên lệch registry/default là lỗi compile, không phải tình
    // huống runtime. Fallback ở đây chỉ để kiểu không dựa vào điều kiện không
    // xảy ra, không phải đường xử lý lỗi im lặng.
    dir: computed(() => getPactBrokerLocaleDefinition(preferred.value)?.dir ?? 'ltr'),
  };
}
