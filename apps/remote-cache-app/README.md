# Remote Cache App

Component admin UI của Remote Cache — Cloudflare Worker (Nuxt 4 + Nitro preset `cloudflare-module`, non-SSR SPA shell), dựng trên `@ecoma-io/ui-app-shell`. Component này là admin UI composition của bounded context `remote-cache`; đây là composition riêng cạnh API composition `apps/remote-cache-api`. Thiết kế chung của cả hai được mô tả trong `docs/applications/remote-cache/`.

Nx project `@ecoma-io/remote-cache-app`, tags `type:composition`, `scope:remote-cache`, `runtime:edge`.

## Purpose

- Worker `ecoma-remote-cache-app` (`wrangler.jsonc`, entry `.output/server/index.mjs`): static asset qua binding `ASSETS`, phần server phục vụ route SPA và route bắt `/api/**`.
- Bề mặt HTTP thật: `GET /health`, `GET /ready`, trang SPA `/`, và route bắt `server/api/[...path].ts` trả 404 JSON cho `/api/**` không có handler — `/api/**` không bao giờ trả shell HTML.
- `nuxt.config.ts` khai `ssr: false` tường minh: shell HTML do Nitro render lúc runtime, build không emit `index.html` tĩnh.
- Vai trò admin UI và đường truy cập control plane là nội dung canonical của `docs/applications/remote-cache/01-architecture.md`.

## Responsibilities

- **Shell dashboard**: sidebar/nav từ `AppShell` của `@ecoma-io/ui-app-shell`, trang Overview `/` (`app/pages/index.vue`), component empty/loading/error (`app/components/`).
- **Đa ngôn ngữ** en / vi / zh-CN: registry locale (`app/i18n/locale-registry.ts`), language selector, lựa chọn lưu qua cookie; `@nuxtjs/i18n` với strategy `no_prefix`.
- **Tuỳ chọn shell** (màu, chiều): cookie `app-shell-preferences`, validate qua `parseAppShellPreferences()` của shell lib.
- **Health/readiness**: `/health` liveness không phụ thuộc dịch vụ nào; `/ready` trả `{ status: 'ready' }`, và `nuxt.config.ts` không khai `runtimeConfig` — khi một phụ thuộc cấu hình thật được đưa vào, route phải fail closed với 503 + mã ổn định.
- `wrangler.jsonc` khai `assets.run_worker_first` cho `/api/*`, `/health`, `/ready` để các nhóm này tới handler Nitro thay vì asset worker.

## Boundaries

- Không có binding Hyperdrive/D1/R2/KV/Queue nào trong `wrangler.jsonc`, không có Service Binding, không có `runtimeConfig`: bề mặt server chỉ gồm static asset, `/health`, `/ready`, trang SPA và route bắt `/api/**` — mọi dữ liệu control plane của Remote Cache nằm phía `apps/remote-cache-api`.
- Không có OIDC client id/secret, session signing key hay credential nào trong repo này; không có đường bypass xác thực cho demo.
- Không sở hữu nghiệp vụ `remote-cache` — tenant, project, API key, quota, metering, audit là domain state tại `docs/domains/remote-cache/domain-model.md`; admin UI chỉ là composition.
- Route bắt `/api/**` khớp sau mọi route cụ thể, nên BFF route thêm vào `server/api/` không bị nuốt.

## Development

```bash
pnpm nx run @ecoma-io/remote-cache-app:serve          # nuxt dev — http://localhost:4210
pnpm nx run @ecoma-io/remote-cache-app:build          # nuxt build — preset cloudflare-module, output `.output/`
pnpm nx run @ecoma-io/remote-cache-app:lint
pnpm nx run @ecoma-io/remote-cache-app:typecheck      # nuxt typecheck (vue-tsc)
```

- Dev server dùng port khai trong `devServer` của `nuxt.config.ts` (4210); tên Worker và env `staging`/`production` khai trong `wrangler.jsonc`.
- Alias `@ecoma-io/ui-app-shell` và `@ecoma-io/ui-ecoma-logo` khai tường minh trong `nuxt.config.ts` — `tsconfig.base.json` có `paths` rỗng nên không có alias thì import trong `server/` chỉ lỗi ở request đầu tiên.

## Testing

```bash
pnpm nx run @ecoma-io/remote-cache-app:test             # vitest — component/catalog/spec colocated
pnpm nx run @ecoma-io/remote-cache-app:test-integration # tests/integrations — workerd thật qua createTestHarness của wrangler
```

- `test` chạy Vitest với harness mount component thật (`tests/harness.ts`); `tests/tailwind-source.spec.ts` ghim số cấp `@source` của stylesheet shell và `fonts.defaults.weights` đủ sáu weight.
- `test-integration` dependsOn `build`: suite boot workerd thật trên `.output/` của chính app, khẳng định `/` trả shell, `/health` và `/ready` JSON 2xx, `/api/**` JSON 404.
- Phân loại test và canonical target theo `docs/architecture/06-testing.md`.

## Related Documentation

- [`docs/applications/remote-cache/README.md`](../../docs/applications/remote-cache/README.md) — component doc pair; [`01-architecture.md`](../../docs/applications/remote-cache/01-architecture.md) (hai composition, admin UI, đường truy cập control plane), [`02-requirements.md`](../../docs/applications/remote-cache/02-requirements.md), [`03-operations.md`](../../docs/applications/remote-cache/03-operations.md).
- [`docs/domains/remote-cache/README.md`](../../docs/domains/remote-cache/README.md) — bounded context `remote-cache`; [`domain-model.md`](../../docs/domains/remote-cache/domain-model.md).
- [`apps/remote-cache-api/README.md`](../remote-cache-api/README.md) — API composition của cùng component.
- [`libs/ui-app-shell/README.md`](../../libs/ui-app-shell/README.md) — shell UI mà app dựng trên đó.
- [`docs/architecture/01-architecture.md`](../../docs/architecture/01-architecture.md) — topology deploy và vị trí cache trong hệ thống.
