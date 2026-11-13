# LLM Console

Component `llm-console` — composition UI consumer + BFF trên Cloudflare Workers, dựng trên `@ecoma-io/ui-app-shell`: SPA non-SSR, server chỉ phục vụ static asset và route BFF. Component không sở hữu database nghiệp vụ; dữ liệu nghiệp vụ đi qua API của context owning theo composition mapping trong `docs/applications/llm-console/`.

Nx project `@ecoma-io/llm-console`, tags `type:composition`, `scope:llm-consumer`, `runtime:edge`.

## Purpose

- Worker `ecoma-llm-console` (`wrangler.jsonc`, entry `.output/server/index.mjs` của Nitro, preset `cloudflare-module`): static asset qua binding `ASSETS`, phần server xử lý request qua Nitro.
- Bề mặt HTTP thật: `GET /health`, `GET /ready`, trang SPA `/`, và route bắt `server/api/[...path].ts` trả 404 JSON cho mọi `/api/**` không có handler — `/api/**` không bao giờ trả shell HTML.
- `nuxt.config.ts` khai `ssr: false` tường minh: shell HTML do Nitro render lúc runtime, build không emit `index.html` tĩnh.
- Thiết kế composition, API integration và session/security là nội dung canonical của `docs/applications/llm-console/`.

## Responsibilities

- **Shell dashboard**: sidebar/nav từ `AppShell` của `@ecoma-io/ui-app-shell`, trang Overview `/` (`app/pages/index.vue`), component empty/loading/error (`app/components/`).
- **Đa ngôn ngữ** en / vi / zh-CN: registry locale (`app/i18n/locale-registry.ts`), language selector, lựa chọn lưu qua cookie; `@nuxtjs/i18n` với strategy `no_prefix`.
- **Chế độ màu** (light/dark/system): lựa chọn người dùng **duy nhất** của shell, lưu qua cookie `app_shell_color_mode` và validate bằng `parseAppShellColorMode()` của shell lib; class `dark` trên `<html>` được `APP_SHELL_COLOR_MODE_BOOTSTRAP_SCRIPT` quyết định **trước first paint** (chèn tĩnh vào `app.head` trong `nuxt.config.ts`), Vue render không đọc môi trường. Chiều chữ (`dir`) **không phải** tuỳ chọn: nó là thuộc tính của ngôn ngữ, suy ra từ registry locale cùng nguồn với `<html lang>`.
- **Health/readiness**: `/health` liveness không phụ thuộc dịch vụ nào; `/ready` trả `{ status: 'ready' }`, và `nuxt.config.ts` không khai `runtimeConfig` — khi một phụ thuộc cấu hình thật được đưa vào, route phải fail closed với 503 + mã ổn định.
- `wrangler.jsonc` khai `assets.run_worker_first` cho `/api/*`, `/health`, `/ready` để các nhóm này tới handler Nitro thay vì asset worker.

## Boundaries

- Không có binding Hyperdrive/D1/R2/KV/Queue nào trong `wrangler.jsonc`, không có Service Binding, không có `runtimeConfig` — mọi dữ liệu nghiệp vụ chỉ có thể đi qua API của context owning (composition mapping → `docs/applications/llm-console/README.md`).
- Không có OIDC client id/secret, session signing key hay credential nào trong repo này; không có đường bypass xác thực cho demo.
- Component không sở hữu bounded context nào — Consumer tenant, routing, usage và financial là context riêng với domain model tại `docs/domains/<context>/`.
- Route bắt `/api/**` khớp sau mọi route cụ thể, nên BFF route thêm vào `server/api/` không bị nuốt.

## Development

```bash
pnpm nx run @ecoma-io/llm-console:serve          # nuxt dev — http://localhost:4208
pnpm nx run @ecoma-io/llm-console:build          # nuxt build — preset cloudflare-module, output `.output/`
pnpm nx run @ecoma-io/llm-console:lint
pnpm nx run @ecoma-io/llm-console:typecheck      # nuxt typecheck (vue-tsc)
```

- Dev server dùng port khai trong `devServer` của `nuxt.config.ts` (4208); tên Worker và env `staging`/`production` khai trong `wrangler.jsonc`.
- Alias `@ecoma-io/ui-app-shell` và `@ecoma-io/ui-ecoma-logo` khai tường minh trong `nuxt.config.ts` — `tsconfig.base.json` có `paths` rỗng nên không có alias thì import trong `server/` chỉ lỗi ở request đầu tiên.

## Testing

```bash
pnpm nx run @ecoma-io/llm-console:test             # vitest — component/catalog/spec colocated
pnpm nx run @ecoma-io/llm-console:test-integration # tests/integrations — workerd thật qua createTestHarness của wrangler
```

- `test` chạy Vitest với harness mount component thật (`tests/harness.ts`); `tests/tailwind-source.spec.ts` ghim số cấp `@source` của stylesheet shell và `fonts.defaults.weights` đủ sáu weight.
- `test-integration` dependsOn `build`: suite boot workerd thật trên `.output/` của chính app, khẳng định `/` trả shell, `/health` và `/ready` JSON 2xx, `/api/**` JSON 404.
- Phân loại test và canonical target theo `docs/architecture/06-testing.md`.

## Related Documentation

- [`docs/applications/llm-console/README.md`](../../docs/applications/llm-console/README.md) — component doc; [`01-architecture.md`](../../docs/applications/llm-console/01-architecture.md) (composition, non-SSR, authN/authZ), [`02-requirements.md`](../../docs/applications/llm-console/02-requirements.md), [`03-operations.md`](../../docs/applications/llm-console/03-operations.md).
- Bounded context tiêu thụ theo composition (catalog → [`docs/domains/README.md`](../../docs/domains/README.md) §2): [`llm-consumer-tenant`](../../docs/domains/llm-consumer-tenant/README.md), [`llm-consumer-routing`](../../docs/domains/llm-consumer-routing/README.md), [`llm-financial`](../../docs/domains/llm-financial/README.md), [`llm-usage`](../../docs/domains/llm-usage/README.md).
- [`libs/ui-app-shell/README.md`](../../libs/ui-app-shell/README.md) — shell UI mà app dựng trên đó.
- [`docs/architecture/01-architecture.md`](../../docs/architecture/01-architecture.md) — topology deploy và ranh giới hệ thống.
