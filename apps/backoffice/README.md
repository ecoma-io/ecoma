# Backoffice

Bề mặt quản trị nội bộ admin-only — Nuxt non-SSR SPA + BFF chạy trên Cloudflare Workers (Nitro preset `cloudflare-module`), sau middleware authn OIDC: staff đăng nhập qua authorization server `auth`, token giữ server-side, trình duyệt chỉ thấy session cookie + CSRF cookie.

Nx project `@ecoma-io/backoffice`, tags `type:composition`, `scope:backoffice`, `runtime:edge`.

## Purpose

- Cung cấp UI quản trị (sổ staff, vai trò, permission, audit, onboarding staff) và BFF đọc dữ liệu nội bộ trong cùng một deploy unit: trên Cloudflare Workers chạy như Worker `ecoma-backoffice` (`wrangler.jsonc`, `env.staging` → `stg-ecoma-backoffice`), trên lane local chạy như container Node do `deploys/backoffice-deploy` provision (override preset `node-server` lúc build image).
- Composition, không phải bounded context (`docs/domains/README.md` §3): ngữ nghĩa staff/RBAC/entitlement canonical nằm ở `docs/domains/staff-access/`; persistence mà project này sở hữu hiện tại là `db-backoffice` (schema `backoffice`) — phân định ownership là nội dung của `docs/domains/staff-access/` và `docs/applications/backoffice/`.
- Thiết kế component là nội dung canonical của `docs/applications/backoffice/` — README này chỉ định vị các phần tử trong project.

## Responsibilities

- **UI** (`app/pages/`): `/` (index), `/staff`, `/roles`, `/permissions`, `/audit`, `/onboarding`; shell dùng `@ecoma-io/ui-app-shell` + `@ecoma-io/ui-ecoma-logo`; i18n qua `@nuxtjs/i18n` (`app/i18n/`, catalog `en`/`vi`/`zh-CN`).
- **Auth flow** (`server/api/auth/`): `GET /api/auth/login` khởi Authorization Code Flow + PKCE, `GET /api/auth/callback` đổi code lấy token, `POST /api/auth/logout` thu hồi phiên (idempotent 204).
- **BFF read** (`server/api/`): `GET /api/me` và `/api/onboarding-status` qua `requirePrincipal`; `/api/staff`, `/api/roles`, `/api/permissions`, `/api/entitlements`, `/api/audit` qua `withReadEnforcement` (`server/read-route.ts` — principal + permission catalog + audit trước khi trả dữ liệu); catch-all `/api/[...path]` và entry `/api` trả 404 để path lạ không rơi vào SPA fallback.
- **Middleware authn** (`server/middleware/authn.ts`): ranh giới chặn là `/api/**` — đọc cookie `__Host-backoffice-session`, load phiên từ `db-backoffice` theo `id_hash = SHA-256(id)` (bảng `bff_sessions`), verify access token offline ES256; thiếu phiên → 401, dependency hỏng → 503, fail-closed.
- **Persistence `db-backoffice`** (`db/`): 6 migration SQL thuần dưới `db/migrations/` — `0001` bảng domain (`staff`, `permissions`, `roles`, `role_permissions`, `role_assignments`, `authorization_audit`), `0002` grant theo bảng, `0003` seed permission catalog, `0004` guard tự nâng quyền, `0005` guard integrity catalog, `0006` `bff_sessions`/`bff_login_flows`; runtime role `ecoma_backoffice_runtime` chỉ DML hạn chế.
- **Integration** qua Service Binding khai trong `wrangler.jsonc` (`services`): `ACCOUNT_SERVICE` → `ecoma-account-bridge` (displayName qua contract `GET /internal/account/profiles`, envelope HMAC) và `STAFF_ACCESS_SERVICE` → `ecoma-staff-access`; trên lane local Node, `STAFF_ACCESS_SERVICE` được mount bởi Nitro plugin `server/plugins/staff-access-service-shim.ts` từ `NUXT_BACKOFFICE_STAFF_ACCESS_SERVICE_URL` do `deploys/backoffice-deploy` cấp.
- **Gating dữ liệu UI** (`app/backoffice-data/`): `NITRO_PUBLIC_BACKOFFICE_DATA_MODE` nhận `prototype` (fixture client-side) hoặc `realtime`; giá trị khác → trạng thái `unavailable` (fail-closed). Staging khai `realtime`, production khai `disabled`.
- **Health/readiness**: `GET /health` và `GET /ready` (`server/routes/`).

## Boundaries

- Không host bounded context nào: ngữ nghĩa staff/RBAC/entitlement thuộc `staff-access`; `displayName` là dữ liệu hồ sơ của `account` (đọc qua contract, cache trong bộ nhớ BFF, không lưu bản sao bền vững); verify token là việc của `auth`.
- Không đọc database của service khác — `db-backoffice` chỉ phục vụ schema `backoffice` của project này; mọi dữ liệu nghiệp vụ khác đi qua API của context sở hữu.
- Trang UI và static asset không nằm trong ranh giới middleware authn (chỉ `/api/**`) — đánh đổi được ghi tường minh trong `server/middleware/authn.ts`.
- Topology deploy ở system level → `docs/architecture/01-architecture.md` §2; cấu hình OIDC/secret trên lane local do `deploys/backoffice-deploy` cấp qua container `envs` (`NUXT_BACKOFFICE_AUTH_ISSUER`/`_AUDIENCE`/`_CLIENT_ID`, `AUTH_INTERNAL_SECRET`, `NITRO_BACKOFFICE_DATABASE_URL`), thiếu bộ OIDC là middleware authn 503 mọi `/api/**`.

## Development

```bash
pnpm nx run @ecoma-io/backoffice:serve          # nuxt dev — devServer port 4201
pnpm nx run @ecoma-io/backoffice:lint
pnpm nx run @ecoma-io/backoffice:typecheck      # nuxt typecheck (vue-tsc)
pnpm nx run @ecoma-io/backoffice:typecheck-db   # tsc cho db/
pnpm nx run @ecoma-io/backoffice:build          # nuxt build — preset cloudflare-module
pnpm nx run @ecoma-io/backoffice:db:migrate     # áp migration — cần kết nối tới PostgreSQL
```

- Dev server dùng port khai trong `devServer` của `nuxt.config.ts` (4201); Nitro config riêng ở `nitro.config.ts` (preset `cloudflare-module`, alias `pg-native`).
- Trên lane local, `db:migrate` do `backoffice-deploy` chạy trong container gắn platform network (platform PostgreSQL không publish host port); target này dành cho runner có kết nối trực tiếp.

## Testing

```bash
pnpm nx run @ecoma-io/backoffice:test             # vitest (jsdom) — spec colocated trong app/, server/, tests/
pnpm nx run @ecoma-io/backoffice:test-integration # tests/integrations + tests/databases — PostgreSQL thật (testcontainers)
```

- `test` dependsOn `nuxt-prepare`; `test-integration` dependsOn `nuxt-prepare` + `build` vì một spec khởi động workerd trên bundle Nitro thật (`tests/integrations/worker-runtime.spec.ts`).
- Suite browser app-owned nằm ở `e2e/` (Playwright, `playwright.config.ts`, webServer tự quản `nuxt dev`); project không khai Nx target riêng cho suite này.
- System E2E của luồng truy cập staff là suite độc lập: `system-tests/e2e/backoffice-access-control-e2e/`.
- Phân loại và canonical target theo `docs/architecture/06-testing.md` §3–§4.

## Related Documentation

- [`docs/applications/backoffice/README.md`](../../docs/applications/backoffice/README.md) — component doc; [`01-architecture.md`](../../docs/applications/backoffice/01-architecture.md) — composition, onboarding gate displayName, API surface.
- [`docs/domains/staff-access/README.md`](../../docs/domains/staff-access/README.md) — bounded context sở hữu ngữ nghĩa staff/RBAC/entitlement; [`domain-model.md`](../../docs/domains/staff-access/domain-model.md).
- [`docs/features/internal-access/access-protected-staff-resources.md`](../../docs/features/internal-access/access-protected-staff-resources.md) — capability mà bề mặt này hiện thực.
- [`apps/backoffice/db/README.md`](./db/README.md) — schema, role, migration của `db-backoffice`.
- [`apps/account/README.md`](../../apps/account/README.md) và [`apps/auth/README.md`](../../apps/auth/README.md) — hai dependency qua contract.
- [`deploys/backoffice-deploy/index.ts`](../../deploys/backoffice-deploy/index.ts) — Pulumi program provision container + OIDC config trên lane local.
