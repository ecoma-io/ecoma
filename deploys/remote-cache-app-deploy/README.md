# Remote Cache App Deploy

Pulumi deployment project của `apps/remote-cache-app` — SPA admin + BFF server routes (`/api/**` qua Nitro) của Remote Cache — trên lane local: container Nitro preset `node-server` phía sau Traefik với router `Host(remote-cache-app.<rootHostname>)`. Unit SỞ HỮU database phiên BFF riêng `db-remote-cache-app` (#180, ADR-0035) — provision hai role + database + migration qua `scripts.ts`, cùng mô hình với `pact-broker-app-deploy`. Chương trình Pulumi ở `index.ts`, entry lifecycle ở `local.ts`, image ở `Dockerfile`, script build ở `scripts.ts` (hàm thuần, spec colocated).

Nx project `remote-cache-app-deploy`, tags `type:deployment`, `scope:remote-cache`, `runtime:native`. Target lifecycle chỉ có configuration `local` — lane duy nhất của chương trình.

## Purpose

- Cung cấp container chạy SPA admin + BFF của component Remote Cache trên local platform: static assets do Nitro `node-server` phục vụ, `/api/portal/**` proxy tới control plane qua envelope HMAC nội bộ mang actor sub đã verify (ADR-0034), phiên BFF nằm trong `db-remote-cache-app`.
- Build app diễn ra bên trong Docker build (hai stage trong `Dockerfile`) — không qua target `build` Nx trên host, khác các WIC container mount bundle.

## Responsibilities

- **Image** (`Dockerfile`): một stage — COPY artifact `.output-node/` (preset `node-server`) do Nx `build:development` build sẵn qua target `local-build`, fail-loud kiểm entrypoint `server/index.mjs`; chạy non-root; base image ghim theo digest; closure build (Nx project graph) gồm `libs/ui-app-shell`, `libs/ui-ecoma-logo` và `libs/internal-auth-contracts` (BFF ký envelope HMAC).
- **Database phiên BFF** (`scripts.ts` + `index.ts`, ADR-0035): provision hai role (`ecoma_remote_cache_app_migrator`, `ecoma_remote_cache_app_runtime`) + `db-remote-cache-app` qua `docker exec` vào PostgreSQL platform — mật khẩu qua map `environment` của provider, không argv; migration qua container ephemeral chạy `tsx db/apply.mts` của app. Script text không chứa secret nào (spec `scripts.spec.ts` chấm bất biến tĩnh này).
- **Container** (`index.ts`): đọc output platform qua `StackReference` (`networkName`, `namespace`, `rootHostname`, `traefikHostPort`) fail-closed, verify cùng namespace với worktree; alias `ecoma-remote-cache-app`; env BFF (base URL control plane qua alias nội bộ `ecoma-remote-cache-api:4207`, secret HMAC nội bộ đọc cross-stack từ stack `remote-cache-api-deploy`, connection string DB role runtime, OIDC issuer/audience ghim từ platform outputs, `client_id` đọc cross-stack từ stack `auth-deploy`); labels Traefik (rule `Host(remote-cache-app.<rootHostname>)`, entrypoint `websecure`, TLS, loadbalancer port 3000); healthcheck `GET /health` yêu cầu 2xx (`r.ok`); `wait: true` nên `pulumi up` xanh là bằng chứng serving; image ghim `tag@sha256` để rebuild tạo diff tường minh.
- Stack exports: `imageDigest`, `containerName`, `containerId`, `provisionCommandName`, `migrateCommandName`, `namespaceVerified`.

## Boundaries

- Không provision hạ tầng Cloudflare; staging/production của app đi preset `cloudflare-module` qua Wrangler, không qua chương trình này.
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

- `test` — spec colocated `scripts.spec.ts`: bất biến tĩnh của script text (không Docker, không PostgreSQL).
- Bằng chứng serving của unit nằm trong `local-up`: healthcheck `/health` phải chuyển `healthy` trước khi `pulumi up` báo thành công (`wait: true`).

## Related Documentation

- [`apps/remote-cache-app/README.md`](../../apps/remote-cache-app/README.md) — app được deploy: phạm vi shell, BFF và các phần không tồn tại.
- [`docs/applications/remote-cache/README.md`](../../docs/applications/remote-cache/README.md) — component Remote Cache và hai composition của nó.
- [`docs/domains/remote-cache/README.md`](../../docs/domains/remote-cache/README.md) — bounded context sở hữu nghiệp vụ remote-cache.
- [`docs/architecture/local-development/01-platform.md`](../../docs/architecture/local-development/01-platform.md) — routing Traefik và cách ly worktree.
- [`deploys/platform-deploy/README.md`](../platform-deploy/README.md) — platform mà unit này đọc outputs.
- [`deploys/pact-broker-app-deploy/README.md`](../pact-broker-app-deploy/README.md) — unit mẫu cho mô hình sở hữu database + kênh secret.
