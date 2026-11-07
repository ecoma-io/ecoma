// Nitro config riêng cho `backoffice`.
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
//
// Lưu ý về `runtimeConfig`: file này **không** khai `runtimeConfig.public`
// cho gating dữ liệu backoffice. Khoá đó được đọc ở phía app
// (`useRuntimeConfig()` trong `use-backoffice-adapter.ts`), nên nó phải nằm ở
// `runtimeConfig` của `nuxt.config.ts` — cùng nguồn với payload mà client nhận.
// Khai thêm ở đây sẽ tạo hai nguồn cho cùng một khoá.
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
    // Đây là cùng cách sửa với `apps/account` — xem
    // `apps/account/server/lib/pg-native.cjs`.
    'pg-native': new URL('./server/lib/pg-native.cjs', import.meta.url).pathname,
  },
};
