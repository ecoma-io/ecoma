import { APP_SHELL_COLOR_MODE_COOKIE } from './defaults';

/**
 * Script inline chạy **trước first paint**, quyết định class `dark` trên `<html>`
 * từ cookie và `prefers-color-scheme`. Đây là thiết kế thay cho invariant cũ
 * "không đọc window/matchMedia ở bất kỳ đâu" (issue #213):
 *
 * - Server không thể biết `prefers-color-scheme` của người dùng, nên với mode
 *   `system` không có đường nào render class đúng từ SSR. Script nằm trong
 *   `<head>` là render-blocking: chạy xong trước khi một pixel nào được vẽ, nên
 *   không có FOUC dù HTML mà server gửi chưa mang class.
 * - Vue và unhead **không** quản lý class này (app chỉ đăng ký `lang`/`dir` qua
 *   `useHead`), nên hydration không bao giờ đụng chạm hay hoàn tác giá trị mà
 *   script đã đặt. Invariant mới, thu hẹp có chủ ý: *render* Vue không đọc
 *   environment; script bootstrap nằm ngoài chu trình render của Vue.
 * - App inject script bằng **`app.head` tĩnh trong `nuxt.config`**, không qua
 *   `useHead`: mọi app shell trong repo chạy `ssr: false`, và `useHead` ở SPA
 *   chỉ áp dụng client-side sau khi bundle mount — quá muộn so với first paint.
 *   Entry tĩnh trong `app.head` được render thẳng vào HTML shell lúc build,
 *   nên script là inline script trong `<head>` của HTML served, chạy đúng lúc
 *   parse. App import hằng số này qua subpath `@ecoma-io/ui-app-shell/lib/color-mode`
 *   (barrel gốc kéo theo component `.vue`, không nạp được từ `nuxt.config`).
 * - Không có JS thì không có class nào được đặt → giao diện sáng. Chấp nhận:
 *   đây cũng hành vi của next-themes và của mọi giải pháp mode-system SSR.
 *
 * Script giữ chủ đích ở mức ES5 (không optional chaining, không arrow function):
 * nó chạy trên mọi trình duyệt trước cả khi bundle chính được parse. Lắng nghe
 * `change` của `prefers-color-scheme` để người dùng đổi mode hệ điều hành giữa
 * chừng mà không reload thì giao diện vẫn đi theo (chỉ áp dụng khi mode hiện tại
 * là `system`; mode tường minh thì người dùng đã quyết, hệ điều hành không được
 * đè lên lựa chọn đó).
 *
 * Cookie name được nội suy lúc build hằng số (`APP_SHELL_COLOR_MODE_COOKIE`) —
 * một nguồn duy nhất cho tên khoá, app không thể lệch script với cookie mình ghi.
 */
export const APP_SHELL_COLOR_MODE_BOOTSTRAP_SCRIPT = [
  '(function(){',
  'try{',
  `var K='${APP_SHELL_COLOR_MODE_COOKIE}',`,
  "RE=new RegExp('(?:^|; )'+K+'=([^;]*)'),",
  'D=document.documentElement,',
  "Q=window.matchMedia?window.matchMedia('(prefers-color-scheme: dark)'):null;",
  'function val(){var m=RE.exec(document.cookie);return m?m[1]:"system"}',
  'function apply(){D.classList.toggle("dark",val()==="dark"||(val()!=="light"&&Q&&Q.matches))}',
  'apply();',
  'if(Q){',
  'var h=function(){if(val()==="system"){D.classList.toggle("dark",Q.matches)}};',
  'if(Q.addEventListener){Q.addEventListener("change",h)}else if(Q.addListener){Q.addListener(h)}',
  '}',
  '}catch(e){}',
  '})();',
].join('\n');
