/// <reference types='vitest' />
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, defaultExclude } from 'vitest/config';
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
 * đặt tên thư mục theo bản dependency + peer deps, nên một đường dẫn viết tay
 * (`vue-i18n@11.4.14_vue@3.5.43_typescript@6.0.3_`) hỏng ngay lần `@nuxtjs/i18n` nâng
 * cấp. Dò directory thì sống sót qua các bản nâng cấp đó.
 *
 * ⚠️ Vì sao `.mjs` chứ không phải bundle `esm-bundler`: file bundler được viết cho
 * bundler có `process.env.NODE_ENV`, và ở test biến đó không tồn tại — build sẽ đọc nó
 * là `undefined` rồi đi vào nhánh dev kèm cảnh báo. `.mjs` là build hoàn chỉnh, không
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
  cacheDir: '../../node_modules/.vite/apps/backoffice',
  resolve: {
    /**
     * Nuxt alias không tồn tại ngoài Nuxt runtime.
     *
     * ⚠️ `#app` trỏ vào **bridge của test** (`tests/nuxt-app-bridge.ts`), không phải
     * `nuxt/dist/app`: module thật tự dựng context Nuxt riêng, tách khỏi state mà test
     * kiểm soát — `useNuxtApp()` trong component trả một object khác object mà harness
     * gắn adapter vào, và test page sẽ xanh nhầm. Cùng lý do, `#i18n` trỏ vào
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
    name: '@ecoma-io/backoffice',
    watch: false,
    globals: true,
    environment: 'jsdom',
    // `DrawerRoot` của `vaul-vue` (qua `AppShellSettingsPanel` → `AppShell` →
    // `app.vue`) đăng ký một `setTimeout(…, 200)` chạm `document.body` bên trong
    // một `watchEffect` và "dọn" nó bằng cách **return** cleanup từ callback.
    // Vue chỉ nhận cleanup qua tham số `onCleanup` của `watchEffect` — giá trị
    // return bị bỏ qua (xem `@vue/reactivity` `doWatch`, nhánh `isFunction(source)`
    // không có `cb`) — nên timer KHÔNG BAO GIỜ được hủy lúc unmount. jsdom teardown
    // gỡ `document` khỏi global mà không hủy timer Node trần, và trên CI chậm
    // (toàn file ~2.3s so với ~0.5s local) timer bắn sau teardown:
    // `ReferenceError: document is not defined` — 169/169 test vẫn xanh nhưng run
    // exit 1. Lọc ĐÚNG MỘT hình dạng đó: cùng message, cùng frame vaul-vue trong
    // stack. Bất kỳ lỗi nào khác (hay vaul-vue đổi code) vẫn làm run đỏ.
    // Không thể sửa ở nguồn: file nằm trong store pnpm (hardlink với node_modules).
    //
    // ⚠️ error qua RPC là object ĐÃ serialize, không phải Error: đọc thẳng
    // `error.message`/`error.stack` như dưới. `String(error)` NÉM
    // "Cannot convert object to primitive value", exception trong callback này
    // làm `StateManager.catchError` chết TRƯỚC khi add — tức nuốt luôn mọi
    // unhandled error khác (đã đo: phiên `String(error)` làm TypeError control
    // thoát exit 0). Đây là phép đo, không phải suy đoán.
    onUnhandledError(error): boolean {
      const message = (error as { message?: unknown }).message;
      if (message !== 'document is not defined') {
        return true;
      }
      const stack = (error as { stack?: unknown }).stack;
      return !(typeof stack === 'string' && stack.includes('/vaul-vue/dist/index.js'));
    },
    // `tests/setup.ts` cài global của Nuxt **trước** mọi test file: `app.vue` và
    // `useAsyncState()` gọi tên trần (`useRoute`, `useHead`, `onMounted`) lúc `setup()`,
    // và global phải có mặt trước lần render đầu.
    setupFiles: ['./tests/setup.ts'],
    // ⚠️ Suite integration nằm ở `tests/integrations/` + `tests/databases/` và
    // chạy qua target `test-integration` với config riêng
    // (`vitest.integration.config.mts`). Include bên dưới phủ `tests/**` (spec
    // colocated với support nằm ở `tests/`), nên phải exclude đúng hai thư mục
    // mục đích đó — nếu không, mọi suite integration chạy HAI lần (cả `test`
    // lẫn `test-integration`) (06-testing.md §4).
    include: ['{src,app,tests,server}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: [...defaultExclude, 'tests/integrations/**', 'tests/databases/**'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
