/**
 * `@ecoma-io/ui-app-shell` — bộ khung dashboard dùng chung cho `backoffice`,
 * `llm-console`, `llm-seller`, `pact-broker-app` và `remote-cache-app`, port từ
 * https://github.com/dianprata/nuxt-shadcn-dashboard
 * (commit 54988681e50feaa4935828882da93faff06cf042, MIT).
 *
 * Hai tầng:
 *
 * - `./lib/ui` — primitive shadcn-vue (button, sidebar, dialog…) không chứa ngữ
 *   nghĩa sản phẩm. Dùng trực tiếp khi dựng nội dung trang.
 * - `./lib/shell` — bố cục dashboard hoàn chỉnh và cấu hình của nó.
 * - `./lib/color-mode` — chế độ màu light/dark/system, cookie và script bootstrap
 *   quyết định class `dark` trước first paint (issue #213).
 *
 * CSS là một entry riêng, không import trong entry TS:
 * `@ecoma-io/ui-app-shell/styles/app-shell.css`. Xem README của library.
 */
export { cn } from './lib/utils';
export * from './lib/color-mode';
export * from './lib/shell';
export * from './lib/ui';
