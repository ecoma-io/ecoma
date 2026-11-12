# Remote Cache API Deploy

Pulumi deployment project của `apps/remote-cache-api` — service Remote Cache (API cache protocol + control plane tenant/project/API key) — trên lane local, dạng WIC container một worker. Provision database `db-remote-cache` + hai role PostgreSQL, migration và bootstrap tenant đi đúng đường canonical của app. Chương trình Pulumi ở `index.ts`, entry lifecycle ở `local.ts`, smoke ở `smoke.ts`.

Nx project `remote-cache-api-deploy`, tags `type:deployment`, `scope:remote-cache`, `runtime:native`. Target lifecycle chỉ có configuration `local` — lane duy nhất của chương trình.

## Purpose

- Đưa service lên local với đủ vòng đời: provision database → migration → bootstrap tenant → image → container → readiness.
- Object storage của data plane là SeaweedFS do `platform-deploy` provision — unit này chỉ cấu hình credential cho worker, không provision storage.

## Responsibilities

- **Provisioning** (`index.ts`): tạo `db-remote-cache` + hai role `ecoma_remote_cache_migrator`/`ecoma_remote_cache_runtime` qua `docker exec` psql trong container PostgreSQL của platform; guard-create role/database, `ALTER ROLE ... PASSWORD` mỗi lần up (mật khẩu do entry up sinh); `REVOKE CONNECT` chéo khỏi database service khác; hardening schema `public`.
- **Migration + bootstrap tenant** (`index.ts`): container ephemeral trên platform network chạy `apps/remote-cache-api/db/apply.mts` (advisory lock, không qua binding Hyperdrive) rồi `db/bootstrap-tenant.mts` — tenant `ecoma` + membership owner + host project `ecoma-ci` + first trusted CI key, trong một transaction idempotent theo natural key, fail-closed khi trạng thái đã lưu lệch.
- **Secret lifecycle** (`local.ts`): hai mật khẩu role xoay mỗi lần up; `objectStorageSecretKey` đọc cross-stack từ stack config platform (`objectStorage:remoteCacheSecretKey`) rồi copy vào stack config của unit; `tenantOwnerSub` được giải trước khi up qua dx runner `bootstrap-superadmin --resolve-if-bootstrapped` (đọc `db-account` + `db-staff-access` bằng credential migrator cross-stack); `ciKeyPlaintext` set-if-absent — bootstrap chỉ lưu SHA-256 hash.
- **Image + container WIC** (`Dockerfile`, `wic-entrypoint.sh`, `index.ts`): một worker `ecoma-remote-cache-api` port 4207 (`dev.port` của app), alias `ecoma-remote-cache-api`; env gồm Hyperdrive local connection string (binding `DB_REMOTE_CACHE`, role runtime) và bộ `S3_*` của object storage; healthcheck `GET /health`, `wait: true` nên `pulumi up` xanh là bằng chứng serving; không route Traefik, không publish port ra host.
- Stack exports: `provisionCommandName`, `migrateCommandName`, `bootstrapTenantCommandName`, `imageDigest`, `containerName`, `containerId`, `stateVolumeName`, `namespaceVerified`.

## Boundaries

- Chỉ phủ lane local — Hyperdrive/Worker identity của delivery lane khai trong `apps/remote-cache-api/wrangler.jsonc` và cấu hình Cloudflare, không nằm trong chương trình này.
- Consumer của API ở local là fetch server-side qua alias nội bộ — không có route công khai nào qua Traefik.
- Ranh giới tenant và ownership → `docs/domains/remote-cache/`; storage partitioning và protocol → `docs/applications/remote-cache/`.

## Development

```bash
pnpm nx run remote-cache-api-deploy:lint
pnpm nx run remote-cache-api-deploy:typecheck
```

Lifecycle mutate Docker/Pulumi state thật — chỉ chạy khi chủ đích thay đổi stack local:

```bash
pnpm nx run remote-cache-api-deploy:local-up -c local   # dependsOn: platform + account + staff-access + build app
pnpm nx run remote-cache-api-deploy:local-down -c local # destroy của riêng project; no-op exit 0 nếu worktree chưa từng deploy
```

## Testing

Target `test` chạy Vitest trên hai spec colocated: `object-storage-env.spec.ts` (đúng bộ tên biến `S3_*` mà `apps/remote-cache-api/src/config.ts` đọc; secret key không nằm trong map non-secret) và `superadmin-resolver.spec.ts` (credential chỉ trong env của process, không argv; password percent-encode trong DATABASE_URL).

`local-smoke` (dependsOn `local-up` của cùng project) là kiểm thật: `GET /ready` phải báo `storage: 'configured'`, rồi client S3 thật của app round-trip trên bucket SeaweedFS — secret đi qua stdin của `docker run -i`. Không e2e suite nào khai unit này làm prerequisite.

## Related Documentation

- [`docs/applications/remote-cache/README.md`](../../docs/applications/remote-cache/README.md) — hai composition của component và ranh giới với context.
- [`docs/applications/remote-cache/03-operations.md`](../../docs/applications/remote-cache/03-operations.md) — §Local lane: luồng credential object storage và nghĩa của `local-smoke`.
- [`docs/domains/remote-cache/README.md`](../../docs/domains/remote-cache/README.md) — bounded context: tenant, project, API key, quota.
- [`docs/architecture/local-development/01-platform.md`](../../docs/architecture/local-development/01-platform.md) — ownership SeaweedFS và hai volume của platform.
- [`deploys/platform-deploy/README.md`](../platform-deploy/README.md) — platform mà unit này đọc outputs.
