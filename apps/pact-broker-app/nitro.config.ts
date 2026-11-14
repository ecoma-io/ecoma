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
  // `pg` được **bundle** vào Worker, không external: preset `cloudflare-module`
  // chạy trong isolate của Cloudflare nên `node:*` không tồn tại ở đó.
  alias: {
    // ⚠️ Bắt buộc, xem `server/lib/pg-native.cjs` về lý do. Tóm tắt:
    // `pg/lib/native/client.js` `require('pg-native')` — optional dependency mà
    // Node nuốt lỗi được, còn Rollup của Nitro thì fail build. Preset bật
    // `noExternals` nên `nitro.externals` **không** được đọc; `nitro.alias` thì có,
    // vì nó chạy trước resolver trong plugin `alias` của rollup.
    //
    // Đây là cùng cách sửa với `apps/backoffice` và `apps/account` — xem
    // `apps/account/server/lib/pg-native.cjs`.
    'pg-native': new URL('./server/lib/pg-native.cjs', import.meta.url).pathname,
  },
};
