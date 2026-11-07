/**
 * Production origin của public surface Home.
 *
 * Canonical và `hreflang` **phải** là URL tuyệt đối dưới production domain
 * (`docs/architecture/01-architecture.md` §7/A13): `ecoma.io` là production public
 * domain, `ecoma.io.vn` là non-production cho staging + preview. Canonical
 * tương đối được crawler resolve theo **hostname của request đang phục vụ nó**
 * — nghĩa là một bản staging, preview hay `localhost` sẽ tự khai mình là
 * canonical, và search engine có thể index một hostname không phải production.
 *
 * Vì vậy origin ở đây là **hằng số policy của Home**: không bao giờ suy ra từ
 * `request.url`, header `Host`, `useRequestURL()` hay bất kỳ state nào của
 * request.
 *
 * Policy này thuộc application, không thuộc `app/i18n` (locale dimension)
 * hay `app/layout` (pathname/topology): hai thư viện đó cố tình không có
 * khái niệm origin, nên origin không được nhét vào chúng.
 */

/** Production public origin — không trailing slash, đúng dạng `URL.origin`. */
export const HOME_PRODUCTION_ORIGIN = 'https://ecoma.io' as const;

/**
 * Dựng URL tuyệt đối dưới production origin từ một public pathname.
 *
 * Dùng `new URL(pathname, HOME_PRODUCTION_ORIGIN)` — không bao giờ ghép chuỗi
 * — nên percent-encoding và `href` theo đúng chuẩn WHATWG URL.
 *
 * Ném lỗi nếu URL dựng ra không nằm dưới origin production: `new URL` chấp
 * nhận cả input tuyệt đối lẫn protocol-relative, nên một pathname như
 * `//attacker.example/en` sẽ thoát origin mà không có lỗi cú pháp nào. Guard
 * biến việc âm thầm đổi origin thành lỗi ồn ào; input như vậy không thể sinh
 * từ `buildPublicPath` nên đây là bất biến, không phải validation của caller.
 */
export function toProductionUrl(pathname: string): string {
  const url = new URL(pathname, HOME_PRODUCTION_ORIGIN);
  if (url.origin !== HOME_PRODUCTION_ORIGIN) {
    throw new Error(`Pathname "${pathname}" escapes the production origin`);
  }
  return url.href;
}
