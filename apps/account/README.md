# Account

Ứng dụng **Account** — Nuxt 4 UI + BFF phục vụ bounded context `account`: đăng nhập email-OTP, consent, và BFF dữ liệu tài khoản. `account` và `auth` là **hai bounded context riêng biệt**; ứng dụng này thuộc context `account` và không host context nào khác.

Nx project `@ecoma-io/account`, tags `type:composition`, `scope:account`, `runtime:edge`.

## Purpose

- Cung cấp Account UI và BFF trong cùng một deploy unit: trên Cloudflare Workers chạy như Worker `ecoma-account` (`wrangler.jsonc`), trên local platform chạy như container Node do `deploys/account-deploy` provision.
- Nói với `db-account` qua Hyperdrive binding `DB_ACCOUNT`; gọi ngược `auth` qua Service Binding `AUTH_SERVICE` cho back-channel — trên lane local binding do `server/plugins/auth-service-shim.ts` mount từ `NUXT_AUTH_SERVICE_URL`, còn trên Workers `wrangler.jsonc` chưa khai entry `services` nào: `auth-client.ts` đọc binding từ `runtimeConfig.cloudflare.env` khi hạ tầng cấp nó.
- Thiết kế component và ngữ nghĩa nghiệp vụ là nội dung canonical của `docs/applications/account/` và `docs/domains/account/` — README này chỉ định vị các phần tử trong project.

## Responsibilities

- **Login email-OTP**: UI `/login`, `/login/continue` (`app/pages/login/`) nối qua BFF routes `server/api/auth/` — `challenge`, `verify`, `session`, `logout`, `handoff`.
- **Consent UI + proxy**: trang `/consent` relay qua `server/api/consent/{context,decide}` tới `auth`.
- **BFF dữ liệu tài khoản**: routes cho `profile`, `emails`, `notifications`, `preferences`, `privacy-requests`, `sessions`, `applications` (`server/api/`) — đọc/ghi `db-account` qua `accountHyperdrive` (`server/utils/bindings.ts`) và tầng `server/lib/data-domain.ts`.
- **Internal contract cho `auth`**: `GET /internal/account/status`, `GET /internal/account/profiles` (`server/routes/internal/`) sau envelope HMAC; back-channel đẩy kết quả verify và consent sang `auth` qua `server/lib/auth-client.ts`.
- **Health/readiness**: `GET /health` (protocol-only) và `GET /ready` (probe `db-account` thật) tại `server/routes/`.
- **Schema `db-account`**: migration SQL thuần dưới `db/migrations/`, áp dụng theo thứ tự tên file — xem `db/README.md`.
- Secret cấu hình qua `runtimeConfig` (`NUXT_*`); trên lane local các giá trị được inject bởi `deploys/account-deploy`.

## Boundaries

- **Không sở hữu endpoint protocol OAuth 2.0/OIDC** — authorization server là app `auth` (`apps/auth`, Worker `ecoma-auth`), một bounded context và một database (`db-auth`) riêng; `account` không đọc `db-auth`, chỉ giao tiếp qua contract.
- Không có đường lấy `access_token`/`id_token` cho bên thứ ba — `auth` mới là bên cấp code/token.
- Runtime architecture, schema chi tiết và vận hành → `docs/applications/account/01-architecture.md` và `03-operations.md`; topology deploy ở system level → `docs/architecture/01-architecture.md` §2.

## Development

```bash
pnpm nx run @ecoma-io/account:serve          # nuxt dev — http://localhost:4202
pnpm nx run @ecoma-io/account:lint
pnpm nx run @ecoma-io/account:typecheck      # nuxt typecheck (vue-tsc)
pnpm nx run @ecoma-io/account:typecheck-db   # tsc cho db/
pnpm nx run @ecoma-io/account:build          # nuxt build — preset cloudflare-module
pnpm nx run @ecoma-io/account:db:migrate     # áp dụng migration — cần kết nối tới PostgreSQL
```

- Dev server dùng port khai trong `devServer` của `nuxt.config.ts` (4202); binding khai trong `wrangler.jsonc`.
- Trên lane local, `db:migrate` thường do `account-deploy` chạy trong container gắn platform network (platform PostgreSQL không publish host port); target này dành cho runner có kết nối trực tiếp.

## Testing

```bash
pnpm nx run @ecoma-io/account:test             # vitest colocated unit/component
pnpm nx run @ecoma-io/account:test-integration # tests/integrations + tests/databases — PostgreSQL thật (testcontainers)
```

- `test` chạy trên TS nguồn và kéo `nuxt-prepare`; `test-integration` dependsOn `build` vì một spec đọc bundle Nitro build thật.
- Phân loại và canonical target theo `docs/architecture/06-testing.md` §3–§4. System E2E của luồng login là suite độc lập: `system-tests/e2e/identity-login-e2e/`.

## Related Documentation

- [`docs/domains/account/README.md`](../../docs/domains/account/README.md) — bounded context `account`; [`domain-model.md`](../../docs/domains/account/domain-model.md) — khái niệm, vòng đời, invariant nghiệp vụ.
- [`docs/applications/account/README.md`](../../docs/applications/account/README.md) — component doc; [`01-architecture.md`](../../docs/applications/account/01-architecture.md), [`02-requirements.md`](../../docs/applications/account/02-requirements.md), [`03-operations.md`](../../docs/applications/account/03-operations.md).
- [`apps/account/db/README.md`](./db/README.md) — schema, role, migration.
- [`docs/architecture/local-development/02-account-auth-topology.md`](../../docs/architecture/local-development/02-account-auth-topology.md) — topology local của cặp account/auth.
- [`deploys/account-deploy/README.md`](../../deploys/account-deploy/README.md) — deploy unit của app này trên lane local.
