# Auth

Authorization server OAuth 2.0 / OpenID Connect của nền tảng — Cloudflare Worker API-only (Hono) phục vụ bounded context `auth`: cấp và thu hồi token, discovery/JWKS, và các glue internal cho luồng login/consent. Worker không render UI nào — login UI và consent UI thuộc `apps/account` (bounded context `account`, database `db-account` riêng); hai context giao tiếp qua hai contract hai hướng, không qua shared database.

Nx project `@ecoma-io/auth`, tags `type:composition`, `scope:auth`, `runtime:edge`.

## Purpose

- Host endpoint protocol OAuth 2.0/OIDC: `/authorize`, `/token`, `/jwks.json`, `/revocation`, `/session/end` (`PROVIDER_ROUTES`, `src/oidc/provider.ts`) và discovery `/.well-known/openid-configuration` + `/.well-known/oauth-authorization-server`; pipeline Koa của `oidc-provider` chạy qua bridge `cloudflare:node`.
- Là một đầu của hai contract `auth ↔ account`: nhận back-channel đẩy kết quả verify/consent từ `account`, và hỏi ngược trạng thái account lúc phát hành qua `AccountClient` (`src/account-client.ts`, `GET /internal/account/status`) — hai hướng là hai contract khác nhau.
- Ngữ nghĩa protocol, mô hình miền và chính sách token/consent là nội dung canonical của `docs/domains/auth/` và `docs/applications/auth/` — README này chỉ định vị các phần tử trong project.

## Responsibilities

- **Route surface hai lớp** (`src/main.ts`): Hono giữ `/health`, `/ready`, hai route discovery, `/authorize`, `/authorize/confirm` và năm route internal POST `/internal/session/verified`, `/internal/consent/context`, `/internal/consent/decide`, `/internal/connected-applications`, `/internal/connected-applications/revoke`; pipeline của provider giữ `/auth`, `/auth/:uid` (resume), `/token`, `/jwks.json`, `/revocation`, `/session/end` qua bảng chuyển tiếp `PROVIDER_ROUTES`. Feature `userinfo` của provider bị tắt trong `src/oidc/provider.ts` nên không có route nào cho nó.
- **Readiness fail-closed** `GET /ready`: kiểm đủ hai binding (`HYPERDRIVE`, `ACCOUNT_SERVICE`), nạp cấu hình signing, probe `db-auth` và probe `account` qua đúng Service Binding mà mọi request thật đi; `GET /health` chỉ protocol-only.
- **Schema `db-auth`**: 14 migration SQL dưới `migrations/` (`0001`…`0014`), áp dụng theo thứ tự tên file bằng `db/apply.mts` (advisory lock, history `auth.schema_migrations`); driver PostgreSQL đi qua lớp adapter trong `libs/auth-infrastructure`, không import thẳng trong app.
- **Cấu hình secret** (`src/config.ts`): `AUTH_SIGNING_KEY` + `AUTH_SIGNING_KEY_ID` (PKCS#8 PEM), `AUTH_HANDLE_KEY` + `AUTH_HANDLE_KEY_VERSION`, `AUTH_INTERNAL_SECRET` với slot verify-only `AUTH_INTERNAL_PREVIOUS_SECRET`/`AUTH_INTERNAL_PREVIOUS_KID`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_RESOURCES`, `AUTH_COOKIE_KEYS`, `AUTH_ACCOUNT_BASE_URL` — không biến nào có default; thiếu là lỗi nạp tường minh.
- **Binding** khai trong `wrangler.jsonc`: Hyperdrive `HYPERDRIVE` (→ `db-auth`) và Service Binding `ACCOUNT_SERVICE` (→ shim Worker `ecoma-account-bridge` trên lane local; shim chuyển tiếp HTTP tới container account qua `BRIDGE_TARGET_ORIGIN` do `deploys/auth-deploy` inject).

## Boundaries

- Không sở hữu credential, browser session, profile hay role nghiệp vụ — những dữ liệu đó thuộc context `account` (`apps/account`) hoặc `staff-access`; `auth` không đọc `db-account`, mọi trao đổi qua envelope HMAC (`AUTH_INTERNAL_SECRET`).
- OAuth client của lane local được seed bởi `deploys/auth-deploy` (redirect URI per-environment), không qua API public nào của Worker.
- Ranh giới context, chính sách OAuth/OIDC và invariant nghiệp vụ → `docs/domains/auth/domain-model.md`; topology account/auth ở system level → `docs/architecture/01-architecture.md` §2; rule Nx theo scope → `docs/architecture/05-code-architecture.md` §6.3.

## Development

```bash
pnpm nx run @ecoma-io/auth:serve          # wrangler dev — dev.port 4203, upstream_protocol https
pnpm nx run @ecoma-io/auth:lint
pnpm nx run @ecoma-io/auth:typecheck      # tsc --build --emitDeclarationOnly
pnpm nx run @ecoma-io/auth:typecheck-db   # tsc cho db/
pnpm nx run @ecoma-io/auth:build          # esbuild bundle → dist/main.js (conditions workerd)
pnpm nx run @ecoma-io/auth:db:migrate     # áp migration — cần kết nối tới PostgreSQL với credential migrator
```

- Connection string thật của Hyperdrive trên lane local đến từ biến `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` trong container env (`platform facts` PF3/PF4), không nằm trong `wrangler.jsonc` — `id` của binding là chuỗi rỗng có chủ ý.
- Trên lane local, Worker chạy trong container WIC (hai process `wrangler dev`: `ecoma-auth` port nội bộ 4203 và shim `ecoma-account-bridge` port 4204) do `deploys/auth-deploy` provision, kèm secret qua container `envs` — không phải `nx serve` của developer.

## Testing

```bash
pnpm nx run @ecoma-io/auth:test             # vitest — spec colocated trong src/
pnpm nx run @ecoma-io/auth:test-integration # tests/integrations + tests/databases — PostgreSQL thật (testcontainers)
```

- `test-integration` chạy qua config riêng `vitest.integration.config.mts` với Docker probe fail-loud (`tests/integrations/docker-probe.global-setup.ts`): vắng Docker là đỏ toàn suite, không skip.
- Phân loại và canonical target theo `docs/architecture/06-testing.md` §3–§4; luồng OIDC browser qua `auth` là suite độc lập: `system-tests/e2e/identity-oidc-e2e/`.

## Related Documentation

- [`docs/domains/auth/README.md`](../../docs/domains/auth/README.md) — bounded context `auth`; [`domain-model.md`](../../docs/domains/auth/domain-model.md) — chính sách OAuth/OIDC, consent ≠ grant, handle X/Y/Z, invariant.
- [`docs/applications/auth/README.md`](../../docs/applications/auth/README.md) — component doc; [`01-architecture.md`](../../docs/applications/auth/01-architecture.md) (runtime, schema `db-auth`, giao thức login/consent), [`02-requirements.md`](../../docs/applications/auth/02-requirements.md) (FR/NFR, threat model), [`03-operations.md`](../../docs/applications/auth/03-operations.md) (role & migration, key rotation, runbook).
- [`apps/auth/migrations/README.md`](./migrations/README.md) — quy ước migration và role của `db-auth`.
- [`apps/account/README.md`](../../apps/account/README.md) — bounded context `account` bên kia hai contract back-channel.
- [`docs/architecture/local-development/02-account-auth-topology.md`](../../docs/architecture/local-development/02-account-auth-topology.md) — topology local của cặp account/auth.
- [`docs/features/identity/oidc-application-access.md`](../../docs/features/identity/oidc-application-access.md) — capability người dùng mà protocol này phục vụ.
