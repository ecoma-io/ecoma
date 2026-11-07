import { defineConfig } from 'vitest/config';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { nxCopyAssetsPlugin } from '@nx/vite/plugins/nx-copy-assets.plugin';
import vue from '@vitejs/plugin-vue';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/ui-ecoma-logo',
  // nxViteTsPaths resolve alias tsconfig (`@ecoma-io/*`), vue() transform
  // component `.vue` — đặt sau vì transform pipeline đọc theo thứ tự.
  plugins: [nxViteTsPaths(), nxCopyAssetsPlugin(['*.md']), vue()],
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
