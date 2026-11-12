# Account Deploy

Pulumi deployment project provision **deploy unit của `apps/account` trên lane LOCAL**: database `db-account`, bộ role PostgreSQL, migration, image và container phía sau Traefik. Đây là deploy project (`type:deployment`), không phải application hay bounded context. Chương trình Pulumi nằm ở `index.ts`, entry lifecycle ở `local.ts`, image ở `Dockerfile`.

Nx project `account-deploy`, tags `type:deployment`, `scope:account`, `runtime:native`; trạng thái `ecoma.deployment.status: "implemented"` trong `package.json`.

## Purpose

- Đưa `apps/account` lên local platform với đủ vòng đời theo `docs/architecture/local-development/02-account-auth-topology.md`: provision database → migration → image → container → readiness.
- Chỉ có lane local (`configurations: local`); Worker staging/production của app `account` khai trong `apps/account/wrangler.jsonc` và thuộc delivery lane — không nằm trong chương trình này.

## Responsibilities

- **Secret lifecycle** (`local.ts`): khi `up`, sinh và persist vào stack config của chính stack — `internalHmacSecret` (`auth` đọc lại qua StackReference), `mailInternalAuthSecret` (`transactional-mail-deploy` đọc lại), `otpHmacSecret`, và mật khẩu bốn role PostgreSQL (owner/runtime/migrator/pruner, xoay mỗi lần `up`).
- **Provisioning** (`index.ts`): tạo `db-account` + bộ 4 role chuẩn bằng SQL chạy qua `docker exec` psql trong container PostgreSQL của platform (platform không publish host port); chạy migration theo đường canonical `apps/account/db/apply.mts` trong container ephemeral gắn platform network.
- **Image + container** (`Dockerfile`, `index.ts`): build Nuxt preset `node-server` từ repo root với Node image pin theo digest; container với alias `ecoma-account`, router Traefik `Host(account.<rootHostname>)` TLS, healthcheck `GET /ready` và `wait: true` — `pulumi up` chỉ xanh khi healthcheck `healthy`.
- **Platform dependency**: đọc outputs của platform qua `StackReference` (`networkName`, `namespace`, `rootHostname`, `traefikHostPort`); target `local-up` dependsOn `platform-deploy:local-up` ở tầng task graph.
- **Multi-worktree**: mọi Docker resource mang namespace theo worktree và ownership labels để `pnpm dx local-cleanup` phân loại được.
- Stack exports: `provisionCommandName`, `migrateCommandName`, `imageDigest`, `containerName`, `containerId`, `namespaceVerified`.

## Boundaries

- Không provision hạ tầng Cloudflare (Hyperdrive, Worker, route) — chương trình này chỉ phủ lane local.
- Không sở hữu code của `apps/account` — build từ output của app; sửa hành vi app thì sửa `apps/account`.
- Topology account/auth ở system level và chuẩn SQL role/migration không được restatement ở đây → `docs/architecture/local-development/` và `docs/applications/account/03-operations.md`.

## Development

```bash
pnpm nx run account-deploy:lint
pnpm nx run account-deploy:typecheck
```

Lifecycle mutate Docker/Pulumi state thật — chỉ chạy khi chủ đích thay đổi stack local:

```bash
pnpm nx run account-deploy:local-up -c local    # provision unit này (kéo platform-deploy:local-up chạy trước)
pnpm nx run account-deploy:local-down -c local  # destroy của riêng project; no-op exit 0 nếu worktree chưa từng deploy
```

## Testing

Project không có target `test`/`test-integration`/`system-test` — targets đã xác nhận từ project graph: `local-up`, `local-down`, `lint`, `typecheck`.

- Kiểm tĩnh: `lint` + `typecheck`.
- Kiểm vòng đời thật: các system-test suite khai `account-deploy:local-up` làm prerequisite — ví dụ `system-tests/e2e/identity-login-e2e`; smoke của cả platform là target `local-smoke` của `platform-deploy`.

## Related Documentation

- [`docs/architecture/local-development/README.md`](../../docs/architecture/local-development/README.md) — nền tảng local platform.
- [`docs/architecture/local-development/02-account-auth-topology.md`](../../docs/architecture/local-development/02-account-auth-topology.md) — topology account/auth mà stack này hiện thực.
- [`docs/architecture/local-development/03-operations.md`](../../docs/architecture/local-development/03-operations.md) — vận hành, teardown, data-volume lifecycle.
- [`docs/applications/account/03-operations.md`](../../docs/applications/account/03-operations.md) — chuẩn SQL provisioning role mà chương trình mirror (§3).
- [`apps/account/README.md`](../../apps/account/README.md) — app được deploy.
