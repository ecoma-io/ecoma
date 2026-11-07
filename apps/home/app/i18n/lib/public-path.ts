/**
 * Kiểu kết quả chung cho mọi phép đọc/đổi public pathname, cùng các helper
 * kiểm tra cấu trúc dùng chung.
 *
 * Library **không normalize input**: không lowercase, không thêm/bớt slash,
 * không decode/re-encode, không repair. Input không hợp lệ trả về
 * `{ kind: 'invalid', reason }` — expected invalid input không bao giờ throw.
 */

import type { PublicLocale } from './locale-registry';

/**
 * Lý do một pathname bị từ chối.
 *
 * Tập lý do cố định và nhỏ: mỗi lý do ứng với một action khác nhau phía caller
 * (redirect policy, 400, decide…). Không thêm lý do mới mà không có action
 * riêng cho nó.
 *
 * - `not_a_pathname` — chuỗi rỗng, không bắt đầu bằng `/`, hoặc chứa `?`/`#`
 *   (định danh tham số là *pathname* thuần; caller tự tách query/hash).
 * - `trailing_slash` — kết thúc bằng `/` (không tính root `/`).
 * - `empty_segment` — chứa đoạn rỗng `//`; `//` không bao giờ bị coi là root.
 * - `unsupported_locale` — một locale được kiểm tra không có trong registry
 *   (so khớp **chính xác**, không lowercase): riêng `parsePublicPath` là segment
 *   đầu tiên (`/EN`, `/fr`, `/blog`); riêng `localizePath`/`switchLocale` là
 *   tham số locale đích. Trong `switchLocale` nó **chỉ** nghĩa là locale đích
 *   không được hỗ trợ — source không mang locale trả `not_localized`.
 * - `not_localized` — riêng `switchLocale`: source pathname không mang locale
 *   supported để đổi (root `/`, hoặc segment đầu tiên không phải locale trong
 *   registry). `vi` có thể hoàn toàn supported; vấn đề là source không có gì
 *   để đổi.
 * - `already_localized` — riêng `localizePath`: pathname đã mang locale, để
 *   chống double-localize (`/vi/en/blog` không bao giờ được sinh ra).
 */
export type PublicPathReason =
  | 'not_a_pathname'
  | 'trailing_slash'
  | 'empty_segment'
  | 'unsupported_locale'
  | 'not_localized'
  | 'already_localized';

/**
 * Kết quả phân biệt (discriminated) của mọi phép xử lý pathname.
 *
 * Ba state: `root` (đúng `/` — là một parse state riêng, không phải `en` và
 * không phải invalid), `localized` (pathname mang locale ở segment đầu tiên),
 * `invalid` (kèm typed reason, không throw).
 *
 * Trên variant thành công:
 * - `path` — public path đầy đủ, không bao giờ có trailing slash
 *   (`/vi`, `/vi/blog/foo`); luôn đúng công thức `'/' + locale + remainder`.
 * - `remainder` — phần còn lại **verbatim** sau `/<locale>`: `''` ở locale root
 *   (`/en`), ngược lại bắt đầu bằng `/` và giữ nguyên từng byte
 *   (`/en/caf%C3%A9` giữ nguyên mã hoá; `/en/blog/` không bao giờ đến được đây).
 */
export type PublicPathResult =
  | { readonly kind: 'root'; readonly path: '/' }
  | {
      readonly kind: 'localized';
      readonly locale: PublicLocale;
      readonly path: string;
      readonly remainder: string;
    }
  | { readonly kind: 'invalid'; readonly reason: PublicPathReason };

/** Kết quả invalid cho sẵn — mọi early-return dùng đúng một constructor này. */
export function invalidPath(reason: PublicPathReason): PublicPathResult {
  return { kind: 'invalid', reason };
}

/**
 * Cấu trúc pathname có hợp lệ không, **trước** khi nhìn tới locale:
 * đúng string, không rỗng, bắt đầu bằng `/`, không chứa `?`/`#`.
 *
 * Kiểm tra `typeof` là guard runtime cho caller đi qua JS hoặc cast: kết quả
 * luôn là boolean, không bao giờ throw trên input không phải string.
 */
export function hasPathnameShape(pathname: string): boolean {
  return (
    typeof pathname === 'string' &&
    pathname !== '' &&
    pathname[0] === '/' &&
    !pathname.includes('?') &&
    !pathname.includes('#')
  );
}

/**
 * Tách pathname (đã có dấu `/`) thành segment đầu tiên và phần còn lại —
 * cả hai đều nguyên văn, không lowercase, không decode.
 *
 * `/` → segment `''`, remainder `''`; `/en` → `en`, `''`;
 * `/en/blog` → `en`, `/blog`.
 */
export function splitFirstSegment(pathname: string): {
  readonly segment: string;
  readonly remainder: string;
} {
  const boundary = pathname.indexOf('/', 1);
  return boundary === -1
    ? { segment: pathname.slice(1), remainder: '' }
    : { segment: pathname.slice(1, boundary), remainder: pathname.slice(boundary) };
}

/**
 * Ghép `/<locale>` với remainder đã cho thành public path đầy đủ.
 *
 * Đây là **nơi duy nhất** việc ghép này xảy ra — consumer không tự concatenate,
 * đúng quy tắc của quy ước public URL của repo (mọi public URL dựng qua
 * library, không qua string concat ở caller).
 */
export function joinLocalizedPath(locale: PublicLocale, remainder: string): string {
  return remainder === '' ? `/${locale}` : `/${locale}${remainder}`;
}

/** Variant thành công `localized` — dùng chung cho parse, localize và switch. */
export function localizedPath(locale: PublicLocale, remainder: string): PublicPathResult {
  return { kind: 'localized', locale, path: joinLocalizedPath(locale, remainder), remainder };
}
