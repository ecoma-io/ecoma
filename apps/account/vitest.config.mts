/// <reference types='vitest' />
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, defaultExclude } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

/**
 * Resolve `vue-i18n` — dependency **transitive** của `@nuxtjs/i18n`.
 *
 * ⚠️ pnpm không đặt dependency transitive ở `node_modules` của workspace, nên
 * `import 'vue-i18n'` **hỏng** ở cả repo lẫn `apps/account`. Nuxt thì không sao: module
 * tự đăng ký alias `#i18n` trỏ vào entrypoint runtime của chính nó. Test mount component
 * thật nên resolve nó bằng **đường tuyệt đối tới file thật** — cùng một bản mà Nuxt chạy,
 * không phải một bản `vue-i18n` khác.
 *
 * ⚠️ Vì sao phải khám phá `node_modules/.pnpm` thay vì viết thẳng tên phiên bản: pnpm
 * đặt tên thư mục theo bản dependency + peer deps, nên một đường dẫn viết tay
 * (`vue-i18n@11.4.14_vue@3.5.43_typescript@6.0.3_`) hỏng ngay lần `@nuxtjs/i18n` nâng
 * cấp. Dò directory thì sống sót qua các bản nâng cấp đó.
 *
 * ⚠️ Vì sao `.mjs` chứ không phải bundle `esm-bundler`: file bundler được viết cho
 * bundler có `process.env.NODE_ENV`, và ở test biến đó không tồn tại — build sẽ đọc nó
 * là `undefined` rồi đi vào nhánh dev kèm cảnh báo. `.mjs` là build hoàn chỉnh, không cần
 * biến môi trường nào.
 *
 * ⚠️ Không phải cách lách `vue-i18n` thành dependency trực tiếp: không mục nào trong
 * `package.json` thêm nó, và production vẫn resolve qua module — thêm vào đây chỉ làm
 * manifest nói dối về dependency thực tế.
 */
function vueI18nEntry(): string {
  const pnpm = resolve(import.meta.dirname, '../../node_modules/.pnpm');
  if (!existsSync(pnpm)) {
    throw new Error(`pnpm store not found at ${pnpm} — the vue-i18n alias would point nowhere`);
  }
  const directory = readdirSync(pnpm).find((name) => /^vue-i18n@[^_]+_/u.test(name));
  if (directory === undefined) {
    throw new Error(`no vue-i18n directory under ${pnpm} — is @nuxtjs/i18n still installed?`);
  }
  const entry = resolve(pnpm, directory, 'node_modules/vue-i18n/dist/vue-i18n.mjs');
  if (!existsSync(entry)) {
    throw new Error(`vue-i18n found at ${directory} but ${entry} is missing`);
  }
  return entry;
}

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/account',
  plugins: [vue()],
  resolve: {
    /**
     * Nuxt alias không tồn tại ngoài Nuxt runtime.
     *
     * ⚠️ `#app` và `#i18n` trỏ vào **bridge của test**
     * (`tests/nuxt-runtime-bridge.ts`), không phải `nuxt/dist/app` hay entrypoint runtime
     * của `@nuxtjs/i18n`. Lý do: `nuxt/dist/app` tự dựng context Nuxt riêng, tách khỏi
     * state mà test kiểm soát — `useState` trong component sẽ đọc một store khác store mà
     * test kiểm tra; còn entrypoint của `@nuxtjs/i18n` còn import `#imports` nên không
     * load được ngoài Nuxt.
     *
     * Đường dẫn viết từ `import.meta.dirname` chứ không dùng `fileURLToPath`: Vite bundle
     * config vào `node_modules/.vite-temp/…`, nên `import.meta.url` ở đây **không** phải
     * URL file và `new URL('./app', import.meta.url)` trỏ vào thư mục sai.
     */
    alias: [
      // `~/` map vào `app/` theo convention Nuxt 4 (`srcDir: app/`).
      { find: /^~\//u, replacement: `${import.meta.dirname}/app/` },
      { find: /^~$/u, replacement: `${import.meta.dirname}/app` },
      { find: /^#app$/u, replacement: `${import.meta.dirname}/tests/nuxt-runtime-bridge.ts` },
      { find: /^#i18n$/u, replacement: `${import.meta.dirname}/tests/nuxt-runtime-bridge.ts` },
      { find: /^vue-i18n$/u, replacement: vueI18nEntry() },
    ],
  },
  test: {
    name: '@ecoma-io/account',
    watch: false,
    globals: true,
    environment: 'jsdom',
    // ⚠️ Bridge phải nạp trước **mọi** module app: composable trong
    // `app/composables/` gọi `useState()` ở phạm vi module. Xem `tests/setup.ts`.
    setupFiles: ['./tests/setup.ts'],
    // Nuxt dựng app trong `app/` (srcDir của Nuxt 4), không dùng `src/`; spec
    // colocated cạnh code subject (`app/`, `server/`). `tests/` giữ lại cho phần
    // support chung (harness, bridge) và những spec có subject ở chính `tests/`.
    // ⚠️ Suite integration nằm ở `tests/integrations/` + `tests/databases/` và
    // chạy qua target `test-integration` với config riêng
    // (`vitest.integration.config.mts`). Include bên dưới phủ `tests/**` (spec
    // colocated với support nằm ở `tests/`), nên phải exclude đúng hai thư mục
    // mục đích đó — nếu không, mọi suite integration chạy HAI lần (cả `test`
    // lẫn `test-integration`) (06-testing.md §4).
    include: ['{src,tests,app,server}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: [...defaultExclude, 'tests/integrations/**', 'tests/databases/**'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
