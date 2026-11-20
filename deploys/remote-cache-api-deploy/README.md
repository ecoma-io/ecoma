# Remote Cache API Deploy

Pulumi deployment project của `apps/remote-cache-api` — service Remote Cache (API cache protocol + control plane tenant/project/API key) — trên lane local, dạng WIC container một worker. Provision database `db-remote-cache` + hai role PostgreSQL, migration và bootstrap tenant đi đúng đường canonical của app. Chương trình Pulumi ở `index.ts`, entry lifecycle ở `local.ts`, smoke ở `smoke.ts`.

Nx project `remote-cache-api-deploy`, tags `type:deployment`, `scope:remote-cache`, `runtime:native`. Hai lane: local (`-c local`) và staging (`-c staging` — xem §Staging lane).

## Purpose

- Đưa service lên local với đủ vòng đời: provision database → migration → bootstrap tenant → image → container → readiness.
- Object storage của data plane là SeaweedFS do `platform-deploy` provision — unit này chỉ cấu hình credential cho worker, không provision storage.

## Responsibilities

- **Provisioning** (`index.ts`): tạo `db-remote-cache` + hai role `ecoma_remote_cache_migrator`/`ecoma_remote_cache_runtime` qua `docker exec` psql trong container PostgreSQL của platform; guard-create role/database, `ALTER ROLE ... PASSWORD` mỗi lần up (mật khẩu do entry up sinh); `REVOKE CONNECT` chéo khỏi database service khác; hardening schema `public`.
- **Migration + bootstrap tenant** (`index.ts`): container ephemeral trên platform network chạy runner của authority `deploys/remote-cache-db` (`runner.mts migrate`, advisory lock, không qua binding Hyperdrive) rồi `apps/remote-cache-api/db/bootstrap-tenant.mts` — tenant `ecoma` + membership owner + host project `ecoma-ci` + first trusted CI key, trong một transaction idempotent theo natural key, fail-closed khi trạng thái đã lưu lệch.
- **Secret lifecycle** (`local.ts`): hai mật khẩu role xoay mỗi lần up; `objectStorageSecretKey` đọc cross-stack từ stack config platform (`objectStorage:remoteCacheSecretKey`) rồi copy vào stack config của unit; `tenantOwnerSub` được giải trước khi up qua dx runner `bootstrap-superadmin --resolve-if-bootstrapped` (đọc `db-account` + `db-staff-access` bằng credential migrator cross-stack); `ciKeyPlaintext` set-if-absent — bootstrap chỉ lưu SHA-256 hash.
- **Image + container WIC** (`Dockerfile`, `wic-entrypoint.sh`, `index.ts`): một worker `ecoma-remote-cache-api` port 4207 (`dev.port` của app), alias `ecoma-remote-cache-api`; env gồm Hyperdrive local connection string (binding `DB_REMOTE_CACHE`, role runtime) và bộ `S3_*` của object storage; healthcheck `GET /health`, `wait: true` nên `pulumi up` xanh là bằng chứng serving; không route Traefik, không publish port ra host.
- Stack exports: `provisionCommandName`, `migrateCommandName`, `bootstrapTenantCommandName`, `imageDigest`, `containerName`, `containerId`, `stateVolumeName`, `namespaceVerified`.

## Staging lane (#350)

Trên stack `staging`, entry guard `index.ts` nạp `staging-program.ts` khai đúng hai resource theo inventory §7.4.1/§9.1: **R2 bucket object storage** `ecoma-remote-cache-staging` (#514) và **HyperdriveConfig** `db-remote-cache-staging` của `db-remote-cache` (pattern pilot #539 — config per-database, per-lane; tổng quát hoá engine staging là follow-up #543). Query cache của config PHẢI OFF (`caching.disabled = true`) — cache không invalidate khi ghi, một API key đã revoke trả về từ cache là lần cấp quyền thứ hai (contract của app). Origin của config đọc từ stack config và fail-closed khi chưa có: đường tới origin private là Tunnel/VPC Service của #349, chưa provision lần nào — `pulumi preview` đỏ cho tới khi #349 cấp origin, không có đường "origin giả".

### Config và credential bắt buộc (fail-closed)

Bốn khóa env được engine `staging-run.ts` kiểm fail-closed TRƯỚC khi Pulumi chạy (danh sách ĐẦY ĐỦ khóa thiếu, không fallback); ba khóa stack config được thân chương trình kiểm tại lúc preview:

| Mục                                                                          | Kênh          | Cách đặt                                                                                                                                                       |
| ---------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `namespace:originHost` / `namespace:originPort` / `namespace:originPassword` | Pulumi config | origin PostgreSQL staging cho Hyperdrive (`originPort` thiếu là default 5432; password qua `set --secret`) — thiếu host/password là preview fail-closed (#349) |
| `CLOUDFLARE_API_TOKEN`                                                       | env           | token Cloudflare quyền provision resource account (`04` R24) — env-only, không bao giờ vào provider config (state ghi lại config provider)                     |
| `ECOMA_PULUMI_STATE_URL_STAGING`                                             | env           | URL backend R2 của stack staging — thiếu nghĩa là staging chưa bootstrap (#350), tuyệt đối không fallback backend khác                                         |
| `PULUMI_CONFIG_PASSPHRASE`                                                   | env           | passphrase per-stack                                                                                                                                           |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`                                | env           | token R2 scope một bucket cho backend s3 (`04` R23)                                                                                                            |

### Wiring sau lần `up` xanh đầu tiên

`staging-up` xong đọc stack output `hyperdriveConfigId`, kiểm id thật (UUID không-phải-toàn-zeros — cùng invariant với guard `resource-bindings`) và surface id cho operator điền vào `env.staging.hyperdrive[].id` của `apps/remote-cache-api/wrangler.jsonc` — entry không tự sửa file đó (wrangler config là tài sản review-able trong Git). Secrets `S3_ENDPOINT`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` của Worker `stg-ecoma-remote-cache-api` đặt qua `wrangler secret put` (giá trị gắn account — endpoint path-style R2 `04` R22 — và token R2 scope một bucket `04` R23); `S3_BUCKET` đã là `var` thật trong wrangler.jsonc trỏ đúng bucket do stack này provision.

### Không có destroy

Lane staging chỉ có hai phase `preview`/`up` (`staging.ts`); mọi đối số khác bị từ chối tường minh — teardown staging KHÔNG có workflow, checklist tay thuộc runbook #364. Mỗi lần chạy ghi một bản ghi evidence JSON vào `.staging-evidence/` (ngoài Git).

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

Target `test` chạy Vitest trên ba spec colocated: `object-storage-env.spec.ts` (đúng bộ tên biến `S3_*` mà `apps/remote-cache-api/src/config.ts` đọc; secret key không nằm trong map non-secret), `superadmin-resolver.spec.ts` (credential chỉ trong env của process, không argv; password percent-encode trong DATABASE_URL) và `scripts.spec.ts` (bất biến tĩnh của script text do `scripts.ts` dựng — không giá trị secret nào vào command text, password chỉ đọc qua TÊN biến môi trường, `ALTER ROLE ... PASSWORD` nạp vào psql qua STDIN).

Target `test-integration` (argv-hygiene, `tests/integrations/`) là kiểm thật bắt buộc Docker: chạy đúng script provision/migrate mà `index.ts` render với sentinel credentials — shim `docker` ghi argv của mọi lời gọi và watcher quét `/proc/<pid>/cmdline` suốt luồng; assert không sentinel nào vào argv/output/script text, đồng thời trạng thái database vẫn đúng (idempotency, xoay password được verify thật qua scram, migrate nối đúng database). Vắng Docker là suite ĐỎ, không skip.

`local-smoke` (dependsOn `local-up` của cùng project) là kiểm thật: `GET /ready` phải báo `storage: 'configured'`, rồi client S3 thật của app round-trip trên bucket SeaweedFS — secret đi qua stdin của `docker run -i`. Không e2e suite nào khai unit này làm prerequisite.

## Related Documentation

- [`docs/applications/remote-cache/README.md`](../../docs/applications/remote-cache/README.md) — hai composition của component và ranh giới với context.
- [`docs/applications/remote-cache/03-operations.md`](../../docs/applications/remote-cache/03-operations.md) — §Local lane: luồng credential object storage và nghĩa của `local-smoke`.
- [`docs/domains/remote-cache/README.md`](../../docs/domains/remote-cache/README.md) — bounded context: tenant, project, API key, quota.
- [`docs/architecture/local-development/01-platform.md`](../../docs/architecture/local-development/01-platform.md) — ownership SeaweedFS và hai volume của platform.
- [`deploys/platform-deploy/README.md`](../platform-deploy/README.md) — platform mà unit này đọc outputs.
