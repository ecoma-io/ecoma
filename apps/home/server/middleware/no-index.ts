import { defineEventHandler, setResponseHeader } from 'h3';

/**
 * `X-Robots-Tag: noindex` cho bề mặt non-production của Home.
 *
 * Cờ đến từ runtime config `public.noIndex`, đặt bằng `vars`
 * `NITRO_PUBLIC_NO_INDEX` trong env `staging` của `wrangler.jsonc`; production
 * không khai biến này nên giữ `false` mặc định (xem `nitro.config.ts`).
 *
 * **PHẠM VI:** chỉ bề mặt **Worker-served** — request khớp static asset
 * (homepage prerendered, `404.html`, các asset build, không `run_worker_first`)
 * KHÔNG invoke Worker nên middleware này không chạy. Noindex cho bề mặt đó
 * đến từ file `_headers` mà job deploy staging inject vào artifact trước
 * `wrangler deploy` (xem `staging-deploy.mts`; mechanism nằm ngoài app này —
 * được ghi nhận là giới hạn đã biết, không fix ở đây); smoke staging assert
 * cả hai bề mặt.
 *
 * Vì sao middleware server chứ không `useHead`/`routeRules`: `X-Robots-Tag`
 * là HTTP header — có hiệu lực với **mọi** URL Worker chạm (kể cả payload
 * JSON, redirect 302 của `/`, error page) chứ không chỉ HTML đã render; và
 * nó không thể bị client-side render "quên".
 *
 * Điều kiện `noIndex === true` là fail-safe: giá trị thiếu/sai kiểu thì
 * KHÔNG bao giờ noindex (bảo vệ SEO của production) — khai
 * `NITRO_PUBLIC_NO_INDEX: "1"` không bật được cờ, wrangler `vars` chỉ dùng
 * `"true"`, test chốt hành vi.
 */
export default defineEventHandler((event) => {
  const { noIndex } = useRuntimeConfig(event).public;
  if (noIndex === true) {
    setResponseHeader(event, 'X-Robots-Tag', 'noindex');
  }
});
