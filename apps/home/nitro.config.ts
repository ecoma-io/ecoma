// Nitro config riêng cho `home`.
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
// ## Mô hình phục vụ sau khi gỡ stack @nuxt/content (issue #72)
//
// Homepage locale-root (`/en`, `/vi`) là **SSG**: prerender lúc build, nằm trong
// `.output/public` và Cloudflare phục vụ thẳng từ static assets — không invoke
// Worker. Lý do: trang chủ ít đổi, thời điểm build là đủ tươi cho nó.
// Mọi path khác (redirect `/`, mọi URL lạ) vẫn được invoke Worker: `/` trả 302
// từ `server/routes/index.get.ts`, URL không khớp page nào đi qua `validate` →
// 404 → `error.vue` render SSR trên Worker. `wrangler.jsonc` cố ý không đặt
// `not_found_handling` để giữ semantics đó.
export default {
  preset: 'cloudflare-module',
  // Cờ noindex cho môi trường staging. Chuỗi giá trị đi qua chuỗi env của
  // Workers: wrangler.jsonc `env.staging.vars.NITRO_PUBLIC_NO_INDEX` → `env`
  // của worker → `globalThis.__env__` (nitropack cloudflare module handler)
  // → proxy `process.env` (unenv) → `applyEnv` của Nitro (prefix
  // `NITRO_`, snakeCase) → `useRuntimeConfig().public.noIndex`. `applyEnv`
  // parse giá trị qua `destr()` — chuỗi `"true"` thành boolean `true` thật
  // (đã kiểm chứng trên nitropack 2.13.4, `runtime/internal/utils.env`),
  // nên middleware `no-index` so khớp `=== true` được như thường.
  // Mặc định `false` (production): middleware `server/middleware/no-index.ts`
  // chỉ bật header khi giá trị là `true` tuyệt đối — fail-safe về mặt SEO.
  //
  // PHẠM VI: cờ chỉ có hiệu lực trên bề mặt Worker-served. Homepage prerendered
  // (SSG) và `404.html` được phục vụ thẳng từ static assets (không invoke
  // Worker), nên noindex cho bề mặt đó đến từ file `_headers` mà job deploy
  // staging inject vào artifact (xem `staging-deploy.mts` — nằm ngoài app này).
  // **Giới hạn đã biết (chưa fix):** cơ chế inject `_headers` thuộc hạ tầng
  // deploy staging; thay đổi đó phải được chủ sở hữu platform làm riêng.
  runtimeConfig: {
    public: {
      noIndex: false,
    },
  },
  hooks: {
    // `404.html` — artifact prerender, không wire vào serving: `wrangler.jsonc`
    // cố ý KHÔNG đặt `not_found_handling`, nên request không khớp asset vẫn
    // được invoke Worker và 404 thật do `validate` từ chối → `error.vue` SSR
    // sinh ra (chi tiết ở wrangler.jsonc). File này giữ tương thích
    // artifact-level với bản static cũ. Preset Worker của Nitro **không** seed
    // route này, nên phải tự prerender.
    //
    // Hai rào cản cần vượt (giữ nguyên từ `apps/docs` cũ):
    //
    // 1. Nuxt hardcode `/404.html` vào `PRERENDER_NO_SSR_ROUTES` — route này
    //    luôn được render bằng SPA renderer, tức shell rỗng
    //    (`data-ssr="false"`, không một byte HTML của error.vue). Prerender
    //    trực tiếp `/404.html` không bao giờ cho ra trang lỗi SSR thật.
    // 2. Prerenderer của Nitro chỉ ghi file khi response **200** — một route
    //    không match page nào trả 404 và bị đánh dấu `_route.error`.
    //
    // Cách giải: prerender một **URL ảo** `/en/__not-found`. Nó đi đúng
    // pipeline lỗi chuẩn của Nuxt như mọi URL không tồn tại khác (không page
    // route nào match → `validate` từ chối → 404 → nitro error handler
    // localFetch `/__nuxt_error?...` → renderer chạy `error.vue` ở chế độ SSR
    // thật, đầy đủ `PublicShell` + shared 404 page). Hook `prerender:generate`
    // chạy sau khi fetch nhưng trước khi ghi: xóa cờ lỗi để route được ghi,
    // và đổi `fileName` thành `404.html` — đĩa nhận HTML của trang lỗi thật
    // dưới đúng tên artifact mà wrangler cần.
    //
    // Nội dung dùng locale mặc định khi build (`en`, xem `app/error.vue`):
    // một file tĩnh duy nhất không biết URL bị lỗi thuộc locale nào.
    //
    // `failOnError` giữ mặc định true cho mọi route khác; route ảo này được
    // miễn một cách có kiểm soát (chỉ đúng `route.route` của nó) thay vì tắt
    // guard toàn cục — một route thật sự hỏng vẫn làm build đỏ.
    'prerender:routes': (routes: Set<string>): void => {
      routes.add('/en/__not-found');
    },
    'prerender:generate': (route: {
      route: string;
      error?: Error;
      fileName?: string;
      skip?: boolean;
    }): void => {
      if (route.route === '/en/__not-found') {
        // Chỉ miễn lỗi **dự kiến** — 404 của route ảo. Lỗi khác (throw trong
        // `error.vue`/`PublicShell`, renderer 500 — lỗi build thật) phải để
        // nguyên cờ cho `failOnError` làm build đỏ: nuốt trắng sẽ đổi
        // `fileName` thành `/404.html`, build xanh nhưng artifact là HTML
        // hỏng. Nitro gắn status vào error object
        // (`statusCode`, hoặc `status` sau khi Nuxt deprecate tên cũ) nhưng
        // type tĩnh không khai báo — kiểu cấu trúc cục bộ thay vì cast rộng.
        type PrerenderRouteError = { statusCode?: unknown; status?: unknown };
        const status = (route.error as PrerenderRouteError | undefined)?.statusCode;
        const altStatus = (route.error as PrerenderRouteError | undefined)?.status;
        if (status === 404 || altStatus === 404) {
          delete route.error;
          route.fileName = '/404.html';
        }
      }
      // Payload JSON của route ảo (`/en/__not-found/_payload.json`) bị crawler
      // queue tiếp từ header `x-nitro-prerender` của response HTML và sẽ được
      // ghi cạnh **URL gốc**, không cạnh `404.html` đã đổi tên — file rác trong
      // artifact deploy (không request nào của trình duyệt chạm tới nó, vì
      // hydration trên URL không tồn tại không bao giờ chạy). Đánh dấu `skip`
      // ngay tại đây: prerenderer bỏ qua ghi đĩa cho route này.
      if (route.route === '/en/__not-found/_payload.json') {
        route.skip = true;
      }
    },
  },
  prerender: {
    // Seed homepage hai locale — bề mặt duy nhất của app sau khi gỡ stack
    // content (issue #72). Prerender xong thì KHÔNG crawler tiếp: các link của
    // trang (brand, locale switcher) đều trỏ về chính hai locale-root này, đã
    // có mặt trong seed.
    routes: ['/en', '/vi'],
    //
    // `/` không có page tương ứng (chỉ `server/routes/index.get.ts` redirect
    // 302) — không loại thì crawler báo lỗi route không render được.
    //
    // Dùng **regex** chứ không phải string: `ignore` so string bằng
    // `startsWith`, nên một prefix ngắn sẽ nuốt cả nhóm path; regex neo hai
    // đầu mới khớp đúng path cần loại. Cờ `u` là yêu cầu của rule
    // `require-unicode-regexp` trong oxlint config của repo.
    //
    // Lưu ý: `ignore` chặn route **hoàn toàn** (`canPrerender` → skip ngay
    // trước khi fetch, không bao giờ ghi file). `/en` và `/vi` **không** nằm
    // ở đây — chúng là seed prerender SSG ở trên; `/en/__not-found` (route
    // ảo sinh `404.html`, hook `prerender:generate` trên) cũng không được
    // đứng ở đây.
    //
    // Cố ý **không** dùng `failOnError: false`: giữ nguyên mặc định để một
    // route thật sự hỏng vẫn làm build đỏ. Chỉ đúng những entry point
    // non-page ở trên được miễn.
    ignore: [
      /^\/$/u,
      // API nội bộ của app không phải page nào cả.
      /^\/api\/greet$/u,
    ],
  },
};
