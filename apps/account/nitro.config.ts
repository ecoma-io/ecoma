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
};
