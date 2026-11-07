/// <reference types='vitest' />
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * Test của library chạy trên hai nhóm đối tượng khác nhau:
 *
 * - hàm thuần (`preferences/*`, `shell/breadcrumb.ts`, tham số hoá của shell) —
 *   chạy trong jsdom cho đồng nhất với nhóm dưới;
 * - component (`shell/*.vue`, `ui/*`) — cần `vue()` để biên dịch SFC và jsdom
 *   cho `document`/`window`.
 *
 * `NuxtLink` là component global của Nuxt, không tồn tại ngoài runtime đó; test
 * nào mount shell thì tự cấp một stub qua `src/lib/testing/nuxt-env.ts` (kèm
 * `matchMedia`/`ResizeObserver` mà jsdom thiếu), không thêm dependency vào Nuxt
 * chỉ để chạy test.
 *
 * `setupFiles` trỏ vào chính module đó, không phải để tiện import: vitest nạp
 * setup file **trước mọi module của test file**, nên global của jsdom có mặt
 * trước khi `reka-ui` (hay bất kỳ dependency nào) được evaluate. Tự import
 * trong từng spec thì thứ tự ngược lại — `import { useDirection } from 'reka-ui'`
 * ở đầu spec chạy trước — và spec nào quên import sẽ chết ở
 * `TypeError: window.matchMedia is not a function` giữa một component không
 * liên quan. Cùng cách đặt như `apps/account/tests/setup.ts`.
 */
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/ui-app-shell',
  plugins: [vue()],
  test: {
    name: '@ecoma-io/ui-app-shell',
    watch: false,
    globals: true,
    environment: 'jsdom',
    // `css: true` vi Vitest mac dinh `css: false` thay moi import CSS bang
    // chuoi rong — ke ca `?raw`. Test doi chieu bang mau trong
    // `lib/preferences/types.ts` voi `.color-*` that trong
    // `styles/app-shell.css` doc chinh file do qua `?raw`, nen phai tat che do
    // thay the; khong bat thi phep so sanh do luon dung mot cach vo nghia.
    css: true,
    setupFiles: ['./src/lib/testing/nuxt-env.ts'],
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    passWithNoTests: true,
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
