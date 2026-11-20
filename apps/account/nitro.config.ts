// Nitro config riêng cho `account`.
//
// Nuxt 4 chuyển cấu hình Nitro ra khỏi `nuxt.config.ts`: docs của Nuxt khuyến
// nghị dùng key `nitro` ở đó, nhưng `@nuxt/schema` 4.5.2 đã gỡ `nitro` khỏi
// `NuxtConfig` (`Omit<ConfigSchema, ... | "nitro">` + `nitro?: never`), nên khai
// báo kiểu sẽ hỏng:
//     error TS2353: 'nitro' does not exist in type 'InputConfig<NuxtConfig, ...>'
// Vì `typescript.typeCheck: true` trong nuxt.config.ts và `.nuxt/tsconfig.node.json`
// có `include: ["../nuxt.config.*"]`, lỗi đó lộ ra ngay trong `nuxt build`.
// File riêng này tránh được cả hai.
//
// Đây là lựa chọn tạm: khi `@nuxt/schema` trả `nitro` vào `NuxtConfig`, chuyển
// nội dung file này thành key `nitro` trong `nuxt.config.ts` cho khớp docs. Nuxt
// hiện cảnh báo B5004 khi thấy `nitro.config.ts` — chỉ dev mode, không ảnh hưởng
// build.
//
// Trang này là deploy unit Workers: docs/architecture/02-delivery.md §1 xếp `apps`
// vào làn Workers, deploy bằng Wrangler. Không có preset này thì Nuxt build cho
// Node server và không emit ra `.output/server/index.mjs` mà `wrangler.jsonc`
// trỏ tới.
//
// Không dùng `cloudflare` (preset legacy, không emit modern Workers output) và
// không dùng `cloudflare-pages`: preset Pages ghi ra `dist/_worker.js` cùng
// `_routes.json`/`_redirects`, lệch với `main` trong wrangler.jsonc.
//
// Export object thuần, không import `defineNitroConfig` từ `nitro/config`:
// `nitro` là transitive dependency của `nuxt`, không phải dependency trực tiếp
// của workspace package này, nên pnpm không cho resolve từ đây.
export default {
  preset: 'cloudflare-module',
  // Cờ noindex cho môi trường staging (#354) — cùng cơ chế với `apps/home`
  // và `apps/backoffice` (`nitro.config.ts` của hai app đó). Chuỗi giá trị đi
  // qua chuỗi env của Workers: wrangler.jsonc `env.staging.vars.NITRO_PUBLIC_NO_INDEX`
  // → `env` của worker → `globalThis.__env__` (nitropack cloudflare module
  // handler) → proxy `process.env` (unenv) → `applyEnv` của Nitro (prefix
  // `NITRO_`, snakeCase) → `useRuntimeConfig().public.noIndex`. `applyEnv`
  // parse giá trị qua `destr()` — chuỗi `"true"` thành boolean `true` thật,
  // nên middleware `server/middleware/no-index.ts` so khớp `=== true` được
  // như thường. Mặc định `false` (production): middleware chỉ bật header khi
  // giá trị là `true` tuyệt đối — fail-safe về mặt SEO.
  //
  // Khai ở đây (không phải `nuxt.config.ts`) vì khoá này ĐỌC thuần phía
  // server (middleware Nitro), khác các khoá data-mode được client hydrate —
  // cùng quy ước với home và backoffice.
  //
  // PHẠM VI: cờ chỉ có hiệu lực trên bề mặt Worker-served — mọi route Nitro
  // (shell HTML SSR, payload, API, error page) và qua middleware. Request
  // khớp static asset (`_nuxt`, `_fonts`) được asset layer phục vụ thẳng,
  // KHÔNG invoke Worker nên middleware không chạy; noindex cho bề mặt đó đến
  // từ file `_headers` mà job deploy staging inject vào artifact (mechanism
  // thuộc `tools/delivery` — giới hạn đã biết, cùng hình với home).
  runtimeConfig: {
    public: {
      noIndex: false,
    },
  },
};
