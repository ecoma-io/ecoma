/**
 * Bề mặt module `#i18n` trong unit test của `backoffice`.
 *
 * App code lấy đúng một thứ từ `#i18n`: `useI18n` — và Nuxt thật cũng chỉ re-export
 * composable của `vue-i18n` qua alias đó. Nên bridge ở đây là một dòng re-export,
 * không có composer giả và không có `t()` giả: `vitest.config.mts` alias `vue-i18n`
 * về **đúng entrypoint thật** mà Nuxt chạy (đường dẫn khám phá trong
 * `node_modules/.pnpm`, vì pnpm không đặt dependency transitive cạnh workspace).
 *
 * ⚠️ Hệ quả: `useI18n()` cần composer đã được cài làm plugin. `tests/harness.ts`
 * truyền `tests/nuxt-globals.ts` → `i18n` vào `global.plugins`, nên composable đọc
 * đúng composer chạy trên catalog thật, và một khẳng định về câu chữ đã dịch kiểm
 * đúng nội dung `app/i18n/locales/` khai.
 */
export { useI18n } from 'vue-i18n';
