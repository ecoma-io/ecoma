/// <reference types='vitest' />
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * Resolve `vue-i18n` — dependency **transitive** của `@nuxtjs/i18n`.
 *
 * ⚠️ pnpm không đặt dependency transitive ở `node_modules` của workspace, nên
 * `import 'vue-i18n'` **hỏng** ở cả repo lẫn app này. Nuxt thì không sao: module tự
 * đăng ký alias `#i18n` trỏ vào entrypoint runtime của chính nó. Test mount component
 * thật nên resolve nó bằng **đường tuyệt đối tới file thật** — cùng một bản mà Nuxt
 * chạy, không phải một bản `vue-i18n` khác.
 *
 * ⚠️ Vì sao phải khám phá `node_modules/.pnpm` thay vì viết thẳng tên phiên bản: pnpm
 * đặt tên thư mục theo bản dependency + peer deps, nên một đường dẫn viết tay hỏng
 * ngay lần `@nuxtjs/i18n` nâng cấp. Dò directory thì sống sót qua các bản nâng cấp đó.
 *
 * ⚠️ Vì sao `.mjs` chứ không phải bundle `esm-bundler`: file bundler được viết cho
 * bundler có `process.env.NODE_ENV`, và ở test biến đó không tồn tại — build sẽ đọc nó
 * là `undefined` rồi đi vào nhánh dev kèm cảnh báo. `.mjs` là build hoàn toàn, không
 * cần biến môi trường nào.
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
  cacheDir: '../../node_modules/.vite/apps/pact-broker-app',
  resolve: {
    /**
     * Nuxt alias không tồn tại ngoài Nuxt runtime.
     *
     * ⚠️ `#app` trỏ vào **bridge của test** (`tests/nuxt-app-bridge.ts`), không phải
     * `nuxt/dist/app`: module thật tự dựng context Nuxt riêng, tách khỏi state mà test
     * kiểm soát — `useNuxtApp()` trong component trả một object khác object mà harness
     * gắn vào, và test page sẽ xanh nhầm. Cùng lý do, `#i18n` trỏ vào
     * `tests/nuxt-i18n-bridge.ts` (re-export `useI18n` của đúng bản `vue-i18n` dưới
     * đây): entrypoint runtime của `@nuxtjs/i18n` còn import `#imports` nên không load
     * được ngoài Nuxt.
     *
     * Đường dẫn viết từ `import.meta.dirname` chứ không dùng `fileURLToPath`: Vite bundle
     * config vào `node_modules/.vite-temp/…`, nên `import.meta.url` ở đây **không** phải
     * URL file và `new URL('./app', import.meta.url)` trỏ vào thư mục sai.
     */
    alias: [
      // `~/` map vào `app/` theo convention Nuxt 4 (`srcDir: app/`).
      { find: /^~\//u, replacement: `${import.meta.dirname}/app/` },
      { find: /^~$/u, replacement: `${import.meta.dirname}/app` },
      { find: /^#app$/u, replacement: `${import.meta.dirname}/tests/nuxt-app-bridge.ts` },
      { find: /^#i18n$/u, replacement: `${import.meta.dirname}/tests/nuxt-i18n-bridge.ts` },
      { find: /^vue-i18n$/u, replacement: vueI18nEntry() },
    ],
  },
  plugins: [vue()],
  test: {
    name: '@ecoma-io/pact-broker-app',
    watch: false,
    globals: true,
    environment: 'jsdom',
    // `tests/setup.ts` cài global của Nuxt **trước** mọi test file: component gọi
    // tên trần (`useRoute`, `useHead`, `onMounted`) lúc `setup()`, và global phải
    // có mặt trước lần render đầu.
    setupFiles: ['./tests/setup.ts'],
    // ⚠️ `app` nằm trong include từ khi spec colocated đầu tiên của `app/`
    // xuất hiện (`app/pages/pacts.spec.ts` — 06-testing.md §2: spec colocated
    // nằm cạnh subject trong owning project). `src`/`server`/`tests` giữ nguyên
    // theo contract của PR-A/#299.
    include: ['{src,app,tests,server}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
