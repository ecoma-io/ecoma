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
// ## Ranh giới `@nuxt/content` / Cloudflare runtime
//
// Preset `cloudflare-module` làm `@nuxt/content` rewrite cấu hình database
// sang **D1** (`{ type: 'd1', bindingName: 'DB' }` — nhánh `cloudflare` của
// `setupNitro` trong `@nuxt/content/dist/module.mjs`). D1 bị cấm cho
// Git-managed Markdown (ràng buộc của repo: không provision database chỉ để
// phục vụ content tĩnh).
//
// Cách chạy tránh hoàn toàn adapter D1 ở runtime:
//
// 1. `@nuxt/content` chọn adapter **lúc request**: với
//    `import.meta.preset ∈ {'nitro-prerender', 'nitro-dev'}` hoặc
//    `import.meta.dev`, adapter là sqlite local trên Node; chỉ preset Worker
//    thật mới đi qua `#content/adapter` → D1 connector
//    (`runtime/internal/database.server.js`). Nitro chỉ gán
//    `import.meta.preset = 'prerender'` khi tiến trình prerender chạy với
//    preset nội bộ `nitro-prerender` — nghĩa là **không** khai preset đó ở
//    đây; nó đến từ chính tiến trình prerender của Nitro.
// 2. Mọi **trang content** (`/<locale>/docs/**`, `/<locale>/blog/**`) được
//    prerender ở build time: query chạy trên Node với sqlite local, HTML +
//    `_payload.json` nằm trong `.output/public` — Cloudflare phục vụ trực tiếp
//    từ **static assets** của Worker (`assets.directory` trong
//    `wrangler.jsonc`), không invoke Worker script. Độ tươi của content =
//    thời điểm build, đúng semantics của bản static cũ (docs/blogs deploy
//    assets-only sau mỗi build).
// 3. Mọi path khác giữ SSR thật trên Worker. Request content path không tồn
//    tại (`/en/docs/unknown`) bị chặn **trước khi** bất kỳ query nào chạy —
//    qua manifest các content path được sinh lúc build (virtual module
//    `virtual:prerendered-content-paths`, lấp bởi hook `prerender:done` ↓) và
//    tra cứu trong middleware `server/middleware/prerendered-content-404.ts`
//    (chạy trước renderer; không đặt trong `validate` của route vì app code
//    bị Vite bundle trước prerender — xem module app-local đăng ký virtual).
//    Nhờ vậy request lạ không bao giờ chạm `loadDatabaseAdapter`, tức không
//    bao giờ gặp D1 connector — nó 404 sạch từ middleware, đúng semantics
//    "unknown content → 404" như bản static cũ (nơi wrangler của app tĩnh cũ
//    đặt `not_found_handling: "404-page"`; config hiện tại KHÔNG đặt — xem
//    wrangler.jsonc: request không khớp asset được invoke Worker).
// 4. Trang prerendered vẫn hydrate: điều hướng client-side giữa các trang
//    content đọc `_payload.json` (asset tĩnh) thay vì POST
//    `/__nuxt_content/<collection>/query` lên Worker — route POST đó vẫn tồn
//    tại trong bundle nhưng không được gọi trong luồng content bình thường.
//
// Kết quả: Worker `ecoma-home` giữ SSR cho landing/legal/404, còn content
// được phục vụ như static asset trong cùng một deployment — không D1, không
// Worker identity mới.
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
  // PHẠM VI: cờ chỉ có hiệu lực trên bề mặt Worker-served. Trang content
  // prerendered được phục vụ thẳng từ static assets (không invoke Worker),
  // nên noindex cho bề mặt đó đến từ file `_headers` mà job deploy staging
  // inject vào artifact (xem `staging-deploy.mts`) — smoke staging assert
  // cả hai bề mặt.
  runtimeConfig: {
    public: {
      noIndex: false,
    },
  },
  hooks: {
    // `404.html` — artifact prerender, không wire vào serving: `wrangler.jsonc`
    // cố ý KHÔNG đặt `not_found_handling`, nên request không khớp asset vẫn
    // được invoke Worker và 404 thật do middleware gate + `error.vue` SSR sinh
    // ra (chi tiết ở wrangler.jsonc). File này giữ tương thích artifact-level
    // với bản static cũ. Preset Worker của Nitro **không** seed route này,
    // nên phải tự prerender.
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
    // pipeline lỗi chuẩn của Nuxt như mọi URL không tồn tại khác (route
    // content không match gì → `validate` từ chối → 404 → nitro error handler
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
    // guard toàn cục — một content route thật sự hỏng vẫn làm build đỏ.
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
    // Sinh **manifest content path** từ chính kết quả prerender, rồi lấp nó
    // vào `globalThis` — virtual module `virtual:prerendered-content-paths`
    // (đăng ký trong `modules/prerendered-content-manifest.ts` qua hook
    // `nitro:config`) đọc từ đó khi rollup của Nitro load nó. Rollup load
    // virtual module **sau** prerender — Worker được bundle sau khi prerender
    // chạy xong, cùng tiến trình — nên manifest luôn khớp artifact
    // `.output/public` thực tế. Consumer: middleware
    // `server/middleware/prerendered-content-404.ts`.
    //
    // Nguồn dữ liệu là `prerenderedRoutes: PrerenderRoute[]` (`route.route` =
    // URL đã render thành công và được ghi đĩa; route lỗi 404 của `/en/
    // __not-found` không có ở đây vì `prerenderedRoutes` chỉ nhận route ghi
    // thành công). Chỉ path content (docs + blog + legal) được giữ:
    // `/en/__not-found` không khớp filter mount; landing docs/blog/legal không
    // cần manifest vì chúng là route tĩnh của mount (landing legal không có
    // document ở `/en/legal` — chỉ văn bản có file content) — landing vẫn được
    // SSR theo request, không qua manifest.
    //
    // Legal nằm trong manifest cùng docs/blog: mọi văn bản legal được
    // prerender (draft bị loại trước, xem routes ↓), nên path legal lạ phải
    // 404 qua gate chứ không được chạm query — legal cùng chịu ràng buộc
    // "không D1 connector" của mọi content.
    //
    // Filter mount phải **giống hệt** `CONTENT_MOUNT_RE` trong
    // `server/middleware/prerendered-content-404.ts` — test
    // `tests/static-output.spec.ts` đọc literal từ hai nơi và bắt sự lệch.
    //
    // Type param là kiểu cấu trúc cục bộ: Nitro export `PrerenderRoute` qua
    // type nhưng hook type của nó không tiện import từ file config object
    // thuần; chỉ hai field này được đọc.
    'prerender:done': (result: { prerenderedRoutes?: ReadonlyArray<{ route?: string }> }): void => {
      const routes = (result.prerenderedRoutes ?? [])
        .map((entry) => entry.route ?? '')
        .filter((route) => /^\/(en|vi)\/(docs|blog|legal)(\/|$)/u.test(route));
      (globalThis as Record<string, unknown>).__PRERENDERED_CONTENT_PATHS__ = routes.toSorted();
    },
  },
  // Virtual module `virtual:prerendered-content-paths` — đọc manifest do hook
  // `prerender:done` vừa ghi vào `globalThis` — KHÔNG đăng ký tại đây mà ở
  // module app-local `modules/prerendered-content-manifest.ts` (qua hook
  // `nitro:config`, vốn chạy trước `createNitro` và trước prerenderer con).
  // Lý do: key `virtual` cấp top-level của file này đi vào `_config` của
  // config chính, nhưng consumer duy nhất của manifest là
  // `server/middleware/prerendered-content-404.ts` — middleware thuộc server
  // bundle chính; đăng ký cùng nơi consumer sống giúp câu chuyện
  // "specifier → virtual → consumer" nằm trọn trong hai file nhìn thấy nhau.
  // Function form chạy tại thời điểm rollup **load** module — sau prerender —
  // nên giá trị luôn là manifest của build hiện tại, không phải state build
  // trước (nitro.vfs cache chỉ giữ chuỗi đã load trong cùng tiến trình
  // build). Key phải là **`virtual` cấp top-level** (`nitro.options.virtual`):
  // nitro chỉ push `virtual(nitro.options.virtual)` vào plugin list của
  // rollup — một key `rollupConfig.virtual` tự đặt bị nitro bỏ qua im lặng
  // (đã xác minh trong nitropack/dist/rollup — `getRollupConfig` không đọc
  // key đó). Plugin `virtual` được push **trước** plugin `alias` (map
  // `#build` → buildDir), nên ở server bundle specifier này luôn resolve qua
  // virtual — manifest thật sau prerender, không bao giờ chạm đĩa.
  prerender: {
    // Seed tường minh hai landing của mỗi mount. Từ đây crawler đi tiếp qua
    // link do sidebar/listing render ra, nên **mọi** document/article/văn bản
    // ở cả hai locale đều được prerender thành HTML thật. Seed không suy từ
    // content file: chính route mới là thứ quyết định URL, và crawler đọc đúng
    // URL đó. Draft legal không vào được listing ở production build (gate ở
    // route query), nên crawler không bao giờ thấy link draft — draft không
    // cần seed tường minh nào.
    routes: ['/en/docs', '/vi/docs', '/en/blog', '/vi/blog', '/en/legal', '/vi/legal'],
    crawlLinks: true,
    // Crawler đi theo **mọi** link trong HTML, mà shell dùng chung render
    // global nav, locale switcher và footer với đầy đủ link chéo mount. Trong
    // app hợp nhất mọi URL đều thuộc cùng Worker, nhưng các surface
    // non-content được **SSR theo request** — prerender chúng ở đây sẽ chụp
    // trạng thái build thành artifact tĩnh và đổi semantics phục vụ (SSR mỗi
    // request → HTML chụp một lần). Giữ chúng ngoài prerender để hành vi
    // không đổi sau khi hợp nhất.
    //
    // `/` không có page tương ứng (chỉ `server/routes/index.get.ts` redirect
    // 302) — không loại thì crawler báo lỗi route không render được.
    //
    // Dùng **regex** chứ không phải string: `ignore` so string bằng
    // `startsWith`, nên `'/en'` sẽ nuốt luôn `/en/docs`; regex neo hai đầu mới
    // khớp đúng path cần loại. Cờ `u` là yêu cầu của rule
    // `require-unicode-regexp` trong oxlint config của repo.
    //
    // Lưu ý: `ignore` chặn route **hoàn toàn** (`canPrerender` → skip ngay
    // trước khi fetch, không bao giờ ghi file), không chỉ chặn crawler —
    // `/en/__not-found` (route ảo sinh `404.html`, hook `prerender:generate`
    // trên) vì thế không được đứng ở đây.
    //
    // Cố ý **không** dùng `failOnError: false`: giữ nguyên mặc định để một
    // content route thật sự hỏng vẫn làm build đỏ. Chỉ đúng những entry point
    // non-content ở trên được miễn.
    ignore: [
      /^\/$/u,
      /^\/en\/?$/u,
      /^\/vi\/?$/u,
      // Legal đã là content prerendered như docs/blog — landing được seed ở
      // `routes` (↑) và crawler đi từ landing tới mọi văn bản qua listing;
      // KHÔNG ignore mount legal nữa. Mọi thứ sâu hơn một segment của legal
      // (vd `/en/legal/privacy/x`) không được prerender — nếu lọt vào crawl
      // là link hỏng trong content và vẫn phải làm build đỏ.
      // API nội bộ của app không phải page nào cả.
      /^\/api\/greet$/u,
    ],
  },
};
