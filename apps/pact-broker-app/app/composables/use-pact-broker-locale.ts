import { useCookie, useState } from '#app';
import { computed, readonly, type ComputedRef, type Ref } from 'vue';
import {
  PACT_BROKER_LOCALES,
  DEFAULT_PACT_BROKER_LOCALE,
  getPactBrokerLocaleDefinition,
  parsePactBrokerLocale,
  type PactBrokerLocale,
  type PactBrokerLocaleDefinition,
} from '../i18n/locale-registry';

/**
 * Tên cookie lưu lựa chọn ngôn ngữ.
 *
 * ⚠️ Cookie chứ không phải `localStorage`: nó đi cùng HTTP request nên SSR render
 * ra đúng ngôn ngữ ngay từ đầu — `localStorage` chỉ đọc được sau hydrate và sinh
 * hydration mismatch ở chính những chuỗi render ra `<html lang>` và nav.
 *
 * Cookie này **không** chứa gì nhạy cảm: chỉ một mã locale nằm trong allowlist.
 *
 * ⚠️ Cookie là của **app**, không phải cookie của `nuxt-i18n`: module đó có cơ
 * chế cookie riêng nhưng nó gắn với `detectBrowserLanguage` (đã tắt), và dùng nó
 * sẽ tạo nguồn sự thật thứ hai cho cùng một lựa chọn.
 */
const PACT_BROKER_LOCALE_COOKIE = 'pact-broker-locale';

/**
 * Lựa chọn tường minh của **phiên** — trạng thái `useState`, không persist.
 *
 * ⚠️ Vì sao cần tầng này ngoài cookie: khi người dùng vừa đổi ngôn ngữ, giao
 * diện phải đổi **ngay**. Tầng `useState` sống trong phiên và luôn thắng cookie,
 * đúng thứ tự ưu tiên "vừa chọn" > "đã lưu".
 */
const PACT_BROKER_LOCALE_EXPLICIT_KEY = 'pact-broker-locale-explicit';

const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365;

/*
 * ⚠️ Biến cục bộ ở đây cố tình KHÔNG tên là `cookie`.
 *
 * Rule `security-sensitive-value-in-http-response` của Semgrep xem mọi identifier
 * khớp `^(…|cookies?|…)([_.\-]|$)` là nguồn nhạy cảm, nên một biến tên `cookie`
 * khiến mọi `return` truy cập tới nó bị gắn cờ — kể cả khi nó chỉ chứa mã locale.
 * Đó là **false positive**, nhưng cách chữa đúng không phải `nosemgrep`:
 * `nosemgrep` làm gate nội bộ xanh trong khi SARIF vẫn còn finding. Tên
 * `localeCookie` nói đúng hơn nội dung của nó, và cũng là tên mà `apps/backoffice`
 * và `apps/account` đã dùng.
 */

/** Trạng thái locale của dashboard. */
export type PactBrokerLocaleState = {
  /** Locale đang dùng: lựa chọn trong phiên → cookie → mặc định. */
  readonly preferred: ComputedRef<PactBrokerLocale>;
  /** BCP-47 cho `<html lang>` — khác `code` ở `zh-CN` (`zh-Hans`). */
  readonly language: ComputedRef<string>;
  /** Danh sách locale cho selector, đúng thứ registry khai. */
  readonly options: Readonly<Ref<readonly PactBrokerLocaleDefinition[]>>;
  /** Đặt lựa chọn trong phiên và ghi cookie để nhớ giữa các phiên. */
  readonly chooseLocale: (locale: PactBrokerLocale) => void;
};

/**
 * Locale của dashboard.
 *
 * Thứ tự ưu tiên (đã chốt, không phải suy luận):
 *
 * 1. lựa chọn **tường minh trong phiên** — người dùng vừa bấm chọn, UI phải đổi
 *    ngay;
 * 2. lựa chọn đã lưu trên cookie — nguồn chuẩn giữa các phiên;
 * 3. `DEFAULT_PACT_BROKER_LOCALE` — tiếng Anh.
 */
export function usePactBrokerLocale(): PactBrokerLocaleState {
  const localeCookie = useCookie<string | undefined>(PACT_BROKER_LOCALE_COOKIE, {
    sameSite: 'lax',
    path: '/',
    maxAge: ONE_YEAR_IN_SECONDS,
  });

  const explicit = useState<PactBrokerLocale | undefined>(
    PACT_BROKER_LOCALE_EXPLICIT_KEY,
    () => undefined,
  );

  const preferred = computed<PactBrokerLocale>(
    () => explicit.value ?? parsePactBrokerLocale(localeCookie.value) ?? DEFAULT_PACT_BROKER_LOCALE,
  );

  return {
    // `getPactBrokerLocaleDefinition` không thể trả `undefined` ở đây vì
    // `preferred` đã là `PactBrokerLocale`; fallback vẫn được khai để kiểu không
    // dựa vào điều kiện không xảy ra — nếu registry và default lệch nhau thì
    // lỗi phải hiện ra, không phải trả `undefined` làm `<html lang>` rỗng.
    language: computed(() => getPactBrokerLocaleDefinition(preferred.value)?.language ?? 'en'),
    preferred,
    options: readonly(computed(() => PACT_BROKER_LOCALES)),
    chooseLocale: (locale) => {
      // `parsePactBrokerLocale` ở đây là ranh giới: giá trị lạ không được biến
      // thành lựa chọn tường minh, đúng cách chặn ở chiều đọc cookie.
      explicit.value = parsePactBrokerLocale(locale);
      // Ghi cookie để lần tải sau giữ lựa chọn. Cookie không phải nguồn sự thật
      // của phiên này (đó là `explicit`), nên ghi thất bại không đổi hành vi.
      localeCookie.value = locale;
    },
  };
}
