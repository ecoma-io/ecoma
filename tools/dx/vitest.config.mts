import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/tools/dx',
  test: {
    name: '@ecoma-io/dx',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    // Spec của dx chấm commit message bằng tiến trình commitlint thật (spawn
    // mỗi case; mỗi tiến trình lại spawn tiếp process đọc Nx project graph).
    // Khi `nx affected -t test` chạy full — 15 project cùng chạy song song trên
    // một runner — một lần spawn có thể mất tới vài giây, vượt quá default 5s
    // của vitest. Biên độ này là cho toàn project thay cho các con số 15s/30s
    // rời rạc từng test (và các test spawn khác không còn chạy với default 5s).
    testTimeout: 120_000,
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
