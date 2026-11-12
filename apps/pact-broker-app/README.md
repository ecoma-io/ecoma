# Pact Broker App

Component dashboard của bounded context `pact-broker` — Cloudflare Worker (Nuxt 4 + Nitro preset `cloudflare-module`, non-SSR SPA + BFF). BFF server route gọi `pact-broker-api`; component pair `pact-broker-api` + `pact-broker-app` được mô tả chung trong `docs/applications/pact-broker/`.

Nx project `@ecoma-io/pact-broker-app`, tags `type:composition`, `scope:pact`, `runtime:edge`.

## Purpose

- Worker `ecoma-pact-broker-app` (`wrangler.jsonc`, entry `.output/server/index.mjs`): static asset qua binding `ASSETS`, BFF route trong `server/api/broker/` gọi `pact-broker-api` phía sau.
- BFF giữ **một** machine token server-side (scope `read`) qua `runtimeConfig` (`pactBrokerApiBaseUrl`, `pactBrokerApiToken`); browser không bao giờ thấy token — mọi request dashboard đi qua BFF và BFF forward kèm token của chính nó.
- `nuxt.config.ts` khai `ssr: false` tường minh; thiếu hoặc sai cấu hình broker là 503 `broker_not_configured`, không đoán origin.
- Thiết kế dashboard, authN/authZ và ranh giới BFF là nội dung canonical của `docs/applications/pact-broker/01-architecture.md`.

## Responsibilities

- **BFF route** (`server/api/broker/`): `pacts.get`, `pacticipants.get`, `environments.get`, `machine-tokens.get`, `can-i-deploy.post` — mỗi route gọi endpoint tương ứng của `pact-broker-api` qua `brokerCall` (`server/utils/broker-client.ts`) và truyền nguyên văn HTTP status + body đã parse về UI; BFF không biến lỗi của API thành 500.
- **Read-only tới broker API**: BFF chỉ dùng token scope `read`; route cần scope cao hơn (ví dụ `machine-tokens` cần `admin`) nhận 403 nguyên văn từ API để UI hiển thị thiếu quyền.
- **Cấu hình** (`server/utils/broker-config.ts`): base URL phải absolute URL http(s), không path/query/hash, không userinfo; thiếu cấu hình ⇒ `null` và caller trả 503 `broker_not_configured`.
- **Route web**: `/` (Overview), `/pacts`, `/environments`, `/tokens` dựng trên `AppShell` (`app/pages/`); đa ngôn ngữ en/vi/zh-CN.
- **Health/readiness**: `/health` liveness; `/ready` kiểm cấu hình broker có mặt và hợp lệ — không probe broker API bằng HTTP thật, để observability không thành serving-path dependency.
- Route bắt `server/api/[...path].ts` trả 404 JSON cho `/api/**` không có handler; `wrangler.jsonc` khai `assets.run_worker_first` cho `/api/*`, `/health`, `/ready`.

## Boundaries

- Không có binding Hyperdrive/D1/R2/KV/Queue (`wrangler.jsonc`); không đọc database của `pact-broker-api` — mọi dữ liệu đi qua HTTP API của broker.
- Không sở hữu bounded context `pact-broker`; domain rule và tenant isolation tại `docs/domains/pact-broker/domain-model.md`.
- `staging`/`production` trong `wrangler.jsonc` khai `NITRO_PACT_BROKER_API_BASE_URL` là URL Worker `pact-broker-api` tương ứng; token là secret cấp lúc provision, không nằm trong repo.
- Browser session qua OIDC `auth.ecoma.io` và ForwardAuth là thiết kế mục tiêu trong `docs/applications/pact-broker/`; cơ chế hiện tại là một machine token tĩnh server-side.

## Development

```bash
pnpm nx run @ecoma-io/pact-broker-app:serve          # nuxt dev — http://localhost:4205
pnpm nx run @ecoma-io/pact-broker-app:build          # nuxt build — preset cloudflare-module, output `.output/`
pnpm nx run @ecoma-io/pact-broker-app:lint
pnpm nx run @ecoma-io/pact-broker-app:typecheck      # nuxt typecheck (vue-tsc)
```

- Dev server dùng port khai trong `devServer` của `nuxt.config.ts` (4205).
- `runtimeConfig` khai `pactBrokerApiBaseUrl` và `pactBrokerApiToken` với default rỗng (fail closed); giá trị thật cấp qua `vars` env hoặc secret.

## Testing

```bash
pnpm nx run @ecoma-io/pact-broker-app:test             # vitest — BFF config/client, component, catalog
pnpm nx run @ecoma-io/pact-broker-app:test-integration # tests/integrations — workerd thật qua createTestHarness của wrangler
```

- `test` ghim hành vi `broker-config` / `broker-client` (`tests/broker-config.spec.ts`, `tests/broker-client.spec.ts`), tính read-only của BFF (`tests/read-only-bff.spec.ts`), trang Pacts và shell integration.
- `test-integration` dependsOn `build`: suite boot workerd thật trên `.output/` để khẳng định routing.
- Phân loại test và canonical target theo `docs/architecture/06-testing.md`.

## Related Documentation

- [`docs/applications/pact-broker/README.md`](../../docs/applications/pact-broker/README.md) — component doc pair; [`01-architecture.md`](../../docs/applications/pact-broker/01-architecture.md) (BFF, Service Binding/fetch nội bộ, session OIDC), [`02-requirements.md`](../../docs/applications/pact-broker/02-requirements.md), [`03-operations.md`](../../docs/applications/pact-broker/03-operations.md).
- [`docs/domains/pact-broker/README.md`](../../docs/domains/pact-broker/README.md) — bounded context; [`domain-model.md`](../../docs/domains/pact-broker/domain-model.md).
- [`apps/pact-broker-api/README.md`](../pact-broker-api/README.md) — API mà BFF gọi.
- [`libs/ui-app-shell/README.md`](../../libs/ui-app-shell/README.md) — shell UI mà app dựng trên đó.
- [`docs/architecture/01-architecture.md`](../../docs/architecture/01-architecture.md) — topology deploy và ranh giới hệ thống.
