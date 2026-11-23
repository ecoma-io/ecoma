import { defineNuxtConfig } from 'nuxt/config';
import tailwindcss from '@tailwindcss/vite';

import { APP_SHELL_COLOR_MODE_BOOTSTRAP_SCRIPT } from '@ecoma-io/ui-app-shell/lib/color-mode';
import {
  DEFAULT_REMOTE_CACHE_APP_LOCALE,
  REMOTE_CACHE_APP_LOCALE_DEFINITIONS,
} from './app/i18n/locale-registry';

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-10-05',
  workspaceDir: '../../',
  // `docs/applications/remote-cache/01-architecture.md` §1–§2 chốt app này là
  // **non-SSR SPA**: render xảy ra ở client, server chỉ phục vụ static asset +
  // BFF route. Pact-broker-app dựa vào mặc định SPA của Nuxt 4; ở đây khai
  // tường minh để ràng buộc kiến trúc không phụ thuộc vào một default của
  // framework có thể đổi.
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
    // 4201 backoffice, 4202 account, 4203 auth, 4204 pact-broker-api,
    // 4205 pact-broker-app, 4206 staff-access, 4207 remote-cache-api,
    // 4208 llm-console, 4209 llm-seller. 4210 là của app này.
    port: 4210,
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
  // `@ecoma-io/*` không resolve được qua tsconfig paths (`tsconfig.base.json`
  // có `paths: {}` rỗng và `vite.resolve.tsconfigPaths` chỉ đọc paths) — alias
  // tường minh là bắt buộc, không phải tuỳ chọn. Không có alias thì import
  // trong `server/` chỉ nổ ở request đầu tiên chạm route đó (dev 500,
  // production 500 theo cold start). Dùng `new URL(...).pathname`, không
  // `node:path` — `.oxlintrc.json` cấm Node builtin trong `apps/**`.
  alias: {
    '@ecoma-io/ui-app-shell': new URL('../../libs/ui-app-shell/src/index.ts', import.meta.url)
      .pathname,
    '@ecoma-io/ui-ecoma-logo': new URL('../../libs/ui-ecoma-logo/src/index.ts', import.meta.url)
      .pathname,
    // Contracts của envelope HMAC nội bộ (`server/control-plane.ts`) — lib
    // `runtime:universal` không đi qua Nuxt build pipeline tự động; alias tường
    // minh là bắt buộc, cùng lý do với hai lib UI phía trên.
    '@ecoma-io/internal-auth-contracts': new URL(
      '../../libs/internal-auth-contracts/src/index.ts',
      import.meta.url,
    ).pathname,
  },
  css: ['~/assets/css/styles.css'],
  vite: {
    resolve: { tsconfigPaths: true },
    server: { allowedHosts: true },
    plugins: [tailwindcss()],
  },
  modules: ['@nuxt/fonts', '@nuxtjs/i18n'],
  fonts: {
    defaults: {
      // Shell đặt `font-synthesis-weight: none`, nên face thiếu weight không
      // được tải — `@nuxt/fonts` chỉ lấy weight 400 nếu app không khai đủ.
      weights: [300, 400, 500, 600, 700, 800],
    },
  },
  i18n: {
    strategy: 'no_prefix',
    detectBrowserLanguage: false,
    defaultLocale: DEFAULT_REMOTE_CACHE_APP_LOCALE,
    locales: REMOTE_CACHE_APP_LOCALE_DEFINITIONS.map(({ code, language, label }) => ({
      code,
      language,
      name: label,
    })),
    restructureDir: 'app/i18n',
    vueI18n: './vue-i18n.config.ts',
  },
  // RuntimeConfig private của BFF (ADR-0035): mọi key đều **không default** —
  // vắng mặt là trạng thái "chưa cấu hình" mà middleware authn / proxy portal /
  // `/ready` fail closed (503), không bao giờ là "chạy được với giá trị rỗng".
  // Trên Workers giá trị đi qua `env` của Worker (`REMOTE_CACHE_AUTH_*`,
  // `REMOTE_CACHE_API_BASE_URL`, `INTERNAL_AUTH_SECRET`); trên Node container
  // local đi qua `NITRO_*` ở đây. Secret không bao giờ nằm trong Git.
  runtimeConfig: {
    remoteCacheAuthIssuer: '',
    remoteCacheAuthAudience: '',
    remoteCacheAuthClientId: '',
    remoteCacheAuthInternalOrigin: '',
    remoteCacheApiBaseUrl: '',
    internalAuthSecret: '',
    remoteCacheAppDatabaseUrl: '',
    // Public cho client (SPA đọc qua `useRuntimeConfig().public`): tên tenant
    // canonical (ADR-0020 Q9) và cache endpoint hiển thị ở trang onboarding
    // (R21). Vắng mặt ⇒ trang trả trạng thái unavailable — fail-closed, không
    // bao giờ đoán tên tenant. Trên Workers đi qua `NUXT_PUBLIC_*` của Worker
    // env; không nằm trong nhánh private vì client cần đọc.
    public: {
      remoteCacheTenantName: '',
      remoteCacheCacheEndpoint: '',
    },
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
  // Không dùng `cloudflare` (preset legacy) và không dùng `cloudflare-pages`
  // (ghi ra `dist/_worker.js` lệch với `main` trong wrangler.jsonc).
  nitro: {
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
      // Đây là cùng cách sửa với `apps/backoffice`, `apps/account` và
      // `apps/pact-broker-app` — cùng file shim được copy sang app này.
      'pg-native': new URL('./server/lib/pg-native.cjs', import.meta.url).pathname,
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
  // `nitro` inline phía trên (kèm alias `pg-native`): `nuxt.options.nitro` (đã
  // merge xong `$env`) đi vào Nitro ở vị trí overrides, cao hơn config gốc
  // trong precedence của c12 — kiểm chứng bằng build thật, see
  // tests/integrations/dual-build-output.spec.ts.
  //
  // `buildDir` resolve theo `rootDir`, nên `.nuxt-node`/`.output-node` nằm
  // trong thư mục app, không đụng `.nuxt`/`.output` của production — hai build
  // chạy song song an toàn. Build này vẫn cần `.nuxt` tồn tại (project
  // `tsconfig.json` reference `./.nuxt/tsconfig.*.json` mà vite-plugin-checker
  // đọc khi `typescript.typeCheck: true`) — target Nx `build` `dependsOn`
  // `nuxt-prepare` đảm bảo điều đó.
  $env: {
    'node-docker': {
      buildDir: '.nuxt-node',
      nitro: {
        // Preset Node server standalone — artifact `.output-node/server/index.mjs`
        // chạy trực tiếp bằng `node`, phục vụ preview/local; không đụng contract
        // wrangler của production. Alias `pg-native` của khối `nitro` inline
        // phía trên không
        // còn tác dụng trên preset này (node-server external hoá `pg` thay vì
        // bundle — `pg.native` chỉ được nạp khi có người chủ động truy cập,
        // app không làm vậy).
        preset: 'node-server',
        output: {
          dir: '.output-node',
        },
      },
    },
  },
});
