# LLM Seller

Component `llm-seller` — composition UI seller + BFF trên Cloudflare Workers, dựng trên `@ecoma-io/ui-app-shell`: SPA non-SSR, server chỉ phục vụ static asset và route BFF. Component không sở hữu database nghiệp vụ; dữ liệu nghiệp vụ đi qua API của context owning theo composition mapping trong `docs/applications/llm-seller/`.

Nx project `@ecoma-io/llm-seller`, tags `type:composition`, `scope:llm-seller`, `runtime:edge`.

## Purpose

- Worker `ecoma-llm-seller` (`wrangler.jsonc`, entry `.output/server/index.mjs` của Nitro, preset `cloudflare-module`): static asset qua binding `ASSETS`, phần server xử lý request qua Nitro.
- Bề mặt HTTP thật: `GET /health`, `GET /ready`, trang SPA `/`, và route bắt `server/api/[...path].ts` trả 404 JSON cho mọi `/api/**` không có handler — `/api/**` không bao giờ trả shell HTML.
- `nuxt.config.ts` khai `ssr: false` tường minh: shell HTML do Nitro render lúc runtime, build không emit `index.html` tĩnh.
- Thiết kế composition (seller profile, offer, pricing, earnings, settlement) là nội dung canonical của `docs/applications/llm-seller/`.

## Responsibilities

- **Shell dashboard**: sidebar/nav từ `AppShell` của `@ecoma-io/ui-app-shell`, trang Overview `/` (`app/pages/index.vue`), component empty/loading/error (`app/components/`).
- **Đa ngôn ngữ** en / vi / zh-CN: registry locale (`app/i18n/locale-registry.ts`), language selector, lựa chọn lưu qua cookie; `@nuxtjs/i18n` với strategy `no_prefix`.
- **Tuỳ chọn shell** (màu, chiều): cookie `app-shell-preferences`, validate qua `parseAppShellPreferences()` của shell lib.
- **Health/readiness**: `/health` liveness không phụ thuộc dịch vụ nào; `/ready` trả `{ status: 'ready' }`, và `nuxt.config.ts` không khai `runtimeConfig` — khi một phụ thuộc cấu hình thật được đưa vào, route phải fail closed với 503 + mã ổn định.
- `wrangler.jsonc` khai `assets.run_worker_first` cho `/api/*`, `/health`, `/ready` để các nhóm này tới handler Nitro thay vì asset worker.

## Boundaries

- **Không có bề mặt seller trong M1** — spec seller quyết bootstrap-only ([`seller-offering.md`](../../docs/features/llm-marketplace/seller-offering.md) §3): không UI hay HTTP API nào để tạo/sửa offer, endpoint, credential hay giá; supported interface cho mọi thao tác seller là bootstrap runner của `llm-api` (8a governance, 8b marketplace — spec §5). Component không có đường đăng nhập seller và không sở hữu dữ liệu nghiệp vụ nào; bổ sung bề mặt là mục tiêu tương lai, phải qua cập nhật feature spec trước khi có slice delivery.
- Không có binding Hyperdrive/D1/R2/KV/Queue nào trong `wrangler.jsonc`, không có Service Binding, không có `runtimeConfig` — mọi dữ liệu nghiệp vụ chỉ có thể đi qua API của context owning (composition mapping → `docs/applications/llm-seller/README.md`).
- Không có OIDC client id/secret, session signing key, provider credential hay credential nào khác trong repo này; không có đường bypass xác thực cho demo.
- Component không sở hữu bounded context nào — Seller tenant, governance, pricing và marketplace là context riêng với domain model tại `docs/domains/<context>/`.
- Route bắt `/api/**` khớp sau mọi route cụ thể, nên BFF route thêm vào `server/api/` không bị nuốt.

## Development

```bash
pnpm nx run @ecoma-io/llm-seller:serve          # nuxt dev — http://localhost:4209
pnpm nx run @ecoma-io/llm-seller:build          # nuxt build — preset cloudflare-module, output `.output/`
pnpm nx run @ecoma-io/llm-seller:lint
pnpm nx run @ecoma-io/llm-seller:typecheck      # nuxt typecheck (vue-tsc)
```

- Dev server dùng port khai trong `devServer` của `nuxt.config.ts` (4209); tên Worker và env `staging`/`production` khai trong `wrangler.jsonc`.
- Alias `@ecoma-io/ui-app-shell` và `@ecoma-io/ui-ecoma-logo` khai tường minh trong `nuxt.config.ts` — `tsconfig.base.json` có `paths` rỗng nên không có alias thì import trong `server/` chỉ lỗi ở request đầu tiên.

## Testing

```bash
pnpm nx run @ecoma-io/llm-seller:test             # vitest — component/catalog/spec colocated
pnpm nx run @ecoma-io/llm-seller:test-integration # tests/integrations — workerd thật qua createTestHarness của wrangler
```

- `test` chạy Vitest với harness mount component thật (`tests/harness.ts`); `tests/tailwind-source.spec.ts` ghim số cấp `@source` của stylesheet shell và `fonts.defaults.weights` đủ sáu weight.
- `test-integration` dependsOn `build`: suite boot workerd thật trên `.output/` của chính app, khẳng định `/` trả shell, `/health` và `/ready` JSON 2xx, `/api/**` JSON 404.
- Phân loại test và canonical target theo `docs/architecture/06-testing.md`.

## Related Documentation

- [`docs/applications/llm-seller/README.md`](../../docs/applications/llm-seller/README.md) — component doc; [`01-architecture.md`](../../docs/applications/llm-seller/01-architecture.md) (composition, ranh giới ownership), [`02-requirements.md`](../../docs/applications/llm-seller/02-requirements.md), [`03-operations.md`](../../docs/applications/llm-seller/03-operations.md).
- Bounded context tiêu thụ theo composition (catalog → [`docs/domains/README.md`](../../docs/domains/README.md) §2): [`llm-seller-tenant`](../../docs/domains/llm-seller-tenant/README.md), [`llm-seller-governance`](../../docs/domains/llm-seller-governance/README.md), [`llm-seller-pricing`](../../docs/domains/llm-seller-pricing/README.md), [`llm-marketplace`](../../docs/domains/llm-marketplace/README.md).
- [`libs/ui-app-shell/README.md`](../../libs/ui-app-shell/README.md) — shell UI mà app dựng trên đó.
- [`docs/architecture/01-architecture.md`](../../docs/architecture/01-architecture.md) — topology deploy và ranh giới hệ thống.
