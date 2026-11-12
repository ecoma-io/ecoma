# LLM Console Deploy

Pulumi deployment project provision **deploy unit của `apps/llm-console` trên lane LOCAL**: image (Nuxt preset `node-server` build trong Docker) và container phía sau Traefik. Đây là deploy project (`type:deployment`), không phải application hay bounded context. Chương trình Pulumi nằm ở `index.ts`, entry lifecycle ở `local.ts`, image ở `Dockerfile`.

Nx project `llm-console-deploy`, tags `type:deployment`, `scope:llm-consumer`, `runtime:native`. Chỉ có lane local (`configurations: local`); staging/production của app khai trong `apps/llm-console/wrangler.jsonc` (preset `cloudflare-module`) và thuộc delivery lane — không nằm trong chương trình này.

## Purpose

- Đưa `apps/llm-console` (consumer portal: Nuxt SPA + BFF) lên local platform với vòng đời image → container → readiness.
- Unit này KHÔNG có business backend: không database, không role, không migration, không Hyperdrive/D1/R2/KV/Queue, không secret, không OIDC/client id — mọi dữ liệu nghiệp vụ đi qua API của context owning theo composition của app.

## Responsibilities

- **Image + container** (`Dockerfile`, `index.ts`): image multi-stage build Nuxt từ repo root (builder `default`, `load: true`, `push: false`); container ghim `tag@sha256:<digest>`, `restart: unless-stopped`, alias DNS `ecoma-llm-console`, router Traefik `Host(llm-console.<rootHostname>)` TLS, healthcheck `GET /health` yêu cầu 2xx (`r.ok` — điều kiện nới hơn kiểu `status < 500` coi luôn route sai là healthy) và `wait: true` — `pulumi up` chỉ xanh khi healthcheck `healthy`.
- **Env inject** (`index.ts`): chỉ `PORT=3000` và `NODE_ENV=production` — app composition này không cần secret hay backend config trên lane local.
- **Platform dependency**: đọc outputs platform qua `StackReference` (`networkName`, `namespace`, `rootHostname`) fail-closed; không đọc output nào khác; so namespace platform với worktree namespace, lệch là lỗi deploy; target `local-up` dependsOn duy nhất `platform-deploy:local-up`.
- **Entry lifecycle** (`local.ts`): `prepare` chỉ đảm bảo stack tồn tại — không `config set` secret nào; toàn bộ config chương trình cần (`namespace:worktreeRoot`, `namespace:platformStackRef`) do `pulumiUpForEntry` truyền qua `--config`.
- **Multi-worktree**: mọi Docker resource mang namespace theo worktree và ownership labels để `pnpm dx local-cleanup` phân loại được.
- Stack exports: `imageDigest`, `containerName`, `containerId`, `namespaceVerified`.

## Boundaries

- Không provision hạ tầng Cloudflare (Worker, route) — chương trình này chỉ phủ lane local.
- Không tạo network, Traefik hay PostgreSQL — đọc qua stack reference tới `platform-deploy`.
- Không sở hữu code của `apps/llm-console` — image build từ source của app; sửa hành vi app thì sửa app.
- Không sở hữu dữ liệu nghiệp vụ LLM consumer — composition và contract consumption của app là nội dung canonical của `docs/applications/llm-console/`, domain rules thuộc `docs/domains/`.

## Development

```bash
pnpm nx run llm-console-deploy:lint
pnpm nx run llm-console-deploy:typecheck
```

Lifecycle mutate Docker/Pulumi state thật — chỉ chạy khi chủ đích thay đổi stack local:

```bash
pnpm nx run llm-console-deploy:local-up -c local    # provision unit này (kéo platform-deploy:local-up chạy trước)
pnpm nx run llm-console-deploy:local-down -c local  # destroy của riêng project; no-op exit 0 nếu worktree chưa từng deploy
```

## Testing

Project không có target `test` — targets đã xác nhận từ project graph: `local-up`, `local-down`, `lint`, `typecheck`.

- Kiểm tĩnh: `lint` + `typecheck`.
- Không có system-test suite nào khai `llm-console-deploy:local-up` làm prerequisite (xác nhận qua project graph) — bằng chứng serving của unit là healthcheck `/health` mà `wait: true` của container bắt buộc trong `local-up`.

## Related Documentation

- [`docs/architecture/local-development/README.md`](../../docs/architecture/local-development/README.md) — nền tảng local platform.
- [`docs/architecture/local-development/01-platform.md`](../../docs/architecture/local-development/01-platform.md) — ownership, cách ly worktree, contract outputs mà stack này đọc.
- [`docs/architecture/local-development/03-operations.md`](../../docs/architecture/local-development/03-operations.md) — vận hành lane, teardown, data-volume lifecycle.
- [`docs/applications/llm-console/README.md`](../../docs/applications/llm-console/README.md) — application được deploy.
- [`docs/applications/llm-console/03-operations.md`](../../docs/applications/llm-console/03-operations.md) — vận hành deploy unit ở delivery lane.
