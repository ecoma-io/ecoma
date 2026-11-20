# Account Deploy

Pulumi deployment project provision **deploy unit của `apps/account`**: lane LOCAL (database `db-account`, bộ role PostgreSQL, migration, image và container phía sau Traefik) và lane STAGING (HyperdriveConfig của `db-account`). Đây là deploy project (`type:deployment`), không phải application hay bounded context. Entry chương trình Pulumi ở `index.ts` (lane guard), thân lane local ở `local-program.ts`, thân lane staging ở `staging-program.ts`; entry lifecycle local ở `local.ts`, entry lifecycle staging ở `staging.ts`; image ở `Dockerfile`.

Nx project `account-deploy`, tags `type:deployment`, `scope:account`, `runtime:native`; trạng thái `ecoma.deployment.status: "implemented"` trong `package.json`.

## Purpose

- Đưa `apps/account` lên local platform với đủ vòng lifecycle theo `docs/architecture/local-development/02-account-auth-topology.md`: provision database → migration → image → container → readiness.
- Cấp HyperdriveConfig staging của `db-account` (`db-account-staging`, §9.1) cho làn staging — id thật đọc từ stack output `hyperdriveConfigId` sau lần `up` xanh đầu tiên và fill vào `env.staging.hyperdrive` của `apps/account/wrangler.jsonc` (id do Pulumi cung cấp, Wrangler không tự tạo config). Worker staging/production của app khai trong `apps/account/wrangler.jsonc` và thuộc delivery lane — không nằm trong chương trình này.

## Responsibilities

- **Secret lifecycle** (`local.ts`): khi `up`, sinh và persist vào stack config của chính stack — `internalHmacSecret` (`auth` đọc lại qua StackReference), `mailInternalAuthSecret` (`transactional-mail-deploy` đọc lại), `otpHmacSecret`, và mật khẩu bốn role PostgreSQL (owner/runtime/migrator/pruner, xoay mỗi lần `up`).
- **Provisioning lane local** (`local-program.ts`): tạo `db-account` + bộ 4 role chuẩn bằng SQL chạy qua `docker exec` psql trong container PostgreSQL của platform (platform không publish host port); chạy migration qua runner thật của `deploys/account-db` (chuỗi `adopt && migrate` của cutover #375) trong container ephemeral gắn platform network.
- **Image + container** (`Dockerfile`, `local-program.ts`): image COPY artifact `build:development` (preset `node-server`) do Nx build sẵn qua target `local-build`, từ repo root, Node base image pin theo digest; container với alias `ecoma-account`, router Traefik `Host(account.<rootHostname>)` TLS, healthcheck `GET /ready` và `wait: true` — `pulumi up` chỉ xanh khi healthcheck `healthy`.
- **Provisioning lane staging** (`staging-program.ts`, `staging-run.ts`, `staging.ts`): `preview`/`up` trên stack `staging` backend R2 khai HyperdriveConfig `db-account-staging` — origin đọc từ stack config và FAIL CLOSED khi chưa có (đường tới origin private là Tunnel/VPC Service của #349); cache OFF tường minh theo yêu cầu documented của `db-account` (HD3/HD4, đường correctness `/internal/account/status`); inventory credential fail-closed với danh sách đầy đủ khóa thiếu; evidence record JSON append-only mỗi lần chạy trong `.staging-evidence/`; KHÔNG có phase down/destroy.
- **Platform dependency**: đọc outputs của platform qua `StackReference` (`networkName`, `namespace`, `rootHostname`, `traefikHostPort`); target `local-up` dependsOn `platform-deploy:local-up` ở tầng task graph.
- **Multi-worktree**: mọi Docker resource mang namespace theo worktree và ownership labels để `pnpm dx local-cleanup` phân loại được.
- Stack exports lane local: `provisionCommandName`, `migrateCommandName`, `imageDigest`, `containerName`, `containerId`, `namespaceVerified`; lane staging: `hyperdriveConfigId`.

## Boundaries

- Lane local không provision hạ tầng Cloudflare; lane staging chỉ khai HyperdriveConfig (owner Pulumi theo §9.1) — KHÔNG deploy Worker, KHÔNG khai route/DNS (Worker deploy là Wrangler, hostname staging thuộc Router non-production A13/MOD1).
- Không sở hữu code của `apps/account` — build từ output của app; sửa hành vi app thì sửa `apps/account`.
- Topology account/auth ở system level và chuẩn SQL role/migration không được restatement ở đây → `docs/architecture/local-development/` và `docs/applications/account/03-operations.md`.

## Development

```bash
pnpm nx run account-deploy:lint
pnpm nx run account-deploy:typecheck
```

Lifecycle mutate Docker/Pulumi state thật — chỉ chạy khi chủ đích thay đổi stack:

```bash
pnpm nx run account-deploy:local-up -c local       # lane local: provision unit này (kéo platform-deploy:local-up chạy trước)
pnpm nx run account-deploy:local-down -c local     # lane local: destroy của riêng project; no-op exit 0 nếu worktree chưa từng deploy
pnpm nx run account-deploy:staging-preview -c staging  # lane staging: pulumi preview --json trên stack staging (fail-closed khi thiếu credential/origin)
pnpm nx run account-deploy:staging-up -c staging       # lane staging: pulumi up --yes --json; sau khi xanh surface output hyperdriveConfigId
```

## Testing

Targets đã xác nhận từ project graph: `local-up`, `local-down`, `staging-preview`, `staging-up`, `test`, `lint`, `typecheck`.

- Kiểm tĩnh: `lint` + `typecheck`.
- Kiểm unit (`test`): `scripts.spec.ts` (bất biến tĩnh của script text + escaping qua `/bin/sh` thật) và `staging-run.spec.ts` — engine staging dạng pure functions + exec inject: fail-closed inventory credential, origin fail-closed (#349), id thật vs placeholder, tên config per-database, phân loại stack theo lane.
- Kiểm vòng đời thật: các system-test suite khai `account-deploy:local-up` làm prerequisite — ví dụ `system-tests/e2e/identity-login-e2e`; smoke của cả platform là target `local-smoke` của `platform-deploy`.

## Related Documentation

- [`docs/architecture/local-development/README.md`](../../docs/architecture/local-development/README.md) — nền tảng local platform.
- [`docs/architecture/local-development/02-account-auth-topology.md`](../../docs/architecture/local-development/02-account-auth-topology.md) — topology account/auth mà stack này hiện thực.
- [`docs/architecture/local-development/03-operations.md`](../../docs/architecture/local-development/03-operations.md) — vận hành, teardown, data-volume lifecycle.
- [`docs/architecture/02-delivery.md`](../../docs/architecture/02-delivery.md) — §4.2 topology staging, §7.4.1 Pulumi stack & lifecycle, §9.1 bảng sở hữu resource (Hyperdrive config owner Pulumi).
- [`docs/applications/account/03-operations.md`](../../docs/applications/account/03-operations.md) — chuẩn SQL provisioning role mà chương trình mirror (§3).
- [`apps/account/README.md`](../../apps/account/README.md) — app được deploy.
