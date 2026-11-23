import { defineNuxtConfig } from 'nuxt/config';
import tailwindcss from '@tailwindcss/vite';

import { APP_SHELL_COLOR_MODE_BOOTSTRAP_SCRIPT } from '@ecoma-io/ui-app-shell/lib/color-mode';
import { BACKOFFICE_DATA_MODE_DISABLED } from './app/backoffice-data/data-mode';
import {
  DEFAULT_BACKOFFICE_LOCALE,
  BACKOFFICE_LOCALE_DEFINITIONS,
} from './app/i18n/locale-registry';

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-10-05',
  workspaceDir: '../../',
  // `backoffice` là **non-SSR SPA** (issue #67, convention của issue cha #66):
  // render xảy ra ở client, server chỉ phục vụ static asset + BFF route.
  //
  // Khai **tường minh**, không dựa vào default của framework: Nuxt 4.6.2
  // resolve `ssr` thành `true` khi key vắng mặt (`@nuxt/schema` 4.6.2), nên
  // "không khai" nghĩa là SSR và một bản nâng cấp framework có thể đổi hành vi
  // sau lưng. Cùng cách `apps/llm-console` đã làm.
  //
  // Non-SSR **không** bỏ Nitro: preset `cloudflare-module` (khối `nitro` inline
  // dưới đây) vẫn emit `.output/server/index.mjs` và mọi route API dưới `/api`
  // vẫn chạy server-side. Đây chỉ là tắt bước render HTML phía server.
  ssr: false,
  // Script bootstrap color mode (issue #213) phải nằm trong HTML served để
  // chạy trước first paint. App là SPA nên `useHead` chỉ áp dụng sau mount;
  // entry tĩnh trong `app.head` được render thẳng vào HTML shell lúc build —
  // inline script trong `<head>` chạy đúng lúc parse, trước một pixel nào
  // được vẽ. Hằng số lấy từ library để tên cookie trong script không thể lệch
  // với cookie mà app ghi khi người dùng đổi mode.
  app: {
    head: {
      script: [{ innerHTML: APP_SHELL_COLOR_MODE_BOOTSTRAP_SCRIPT }],
    },
  },
  devtools: { enabled: true },
  devServer: {
    host: '0.0.0.0',
    port: 4201,
  },
  // Gating dữ liệu backoffice — E1 (`docs` issue #256).
  //
  // `backofficeDataMode` là **công tắc duy nhất** quyết định mock có được dùng
  // hay không. Giá trị mặc định ở đây là `BACKOFFICE_DATA_MODE_DISABLED`
  // (`'disabled'`): khi không có cấu hình deployment nào áp vào, app fail closed
  // và vào trạng thái "không khả dụng" thay vì phục vụ fixture. Dùng hằng thay vì
  // viết lại literal để tập giá trị hợp lệ chỉ được khai ở `data-mode.ts`.
  //
  // Giá trị runtime đến từ biến môi trường `NITRO_PUBLIC_BACKOFFICE_DATA_MODE`
  // (Nitro `applyEnv` phủ lên giá trị build-time dưới đây), khai tường minh cho
  // từng env trong `wrangler.jsonc` — `vars` không inherit giữa các env.
  // Local dev: đặt biến này trong `.env` (đã gitignore) hoặc truyền khi chạy
  // `nx serve @ecoma-io/backoffice`.
  //
  // Khai ở `nuxt.config.ts` vì đây là khoá
  // `public` được đọc ở phía app: cùng nguồn với payload `runtimeConfig.public`
  // mà client hydrate, nên SSR và client không thể lệch nhau.
  runtimeConfig: {
    // Connection string PostgreSQL local (Node container) — **private**, không vào
    // `public`/client bundle/log. Workers dùng Hyperdrive binding, không dùng key này.
    backofficeDatabaseUrl: '',
    // Cấu hình OIDC của backoffice (ADR-0012) — **private**, cùng luật
    // `NUXT_*` của `account`: `backofficeAuthIssuer` ← `NUXT_BACKOFFICE_AUTH_ISSUER`.
    // Workers đọc ba giá trị này từ `env` của Worker (`BACKOFFICE_AUTH_*`),
    // Node container local đọc từ đây. KHÔNG default: thiếu biến là fail-closed
    // 503 ở middleware authn (`server/auth/config.ts`), không phải "chạy với
    // giá trị rỗng".
    backofficeAuthIssuer: '',
    backofficeAuthAudience: '',
    backofficeAuthClientId: '',
    // Origin fetch server-side tới `auth` — **tuỳ chọn** (đối lập ba biến trên):
    // rỗng = mọi fetch JWKS/token dựng URL từ issuer như production; có giá trị
    // (local: `http://ecoma-<ns>-auth:4203` do backoffice-deploy cấp) = fetch
    // từ origin nội bộ vì container không resolve được hostname issuer. Issuer
    // vẫn là danh tính `iss`/authorize — chỉ fetch origin đổi. Xem JSDoc của
    // `server/auth/config.ts`.
    backofficeAuthInternalOrigin: '',
    // Origin fetch server-side tới `staff-access` — **tuỳ chọn** (đối lập ba biến
    // trên): rỗng = không mount shim ⇒ `staffAccessClientConfig()` trả `null`
    // ⇒ mọi gọi staff-access fail-closed `binding_missing`, đúng trạng thái
    // production khi hạ tầng chưa provision. Có giá trị (local:
    // `http://ecoma-staff-access:4206` do backoffice-deploy cấp) = fetch từ
    // origin nội bộ vì container không resolve được hostname `staff-access`
    // và không đi ra host loopback được.
    //
    // Cùng nguyên tắc với `backofficeAuthInternalOrigin`: envelope HMAC ký trên
    // chính path của request (`/staff`, `/roles`, `/permissions`), shim chỉ thay
    // protocol + authority của URL, KHÔNG ký thêm gì, KHÔNG giữ khoá.
    backofficeStaffAccessServiceUrl: '',
    // Origin fetch server-side tới `account` — **tuỳ chọn**, cùng nguyên tắc
    // `backofficeStaffAccessServiceUrl`: rỗng = không mount shim ⇒
    // `accountClientConfig()` trả `null` ⇒ mọi gọi account fail-closed
    // `binding_missing` (`/api/onboarding-status` 503, `/api/me` trả
    // `displayName: null`), đúng trạng thái production khi hạ tầng chưa
    // provision. Có giá trị (local: `http://ecoma-account:3000` do
    // backoffice-deploy cấp) = fetch từ origin nội bộ vì container không
    // resolve được hostname `account` và không đi ra host loopback được. Xem
    // `server/plugins/account-service-shim.ts`.
    backofficeAccountServiceUrl: '',
    public: {
      backofficeDataMode: BACKOFFICE_DATA_MODE_DISABLED,
      // URL trang profile của `account` (origin + path, vd
      // `https://account.example.com/`) — màn onboarding (#325) dùng nó làm
      // link "đặt tên hiển thị". KHÔNG default: rỗng = deployment chưa cấu
      // hình ⇒ ẩn link thay vì render link chết. Workers cấp qua `vars`
      // (`NITRO_PUBLIC_BACKOFFICE_ACCOUNT_PROFILE_URL`); Node container local
      // qua biến cùng tên trong `.env`.
      backofficeAccountProfileUrl: '',
      // Cờ noindex cho môi trường staging (#354) — cùng cơ chế với `apps/home`
      // (`nuxt.config.ts` của home). Trước đây khai ở `nitro.config.ts`, đã gộp
      // vào đây theo #607: `nitro.runtimeConfig` và `runtimeConfig` cấp cao là
      // cùng một object (portal properties trong nuxt core), nên hành vi giữ
      // nguyên. Chuỗi giá trị đi qua chuỗi env của Workers:
      // wrangler.jsonc `env.staging.vars.NITRO_PUBLIC_NO_INDEX` → `env` của worker
      // → `globalThis.__env__` (nitropack cloudflare module handler) → proxy
      // `process.env` (unenv) → `applyEnv` của Nitro (prefix `NITRO_`, snakeCase)
      // → `useRuntimeConfig().public.noIndex`. `applyEnv` parse giá trị qua
      // `destr()` — chuỗi `"true"` thành boolean `true` thật, nên middleware
      // `server/middleware/no-index.ts` so khớp `=== true` được như thường.
      // Mặc định `false` (production): middleware chỉ bật header khi giá trị là
      // `true` tuyệt đối — fail-safe về mặt SEO.
      //
      // Khai ở `nuxt.config.ts` vì khoá này ĐỌC thuần phía server (middleware
      // Nitro), khác `backofficeDataMode` được client hydrate — cùng quy ước
      // với home.
      //
      // PHẠM VI: cờ chỉ có hiệu lực trên bề mặt Worker-served — shell HTML (route
      // `/**` của Nitro, kể cả `/`) và mọi route API đều qua middleware. Request
      // khớp static asset (`_nuxt`, `_fonts`) được asset layer phục vụ thẳng,
      // KHÔNG invoke Worker nên middleware không chạy; noindex cho bề mặt đó đến
      // từ file `_headers` mà job deploy staging inject vào artifact (mechanism
      // thuộc `tools/delivery` — giới hạn đã biết, cùng hình với home).
      noIndex: false,
    },
  },
  typescript: {
    typeCheck: true,
    tsConfig: {
      extends: '../../../tsconfig.base.json',
    },
  },
  imports: {
    autoImport: true,
  },
  alias: {
    '@ecoma-io/ui-app-shell': new URL('../../libs/ui-app-shell/src/index.ts', import.meta.url)
      .pathname,
    '@ecoma-io/ui-ecoma-logo': new URL('../../libs/ui-ecoma-logo/src/index.ts', import.meta.url)
      .pathname,
    '@ecoma-io/backoffice-application': new URL(
      '../../libs/backoffice-application/src/index.ts',
      import.meta.url,
    ).pathname,
    '@ecoma-io/backoffice-infrastructure': new URL(
      '../../libs/backoffice-infrastructure/src/index.ts',
      import.meta.url,
    ).pathname,
    '@ecoma-io/staff-access-contracts': new URL(
      '../../libs/staff-access-contracts/src/index.ts',
      import.meta.url,
    ).pathname,
  },
  css: ['~/assets/css/styles.css'],
  vite: {
    resolve: { tsconfigPaths: true },
    server: { allowedHosts: true },
    plugins: [tailwindcss()],
  },
  modules: ['@vite-pwa/nuxt', '@nuxt/fonts', '@nuxtjs/i18n'],
  fonts: {
    defaults: {
      weights: [300, 400, 500, 600, 700, 800],
    },
  },
  i18n: {
    strategy: 'no_prefix',
    detectBrowserLanguage: false,
    defaultLocale: DEFAULT_BACKOFFICE_LOCALE,
    locales: BACKOFFICE_LOCALE_DEFINITIONS.map(({ code, language, label }) => ({
      code,
      language,
      name: label,
    })),
    restructureDir: 'app/i18n',
    vueI18n: './vue-i18n.config.ts',
  },
  nitro: {
    // Preset inline (trước đây ở `nitro.config.ts`, đã gỡ theo #607 để hết
    // cảnh báo `NUXT_B5004` — `@nuxt/schema` 4.6.4 đã trả key `nitro` vào
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
    plugins: [new URL('./server/plugins/staff-access-service-shim.ts', import.meta.url).pathname],
  },
  pwa: {
    registerType: 'prompt',
    generateSW: {
      globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
      runtimeCaching: [
        {
          urlPattern: /^\/api\/.*/iu,
          handler: 'NetworkOnly',
        },
        {
          urlPattern: /^https:\/\/.*\.api\..*/iu,
          handler: 'NetworkOnly',
        },
        {
          urlPattern: /\/_nuxt\/.*\.(js|css)/iu,
          handler: 'CacheFirst',
          options: {
            cacheName: 'nuxt-assets',
            expiration: {
              maxEntries: 100,
              maxAgeSeconds: 60 * 60 * 24 * 30,
            },
          },
        },
      ],
    },
    manifest: {
      name: 'Ecoma Backoffice',
      short_name: 'Backoffice',
      description: 'Ecoma backoffice application',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: '#111827',
      icons: [
        {
          src: '/favicon.ico',
          sizes: '48x48',
          type: 'image/x-icon',
        },
      ],
    },
    devOptions: {
      enabled: false,
    },
  },

  // #385: cấu hình build cho runtime Node standalone (Docker) qua khối
  // `$env['node-docker']` — chỉ kích hoạt khi envName đúng bằng `node-docker`,
  // tức `nuxt build --envName=node-docker` (c12 xử lý khối `$env` trong
  // `loadNuxtConfig`; envName tuỳ ý phải nằm trong `$env` — key `$development`
  // có type riêng nhưng KHÔNG được dùng: `nuxt dev` tự đặt envName =
  // `development`, nên khối đó sẽ kích hoạt cả trong `nuxt dev` và làm dev
  // server hỏng trên fresh checkout. Tên Nx configuration vẫn là
  // `development` (contract của target build), chỉ command bên trong mới mang
  // envName.)
  //
  // `nitro.preset` ở đây phải thắng preset `cloudflare-module` của khối
  // `nitro` inline phía trên VÀ merge đè lên plugins shim staff-access trong
  // cùng khối đó: `nuxt.options.nitro` (đã merge xong `$env`) đi
  // vào Nitro ở vị trí overrides, cao hơn config gốc trong precedence của
  // c12 — kiểm chứng bằng build thật, see
  // tests/integrations/dual-build-output.spec.ts.
  //
  // `buildDir` resolve theo `rootDir`, nên `.nuxt-node`/`.output-node` nằm
  // trong thư mục app, không đụng `.nuxt`/`.output` của production — hai build
  // chạy song song an toàn. Build này vẫn cần `.nuxt` tồn tại (project
  // `tsconfig.json` reference `./.nuxt/tsconfig.*.json` mà vite-plugin-checker
  // đọc khi `typescript.typeCheck: true`) — target Nx `build` `dependsOn`
  // `nuxt-prepare` đảm bảo điều đó. Cấu hình PWA/manifest/i18n được kế thừa
  // nguyên vẹn (c12 merge sâu, không thay thế).
  $env: {
    'node-docker': {
      buildDir: '.nuxt-node',
      nitro: {
        // Preset Node server standalone — artifact `.output-node/server/index.mjs`
        // chạy trực tiếp bằng `node`, phục vụ preview/local; không đụng contract
        // wrangler của production.
        preset: 'node-server',
        output: {
          dir: '.output-node',
        },
      },
    },
  },
});
