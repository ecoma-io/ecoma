import { defineNuxtConfig } from 'nuxt/config';
import tailwindcss from '@tailwindcss/vite';

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-10-05',
  workspaceDir: '../../',
  devtools: { enabled: true },
  devServer: {
    // Listen trên mọi network interface để mở app từ thiết bị khác (LAN,
    // Tailscale IP) thay vì chỉ loopback. `vite.server.allowedHosts` phải
    // đi kèm: Vite mặc định chỉ nhận `localhost`, `*.localhost` và IP
    // literal, nên mọi tên DNS khác — kể cả MagicDNS `.ts.net` — bị chặn
    // 403. Hardcode hostname không dùng được vì mỗi developer một tailnet.
    // Đánh đổi: dev server không có authentication, ai nối được tới máy dev
    // đều đọc được app, build error và source code. Cả hai key chỉ có tác
    // dụng khi `nuxt.options.dev`, nên build production không đổi.
    host: '0.0.0.0',
    port: 4200,
  },
  typescript: {
    typeCheck: true,
    tsConfig: {
      extends: '../../../tsconfig.base.json', // Nuxt chép nguyên văn chuỗi này sang `./.nuxt/tsconfig.json`, nên nó phải là đường dẫn tương đối so với thư mục đó
      include: ['../app/**/*', '../shared/**/*', '../test/**/*', './nuxt.d.ts', '../types/*.d.ts'],
    },
  },
  imports: {
    autoImport: true,
  },
  // Alias tường minh cho `@ecoma-io/ui-ecoma-logo` — **bắt buộc**, không phải tuỳ chọn.
  //
  // `tsconfig.base.json` có `paths: {}` rỗng và `vite.resolve.tsconfigPaths` chỉ
  // đọc `paths`, nên cả hai cùng không map `@ecoma-io/*`. Hệ quả đã quan sát được
  // trên `apps/account`: Vite resolve `@ecoma-io/*` **không** được ở runtime,
  // import trong `server/` chỉ nổ ở request đầu tiên chạm tới route đó (dev 500,
  // production 500 theo cold start). Library `ui-ecoma-logo` là duy nhất trong
  // workspace có tag `scope:shared` và được app này tiêu thụ, nên alias được đặt
  // ở đây — trỏ thẳng vào entrypoint của lib (`src/index.ts`), không cần build
  // output.
  //
  // Vì sao không sửa `tsconfig.base.json`: đó là file dùng chung của **mọi** app,
  // nên thêm `paths` ở đó là thay đổi ngoài phạm vi app này — và app nào không
  // có Nuxt/Vite resolver tương ứng vẫn không được lợi. `nuxt.config.ts` của
  // chính app là nơi duy nhất chịu trách nhiệm resolve được alias của app mình.
  alias: {
    '@ecoma-io/ui-ecoma-logo': new URL('../../libs/ui-ecoma-logo/src/index.ts', import.meta.url)
      .pathname,
  },
  modules: ['@nuxt/fonts'],
  css: ['~/assets/css/styles.css'],

  vite: {
    resolve: { tsconfigPaths: true },
    server: { allowedHosts: true },
    plugins: [tailwindcss()],
  },

  // Cấu hình Nitro inline (trước đây ở `nitro.config.ts`, đã gỡ theo #607 để
  // hết cảnh báo `NUXT_B5004` — `@nuxt/schema` 4.6.4 đã trả key `nitro` vào
  // `NuxtConfig`, không còn TS2353).
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
  // ## Mô hình phục vụ sau khi gỡ stack @nuxt/content (issue #72)
  //
  // Homepage locale-root (`/en`, `/vi`) là **SSG**: prerender lúc build, nằm trong
  // `.output/public` và Cloudflare phục vụ thẳng từ static assets — không invoke
  // Worker. Lý do: trang chủ ít đổi, thời điểm build là đủ tươi cho nó.
  // Mọi path khác (redirect `/`, mọi URL lạ) vẫn được invoke Worker: `/` trả 302
  // từ `server/routes/index.get.ts`, URL không khớp page nào đi qua `validate` →
  // 404 → `error.vue` render SSR trên Worker. `wrangler.jsonc` cố ý không đặt
  // `not_found_handling` để giữ semantics đó.
  nitro: {
    preset: 'cloudflare-module',
    runtimeConfig: {
      public: {
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
        // Worker), nên noindex cho bề mặt đó đến từ file `_headers` mà lane deploy
        // staging inject vào artifact trước `wrangler deploy` (xem
        // `tools/delivery/src/staging-deploy.ts` — `injectStagingNoIndexHeaders`).
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
  },

  // Prototype #385: cấu hình build cho runtime Node standalone (Docker) qua
  // khối `$env['node-docker']` — chỉ kích hoạt khi envName đúng bằng
  // `node-docker`, tức `nuxt build --envName=node-docker` (c12 xử lý các khối
  // `$development`/`$env` trong `loadNuxtConfig`; envName tuỳ ý phải nằm trong
  // `$env`, còn `$development`/`$production` là key riêng có type). Đây là
  // cơ chế duy nhất cần thiết: nitro preset và output dir đều đặt được từ đây
  // vì `@nuxt/schema` 4.6.4 đã trả `nitro` vào `NuxtConfig` (không còn TS2353).
  //
  // TÊN BẮT BUỘC KHÁC `development`/`production`: `nuxt dev` tự đặt
  // envName = `development` (@nuxt/cli `overrideEnv("development")`, và c12
  // fallback theo NODE_ENV), nên khối `$development` sẽ kích hoạt cả trong
  // `nuxt dev` — buildDir `.nuxt-node` làm dev server hỏng trên fresh checkout
  // (không tìm thấy `.nuxt/tsconfig.*`). envName riêng (`node-docker`) tách
  // `nuxt dev` ra hoàn toàn. Tên Nx configuration vẫn là `development`
  // (contract của target build), chỉ command bên trong mới mang envName.
  //
  // `buildDir` được resolve theo `rootDir` (không phải `workspaceDir`), nên
  // `.nuxt-node`/`.output-node` nằm trong `apps/home/`, không đụng
  // `.nuxt`/`.output` của production — hai build chạy song song an toàn.
  // Lưu ý: build này vẫn cần `.nuxt` tồn tại (project `tsconfig.json`
  // reference `./.nuxt/tsconfig.*.json` mà `vite-plugin-checker` đọc khi
  // `typescript.typeCheck: true`) — target Nx `build` `dependsOn`
  // `nuxt-prepare` đã đảm bảo điều đó.
  $env: {
    'node-docker': {
      buildDir: '.nuxt-node',
      nitro: {
        // Preset Node server standalone — artifact `.output-node/server/index.mjs`
        // chạy trực tiếp bằng `node`, phục vụ preview/local; không đụng contract
        // wrangler của production (`.output/server/index.mjs` + `.output/public`).
        preset: 'node-server',
        output: {
          dir: '.output-node',
        },
      },
    },
  },
});
