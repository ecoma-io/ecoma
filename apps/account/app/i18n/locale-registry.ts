/**
 * Registry locale của `account` — **nguồn sự thật duy nhất** cho tập locale của
 * app này.
 *
 * `ACCOUNT_LOCALE_DEFINITIONS` là dữ liệu duy nhất khai danh sách locale;
 * `AccountLocale` suy ra từ chính mảng đó (không viết tay union), nên thêm/bớt
 * một locale làm compiler phản ứng ở mọi chỗ phụ thuộc, và **không có đường
 * nào** khai lại danh sách này ở nơi khác.
 *
 * ⚠️ **`code` khác `language`.** `code` là giá trị hợp lệ của
 * `user_preferences.locale` trong `db-account` (`en` | `vi` | `zh-CN`, xem
 * `docs/applications/account/01-architecture.md` §3.3). `language` là BCP-47 dùng
 * cho `<html lang>` và `hreflang` (`zh-Hans`, không phải `zh-CN`). Trộn hai
 * giá trị này là lỗi thường gặp: `zh-CN` ở `lang` vẫn hợp lệ nhưng `hreflang`
 * cần `zh-Hans` để crawler hiểu đúng biến thể chữ Hán.
 *
 * ⚠️ **Danh sách này RỘNG HƠN contract hiện tại ở server.** `01-architecture.md`
 * §3.3 và FR-008a mới chỉ cho `en` | `vi`. Việc align phía server (typed
 * contract + validation + default `en`) là **handoff của PR UI này**, không
 * thực hiện ở đây: đó là schema `db-account`, thuộc Account Foundation.
 */
export const ACCOUNT_LOCALE_DEFINITIONS = [
  { code: 'en', language: 'en', label: 'English' },
  { code: 'vi', language: 'vi', label: 'Tiếng Việt' },
  // Nhãn cố ý là chữ Hán giản thể bất kể locale đang chọn: người dùng đang tìm
  // ngôn ngữ của mình trong danh sách này, nên mỗi mục tự hiển thị bằng chính
  // ngôn ngữ đó — dịch nhãn "简体中文" theo locale hiện tại khiến nó khó nhận ra.
  { code: 'zh-CN', language: 'zh-Hans', label: '简体中文' },
] as const;

/** Locale code hợp lệ — union **suy ra** từ registry, không viết tay. */
export type AccountLocale = (typeof ACCOUNT_LOCALE_DEFINITIONS)[number]['code'];

/** Metadata của một locale. Mọi field `readonly`: registry là policy, không phải state. */
export type AccountLocaleDefinition = {
  readonly code: AccountLocale;
  /** BCP-47 language tag cho `<html lang>`/`hreflang` — **khác** `code`. */
  readonly language: string;
  /** Nhãn hiển thị trong language selector. */
  readonly label: string;
};

/**
 * Locale mặc định khi không có preference đã lưu và không có lựa chọn tường minh.
 *
 * Đây là yêu cầu sản phẩm, không phải suy luận từ `Accept-Language`: browser
 * language detection **không** được ghi đè giá trị này (vì vậy
 * `detectBrowserLanguage: false` trong `nuxt.config.ts`).
 */
export const DEFAULT_ACCOUNT_LOCALE: AccountLocale = 'en';

/** Toàn bộ locale, frozen ở cả mảng và từng entry. */
export const ACCOUNT_LOCALES: readonly AccountLocaleDefinition[] = Object.freeze(
  ACCOUNT_LOCALE_DEFINITIONS.map((definition) => Object.freeze(definition)),
);

/**
 * Tập code để tra cứu exact-match.
 *
 * Exact-match là thứ giữ `/email` khỏi bị đọc thành locale `en`, và cũng là cách
 * duy nhất sinh ra một `AccountLocale` mà không cần `as` — không có đường nào
 * bypass được validation runtime, kể cả giá trị đến từ response của server.
 */
const ACCOUNT_LOCALE_CODES: ReadonlySet<string> = new Set(
  ACCOUNT_LOCALES.map((definition) => definition.code),
);

/**
 * Thu hẹp một string bất kỳ về `AccountLocale` khi nó khớp chính xác một locale.
 *
 * Đây là **ranh giới duy nhất** giữa "giá trị đến từ nguồn chưa kiểm chứng"
 * (response của BFF, cookie, lựa chọn của người dùng) và "locale đã biết". Nhận
 * `string` chứ không phải `AccountLocale` là cố ý: nó buộc call-site phải thu
 * hẹp trước khi dùng, thay vì cast và tin.
 */
export function isAccountLocale(value: string): value is AccountLocale {
  return ACCOUNT_LOCALE_CODES.has(value);
}

/** Metadata của một locale, hoặc `undefined` khi không được hỗ trợ. */
export function getAccountLocaleDefinition(locale: string): AccountLocaleDefinition | undefined {
  return ACCOUNT_LOCALES.find((definition) => definition.code === locale);
}

/**
 * Thu hẹp giá trị đến từ server, **không** im lặng thay bằng locale khác.
 *
 * Trả `undefined` khi giá trị không hợp lệ — call-site phải quyết định làm gì
 * với nó (hiện lỗi, dùng default, hay từ chối lưu). Trả `DEFAULT_ACCOUNT_LOCALE`
 * ở đây sẽ biến "server trả giá trị lạ" thành "người dùng đang dùng tiếng Anh",
 * xoá mất dấu vết của một lỗi contract — đúng thứ FR-008a cấm phía server.
 */
export function parseAccountLocale(value: unknown): AccountLocale | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return isAccountLocale(value) ? value : undefined;
}
