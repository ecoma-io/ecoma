/**
 * Registry locale của public surface `ecoma.io`.
 *
 * Đây là **single source of truth** cho locale: mọi metadata khác trong library
 * đều suy ra từ đây, không có chỗ nào khai báo lại danh sách locale.
 *
 * Dimension locale thuộc app này (`app/i18n`): không
 * biết mount, không biết application, không biết hostname. Registry cũng vậy —
 * nó chỉ mô tả một locale, không mô tả nơi locale đó được phục vụ.
 */

/**
 * Toàn bộ định danh locale — **dữ liệu duy nhất** khai báo danh sách locale
 * trong repository. `PublicLocale` suy ra trực tiếp từ mảng này: thêm/bớt một
 * entry tại đây làm thay đổi union kiểu, compiler phản ứng, và không chỗ nào
 * được phép khai báo lại danh sách locale.
 *
 * Mảng được khai báo **trước** mọi kiểu phụ thuộc vào nó để tránh vòng lặp
 * type (`satisfies PublicLocaleDefinition[]` ở chính câu này sẽ cần
 * `PublicLocale`, mà `PublicLocale` lại cần `typeof` mảng); kiểm tra shape
 * against `PublicLocaleDefinition` diễn ra ở khai báo `PUBLIC_LOCALES` bên dưới.
 *
 * Export nội bộ (không qua `src/index.ts`): test type-level cần chiếu
 * `typeof` vào đúng nguồn dữ liệu này; consumer bên ngoài chỉ thấy `PUBLIC_LOCALES`.
 */
export const PUBLIC_LOCALE_DEFINITIONS = [
  { code: 'en', hreflang: 'en' },
  { code: 'vi', hreflang: 'vi-VN' },
] as const;

/**
 * Một locale có thể đứng ở segment đầu tiên của public URL.
 *
 * Union **derive từ registry data** (`PUBLIC_LOCALE_DEFINITIONS`), không viết
 * tay: chỉ có một nơi khai báo danh sách locale thực tế, và union tự phản ứng
 * khi registry thay đổi — không chỗ nào âm thầm lệch khỏi dữ liệu.
 */
export type PublicLocale = (typeof PUBLIC_LOCALE_DEFINITIONS)[number]['code'];

/**
 * Metadata của một locale.
 *
 * `hreflang` là BCP-47 language tag (`vi-VN`), **không** phải locale code
 * (`vi`) — hai giá trị này khác nhau và hay bị nhầm khi sinh metadata.
 *
 * Mọi field là `readonly`: registry là policy, không phải mutable state.
 */
export type PublicLocaleDefinition = {
  readonly code: PublicLocale;
  readonly hreflang: string;
};

/**
 * Toàn bộ public locale, theo thứ tự khai báo.
 *
 * Frozen ở cả mảng và từng entry: consumer nhận về cùng một object mỗi lần gọi
 * và không thể sửa nó làm thay đổi kết quả của các lời gọi sau. Kiểu
 * `readonly PublicLocaleDefinition[]` kiểm tra compile-time shape của entry
 * (thiếu field, sai kiểu `hreflang`) — còn `code` vốn đã suy ra từ chính mảng
 * này, nên phần guarantee thật cho code union nằm ở test type pin trong
 * `locale-registry.spec.ts`.
 */
export const PUBLIC_LOCALES: readonly PublicLocaleDefinition[] = Object.freeze(
  PUBLIC_LOCALE_DEFINITIONS.map((definition) => Object.freeze(definition)),
);

/**
 * Tập code locale để tra cứu bằng **so khớp chính xác** trên string.
 *
 * Tra cứu exact-match là thứ giữ `/enabled` khỏi bị đọc thành locale `en`; và
 * lookup exact cũng là cách duy nhất sinh ra một `PublicLocale` mà không cần
 * `as PublicLocale` — không có đường nào bypass được runtime validation.
 */
const PUBLIC_LOCALE_CODES: ReadonlySet<string> = new Set(
  PUBLIC_LOCALES.map((definition) => definition.code),
);

/** Thu hẹp một string bất kỳ về `PublicLocale` khi nó khớp chính xác một locale trong registry. */
export function isPublicLocale(value: string): value is PublicLocale {
  return PUBLIC_LOCALE_CODES.has(value);
}

/**
 * Metadata của một locale, hoặc `undefined` khi locale không được hỗ trợ.
 *
 * Nhận `string` thay vì `PublicLocale` để consumer tra cứu được locale đến từ
 * nguồn chưa được kiểm chứng mà không phải cast — đây là ranh giới type-safe
 * duy nhất giữa "giá trị người dùng nhập" và "locale đã biết".
 *
 * Luôn trả về cùng một instance đã frozen cho một locale, nên so sánh bằng `===`
 * là hợp lệ và không thể bị mutate giữa hai lời gọi.
 */
export function getLocaleDefinition(locale: string): PublicLocaleDefinition | undefined {
  return PUBLIC_LOCALES.find((definition) => definition.code === locale);
}
