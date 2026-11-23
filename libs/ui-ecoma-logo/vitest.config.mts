import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/ui-ecoma-logo',
  // `resolve.tsconfigPaths` (native Vite) resolve alias tsconfig
  // (`@ecoma-io/*`), vue() transform component `.vue` — đặt sau vì transform
  // pipeline đọc theo thứ tự.
  // Không cần copy-assets: vitest không emit build output, còn spec đọc asset
  // thẳng từ source qua `readFileSync` (xem `ecoma-logo.spec.ts`).
  plugins: [vue()],
  resolve: {
    // Vite native thay cho plugin `vite-tsconfig-paths` (deprecated).
    tsconfigPaths: true,
  },
  test: {
    name: '@ecoma-io/ui-ecoma-logo',
    watch: false,
    globals: true,
    // node là default — pure asset URL/export surface phải chạy được mà không
    // có DOM; component test tự khai `// @vitest-environment jsdom` riêng.
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/libs/ui-ecoma-logo',
      provider: 'v8' as const,
    },
  },
}));
