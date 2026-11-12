# Home Deploy

Pulumi deployment project provision **deploy unit của `apps/home` trên lane LOCAL**: image (Nuxt preset `node-server` build trong Docker) và container phía sau Traefik. Đây là deploy project (`type:deployment`), không phải application hay bounded context. Chương trình Pulumi nằm ở `index.ts`, entry lifecycle ở `local.ts`, image ở `Dockerfile`.

Nx project `home-deploy`, tags `type:deployment`, `scope:public`, `runtime:native`. Chỉ có lane local (`configurations: local`); staging/production của app khai trong `apps/home/wrangler.jsonc` và thuộc delivery lane — không nằm trong chương trình này.

## Purpose

- Đưa `apps/home` (public homepage) lên local platform — unit độc lập đầu tiên dùng hạ tầng platform, không sở hữu database hay secret nào.
- Là prerequisite thật của `platform-deploy:local-smoke`: smoke kiểm chuỗi redirect `/` → `/en` của home qua Traefik.

## Responsibilities

- **Image + container** (`Dockerfile`, `index.ts`): image multi-stage build Nuxt từ repo root (builder `default`, `load: true`, `push: false`); container ghim `tag@sha256:<digest>` nên mỗi rebuild thành thay đổi input thấy được, `restart: unless-stopped`, alias DNS `ecoma-home`, router Traefik `Host(<rootHostname>)` TLS, healthcheck HTTP `GET /` (chấp nhận `status < 500` vì `/` trả 302 sang `/en`) và `wait: true` — `pulumi up` chỉ xanh khi healthcheck `healthy`.
- **Env inject** (`index.ts`): chỉ `PORT=3000` và `NODE_ENV=production`; không có `ROOT_HOST` (không consumer runtime nào đọc biến này) và không có endpoint PostgreSQL — home không sở hữu database, tiêm endpoint DB của platform vào là vi phạm invariant data ownership.
- **Platform dependency**: đọc outputs platform qua `StackReference` (`networkName`, `namespace`, `rootHostname`) fail-closed; không đọc `traefikHostPort`/`postgresHost`/`postgresPort` vì container không publish cổng và không dùng DB; so namespace platform với worktree namespace, lệch là lỗi deploy; target `local-up` dependsOn duy nhất `platform-deploy:local-up`.
- **Multi-worktree**: mọi Docker resource mang namespace theo worktree và ownership labels để `pnpm dx local-cleanup` phân loại được; `traefik.docker.network` khai network cho router để Traefik của worktree khác không đăng ký nhầm.
- Stack exports: `imageDigest`, `containerName`, `containerId`, `namespaceVerified`.

## Boundaries

- Không provision hạ tầng Cloudflare (Worker, route) — chương trình này chỉ phủ lane local.
- Không tạo network, Traefik hay PostgreSQL — đọc qua stack reference tới `platform-deploy`; không có resource dùng chung nào ở đây.
- Không sở hữu code của `apps/home` — image build từ source của app; sửa hành vi app thì sửa `apps/home`.
- Nội dung public và quy tắc locale của homepage không được restatement ở đây → `docs/features/public-website/`.

## Development

```bash
pnpm nx run home-deploy:lint
pnpm nx run home-deploy:typecheck
```

Lifecycle mutate Docker/Pulumi state thật — chỉ chạy khi chủ đích thay đổi stack local:

```bash
pnpm nx run home-deploy:local-up -c local    # provision unit này (kéo platform-deploy:local-up chạy trước)
pnpm nx run home-deploy:local-down -c local  # destroy của riêng project; no-op exit 0 nếu worktree chưa từng deploy
```

## Testing

Project không có target `test` — targets đã xác nhận từ project graph: `local-up`, `local-down`, `lint`, `typecheck`.

- Kiểm tĩnh: `lint` + `typecheck`.
- Kiểm vòng đời thật: `system-tests/e2e/home-public-e2e` khai `home-deploy:local-up` làm prerequisite; smoke platform là target `local-smoke` của `platform-deploy` (phụ thuộc `home-deploy:local-up`, kiểm redirect `/` → `/en` và TLS qua Traefik).

## Related Documentation

- [`docs/architecture/local-development/README.md`](../../docs/architecture/local-development/README.md) — nền tảng local platform.
- [`docs/architecture/local-development/01-platform.md`](../../docs/architecture/local-development/01-platform.md) — ownership, port/URL và invariants của platform.
- [`docs/architecture/local-development/03-operations.md`](../../docs/architecture/local-development/03-operations.md) — luồng deploy, smoke, teardown, data-volume lifecycle.
- [`docs/features/public-website/browse-localized-public-content.md`](../../docs/features/public-website/browse-localized-public-content.md) — capability homepage public đa ngôn ngữ mà unit này phục vụ.
