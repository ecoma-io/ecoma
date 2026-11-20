import { defineEventHandler, setResponseHeader } from 'h3';

/**
 * `X-Robots-Tag: noindex` cho bề mặt non-production của Backoffice (#354) —
 * cùng cơ chế với `apps/home/server/middleware/no-index.ts`.
 *
 * Cờ đến từ runtime config `public.noIndex`, đặt bằng `vars`
 * `NITRO_PUBLIC_NO_INDEX` trong env `staging` của `wrangler.jsonc`; production
 * không khai biến này nên giữ `false` mặc định (xem `nitro.config.ts`).
 *
 * **PHẠM VI:** chỉ bề mặt **Worker-served** — shell HTML (route `/**` của
 * Nitro, kể cả `/` vì app non-SSR SPA không emit `index.html` tĩnh) và mọi
 * route API đều qua middleware này. Request khớp static asset (`_nuxt`,
 * `_fonts`) được asset layer phục vụ thẳng, không invoke Worker nên middleware
 * không chạy; noindex cho bề mặt đó đến từ file `_headers` mà job deploy
 * staging inject vào artifact (mechanism thuộc `tools/delivery` — giới hạn đã
 * biết, không fix ở đây); smoke staging assert cả hai bề mặt.
 *
 * Vì sao middleware server chứ không `useHead`/`routeRules`: app là non-SSR
 * SPA nên `useHead` chỉ áp dụng sau mount client — header HTTP thì có hiệu lực
 * với **mọi** URL Worker chạm (kể cả shell HTML, payload JSON, error page) và
 * không thể bị client-side render "quên".
 *
 * Điều kiện `noIndex === true` là fail-safe: giá trị thiếu/sai kiểu thì
 * KHÔNG bao giờ noindex (bảo vệ SEO của production) — khai
 * `NITRO_PUBLIC_NO_INDEX: "1"` không bật được cờ, wrangler `vars` chỉ dùng
 * `"true"`, test chốt hành vi.
 */
export default defineEventHandler((event) => {
  // `?.` giữ fail-safe của mệnh đề trên: `public` thiếu (shape config đổi) là
  // bỏ qua header, không phải TypeError làm hỏng mọi route Worker-served.
  const noIndex = useRuntimeConfig(event).public?.noIndex;
  if (noIndex === true) {
    setResponseHeader(event, 'X-Robots-Tag', 'noindex');
  }
});
