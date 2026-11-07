import { computed, type Ref } from 'vue';
import { useNuxtApp, useState, type NuxtApp } from '#app';
import { useAccountAdapter } from './use-account-adapter';
import { useAccountLocale } from './use-account-locale';
import { isValidTimeZone } from '../utils/is-valid-time-zone';
import { getAccountLocaleDefinition, type AccountLocale } from '../i18n/locale-registry';
import type { AccountPreferences } from '../account-data/types';

type PreferencesNuxtApp = NuxtApp & {
  /**
   * Promise đang nạp, dùng chung cho mọi trang.
   *
   * ⚠️ Nằm trên `nuxtApp`, **không** phải trong `useState`: `useState` ghi vào
   * `payload.state` và payload được serialize để hydrate client, nên một promise đi
   * qua đó thành `{}` ở client — `await` trên nó cho ra ngay lập tức và "chờ cùng một
   * lần nạp" im lặng thành vô nghĩa.
   */
  $accountPreferencesLoad?: Promise<AccountPreferences>;
};

/**
 * Locale định dạng + timezone định dạng, theo **preference của tài khoản**.
 *
 * Ba thứ trả về đều là `Ref` **lưu trữ trong adapter** chứ không phải biến của
 * trang: format ngày giờ xuất hiện ở `/sessions`, `/applications`, `/security` và
 * `/privacy`, và chúng phải dùng **cùng** một timezone. Nếu mỗi trang tự `await`
 * preference trong setup thì một trang nạp trước, một trang nạp sau, và người vừa
 * đổi timezone sẽ thấy màn hình nửa cũ nửa mới.
 *
 * Vì vậy một promise dùng chung: trang sau đợi chính promise đó thay vì đọc adapter
 * lần nữa. `reload()` tồn tại cho đúng một việc: `/preferences` vừa ghi timezone mới
 * thì cần đọc lại ngay.
 */
export function useAccountPreferences(): {
  readonly preferences: Ref<AccountPreferences | undefined>;
  readonly load: () => Promise<AccountPreferences>;
  readonly reload: () => Promise<AccountPreferences>;
} {
  /**
   * `useState` **trong** composable, không phải ở phạm vi module.
   *
   * ⚠️ Ở phạm vi module là một lỗi SSR thật, không phải lỗi hình thức: `useState` đọc
   * `nuxtApp` của request **đang chạy**, nên một lời gọi ở top-level sẽ khóa vào
   * `nuxtApp` của request đầu tiên. Từ request thứ hai trở đi, mọi người đọc preference
   * của người đầu tiên — rò dữ liệu chéo session ngay trên server. Gọi bên trong hàm thì
   * mỗi lần gọi lấy đúng `nuxtApp` của request đó, và scope theo request vẫn giữ nguyên.
   *
   * ⚠️ `useState` chứ không phải biến module: preference mang session của người đang
   * đăng nhập. Nó là **dữ liệu thuần** nên serialize qua payload hydrate được, khác
   * `AccountAdapter` bên cạnh — adapter không phải dữ liệu để vận chuyển.
   */
  const preferences = useState<AccountPreferences | undefined>(
    'account-preferences',
    () => undefined,
  );

  const nuxtApp = useNuxtApp() as PreferencesNuxtApp;
  // ⚠️ Resolve trong **setup**, không bên trong `load()`: `reload()` được gọi từ
  // handler sau `await` (`/preferences` vừa lưu xong), và ngoài ngữ cảnh setup
  // `useNuxtApp()` ném `[nuxt] instance unavailable` — khi đó cả luồng lưu chết
  // dù chính trang đã ghi xong. Ở server thì adapter vẫn phải tạo mới mỗi request,
  // đúng nghĩa của việc resolve nó trong thân composable.
  const adapter = useAccountAdapter();

  async function load(): Promise<AccountPreferences> {
    nuxtApp.$accountPreferencesLoad ??= adapter.getPreferences();
    const pending = nuxtApp.$accountPreferencesLoad;
    try {
      return await pending;
    } finally {
      // Xoá promise sau khi xong để `reload()` nạp lại được. Giữ lại sẽ biến reload
      // thành no-op vĩnh viễn. So sánh định danh trước khi xoá: giữa lúc nạp và lúc
      // xong, một `reload()` song song có thể đã gắn promise khác vào.
      if (nuxtApp.$accountPreferencesLoad === pending) {
        nuxtApp.$accountPreferencesLoad = undefined;
      }
    }
  }

  return {
    preferences,
    load: async () => {
      // `??=` hẹp kiểu: sau dòng này `preferences.value` là `AccountPreferences`,
      // nên không cần ép kiểu ở return.
      preferences.value ??= await load();
      return preferences.value;
    },
    reload: async () => {
      const fresh = await load();
      preferences.value = fresh;
      return fresh;
    },
  };
}

/**
 * Định dạng theo locale **đang hiển thị** + timezone của tài khoản, an toàn khi
 * preference **chưa** có.
 *
 * Locale đến từ `useAccountLocale().preferred` — nguồn duy nhất của chữ đang
 * hiện (explicit → stored → cookie → default) — chứ không phải
 * `preferences.locale`: đổi ngôn ngữ ở selector header phải làm ngày giờ/số
 * đổi theo ngay, và các trang chưa nạp preference vẫn định dạng đúng ngôn ngữ
 * người dùng đang thấy. `preferred` có mặt ở SSR lẫn hydrate (đi qua allowlist
 * ở mọi nhánh) nên dùng nó không tạo mismatch.
 *
 * ⚠️ Locale hỏng từ server không dùng làm locale định dạng: nó đi qua
 * `parseAccountLocale` và thành `undefined`, rồi rơi về default ở chính
 * `preferred` — cùng cách xử lý trong `useAccountLocale`, và cùng lý do: giá trị
 * lạ phải được nhìn thấy ở `/preferences` chứ không được âm thầm thành một
 * locale khác.
 */
export function useAccountFormat(): {
  readonly formatDateTime: (isoString: string) => string;
  readonly formatCount: (count: number) => string;
} {
  const { preferences: saved } = useAccountPreferences();
  const { preferred } = useAccountLocale();

  const locale = computed<string>(() => preferred.value);
  // `Intl` ném `RangeError` với timezone không có trong tz database, và một giá trị
  // hỏng từ server không được phép làm hỏng cả trang. UTC là fallback trung thực: nó là
  // một timezone có thật, khác với "hiển thị bằng locale của máy". Cùng hàm với
  // `/preferences` — xem `isValidTimeZone`.
  const timeZone = computed<string>(() => {
    const candidate = saved.value?.timezone;
    return candidate !== undefined && isValidTimeZone(candidate) ? candidate : 'UTC';
  });

  return {
    formatDateTime: (isoString) => formatDateTime(isoString, locale.value, timeZone.value),
    formatCount: (count) => new Intl.NumberFormat(locale.value).format(count),
  };
}

/** Tên hiển thị của một locale — dùng cho `<html lang>` và danh sách chọn. */
export function accountLocaleLanguage(locale: AccountLocale): string {
  return getAccountLocaleDefinition(locale)?.language ?? 'en';
}

/**
 * Format một ISO string theo locale + timezone đã lưu.
 *
 * Tách thành hàm thuần để test được không cần dựng Vue: kết quả của nó là thứ bị
 * hydration so khớp giữa SSR và client, nên nó phải là hàm thuần của `(isoString,
 * locale, timeZone)` — không đọc được gì từ ngoài.
 */
function formatDateTime(isoString: string, locale: string, timeZone: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return isoString;
  }
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(date);
}
