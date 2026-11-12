# Remote Cache App Deploy

Pulumi deployment project của `apps/remote-cache-app` — SPA admin shell của Remote Cache — trên lane local: container Nitro preset `node-server` phía sau Traefik với router `Host(remote-cache-app.<rootHostname>)`. App composition này không có business backend — không database, không role, không migration, không binding nào. Chương trình Pulumi ở `index.ts`, entry lifecycle ở `local.ts`, image ở `Dockerfile`.

Nx project `remote-cache-app-deploy`, tags `type:deployment`, `scope:remote-cache`, `runtime:native`. Target lifecycle chỉ có configuration `local` — lane duy nhất của chương trình.

## Purpose

- Cung cấp container chạy SPA admin của component Remote Cache trên local platform: chỉ `/health`, `/ready` và static assets do Nitro `node-server` phục vụ.
- Build app diễn ra bên trong Docker build (hai stage trong `Dockerfile`) — không qua target `build` Nx trên host, khác các WIC container mount bundle.

## Responsibilities

- **Image** (`Dockerfile`): hai stage build/runtime; build Nuxt với override `--preset=node-server` (thắng giá trị `preset` trong `nitro.config.ts`, không sửa config file); chỉ `.output` được copy vào image slim, chạy non-root; base image ghim theo digest.
- **Container** (`index.ts`): đọc ba output platform qua `StackReference` (`networkName`, `namespace`, `rootHostname`) fail-closed, verify cùng namespace với worktree; alias `ecoma-remote-cache-app`; env chỉ `PORT=3000` + `NODE_ENV=production`; labels Traefik (rule `Host(remote-cache-app.<rootHostname>)`, entrypoint `websecure`, TLS, loadbalancer port 3000); healthcheck `GET /health` yêu cầu 2xx (`r.ok`); `wait: true` nên `pulumi up` xanh là bằng chứng serving; image ghim `tag@sha256` để rebuild tạo diff tường minh.
- Stack exports: `imageDigest`, `containerName`, `containerId`, `namespaceVerified`.

## Boundaries

- Không provision database hay hạ tầng Cloudflare; staging/production của app đi preset `cloudflare-module` qua Wrangler, không qua chương trình này.
- Không sở hữu code của `apps/remote-cache-app` — sửa hành vi app thì sửa app; identity Cloudflare của app khai trong `wrangler.jsonc` của nó.
- Admin UI truy cập control plane của Remote Cache theo ràng buộc ghi trong `docs/applications/remote-cache/` — wiring consumer không thuộc chương trình deploy này.

## Development

```bash
pnpm nx run remote-cache-app-deploy:lint
pnpm nx run remote-cache-app-deploy:typecheck
```

Lifecycle mutate Docker/Pulumi state thật — chỉ chạy khi chủ đích thay đổi stack local:

```bash
pnpm nx run remote-cache-app-deploy:local-up -c local   # dependsOn duy nhất platform-deploy:local-up
pnpm nx run remote-cache-app-deploy:local-down -c local # destroy của riêng project; no-op exit 0 nếu worktree chưa từng deploy
```

## Testing

Project không có target `test`/`test-integration`/`system-test` — targets đã xác nhận từ project graph: `local-up`, `local-down`, `lint`, `typecheck`.

- Kiểm tĩnh: `lint` + `typecheck`.
- Bằng chứng serving của unit nằm trong `local-up`: healthcheck `/health` phải chuyển `healthy` trước khi `pulumi up` báo thành công (`wait: true`).

## Related Documentation

- [`apps/remote-cache-app/README.md`](../../apps/remote-cache-app/README.md) — app được deploy: phạm vi shell và các phần không tồn tại.
- [`docs/applications/remote-cache/README.md`](../../docs/applications/remote-cache/README.md) — component Remote Cache và hai composition của nó.
- [`docs/domains/remote-cache/README.md`](../../docs/domains/remote-cache/README.md) — bounded context sở hữu nghiệp vụ remote-cache.
- [`docs/architecture/local-development/01-platform.md`](../../docs/architecture/local-development/01-platform.md) — routing Traefik và cách ly worktree.
- [`deploys/platform-deploy/README.md`](../platform-deploy/README.md) — platform mà unit này đọc outputs.
