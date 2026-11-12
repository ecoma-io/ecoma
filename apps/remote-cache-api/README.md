# Remote Cache API

Component API của Remote Cache — self-hosted remote cache cho Nx: control plane quản lý tenant/project/API key và data plane phục vụ Nx remote cache protocol `GET`/`PUT /v1/cache/{hash}` với Bearer API key project-scoped. Hai composition `remote-cache-api` + `remote-cache-app` được mô tả chung trong `docs/applications/remote-cache/`; nghiệp vụ multi-tenant thuộc bounded context `remote-cache` tại `docs/domains/remote-cache/`.

Nx project `@ecoma-io/remote-cache-api`, tags `type:composition`, `scope:remote-cache`, `runtime:edge`.

## Purpose

- Worker `ecoma-remote-cache-api` (`wrangler.jsonc`, entry `dist/main.js` sinh bởi `@nx/esbuild`): composition root `src/main.ts` boot fail-closed từ Hyperdrive binding `DB_REMOTE_CACHE`; `/health` không credential và không chạm DB, `/ready` probe DB và báo trạng thái storage config.
- Control plane (`src/routes.ts`): `POST /projects` tạo project trong tenant của key gọi kèm API key mặc định (scopes do request chọn, token trả một lần show-once), `GET /projects` liệt kê project của tenant với phân trang cursor keyset.
- Data plane (`src/cache-routes.ts`): `GET /v1/cache/:hash` và `PUT /v1/cache/:hash` theo Nx remote cache protocol, stream artifact tới object storage S3-compatible qua `src/storage.ts`.
- Thiết kế boundary, request flow, storage partitioning và invariants là nội dung canonical của `docs/applications/remote-cache/01-architecture.md`.

## Responsibilities

- **Xác thực API key**: lookup hash-only theo `token_hash` UNIQUE; token gọn không bao giờ chạm DB hay log; phân quyền theo scope `read`/`write` của key.
- **Lifecycle enforcement** (`src/lifecycle.ts`): trạng thái tenant/project được kiểm trước khi phục vụ — tenant suspended/deleted, project xoá, key revoked được ánh xạ từ domain error sang HTTP status tương ứng.
- **Quota mặc định**: `DEFAULT_MAX_STORAGE_BYTES`, `DEFAULT_MAX_ENTRY_COUNT` áp cho project không có hàng `quota_limits`; `MAX_ARTIFACT_SIZE` chặn kích thước artifact; `DEFAULT_RETENTION_TTL_SECONDS` cho TTL entry.
- **Persistence**: `db/` là nguồn sự thật migration của `db-remote-cache` (PostgreSQL, schema `remote_cache`, ba role `ecoma_owner`/`ecoma_remote_cache_migrator`/`ecoma_remote_cache_runtime`); access qua `withRemoteCacheClient` của `@ecoma-io/remote-cache-infrastructure`.
- **Wire shape** theo `@ecoma-io/remote-cache-contracts` — response dựng qua validator của contract, không ghép field bằng tay.
- Middleware chung: request-id, security headers; lỗi cấu hình → 503 fail-closed; error handler log một dòng JSON không bao giờ chứa token hay `token_hash`.
- `smoke/smoke-inner.mts` nằm cùng app để deploy unit (`remote-cache-api-deploy`) chạy smoke real-storage: import `S3ObjectStorage` từ `../src/storage` và probe `GET /ready` qua alias DNS nội bộ; file không thuộc bundle Worker.

## Boundaries

- Không đọc database của service khác; `db-remote-cache` là storage duy nhất của component này — ranh giới tenant với `pact-broker` và entitlement Staff Access được chốt trong `docs/domains/remote-cache/` (ADR-0015).
- Cache là disposable build state: không phải source of truth, không phải serving dependency của application nào (`docs/architecture/01-architecture.md`, A18, invariant 22).
- Storage object là S3-compatible external (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`); thiếu bộ config storage thì data plane fail-closed 503 trong khi control plane vẫn phục vụ.
- Admin UI composition là Worker riêng `apps/remote-cache-app`; component này không phục vụ UI.

## Development

```bash
pnpm nx run @ecoma-io/remote-cache-api:build          # esbuild → dist/main.js
pnpm nx run @ecoma-io/remote-cache-api:lint
pnpm nx run @ecoma-io/remote-cache-api:typecheck      # tsc --build (phần TS)
pnpm nx run @ecoma-io/remote-cache-api:typecheck-db   # tsc --noEmit -p tsconfig.db.json
pnpm nx run @ecoma-io/remote-cache-api:db:migrate     # db/apply.mts — cần DATABASE_URL migrator
```

- Dev server dùng port khai trong `dev` của `wrangler.jsonc` (4207); Hyperdrive binding khai id chuỗi rỗng, connection string local đi qua biến `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_REMOTE_CACHE`.
- `db:migrate` mutate database thật và chạy từ runner có kết nối trực tiếp tới PostgreSQL, không qua Hyperdrive.

## Testing

```bash
pnpm nx run @ecoma-io/remote-cache-api:test             # vitest — unit colocated trong src/
pnpm nx run @ecoma-io/remote-cache-api:test-integration # tests/integrations + tests/databases — PostgreSQL thật (testcontainers)
```

- `tests/databases/` ghim migration, bootstrap tenant và phân loại classification/plan; `tests/integrations/` ghim control-plane routes, cache protocol, quota/retention (P4.3/P4.5) và roles.
- Phân loại test và canonical target theo `docs/architecture/06-testing.md`.

## Related Documentation

- [`docs/applications/remote-cache/README.md`](../../docs/applications/remote-cache/README.md) — component doc pair; [`01-architecture.md`](../../docs/applications/remote-cache/01-architecture.md) (boundary, request flow, storage partitioning), [`02-requirements.md`](../../docs/applications/remote-cache/02-requirements.md), [`03-operations.md`](../../docs/applications/remote-cache/03-operations.md).
- [`docs/domains/remote-cache/README.md`](../../docs/domains/remote-cache/README.md) — bounded context `remote-cache`; [`domain-model.md`](../../docs/domains/remote-cache/domain-model.md); ADR index tại [`adr/`](../../docs/domains/remote-cache/adr/README.md), trong đó [ADR-0015](../../docs/domains/remote-cache/adr/0015-remote-cache-bounded-context.md) xác lập storage và ranh giới tenant.
- [`apps/remote-cache-api/db/README.md`](./db/README.md) — schema, role, migration.
- [`apps/remote-cache-app/README.md`](../remote-cache-app/README.md) — admin UI composition của cùng component.
- [`docs/architecture/01-architecture.md`](../../docs/architecture/01-architecture.md) — topology deploy, data ownership và vị trí cache trong hệ thống.
