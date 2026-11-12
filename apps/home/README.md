# Home

Bề mặt public của nền tảng — Nuxt SSR trên Cloudflare Workers (Nitro preset `cloudflare-module`), phục vụ homepage đa ngôn ngữ tại `/en` và `/vi`. Đây là deploy unit public, không phải bounded context: app không sở hữu database nghiệp vụ, không mount nội dung, và chỉ tiêu thụ content tĩnh khai trong chính source.

Nx project `@ecoma-io/home`, tags `type:composition`, `scope:public`, `runtime:edge`.

## Purpose

- Phục vụ homepage public với URL ổn định theo locale: `/en` và `/vi` là hai locale-root prerendered lúc build (SSG), phục vụ từ static assets; `/` chỉ là locale-resolution entry — `GET /` trả 302 server-side về `/en` (`HOME_DEFAULT_LOCALE`, `server/routes/index.get.ts`).
- Giữ bề mặt phẳng: không có mount nội dung nào, không có API nghiệp vụ, không có database; mọi nội dung homepage nằm trong `app/domain/home-content.ts` theo từng locale.
- Hệ thống nội dung public (blog · docs · legal) là mục mở ở system level — `docs/architecture/01-architecture.md` §10; README này chỉ định vị các phần tử trong project.

## Responsibilities

- **Prerender** (`nitro.config.ts`): `routes: ['/en', '/vi']` sinh HTML tĩnh lúc build; hook `prerender:routes` thêm `/en/__not-found` và hook `prerender:generate` map nó thành artifact `404.html`; `/` và `/api/greet` bị `ignore` khỏi prerender.
- **Locale registry** (`app/i18n/lib/locale-registry.ts`): `en` (hreflang `en`) và `vi` (hreflang `vi-VN`); `app/i18n/lib/parse-public-path.ts` là bộ strict canonicality cho pathname public — không decode, không lowercase, không repair.
- **Page + shell** (`app/pages/[locale]/index.vue`, `app/layout/`): route `validate` chỉ nhận locale-root hợp lệ; `PublicShell` giữ header/footer/nav và locale switcher; `app/domain/home-seo.ts` dựng `lang`, canonical tuyệt đối self-canonical và `hreflang` hai chiều.
- **Error page** (`app/error.vue`, `app/error-pages/`): 404 map sang `NotFoundPage` render SSR trên Worker; 401/500 giữ fallback mặc định của Nuxt.
- **Worker surface** (`server/`): `GET /` redirect 302; `GET /api/greet` trả JSON `{ message }`; middleware `server/middleware/no-index.ts` đặt `X-Robots-Tag: noindex` khi `runtimeConfig.public.noIndex === true` (biến `NITRO_PUBLIC_NO_INDEX`).
- **Binding** khai trong `wrangler.jsonc`: asset binding `ASSETS` (`directory: .output/public`, `html_handling: "drop-trailing-slash"`); Worker identity `ecoma-home`, `env.staging` → `stg-ecoma-home` với custom domain `ecoma.io.vn` và `NITRO_PUBLIC_NO_INDEX=true`, `env.production` → `ecoma-home` với custom domain `ecoma.io`.

## Boundaries

- Không phải bounded context và không sở hữu storage — `docs/domains/README.md` §3 xếp `home` là deploy unit public; nội dung homepage nằm trong source của app, không phải dữ liệu từ một context nào.
- Không có đường gọi service khác: app không đọc database, không gọi `auth`/`account`, không dùng Service Binding — bề mặt public là static + Worker-served.
- Worker chỉ phục vụ phần không khớp static asset; hai locale-root prerendered và `404.html` được asset layer phục vụ trực tiếp nên middleware `no-index` không chạy trên bề mặt đó — noindex đầy đủ của staging là hợp đồng giữa app và tầng delivery (`docs/architecture/02-delivery.md`).
- Trên lane local, deploy unit chạy như container Node (preset `node-server` override lúc build image) do `deploys/home-deploy` provision; healthcheck Docker probe `GET /` — 302 là phản hồi khỏe.
- Topology và ranh giới public → `docs/architecture/01-architecture.md` §2; rule Nx theo scope → `docs/architecture/05-code-architecture.md` §6.3.

## Development

```bash
pnpm nx run @ecoma-io/home:serve          # nuxt dev — devServer port 4200
pnpm nx run @ecoma-io/home:lint
pnpm nx run @ecoma-io/home:typecheck      # nuxt typecheck (vue-tsc)
pnpm nx run @ecoma-io/home:build          # nuxt build — preset cloudflare-module + prerender
```

- Dev server listen trên `0.0.0.0:4200` (`devServer` của `nuxt.config.ts`) để mở app từ thiết bị khác; `vite.server.allowedHosts` đi kèm.
- Alias `@ecoma-io/ui-ecoma-logo` khai tường minh trong `nuxt.config.ts`; `nitro.config.ts` giữ preset và `runtimeConfig.public.noIndex` (mặc định `false`).
- Không có `db:migrate` — app không có database.

## Testing

```bash
pnpm nx run @ecoma-io/home:test             # vitest (jsdom) — spec colocated trong app/, shared/, server/
pnpm nx run @ecoma-io/home:test-integration # tests/integrations — đọc artifact build thật
```

- `test-integration` dependsOn `nuxt-prepare` + `build` vì suite đọc artifact `.output` thật (`tests/integrations/static-output.spec.ts` kiểm inventory prerender, HTML SSR thật, canonical/hreflang, artifact 404 và contract của `wrangler.jsonc`; `design-tokens.spec.ts` kiểm contrast của design token).
- System E2E của bề mặt public là suite độc lập: `system-tests/e2e/home-public-e2e/` (target `system-test`, dependsOn `local-up` của `platform-deploy` và `home-deploy`).
- Phân loại và canonical target theo `docs/architecture/06-testing.md` §3–§4.

## Related Documentation

- [`docs/features/public-website/browse-localized-public-content.md`](../../docs/features/public-website/browse-localized-public-content.md) — capability người dùng mà bề mặt này hiện thực.
- [`docs/architecture/01-architecture.md`](../../docs/architecture/01-architecture.md) — deploy unit `home` trong topology (§2) và mục mở về hệ thống nội dung public (§10).
- [`docs/architecture/02-delivery.md`](../../docs/architecture/02-delivery.md) — identity Worker staging/production và cơ chế artifact staging.
- [`deploys/home-deploy/index.ts`](../../deploys/home-deploy/index.ts) — Pulumi program provision container + router của lane local.
- [`docs/architecture/local-development/03-operations.md`](../../docs/architecture/local-development/03-operations.md) — vận hành local stack.
