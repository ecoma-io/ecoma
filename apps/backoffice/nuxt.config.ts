import { defineNuxtConfig } from 'nuxt/config';
import tailwindcss from '@tailwindcss/vite';

import { BACKOFFICE_DATA_MODE_DISABLED } from './app/backoffice-data/data-mode';
import {
  DEFAULT_BACKOFFICE_LOCALE,
  BACKOFFICE_LOCALE_DEFINITIONS,
} from './app/i18n/locale-registry';

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-10-05',
  workspaceDir: '../../',
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
  // Khai ở `nuxt.config.ts` (không phải `nitro.config.ts`) vì đây là khoá
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
    public: {
      backofficeDataMode: BACKOFFICE_DATA_MODE_DISABLED,
      // URL trang profile của `account` (origin + path, vd
      // `https://account.example.com/`) — màn onboarding (#325) dùng nó làm
      // link "đặt tên hiển thị". KHÔNG default: rỗng = deployment chưa cấu
      // hình ⇒ ẩn link thay vì render link chết. Workers cấp qua `vars`
      // (`NITRO_PUBLIC_BACKOFFICE_ACCOUNT_PROFILE_URL`); Node container local
      // qua biến cùng tên trong `.env`.
      backofficeAccountProfileUrl: '',
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
    plugins: [new URL('./server/plugins/staff-access-service-shim.ts', import.meta.url).pathname],
  },
  pwa: {
    registerType: 'prompt',
    workbox: {
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
});
