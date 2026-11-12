import { defineConfig, defaultExclude } from 'vitest/config';

/**
 * Config cua target `test` — chi spec colocated voi subject (06-testing.md §4:
 * `test` = colocated unit/component cua project so huu). Runtime Worker la
 * TypeScript: unit spec nam trong `src/` ben canh file nguon (port cua unit
 * test Rust cu); include ben duoi phu `src/**` de bat dung chung do.
 *
 * ⚠️ `passWithNoTests: false` LA CHU Y DELIBERATE cua project nay (khac chuan
 * `true` o cac app khac): unit suite la buoc chung minh bat buoc cua viec port
 * runtime (9 unit test Rust phai co port tuong duong o day) — "khong test nao
 * chay" phai DO de viec doi include/path khong lam target chay rong ma van
 * xanh. Khong sua gia tri nay o cac app khac.
 *
 * Suite integration (PostgreSQL that qua testcontainers) nam duoi
 * `tests/integrations/` + `tests/databases/` va chay qua target
 * `test-integration` voi config rieng (`vitest.integration.config.mts`) —
 * exclude ben duoi dam bao target `test` khong nham suite do.
 */
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/llm-api',
  test: {
    name: '@ecoma-io/llm-api',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests,db}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: [...defaultExclude, 'tests/integrations/**', 'tests/databases/**'],
    passWithNoTests: false,
    reporters: ['default'],
    // `pg` phải đi qua dependency optimizer thì `vi.mock('pg')` mới có hiệu
    // lực (Vitest 4 externalize node_modules mặc định — mock bị bỏ qua, unit
    // test của `src/connections.ts` sẽ chạy nhầm client thật và thử kết nối
    // mạng). Chỉ ảnh hưởng unit target; suite integration chạy worker thật,
    // không mock pg.
    deps: {
      optimizer: {
        ssr: {
          include: ['pg'],
        },
      },
    },
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
