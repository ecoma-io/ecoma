import { defineNuxtConfig } from 'nuxt/config';
import tailwindcss from '@tailwindcss/vite';

import {
  DEFAULT_LLM_SELLER_LOCALE,
  LLM_SELLER_LOCALE_DEFINITIONS,
} from './app/i18n/locale-registry';

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-10-05',
  workspaceDir: '../../',
  // `docs/applications/llm-seller/01-architecture.md` §1–§2 chốt app này là
  // **non-SSR SPA**: render xảy ra ở client, server chỉ phục vụ static asset +
  // BFF route. Pact-broker-app dựa vào mặc định SPA của Nuxt 4; ở đây khai
  // tường minh để ràng buộc kiến trúc không phụ thuộc vào một default của
  // framework có thể đổi.
  ssr: false,
  devtools: { enabled: true },
  devServer: {
    host: '0.0.0.0',
    // 4201 backoffice, 4202 account, 4203 auth, 4204 pact-broker-api,
    // 4205 pact-broker-app, 4206 staff-access, 4207 llm-api,
    // 4208 llm-console (dev của wrangler).
    port: 4209,
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
    defaultLocale: DEFAULT_LLM_SELLER_LOCALE,
    locales: LLM_SELLER_LOCALE_DEFINITIONS.map(({ code, language, label }) => ({
      code,
      language,
      name: label,
    })),
    restructureDir: 'app/i18n',
    vueI18n: './vue-i18n.config.ts',
  },
  // Không có `runtimeConfig`: app này chưa có BFF route nào cần cấu hình hay
  // secret (chỉ `/health`, `/ready` và static asset). Khi BFF thật xuất hiện,
  // khai key tường minh ở đây và `vars` cho từng env trong `wrangler.jsonc` —
  // không default một giá trị đoán được, vì default rỗng biến "chưa cấu hình"
  // thành "chạy được với giá trị rỗng" thay vì fail closed.
});
