# UI App Shell

Shell dashboard dùng chung (`@ecoma-io/ui-app-shell`) cho các app Nuxt trong repo: `apps/backoffice`, `apps/pact-broker-app`, `apps/llm-console`, `apps/llm-seller`, `apps/remote-cache-app`. Hai tầng — primitive shadcn-vue không chứa ngữ nghĩa sản phẩm, và bố cục dashboard hoàn chỉnh — port từ [dianprata/nuxt-shadcn-dashboard](https://github.com/dianprata/nuxt-shadcn-dashboard) (commit `54988681e50feaa4935828882da93faff06cf042`, MIT); repository nguồn là bản tham chiếu, banner nguồn giữ nguyên ở các file port.

Nx project `@ecoma-io/ui-app-shell`, tags `type:application`, `scope:shared`, `runtime:universal`.

## Purpose

- Một shell duy nhất cho mọi app dashboard: cùng bố cục sidebar/header/breadcrumb/command palette, cùng hệ token CSS, cùng hành vi responsive — app chỉ đưa nav và nội dung trang.
- Giữ shell ở chế độ duy nhất mà Ecoma dùng: luôn dark mode, sidebar variant `sidebar`, typography `default` — người dùng chỉ cấu hình được `themeColor` và `direction`.

## Responsibilities

Entry TS `src/index.ts` export bốn nhóm:

- **`./lib/shell`** — `AppShell` và các mảnh con (`AppShellSidebar`, `AppShellHeader`, `AppShellNav`, `AppShellBreadcrumb`, `AppShellSearch`, `AppShellSettingsPanel`, `AppShellSidebarNavGroup`, `AppShellSidebarNavLink`), kiểu nav/command/breadcrumb, `useAppShell`, `useAppShellCommandPaletteShortcut`, `appShellBreadcrumbLinks`, `DEFAULT_APP_SHELL_LABELS`. `AppShell` là component thuần: không đọc/ghi cookie, không đọc route, không giữ bản sao cấu hình — app truyền `preferences` bằng prop, nhận lại qua `update:preferences`, đưa nav qua prop và thương hiệu/menu tài khoản qua slot (`brand`, `actions`, `footer`, slot mặc định).
- **`./lib/ui`** — primitive shadcn-vue theo thư mục nguồn (avatar, badge, breadcrumb, button, collapsible, command, dialog, drawer, dropdown-menu, input, kbd, label, scroll-area, separator, sheet, sidebar, skeleton, tooltip); dùng trực tiếp khi dựng nội dung trang.
- **`./lib/preferences`** — cấu hình người dùng: `AppShellPreferences` (`themeColor` từ `APP_SHELL_THEME_COLORS` — 9 giá trị; `direction` `'ltr' | 'rtl'`), cookie `app_shell_preferences`, `parseAppShellPreferences` (luôn trả giá trị hợp lệ — cookie hỏng rơi về `DEFAULT_APP_SHELL_PREFERENCES`), `appShellHeadAttributes`, `appShellColorClass`, `migrateLegacyAppSettings` cho khoá cũ `app_settings`.
- **`cn`** — helper ghép class.

CSS là entry riêng, không import trong entry TS: `src/styles/app-shell.css`. Consumer `@import` file này (đường dẫn **tương đối**, không specifier package — alias của app áp cho cả resolver stylesheet của Tailwind và build đỏ `ENOTDIR`) và đăng ký `@source` tới source của lib; mọi app consumer giữ một test ghim số cấp `..` (ví dụ `apps/backoffice/app/assets/css/styles.spec.ts`, `apps/remote-cache-app/tests/tailwind-source.spec.ts`) vì đếm sai một cấp là lỗi im lặng của Tailwind.

## Boundaries

- Shell không sở hữu dữ liệu điều hướng, quyền hạn, xác thực hay route — mọi thứ đó thuộc app consumer.
- `AppShell` không biết `NuxtPage` hay router của app nào; truy vấn media (`useAppShellMediaQuery`) chỉ đọc `matchMedia` trong `onMounted`, giá trị SSR truyền tường minh nên hydration không lệch.
- Không phải design system tổng thể của repo: lib là shell + primitive đã port; component thương hiệu riêng nằm ở `libs/ui-ecoma-logo`.
- `runtime:universal` là cam kết: không Node builtin trong code runtime, không `window`/`localStorage` cho lần render đầu.
- Quy tắc Nx tags và `scope:shared` → `docs/architecture/05-code-architecture.md` §6.

## Development

```bash
pnpm nx run @ecoma-io/ui-app-shell:lint
pnpm nx run @ecoma-io/ui-app-shell:typecheck   # vue-tsc --build tsconfig.json --emitDeclarationOnly
pnpm nx run @ecoma-io/ui-app-shell:build       # vue-tsc --build tsconfig.lib.json
```

Source nằm dưới `src/lib/` (`shell/`, `ui/`, `preferences/`, `media-query.ts`, `utils.ts`) và `src/styles/app-shell.css`; giấy phép và nguồn gốc của từng thành phần bên thứ ba ghi ở `THIRD-PARTY-NOTICES.md`.

## Testing

```bash
pnpm nx run @ecoma-io/ui-app-shell:test    # vitest, environment jsdom
```

Spec colocated: `preferences.spec.ts`, `shell.spec.ts`, `sidebar.spec.ts`, `command.spec.ts`, `cascade.spec.ts` (so khớp cascade CSS bằng mẫu), `globals.spec.ts` (harness `nuxt-env.ts`). Test đọc CSS thật (`css: true` trong `vitest.config.mts`) thay vì chuỗi rỗng.

## Related Documentation

- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — quy tắc Nx tags và `scope:shared` (§6).
- [`docs/applications/llm-console/README.md`](../../docs/applications/llm-console/README.md) — một consumer, mô tả cách app compose shell.
- [`libs/ui-ecoma-logo/README.md`](../ui-ecoma-logo/README.md) — component brand logo dùng trong slot `brand` của shell.
- [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md) — nguồn gốc và giấy phép của mã port và dependency bên thứ ba.
