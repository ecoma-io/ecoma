/**
 * Kiểu kết quả chung của `app/layout` — phần pathname sau khi locale đã
 * được `app/i18n` giải quyết.
 *
 * Thư viện **không normalize input**: mọi kiểm tra cấu trúc kế thừa từ
 * `parsePublicPath`/`localizePath` của `app/i18n`; phần thêm riêng ở đây
 * là phân loại bề mặt. Expected invalid input luôn trả `{ kind: 'invalid',
 * reason }` — không bao giờ throw.
 *
 * Public Web hiện chỉ có locale-root (`/en`, `/vi`) làm bề mặt nội dung:
 * registry mount đã bị xoá cùng với stack @nuxt/content (issue #72). Khi
 * một mount mới ra đời, thêm lại variant `localized` cùng registry lúc đó —
 * không khôi phục variant sớm "cho dù chưa dùng".
 */

import type { PublicLocale, PublicPathReason } from '../../i18n/index';

/**
 * Lý do một pathname bị `app/layout` từ chối.
 *
 * Tập lý do bằng đúng tập của `app/i18n` cộng `unknown_mount` — mỗi lý do
 * ứng với một action khác nhau phía caller:
 *
 * - `not_a_pathname` / `trailing_slash` / `empty_segment` / `unsupported_locale` —
 *   pass-through từ `parsePublicPath` (parse) hoặc `localizePath` (build);
 * - `unknown_mount` — segment sau locale khác rỗng mà không có bề mặt nào
 *   (`/en/unknown`, `/en/docs`) — mọi pathname có remainder đều không còn
 *   bề mặt phục vụ sau khi stack content bị xoá.
 *
 * `not_localized` và `already_localized` là lý do riêng của `switchLocale`/
 * `localizePath` — hai hàm này không thuộc `app/layout`, nhưng kiểu dùng
 * chung `PublicPathReason` nên chúng vẫn có mặt trong union (đúng convention
 * của `app/i18n`: mỗi hàm document rõ lý do nào hàm đó thực sự phát).
 */
export type PublicLayoutPathReason = PublicPathReason | 'unknown_mount';

/**
 * Kết quả phân biệt (discriminated) của `parsePublicLayoutPath` và
 * `buildPublicPath`.
 *
 * Ba state:
 * - `root` — đúng `/`: locale-resolution entry point, không serve content,
 *   không phải `en` và không phải invalid;
 * - `locale-root` — `/en`, `/vi`: bề mặt nội dung public duy nhất;
 * - `invalid` — kèm typed reason, không throw.
 *
 * `path` trên variant thành công là public path đầy đủ, không bao giờ có
 * trailing slash — giữ nguyên từng byte kể từ input (parse) hoặc đúng những
 * gì đã dựng (build).
 */
export type PublicLayoutPathResult =
  | { readonly kind: 'root'; readonly path: '/' }
  | {
      readonly kind: 'locale-root';
      readonly locale: PublicLocale;
      readonly path: string;
    }
  | { readonly kind: 'invalid'; readonly reason: PublicLayoutPathReason };

/**
 * Input của `buildPublicPath` — chỉ còn nhánh locale-root.
 */
export type PublicLayoutPathInput = {
  readonly locale: PublicLocale;
};

/** Variant invalid cho sẵn — mọi early-return dùng đúng một constructor này. */
export function invalidLayoutPath(reason: PublicLayoutPathReason): PublicLayoutPathResult {
  return { kind: 'invalid', reason };
}
