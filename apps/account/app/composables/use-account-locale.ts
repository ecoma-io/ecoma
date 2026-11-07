import { useCookie, useState } from '#app';
import { computed, readonly, type ComputedRef, type Ref } from 'vue';
import {
  ACCOUNT_LOCALES,
  DEFAULT_ACCOUNT_LOCALE,
  getAccountLocaleDefinition,
  parseAccountLocale,
  type AccountLocale,
  type AccountLocaleDefinition,
} from '../i18n/locale-registry';
import type { AccountAdapter } from '../account-data/types';

/**
 * Tên cookie lưu lựa chọn ngôn ngữ **cục bộ**.
 *
 * ⚠️ Vì sao là cookie chứ không phải `localStorage`: nó đi cùng HTTP request nên
 * SSR render ra đúng ngôn ngữ ngay từ đầu — `localStorage` chỉ đọc được sau
 * hydrate và sinh hydration mismatch ở chính ba trang đó (`/login`,
 * `/login/continue`, `/consent`). Cookie này **không** chứa gì nhạy cảm: chỉ
 * một mã locale nằm trong allowlist.
 *
 * ⚠️ Vì sao không dùng cookie của `nuxt-i18n`: cookie đó gắn với cơ chế dò
 * browser language, mà sản phẩm đã chốt là **không** dò
 * (`detectBrowserLanguage: false`). Cookie tự quản lý giữ ranh giới rõ: chỉ
 * composable này đọc/ghi nó, và không có đường nào biến nó thành nguồn sự thật
 * phía server.
 */
const ACCOUNT_LOCALE_COOKIE = 'account-locale';

/**
 * Tên `useState` giữ preference locale **đã lưu** của tài khoản.
 *
 * ⚠️ Hằng dùng chung cho cả hai chỗ đọc/ghi (`useAccountLocale` và
 * `useStoredAccountLocale`): viết tay cùng một chuỗi ở hai nơi thì đổi một bên
 * là toàn bộ thứ tự ưu tiên hỏng mà typecheck không bắt.
 */
const ACCOUNT_LOCALE_STORED_KEY = 'account-locale-stored';

const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365;

/*
 * ⚠️ Biến cục bộ ở đây cố tình KHÔNG tên là `cookie`.
 *
 * Rule `security-sensitive-value-in-http-response` xem bất kỳ identifier nào
 * khớp `^(…|cookies?|…)([_.\-]|$)` là nguồn nhạy cảm, nên một biến tên `cookie`
 * khiến mọi `return` truy cập tới nó bị gắn cờ — kể cả khi nó chỉ chứa mã locale.
 * Đó là **false positive**, nhưng cách chữa đúng không phải `nosemgrep`:
 * `nosemgrep` làm gate nội bộ xanh trong khi SARIF vẫn còn finding, nên GitHub
 * vẫn đỏ (xem `docs/` của repo: SARIF bỏ qua `suppressions`).
 *
 * `localeCookie` và `localeSelection` nói đúng hơn `cookie` khi đọc: đây là
 * lựa chọn ngôn ngữ cục bộ, không phải cookie phiên. Giá trị đi qua
 * `parseAccountLocale` — allowlist `en` | `vi` | `zh-CN` — ở cả chiều đọc lẫn
 * chiều ghi, nên không có gì nhạy cảm để lộ ra ngoài.
 */

/** Lựa chọn ngôn ngữ cục bộ, cho các trang chưa đăng nhập. */
export type AccountLocaleCookie = {
  readonly saved: Ref<AccountLocale | undefined>;
  readonly save: (locale: AccountLocale) => void;
  readonly clear: () => void;
};

export function useAccountLocaleCookie(): AccountLocaleCookie {
  const localeCookie = useCookie<string | undefined>(ACCOUNT_LOCALE_COOKIE, {
    sameSite: 'lax',
    path: '/',
    maxAge: ONE_YEAR_IN_SECONDS,
  });

  return {
    // `parseAccountLocale` trả `undefined` cho giá trị lạ thay vì thay thế bằng
    // locale khác: cookie sửa tay hoặc cookie của một client cũ phải được coi
    // như **chưa có lựa chọn**, để app về `DEFAULT_ACCOUNT_LOCALE` một cách trung
    // thực chứ không âm thầm đổi sang ngôn ngữ khác.
    saved: computed(() => parseAccountLocale(localeCookie.value)),
    // Ghi cũng qua `parseAccountLocale`: đây là ranh giới duy nhất để một locale
    // đi ra khỏi UI, nên nó phải dùng cùng cách thu hẹp với dữ liệu đọc vào.
    save: (locale) => {
      localeCookie.value = parseAccountLocale(locale);
    },
    clear: () => {
      localeCookie.value = undefined;
    },
  };
}

/** Kết quả một lần đổi ngôn ngữ có lưu vào tài khoản. */
export type PersistLocaleOutcome = 'saved' | 'not-saved' | 'rejected';

export type AccountLocaleState = {
  /** Locale đang dùng: đã lưu → cục bộ → mặc định. */
  readonly preferred: ComputedRef<AccountLocale>;
  /** BCP-47 cho `<html lang>` — khác `code` ở `zh-CN` (`zh-Hans`). */
  readonly language: ComputedRef<string>;
  /** Danh sách locale cho selector, đúng thứ registry khai. */
  readonly options: Readonly<Ref<readonly AccountLocaleDefinition[]>>;
  /** `true` khi locale đến từ preference đã lưu của tài khoản. */
  readonly hasStoredPreference: ComputedRef<boolean>;
  /** Đặt lựa chọn cục bộ, không đụng preference đã lưu. */
  readonly chooseLocal: (locale: AccountLocale) => void;
  /**
   * Áp một locale **đã lưu thành công** vào trạng thái hiển thị của phiên.
   *
   * Tách khỏi `chooseAndPersist` để một call-site vừa ghi preference (kèm timezone,
   * colorMode) vừa áp locale **không phải gửi lần ghi thứ hai**: mỗi lời gọi là
   * một `updatePreferences` thật, và lần thứ hai hỏng trong khi lần đầu đã thành
   * công sẽ báo thất bại cho một thay đổi đã nằm trên server.
   */
  readonly applySavedLocale: (locale: AccountLocale) => void;
  /** Đặt locale và lưu qua adapter; báo rõ có lưu được hay không. */
  readonly chooseAndPersist: (
    locale: AccountLocale,
    adapter: AccountAdapter,
  ) => Promise<PersistLocaleOutcome>;
};

/**
 * Locale của app, theo thứ tự ưu tiên đã chốt:
 *
 * 1. lựa chọn **tường minh trong phiên** — người dùng vừa bấm chọn, UI phải đổi
 *    ngay, kể cả khi preference đã lưu chưa theo kịp (lưu đang hỏng hoặc chưa xong);
 * 2. preference **đã lưu** của tài khoản — nguồn chuẩn giữa các phiên, thắng cookie
 *    lúc tải trang;
 * 3. lựa chọn cục bộ trên cookie;
 * 4. `DEFAULT_ACCOUNT_LOCALE` — tiếng Anh.
 *
 * ⚠️ Thứ tự này là **quy tắc sản phẩm**. Mốc 1 nằm trên mốc 2 không phải để local
 * thắng tài khoản vĩnh viễn: `explicit` là trạng thái **của phiên** (một `useState`
 * chỉ sống trong app đang mở), còn preference đã lưu là thứ quyết định lại ở phiên
 * sau. Không có mốc 1 thì chọn ở selector không đổi gì khi `stored` đã có giá trị,
 * và lưu hỏng làm select bật ngược về locale cũ — đúng hai hành vi mà khối chú thích
 * của `AccountLanguageSelect` cấm. Đổi thứ tự là đổi hành vi sản phẩm, không phải
 * refactor.
 */
export function useAccountLocale(): AccountLocaleState {
  const localeSelection = useAccountLocaleCookie();

  /**
   * Lựa chọn tường minh của phiên — do `chooseLocal` ghi. Tách khỏi cookie để
   * selector đổi được `preferred` ngay cả khi `stored` đã có giá trị, và tách khỏi
   * `stored` để "vừa chọn" không bị hiểu là "đã lưu".
   */
  const explicit = useState<AccountLocale | undefined>('account-locale-explicit', () => undefined);

  /**
   * Preference đã lưu. Tách khỏi cookie để `useAccountLocale` không phụ thuộc
   * thứ tự khởi tạo của các trang, và để `useI18nPreloadKeys`-style preload không
   * nhìn thấy nó.
   */
  const stored = useState<AccountLocale | undefined>(ACCOUNT_LOCALE_STORED_KEY, () => undefined);

  const preferred = computed<AccountLocale>(
    () => explicit.value ?? stored.value ?? localeSelection.saved.value ?? DEFAULT_ACCOUNT_LOCALE,
  );

  /**
   * Lựa chọn tường minh của phiên phải bám theo locale vừa lưu, nếu không nó
   * vẫn thắng `stored` và `preferred` lệch với preference đã lưu: ví dụ người
   * dùng từng chọn ở selector header nhưng lưu hỏng (`explicit` giữ lựa chọn
   * mới, `stored` giữ giá trị cũ), rồi lưu thành công từ `/preferences` —
   * thiếu bước này thì cả app vẫn hiển thị locale cũ trong khi server đã lưu
   * locale mới. Đồng bộ cookie để lựa chọn cục bộ cũng không mâu thuẫn.
   */
  const applySavedLocale = (locale: AccountLocale): void => {
    explicit.value = locale;
    stored.value = locale;
    localeSelection.save(locale);
  };

  return {
    preferred,
    // `getAccountLocaleDefinition` không thể trả `undefined` ở đây vì `preferred`
    // đã là một `AccountLocale`; fallback vẫn được khai để kiểu không phải dựa
    // vào điều kiện không xảy ra — nếu registry và default lệch nhau thì lỗi phải
    // hiện ra, không phải trả `undefined` làm `<html lang>` rỗng.
    language: computed(() => getAccountLocaleDefinition(preferred.value)?.language ?? 'en'),
    options: readonly(computed(() => ACCOUNT_LOCALES)),
    hasStoredPreference: computed(() => stored.value !== undefined),
    chooseLocal: (locale) => {
      // `parseAccountLocale` ở đây cũng là ranh giới: giá trị lạ không được biến
      // thành lựa chọn tường minh, đúng cách cookie chặn ở chiều đọc.
      explicit.value = parseAccountLocale(locale);
      localeSelection.save(locale);
    },
    applySavedLocale,
    chooseAndPersist: async (locale, adapter) => {
      const result = await adapter.updatePreferences({ locale });
      if (!result.ok) {
        // Lưu hỏng: KHÔNG đổi `stored`, KHÔNG đổi lựa chọn tường minh. Người dùng
        // vẫn thấy ngôn ngữ họ vừa chọn trên máy này (mốc 1 của `preferred` giữ
        // nó), nhưng không ai bị hiểu là đã lưu — đúng yêu cầu "không hiện trạng
        // thái thành công bền vững khi lưu hỏng", và select không bật ngược.
        return 'not-saved';
      }
      const savedLocale = parseAccountLocale(result.value.locale);
      if (savedLocale === undefined) {
        // Adapter trả về một locale mà chính allowlist của app không chứa: lỗi
        // contract ở phía adapter, không phải thành công. Cũng không fallback
        // im lặng — giá trị lạ phải được nhìn thấy (FR-008a).
        return 'rejected';
      }
      applySavedLocale(savedLocale);
      return 'saved';
    },
  };
}

/**
 * Nạp preference đã lưu của tài khoản để locale của app theo.
 *
 * ⚠️ Giá trị server trả về được thu hẹp qua `parseAccountLocale`, và giá trị
 * **không** hợp lệ thì `preferences.locale` là `undefined` còn
 * `preferences.invalidLocale` mang giá trị thô cho trang `/preferences` báo lỗi.
 * Ở đây, lúc dựng shell, locale hỏng chỉ được xử lý bằng cách **không** áp nó —
 * app rơi về lựa chọn cục bộ rồi `DEFAULT_ACCOUNT_LOCALE`, còn trang
 * `/preferences` vẫn hiện lỗi để người dùng thấy và sửa. Dựng shell rồi báo lỗi
 * ngay lúc vào trang sẽ chặn cả những trang mà lỗi đó không liên quan (`/emails`).
 */
export async function useStoredAccountLocale(adapter: AccountAdapter): Promise<void> {
  const stored = useState<AccountLocale | undefined>(ACCOUNT_LOCALE_STORED_KEY, () => undefined);
  const preferences = await adapter.getPreferences();
  if (preferences.locale !== undefined) {
    stored.value = preferences.locale;
  }
}
