import { defineNuxtConfig } from 'nuxt/config';
import tailwindcss from '@tailwindcss/vite';

import {
  DEFAULT_PACT_BROKER_LOCALE,
  PACT_BROKER_LOCALE_DEFINITIONS,
} from './app/i18n/locale-registry';

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-10-05',
  workspaceDir: '../../',
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
    // Secret của BFF khai chuỗi rỗng — KHÔNG BAO GIỜ default có giá trị đoán
    // được: default rỗng biến "chưa cấu hình" thành "chạy được với secret
    // rỗng", mà BFF với broker token rỗng thì mọi request dashboard bị API
    // từ chối 401 (fail closed ở chiều đúng). `server/plugins/config.ts`
    // kiểm lúc request và trả 503 — mới là fail closed rõ ràng.
    //
    // Giá trị runtime đến từ biến môi trường `NITRO_PACT_BROKER_*` (Nitro
    // `applyEnv` phủ lên giá trị build-time dưới đây), khai tường minh cho
    // từng env trong `wrangler.jsonc` — `vars` không inherit giữa các env;
    // secret thật thì dùng Worker Secrets, không phải `vars`.
    pactBrokerApiBaseUrl: '',
    pactBrokerApiToken: '',
  },
});
