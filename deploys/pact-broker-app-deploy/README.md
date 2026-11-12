# Pact Broker App Deploy

Pulumi deployment project provision **deploy unit của `apps/pact-broker-app` trên lane LOCAL**: image (Nuxt preset `node-server` build trong Docker) và container phía sau Traefik, với cấu hình gọi `pact-broker-api` qua HTTP nội bộ. Đây là deploy project (`type:deployment`), không phải application hay bounded context. Chương trình Pulumi nằm ở `index.ts`, entry lifecycle ở `local.ts`, image ở `Dockerfile`.

Nx project `pact-broker-app-deploy`, tags `type:deployment`, `scope:pact`, `runtime:native`. Chỉ có lane local (`configurations: local`); staging/production của app khai trong `apps/pact-broker-app/wrangler.jsonc` (preset `cloudflare-module`) và thuộc delivery lane — không nằm trong chương trình này.

## Purpose

- Đưa `apps/pact-broker-app` (dashboard BFF của pact-broker) lên local platform với vòng đời image → container → readiness.
- Ghim đúng cấu hình broker của BFF: base URL trỏ alias nội bộ của container `pact-broker-api` và token máy dùng chung — thiếu hoặc sai là route trả 503 `broker_not_configured` (fail-closed ở tầng app, đúng contract `server/utils/broker-config.ts` của app kiểm).

## Responsibilities

- **Secret lifecycle** (`local.ts`): khi `up`, ĐỌC LẠI `namespace:machineToken` từ stack config của `pact-broker-api-deploy` (api sở hữu, sinh set-if-absent ở lần up của nó theo `dependsOn`) và ghi bản sao vào stack config của stack này làm `namespace:apiToken` — một giá trị chia hai stack, cùng cơ chế với các cặp secret liên unit khác của lane.
- **Image + container** (`Dockerfile`, `index.ts`): image multi-stage build Nuxt từ repo root (builder `default`, `load: true`, `push: false`); container ghim `tag@sha256:<digest>`, `restart: unless-stopped`, alias DNS `ecoma-pact-app`, router Traefik `Host(pact.<rootHostname>)` TLS, healthcheck `GET /health` yêu cầu 2xx (`r.ok`) và `wait: true` — `pulumi up` chỉ xanh khi healthcheck `healthy`. Healthcheck cố ý KHÔNG dùng `/ready`: `/ready` trả 503 `broker_not_configured` khi thiếu cấu hình broker, sai làm readiness của container.
- **Env inject** (`index.ts`): `PORT=3000`, `NODE_ENV=production`, `NITRO_PACT_BROKER_API_BASE_URL=http://ecoma-pact-api:4204` (alias + port là contract hai hằng đối xứng với `pact-broker-api-deploy`) và `NITRO_PACT_BROKER_API_TOKEN` bọc `pulumi.secret` qua container `envs` — không argv, không label, không log.
- **Platform dependency**: đọc outputs platform qua `StackReference` (`networkName`, `namespace`, `rootHostname`) fail-closed; so namespace platform với worktree namespace, lệch là lỗi deploy; target `local-up` dependsOn `platform-deploy:local-up` và `pact-broker-api-deploy:local-up` (token máy).
- **Multi-worktree**: mọi Docker resource mang namespace theo worktree và ownership labels để `pnpm dx local-cleanup` phân loại được.
- Stack exports: `imageDigest`, `containerName`, `containerId`, `namespaceVerified`.

## Boundaries

- Không provision hạ tầng Cloudflare (Worker, route) — chương trình này chỉ phủ lane local.
- Không tạo network, Traefik hay PostgreSQL; không sở hữu database nào — chỉ `pact-broker-api` chạm `db-pact-broker`.
- Không sở hữu code của `apps/pact-broker-app` — image build từ source của app; sửa hành vi app thì sửa app.
- Ngữ nghĩa nghiệp vụ của dashboard (pact, verification, `can-i-deploy`) không được restatement ở đây → `docs/applications/pact-broker/`.

## Development

```bash
pnpm nx run pact-broker-app-deploy:lint
pnpm nx run pact-broker-app-deploy:typecheck
```

Lifecycle mutate Docker/Pulumi state thật — chỉ chạy khi chủ đích thay đổi stack local:

```bash
pnpm nx run pact-broker-app-deploy:local-up -c local    # provision unit này (kéo platform + pact-broker-api chạy trước)
pnpm nx run pact-broker-app-deploy:local-down -c local  # destroy của riêng project; no-op exit 0 nếu worktree chưa từng deploy
```

## Testing

Project không có target `test` — targets đã xác nhận từ project graph: `local-up`, `local-down`, `lint`, `typecheck`.

- Kiểm tĩnh: `lint` + `typecheck`.
- Không có system-test suite nào khai `pact-broker-app-deploy:local-up` làm prerequisite (xác nhận qua project graph) — bằng chứng serving của unit là healthcheck `/health` mà `wait: true` của container bắt buộc trong `local-up`.

## Related Documentation

- [`docs/architecture/local-development/README.md`](../../docs/architecture/local-development/README.md) — nền tảng local platform.
- [`docs/architecture/local-development/01-platform.md`](../../docs/architecture/local-development/01-platform.md) — ownership, cách ly worktree, contract outputs mà stack này đọc.
- [`docs/architecture/local-development/03-operations.md`](../../docs/architecture/local-development/03-operations.md) — vận hành lane, teardown, data-volume lifecycle (§ bất biến cross-stack).
- [`docs/applications/pact-broker/README.md`](../../docs/applications/pact-broker/README.md) — application được deploy.
- [`deploys/pact-broker-api-deploy/README.md`](../pact-broker-api-deploy/README.md) — unit sở hữu `db-pact-broker` và token máy mà BFF dùng.
