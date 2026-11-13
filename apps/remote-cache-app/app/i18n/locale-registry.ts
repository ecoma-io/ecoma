/**
 * Registry locale của `remote-cache-app` — **nguồn sự thật duy nhất** cho tập locale
 * của app này.
 *
 * `REMOTE_CACHE_APP_LOCALE_DEFINITIONS` là dữ liệu duy nhất khai danh sách locale;
 * `RemoteCacheAppLocale` suy ra từ chính mảng đó, nên thêm/bớt một locale làm
 * compiler phản ứng ở mọi chỗ phụ thuộc và **không có đường nào** khai lại
 * danh sách này ở nơi khác.
 *
 * Cấu trúc copy đúng pattern của `apps/backoffice/app/i18n/locale-registry.ts`
 * — các app dùng chung một convention, và lý do hai giá trị `code`/`language`
 * tách nhau nằm ở block ngay dưới.
 *
 * ⚠️ **`code` khác `language`.** `code` là mã locale app dùng nội bộ (khoá của
 * catalog, giá trị trong cookie). `language` là BCP-47 dành cho `<html lang>`
 * và `hreflang` — ở `zh-CN` hai giá trị **khác nhau**: `zh-CN` vẫn hợp lệ về
 * cú pháp, nhưng screen reader và công cụ dịch cần `zh-Hans` để hiểu đúng biến
 * thể chữ Hán giản thể mà catalog này viết. Trộn hai khái niệm là lỗi thường
 * gặp và không có dấu hiệu nào báo — `lang="zh-CN"` vẫn render bình thường.
 *
 * ⚠️ **`dir` là thuộc tính của ngôn ngữ, không phải lựa chọn người dùng** (issue
 * #213): chiều văn bản của `<html>` suy ra từ chính khai báo locale — ngôn ngữ
 * dùng hệ chữ RTL (`ar`, `he`, `fa`, `ur`…) khai `'rtl'`, còn lại `'ltr'`. Ba
 * locale hiện tại đều `'ltr'`. Đây là cùng nguồn với `<html lang>`, nên shell
 * không có đường nào đổi `dir` và app không có setting LTR/RTL nào.
 */
export const REMOTE_CACHE_APP_LOCALE_DEFINITIONS = [
  { code: 'en', language: 'en', dir: 'ltr', label: 'English' },
  { code: 'vi', language: 'vi', dir: 'ltr', label: 'Tiếng Việt' },
  // Nhãn cố ý là chữ Hán giản thể bất kể locale đang chọn: người dùng đang tìm
  // ngôn ngữ của mình trong danh sách này, nên mỗi mục tự hiển thị bằng chính
  // ngôn ngữ đó — dịch nhãn "简体中文" theo locale hiện tại làm nó khó nhận ra.
  { code: 'zh-CN', language: 'zh-Hans', dir: 'ltr', label: '简体中文' },
] as const;

/** Locale code hợp lệ — union **suy ra** từ registry, không viết tay. */
export type RemoteCacheAppLocale = (typeof REMOTE_CACHE_APP_LOCALE_DEFINITIONS)[number]['code'];

/** Metadata của một locale. Mọi field `readonly`: registry là policy, không phải state. */
export type RemoteCacheAppLocaleDefinition = {
  readonly code: RemoteCacheAppLocale;
  /** BCP-47 language tag cho `<html lang>`/`hreflang` — **khác** `code`. */
  readonly language: string;
  /**
   * Chiều văn bản của locale — cho `<html dir>` và prop `dir` của `AppShell`.
   * Kiểu trùng literal union `AppShellDirection` của `@ecoma-io/ui-app-shell`
   * nhưng khai độc lập: registry là data thuần của app, không import library
   * (file này được `nuxt.config.ts` đọc lúc build, trước cả khi alias có ý nghĩa).
   */
  readonly dir: 'ltr' | 'rtl';
  /** Nhãn hiển thị trong language selector. */
  readonly label: string;
};

/**
 * Locale mặc định khi chưa có lựa chọn nào.
 *
 * Đây là quy tắc sản phẩm, **không** suy ra từ `Accept-Language`: app quản trị
 * không dò ngôn ngữ trình duyệt (`detectBrowserLanguage: false` trong
 * `nuxt.config.ts`), nên không có lựa chọn nào thì app là tiếng Anh.
 */
export const DEFAULT_REMOTE_CACHE_APP_LOCALE: RemoteCacheAppLocale = 'en';

/** Toàn bộ locale, frozen ở cả mảng và từng entry. */
export const REMOTE_CACHE_APP_LOCALES: readonly RemoteCacheAppLocaleDefinition[] = Object.freeze(
  REMOTE_CACHE_APP_LOCALE_DEFINITIONS.map((definition) => Object.freeze(definition)),
);

/**
 * Tập code để tra cứu exact-match.
 *
 * Exact-match là ranh giới duy nhất giữa "giá trị đến từ nguồn chưa kiểm chứng"
 * (cookie, giá trị gõ tay) và "locale đã biết".
 */
const REMOTE_CACHE_APP_LOCALE_CODES: ReadonlySet<string> = new Set(
  REMOTE_CACHE_APP_LOCALES.map((definition) => definition.code),
);

/**
 * Thu hẹp một string bất kỳ về `RemoteCacheAppLocale` khi khớp chính xác một locale.
 *
 * Nhận `string` chứ không phải `RemoteCacheAppLocale` là cố ý: nó buộc call-site
 * phải thu hẹp trước khi dùng, thay vì cast và tin.
 */
export function isRemoteCacheAppLocale(value: string): value is RemoteCacheAppLocale {
  return REMOTE_CACHE_APP_LOCALE_CODES.has(value);
}

/** Metadata của một locale, hoặc `undefined` khi không được hỗ trợ. */
export function getRemoteCacheAppLocaleDefinition(
  locale: string,
): RemoteCacheAppLocaleDefinition | undefined {
  return REMOTE_CACHE_APP_LOCALES.find((definition) => definition.code === locale);
}

/**
 * Thu hẹp giá trị đến từ nguồn không kiểm chứng, **không** im lặng thay bằng
 * locale khác.
 *
 * Trả `undefined` khi giá trị không hợp lệ — call-site quyết định làm gì với nó
 * (hiện lỗi, dùng default). Trả `DEFAULT_REMOTE_CACHE_APP_LOCALE` ở đây sẽ biến
 * "giá trị lạ" thành "người dùng đang dùng tiếng Anh", xoá mất dấu vết của một
 * lỗi — đúng thứ không nên xảy ra.
 */
export function parseRemoteCacheAppLocale(value: unknown): RemoteCacheAppLocale | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return isRemoteCacheAppLocale(value) ? value : undefined;
}
