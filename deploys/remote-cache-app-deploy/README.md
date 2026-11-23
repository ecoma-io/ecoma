# Remote Cache App Deploy

Pulumi deployment project của `apps/remote-cache-app` — SPA admin + BFF server routes (`/api/**` qua Nitro) của Remote Cache — trên lane local: container Nitro preset `node-server` phía sau Traefik với router `Host(remote-cache-app.<rootHostname>)`. Unit SỞ HỮU database phiên BFF riêng `db-remote-cache-app` (#180, ADR-0035) — provision hai role + database + migration qua `scripts.ts`, cùng mô hình với `pact-broker-app-deploy`. Chương trình Pulumi ở `index.ts` (lane guard nạp `local-program.ts` cho stack `local-*`, `staging-program.ts` cho stack staging), entry lifecycle ở `local.ts`/`staging.ts`, image ở `Dockerfile`, script build ở `scripts.ts` (hàm thuần, spec colocated).

Nx project `remote-cache-app-deploy`, tags `type:deployment`, `scope:remote-cache`, `runtime:native`. Hai lane: local (`-c local`) và staging (`-c staging` — xem §Staging lane).

## Purpose

- Cung cấp container chạy SPA admin + BFF của component Remote Cache trên local platform: static assets do Nitro `node-server` phục vụ, `/api/portal/**` proxy tới control plane qua envelope HMAC nội bộ mang actor sub đã verify (ADR-0034), phiên BFF nằm trong `db-remote-cache-app`.
- Build app diễn ra bên trong Docker build (hai stage trong `Dockerfile`) — không qua target `build` Nx trên host, khác các WIC container mount bundle.

## Responsibilities

- **Image** (`Dockerfile`): một stage — COPY artifact `.output-node/` (preset `node-server`) do Nx `build:development` build sẵn qua target `local-build`, fail-loud kiểm entrypoint `server/index.mjs`; chạy non-root; base image ghim theo digest; closure build (Nx project graph) gồm `libs/ui-app-shell`, `libs/ui-ecoma-logo` và `libs/internal-auth-contracts` (BFF ký envelope HMAC).
- **Database phiên BFF** (`scripts.ts` + `index.ts`, ADR-0035): provision hai role (`ecoma_remote_cache_app_migrator`, `ecoma_remote_cache_app_runtime`) + `db-remote-cache-app` qua `docker exec` vào PostgreSQL platform — mật khẩu qua map `environment` của provider, không argv; migration qua container ephemeral chạy runner của authority `databases/remote-cache-app-db` (`tsx runner.mts migrate`). Script text không chứa secret nào (spec `scripts.spec.ts` chấm bất biến tĩnh này).
- **Container** (`index.ts`): đọc output platform qua `StackReference` (`networkName`, `namespace`, `rootHostname`, `traefikHostPort`) fail-closed, verify cùng namespace với worktree; alias `ecoma-remote-cache-app`; env BFF (base URL control plane qua alias nội bộ `ecoma-remote-cache-api:4207`, secret HMAC nội bộ đọc cross-stack từ stack `remote-cache-api-deploy`, connection string DB role runtime, OIDC issuer/audience ghim từ platform outputs, `client_id` đọc cross-stack từ stack `auth-deploy`); labels Traefik (rule `Host(remote-cache-app.<rootHostname>)`, entrypoint `websecure`, TLS, loadbalancer port 3000); healthcheck `GET /health` yêu cầu 2xx (`r.ok`); `wait: true` nên `pulumi up` xanh là bằng chứng serving; image ghim `tag@sha256` để rebuild tạo diff tường minh.
- Stack exports: `imageDigest`, `containerName`, `containerId`, `provisionCommandName`, `migrateCommandName`, `namespaceVerified`.

## Staging lane (#357/#350)

Trên stack `staging`, entry guard `index.ts` nạp `staging-program.ts` khai **HyperdriveConfig** `db-remote-cache-app-staging` của `db-remote-cache-app` (inventory §9.1 — config per-database per-lane; pattern pilot #539; tổng quát hoá engine staging là follow-up #543). Query cache của config PHẢI OFF (`caching.disabled = true`) — KHÁCH với mặc định server-side của Cloudflare (HD3): cache không invalidate khi ghi, một phiên BFF đã xoá trả về từ cache là lần cấp quyền thứ hai (ADR-0031 §3/ADR-0035). Origin của config đọc từ stack config và fail-closed khi chưa có: đường tới origin private là Tunnel/VPC Service của #349, chưa provision lần nào — `pulumi preview` đỏ cho tới khi #349 cấp origin, không có đường "origin giả". Entry `staging.ts` chỉ có hai phase `preview`/`up`; mọi đối số khác bị từ chối tường minh (không destroy — runbook #364), mỗi lần chạy ghi một bản ghi evidence JSON vào `.staging-evidence/` (ngoài Git).

### Config và credential bắt buộc (fail-closed)

Engine `staging-run.ts` kiểm năm khóa env fail-closed TRƯỚC khi Pulumi chạy (danh sách ĐẦY ĐỦ khóa thiếu, không fallback); ba khóa stack config được thân chương trình kiểm tại lúc preview:

| Mục                                                                          | Kênh          | Cách đặt                                                                                                                                                       |
| ---------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `namespace:originHost` / `namespace:originPort` / `namespace:originPassword` | Pulumi config | origin PostgreSQL staging cho Hyperdrive (`originPort` thiếu là default 5432; password qua `set --secret`) — thiếu host/password là preview fail-closed (#349) |
| `CLOUDFLARE_API_TOKEN`                                                       | env           | token Cloudflare quyền provision resource account (`04` R24) — env-only, không bao giờ vào provider config (state ghi lại config provider)                     |
| `ECOMA_PULUMI_STATE_URL_STAGING`                                             | env           | URL backend R2 của stack staging — thiếu nghĩa là staging chưa bootstrap (#350), tuyệt đối không fallback backend khác                                         |
| `PULUMI_CONFIG_PASSPHRASE`                                                   | env           | passphrase per-stack                                                                                                                                           |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`                                | env           | token R2 scope một bucket cho backend s3 (`04` R23)                                                                                                            |

### Wiring sau lần `up` xanh đầu tiên

`staging-up` xong đọc stack output `hyperdriveConfigId`, kiểm id thật (UUID không-phải-toàn-zeros — cùng invariant với guard `resource-bindings`) và surface id cho operator điền vào `env.staging.hyperdrive[].id` (binding `DB_REMOTE_CACHE_APP`) của `apps/remote-cache-app/wrangler.jsonc` — entry không tự sửa file đó (wrangler config là tài sản review-able trong Git).

## Boundaries

- Chỉ phủ lane local cho resource Docker — lane staging khai đúng một resource Cloudflare (HyperdriveConfig của `db-remote-cache-app`, §Staging lane); Worker identity/binding của delivery lane khai trong `apps/remote-cache-app/wrangler.jsonc` qua Wrangler, không nằm trong chương trình này.
- Không sở hữu code của `apps/remote-cache-app` — sửa hành vi app thì sửa app; identity Cloudflare của app khai trong `wrangler.jsonc` của nó.
- Không chạm `db-remote-cache` của control plane — cross-service đi qua HTTP + HMAC envelope (invariant 1, `docs/architecture/01-architecture.md` §9).
- Admin UI truy cập control plane của Remote Cache theo ràng buộc ghi trong `docs/applications/remote-cache/` — wiring consumer không thuộc chương trình deploy này.

## Development

```bash
pnpm nx run remote-cache-app-deploy:lint
pnpm nx run remote-cache-app-deploy:typecheck
pnpm nx run remote-cache-app-deploy:test
```

Lifecycle mutate Docker/Pulumi state thật — chỉ chạy khi chủ đích thay đổi stack local:

```bash
pnpm nx run remote-cache-app-deploy:local-up -c local   # dependsOn: platform-deploy, auth-deploy, remote-cache-api-deploy (local-up)
pnpm nx run remote-cache-app-deploy:local-down -c local # destroy của riêng project; no-op exit 0 nếu worktree chưa từng deploy
```

## Testing

- `test` — spec colocated `scripts.spec.ts` (bất biến tĩnh của script text — không Docker, không PostgreSQL) và `staging-run.spec.ts` (engine staging lane — pure functions + exec inject, không chạy Pulumi thật và không đụng backend nào).
- Bằng chứng serving của unit nằm trong `local-up`: healthcheck `/health` phải chuyển `healthy` trước khi `pulumi up` báo thành công (`wait: true`).

## Related Documentation

- [`apps/remote-cache-app/README.md`](../../apps/remote-cache-app/README.md) — app được deploy: phạm vi shell, BFF và các phần không tồn tại.
- [`docs/applications/remote-cache/README.md`](../../docs/applications/remote-cache/README.md) — component Remote Cache và hai composition của nó.
- [`docs/domains/remote-cache/README.md`](../../docs/domains/remote-cache/README.md) — bounded context sở hữu nghiệp vụ remote-cache.
- [`docs/architecture/local-development/01-platform.md`](../../docs/architecture/local-development/01-platform.md) — routing Traefik và cách ly worktree.
- [`deploys/platform-deploy/README.md`](../platform-deploy/README.md) — platform mà unit này đọc outputs.
- [`deploys/pact-broker-app-deploy/README.md`](../pact-broker-app-deploy/README.md) — unit mẫu cho mô hình sở hữu database + kênh secret.
