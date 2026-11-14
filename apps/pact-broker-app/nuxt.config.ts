import { defineNuxtConfig } from 'nuxt/config';
import tailwindcss from '@tailwindcss/vite';

import { APP_SHELL_COLOR_MODE_BOOTSTRAP_SCRIPT } from '@ecoma-io/ui-app-shell/lib/color-mode';
import {
  DEFAULT_PACT_BROKER_LOCALE,
  PACT_BROKER_LOCALE_DEFINITIONS,
} from './app/i18n/locale-registry';

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-10-05',
  workspaceDir: '../../',
  // `pact-broker-app` là **non-SSR SPA** (issue #68, convention chung của issue
  // cha #66): render xảy ra ở client, server chỉ phục vụ static asset và các
  // route server (BFF `/api/broker/**`, `/health`, `/ready`).
  //
  // Khai **tường minh**, không dựa vào default của framework: Nuxt 4.6.2
  // resolve `ssr` thành `true` khi key vắng mặt (`@nuxt/schema` 4.6.2), nên
  // "không khai" nghĩa là SSR và một bản nâng cấp framework có thể đổi hành vi
  // sau lưng. Cùng cách `apps/llm-console` và `apps/backoffice` đã làm.
  //
  // Non-SSR **không** bỏ Nitro: preset `cloudflare-module` vẫn emit
  // `.output/server/index.mjs` (`nitro.config.ts`) và mọi route server vẫn chạy
  // server-side trên Worker lẫn container local. Đây chỉ là tắt bước render HTML
  // phía server — shell cho client router do route `/**` của Nitro trả.
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
    // 4201 backoffice, 4202 account, 4204 pact-broker-api (dev của wrangler).
    port: 4205,
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
    defaultLocale: DEFAULT_PACT_BROKER_LOCALE,
    locales: PACT_BROKER_LOCALE_DEFINITIONS.map(({ code, language, label }) => ({
      code,
      language,
      name: label,
    })),
    restructureDir: 'app/i18n',
    vueI18n: './vue-i18n.config.ts',
  },
  runtimeConfig: {
    // Địa chỉ của `pact-broker-api` mà BFF gọi. KHÔNG có token nào ở đây nữa:
    // ADR-0031 §5 retire hẳn machine token của BFF — BFF forward access token
    // **của chủ phiên**, API tự verify + phân quyền (ADR-0032). Browser không
    // bao giờ thấy token nào (token nằm ở cookie HttpOnly phía server).
    //
    // Giá trị runtime đến từ biến môi trường `NITRO_PACT_BROKER_*` (Nitro
    // `applyEnv` phủ lên giá trị build-time dưới đây), khai tường minh cho
    // từng env trong `wrangler.jsonc` — `vars` không inherit giữa các env;
    // secret thật thì dùng Worker Secrets, không phải `vars`.
    pactBrokerApiBaseUrl: '',
    // Connection string PostgreSQL local (Node container) — **private**, không
    // vào `public`/client bundle/log. Workers dùng binding Hyperdrive
    // `DB_PACT_BROKER_APP`, không dùng key này.
    pactBrokerAppDatabaseUrl: '',
    // Cấu hình OIDC của portal (ADR-0031 §2) — **private**, cùng luật
    // `NUXT_*` của `backoffice`: `pactBrokerAuthIssuer` ←
    // `NITRO_PACT_BROKER_AUTH_ISSUER`. Workers đọc các giá trị này từ `env`
    // của Worker (`PACT_BROKER_AUTH_*`), Node container local đọc từ đây.
    // KHÔNG default: thiếu biến là fail-closed 503 ở middleware authn
    // (`server/auth/config.ts`), không phải "chạy với giá trị rỗng".
    pactBrokerAuthIssuer: '',
    pactBrokerAuthAudience: '',
    pactBrokerAuthClientId: '',
    // Origin fetch server-side tới `auth` — **tuỳ chọn** (đối lập ba biến trên):
    // rỗng = mọi fetch JWKS/token dựng URL từ issuer như production; có giá
    // trị (local: origin nội bộ do pact-broker-app-deploy cấp) = fetch từ
    // origin nội bộ vì container không resolve được hostname issuer. Issuer vẫn
    // là danh tính `iss`/authorize — chỉ fetch origin đổi. Xem JSDoc của
    // `server/auth/config.ts`.
    pactBrokerAuthInternalOrigin: '',
  },
});
