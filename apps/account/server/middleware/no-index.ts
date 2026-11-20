import { defineEventHandler, setResponseHeader } from 'h3';

/**
 * `X-Robots-Tag: noindex` cho bề mặt non-production của Account (#354) —
 * cùng cơ chế với `apps/home` và `apps/backoffice`
 * (`server/middleware/no-index.ts` của hai app đó).
 *
 * Cờ đến từ runtime config `public.noIndex`, đặt bằng `vars`
 * `NITRO_PUBLIC_NO_INDEX` trong env `staging` của `wrangler.jsonc`; production
 * không khai biến này nên giữ `false` mặc định (xem `nitro.config.ts`).
 *
 * **PHẠM VI:** chỉ bề mặt **Worker-served** — mọi route Nitro (shell HTML SSR,
 * payload, route API, error page) đều qua middleware này. Request khớp static
 * asset (`_nuxt`, `_fonts`) được asset layer phục vụ thẳng, không invoke
 * Worker nên middleware không chạy; noindex cho bề mặt đó đến từ file
 * `_headers` mà job deploy staging inject vào artifact (mechanism thuộc
 * `tools/delivery` — giới hạn đã biết, không fix ở đây); smoke staging
 * (`root-noindex` của flat app theo `02-delivery.md`) assert bề mặt
 * Worker-served.
 *
 * Vì sao middleware server chứ không `useHead`: app có SSR nên `useHead`
 * phủ được HTML, nhưng header HTTP áp dụng **đồng nhất cho mọi URL** Worker
 * chạm — kể cả response không phải HTML (payload JSON, error page, API) —
 * và không phụ thuộc render client nào "quên" gắn thẻ.
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
