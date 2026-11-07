/**
 * Locale availability của một resource — input cấp app, resolve thành
 * `PublicLocaleContext` cho locale switcher của `app/layout`.
 *
 * Library không tự suy ra availability từ content, filesystem hay application:
 * app báo resource hiện tại thực sự có những locale nào, thư viện chỉ resolve
 * và tiêu thụ. Danh sách locale thật vẫn thuộc `app/i18n` — entry không
 * khớp registry bị so khớp exact rồi loại, không throw, không mở rộng locale
 * union và không bao giờ sinh link tới locale ngoài registry.
 */

import { PUBLIC_LOCALES, isPublicLocale, type PublicLocale } from '../../i18n/index';

/**
 * Context locale đã resolve cho một resource.
 *
 * Invariant: `current` luôn nằm trong `availableLocales` — kể cả khi app
 * không liệt kê locale hiện tại (hoặc truyền availability rỗng), locale
 * switcher vẫn luôn render được locale mà người dùng đang xem.
 * (`current: PublicLocale` theo type luôn thuộc registry — guarantee ở mức
 * compile time, không cần repair ở runtime.)
 */
export type PublicLocaleContext = {
  /** Locale của pathname hiện tại. */
  readonly current: PublicLocale;
  /** Các locale thực sự tồn tại cho resource, theo thứ tự registry — luôn chứa `current`. */
  readonly availableLocales: readonly PublicLocale[];
};

/**
 * Resolve availability của một resource thành `PublicLocaleContext`.
 *
 * - Không truyền `availableLocales` → toàn bộ registry của `app/i18n`
 *   (behavior mặc định, không giới hạn availability — giữ nguyên switcher
 *   trước đây);
 * - Truyền → so khớp exact qua `isPublicLocale` (kế thừa contract của
 *   `app/i18n`: giá trị ngoài registry bị loại, không throw), khử trùng
 *   lặp, rồi luôn cộng thêm `current` để locale hiện tại hợp lệ trong context;
 * - Kết quả theo thứ tự khai báo của `PUBLIC_LOCALES` (không phụ thuộc thứ tự
 *   input), frozen — không thể mutate giữa hai lời gọi.
 */
export function resolveLocaleContext(
  current: PublicLocale,
  availableLocales?: readonly PublicLocale[],
): PublicLocaleContext {
  const allowed: Set<PublicLocale> = new Set<PublicLocale>(
    availableLocales === undefined
      ? PUBLIC_LOCALES.map((definition) => definition.code)
      : availableLocales.filter((code) => isPublicLocale(code)),
  );
  // `current` luôn thuộc context — kể cả availability rỗng hay không liệt kê.
  allowed.add(current);
  const resolved: PublicLocale[] = PUBLIC_LOCALES.filter((definition) =>
    allowed.has(definition.code),
  ).map((definition) => definition.code);
  return Object.freeze({
    current,
    availableLocales: Object.freeze(resolved),
  });
}
