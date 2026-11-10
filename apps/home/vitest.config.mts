/// <reference types='vitest' />
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/home',
  // `nxViteTsPaths()` resolve alias `@ecoma-io/*` từ `tsconfig.base.json`;
  // `vue()` transform component `.vue` (nuxt.config.ts cũng khai alias này cho
  // runtime — hai nơi phải khớp, xem `apps/home/nuxt.config.ts`).
  plugins: [nxViteTsPaths(), vue()],
  resolve: {
    // Nuxt alias không tồn tại ngoài Nuxt runtime: `#shared` là output của
    // Nuxt, ở đây phải tự trỏ, còn `~`/`~/` map vào `app/` theo convention
    // Nuxt 4 (`srcDir: app/`).
    alias: {
      '#shared': new URL('./shared', import.meta.url).pathname,
      '~': new URL('./app', import.meta.url).pathname,
      '~/': new URL('./app/', import.meta.url).pathname,
      // `@ecoma-io/ui-ecoma-logo` — library scope:shared duy nhất workspace này
      // tiêu thụ. `nxViteTsPaths()` đọc `paths` từ `tsconfig.base.json`, nhưng
      // file đó để rỗng (`"paths": {}`) — do đó alias phải được khai báo tường
      // minh ở đây, giống `apps/account` làm cho `@ecoma-io/*` của nó. Bỏ qua,
      // test mount `EcomaLogo` sẽ fail với "Cannot find module
      // '@ecoma-io/ui-ecoma-logo'" dù typecheck của app vẫn xanh (tsc chỉ
      // resolve đường dẫn, không cần runtime module).
      '@ecoma-io/ui-ecoma-logo': new URL('../../libs/ui-ecoma-logo/src/index.ts', import.meta.url)
        .pathname,
    },
  },
  test: {
    name: '@ecoma-io/home',
    watch: false,
    globals: true,
    environment: 'jsdom',
    // Nuxt dùng `app/` (pages, domain) và `shared/`, không dùng `src/`;
    // `tests/` chứa static-output (chạy trên output build thật — xem
    // `package.json` target `test` dependsOn `build`) cùng token tests; giữ
    // `src`/`tests` để không phá project được generate.
    //
    // Không còn glob cho `deploy/pipeline/`: pipeline hai làn (overview
    // `02-delivery.md` §7.2) là thiết kế chưa hiện thực — tooling dùng chung
    // cho mọi deploy unit thuộc tầng delivery, đặt trong `apps/home` sẽ khiến
    // app sở hữu code không liên quan tới nó, và repo chặn app import project
    // `scope:local`. Spec của pipeline tương lai sẽ chạy bằng vitest của
    // project tooling đó, không phải của app.
    include: ['{src,tests,app,shared,server}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
