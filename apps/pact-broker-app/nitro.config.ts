// Nitro config riêng cho `pact-broker-app`.
//
// Nuxt 4 chuyển cấu hình Nitro ra khỏi `nuxt.config.ts`: docs của Nuxt khuyến
// nghị dùng key `nitro` ở đó, nhưng `@nuxt/schema` 4.5.2 đã gỡ `nitro` khỏi
// `NuxtConfig` (`Omit<ConfigSchema, ... | "nitro">` + `nitro?: never`), nên khai
// báo kiểu sẽ hỏng:
//     error TS2353: 'nitro' does not exist in type 'InputConfig<NuxtConfig, ...>'
// File riêng này tránh được cả hai. (Giải thích đầy đủ nằm ở
// `apps/backoffice/nitro.config.ts` — cùng một thiết kế.)
//
// Trang này là deploy unit Workers: docs/architecture/02-delivery.md §1 xếp `apps`
// vào làn Workers, deploy bằng Wrangler. Không có preset này thì Nuxt build cho
// Node server và không emit ra `.output/server/index.mjs` mà `wrangler.jsonc`
// trỏ tới.
//
// Không dùng `cloudflare` (preset legacy) và không dùng `cloudflare-pages`
// (ghi ra `dist/_worker.js` lệch với `main` trong wrangler.jsonc).
//
// Export object thuần, không import `defineNitroConfig` từ `nitro/config`:
// `nitro` là transitive dependency của `nuxt`, pnpm không cho resolve từ đây.
export default {
  preset: 'cloudflare-module',
};
