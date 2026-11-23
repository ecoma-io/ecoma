# Pact Broker API Deploy

Pulumi deployment project provision **deploy unit của `apps/pact-broker-api`**: trên lane LOCAL là database `db-pact-broker`, hai role PostgreSQL, migration, bootstrap tenant `ecoma`, image và container WIC (worker-in-container); trên lane STAGING là HyperdriveConfig `db-pact-broker-staging` (#358, §9.1). Đây là deploy project (`type:deployment`), không phải application hay bounded context. Entry `index.ts` là **lane guard** (#358, pattern #453/#539): phân loại stack trước khi nạp thân — `local-program.ts` (lane local), `staging-program.ts` (lane staging), stack lạ là throw; entry lifecycle local ở `local.ts`, entry staging ở `staging.ts` (engine dùng chung `staging-run.ts`), image ở `Dockerfile` với entrypoint `wic-entrypoint.sh`, lời gọi Docker của bước superadmin dựng bằng module thuần `superadmin-resolver.ts`.

Nx project `pact-broker-api-deploy`, tags `type:deployment`, `scope:pact`, `runtime:native`. Hai lane: local (`configurations: local`) và staging (`configurations: staging`, #358). Production là M3 — chưa khai ở chương trình này.

## Purpose

- Đưa `apps/pact-broker-api` (Worker `ecoma-pact-broker-api`, Hono + `pg` qua Hyperdrive) lên local platform với đủ vòng đời: provision database → migration → bootstrap tenant → image → container → readiness.
- Chuẩn bị đúng dữ liệu mà consumer local cần trước khi container lên: tenant canonical `ecoma`. KHÔNG còn cấp token máy cho consumer nào: token máy của BFF `pact-broker-app` bị retire hoàn toàn (ADR-0031 §5, #206) — BFF forward access token của chủ phiên, API verify offline qua JWKS của `auth` (ADR-0031 §1); machine path của Pact CLI/CI không đổi và cấp token là hành động operator qua `db/provision-machine-token.mts` của app, không phải đầu ra idempotent của stack này.

## Staging lane (#358)

- **Phủ đúng một resource**: HyperdriveConfig `db-pact-broker-staging` cho database `db-pact-broker` (inventory §9.1: Hyperdrive config **per-database per-lane** — config chị `db-pact-broker-app-staging` của `pact-broker-app-deploy` là resource rời). Origin đọc từ stack config (`namespace:originHost`/`originPort`/`originPassword`) và **fail closed** khi chưa có: đường tới origin private là Tunnel/VPC Service của #349, chưa provision lần nào — `pulumi preview` đỏ cho tới khi #349 cấp origin, không có đường "chạy tạm với origin giả".
- **Chỉ `preview`/`up`** — KHÔNG có down/destroy: teardown staging không có workflow (§7.4.1), checklist tay thuộc runbook #364; entry `staging.ts` từ chối tường minh mọi verb khác.
- **Prerequisite vận hành fail-closed** (`staging-run.ts`): `ECOMA_PULUMI_STATE_URL_STAGING` (backend R2, bootstrap một lần ngoài mọi stack — thiếu là chưa bootstrapped, tuyệt đối không fallback), `PULUMI_CONFIG_PASSPHRASE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `CLOUDFLARE_API_TOKEN`. Thiếu bất kỳ khóa nào là từ chối TRƯỚC KHI đụng Pulumi; token không bao giờ vào provider config/state.
- **Evidence append-only**: mỗi lần chạy ghi một bản ghi JSON mới vào `.staging-evidence/` (phase, stack ref, revision, resource changes) — reconstructible, không overwrite.
- **Wiring id về sau**: sau một lần `up` xanh, entry đọc stack output `hyperdriveConfigId` và surface id thật để operator fill vào `env.staging.hyperdrive[0].id` của `apps/pact-broker-api/wrangler.jsonc` (§9.1 — id do Pulumi cung cấp, Wrangler không tạo config; deploy với placeholder là lỗi định danh, guard `resource-bindings` chặn).

## Responsibilities

- **Secret lifecycle** (`local.ts`): khi `up`, sinh và persist vào stack config — mật khẩu hai role PostgreSQL (migrator/runtime, xoay mỗi lần `up`); `tenantOwnerSub` — `sub` của superadmin sở hữu tenant `ecoma`, là định danh không phải credential. Hai password migrator của `account-deploy` và `staff-access-deploy` được ĐỌC cross-stack (fail-closed khi stack đó chưa up) để bước resolve superadmin kiểm hai môi trường đó.
- **Resolve superadmin** (`superadmin-resolver.ts`, `local.ts`): container ephemeral gắn platform network chạy đúng đường canonical `tools/dx` (`bootstrap-superadmin --resolve-if-bootstrapped --json`) — môi trường đã bootstrap thì chỉ đọc `sub`, môi trường mới thì bootstrap đầy đủ; hai `DATABASE_URL` đi qua env của process Docker, argv chỉ mang TÊN biến (credential không nằm trong argv).
- **Provisioning** (`index.ts`): tạo `db-pact-broker` + hai role `ecoma_pact_broker_{migrator,runtime}` qua `docker exec` psql trong container PostgreSQL của platform (guard-create bằng shell `if`, password `ALTER` idempotent), revoke CONNECT của PUBLIC, grant per-role, hardening schema public; mật khẩu hai role đi qua map `environment` của `command.local.Command` (bọc `pulumi.secret`) và câu `ALTER ROLE ... PASSWORD` được nạp vào psql qua STDIN của `docker exec -i` — script text (và argv của `sh -c`) chỉ chứa TÊN biến môi trường, script dựng bởi module thuần `scripts.ts`.
- **Migration + provisioning service-owned** (`index.ts`): container ephemeral chạy đúng runner authority `databases/pact-broker-db/runner.mts migrate` (advisory lock `hashtext('db-pact-broker')` đo thật — cutover #378), rồi `db/bootstrap-tenant.mts` (tenant `ecoma` idempotent theo ADR-0020, `CANONICAL_TENANT_OWNER_SUB` qua env). Cấp token máy KHÔNG còn là bước deploy (ADR-0031 §5) — script `db/provision-machine-token.mts` của app vẫn là công cụ operator.
- **Image + container WIC** (`Dockerfile`, `wic-entrypoint.sh`, `index.ts`): image mỏng ghim `node:24-bookworm-slim` theo digest + `ca-certificates`; repo mount read-only, bundle `apps/pact-broker-api/dist` mount bind trực tiếp, runtime tree mirror ghi được nằm trong volume `/state` (ephemeral, một-shot `chown 1000:1000` chạy trước container); MỘT process `wrangler dev` chạy worker `ecoma-pact-broker-api` (cổng nội bộ 4204). Container: alias DNS hằng `ecoma-pact-api`, KHÔNG có label `traefik.*` và KHÔNG publish cổng ra host (consumer là `pact-broker-app` fetch server-side qua alias và Pact CLI trong network), biến `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` bọc `pulumi.secret` qua container `envs`, healthcheck `GET /health` (liveness không chạm DB) và `wait: true` — `pulumi up` chỉ xanh khi healthcheck `healthy`.
- **Platform dependency**: đọc outputs platform qua `StackReference` (`networkName`, `namespace`) fail-closed; so namespace platform với worktree namespace, lệch là lỗi deploy; target `local-up` dependsOn `platform-deploy:local-up`, build bundle `@ecoma-io/pact-broker-api`, `account-deploy:local-up` và `staff-access-deploy:local-up` (credential migrator cho bước resolve superadmin).
- **Multi-worktree**: mọi Docker resource mang namespace theo worktree và ownership labels để `pnpm dx local-cleanup` phân loại được.
- Stack exports: `provisionCommandName`, `migrateCommandName`, `bootstrapTenantCommandName`, `imageDigest`, `containerName`, `containerId`, `stateVolumeName`, `namespaceVerified`.

## Boundaries

- Lane local không provision hạ tầng Cloudflare nào; lane staging chỉ provision HyperdriveConfig của database mình (§9.1) — KHÔNG deploy Worker, route hay custom domain nào (Worker `stg-ecoma-pact-broker-api` deploy bằng machinery staging dùng chung `tools/delivery`, #535; production là M3).
- Không sở hữu code của `apps/pact-broker-api` — container chạy bundle do app đó build; sửa hành vi app thì sửa app.
- Không sở hữu consumer của broker — hợp đồng `(alias ecoma-pact-api, port 4204)` là hai hằng đối xứng ở hai stack; BFF xác thực bằng access token của chủ phiên (ADR-0031 §1), không còn channel token nào giữa hai stack.
- Hợp đồng bootstrap/tenant ở system level không được restatement ở đây → `docs/applications/pact-broker/03-operations.md` §Bootstrap và `docs/architecture/02-delivery.md` §3.2.

## Development

```bash
pnpm nx run pact-broker-api-deploy:lint
pnpm nx run pact-broker-api-deploy:typecheck
```

Lifecycle mutate Docker/Pulumi state thật — chỉ chạy khi chủ đích thay đổi stack local:

```bash
pnpm nx run pact-broker-api-deploy:local-up -c local    # provision unit này (kéo platform + build bundle + account + staff-access chạy trước)
pnpm nx run pact-broker-api-deploy:local-down -c local  # destroy của riêng project; no-op exit 0 nếu worktree chưa từng deploy
```

Lane staging mutate Pulumi state staging thật — chỉ chạy khi đủ prerequisite vận hành (xem §Staging lane):

```bash
pnpm nx run pact-broker-api-deploy:staging-preview -c staging  # pulumi preview --json trên stack staging, ghi evidence
pnpm nx run pact-broker-api-deploy:staging-up -c staging       # pulumi up --yes; sau đó surface id Hyperdrive để wiring wrangler.jsonc
```

## Testing

Targets đã xác nhận từ project graph: `local-up`, `local-down`, `staging-preview`, `staging-up`, `test`, `test-integration`, `lint`, `typecheck`.

- Kiểm tĩnh: `lint` + `typecheck`; `test` (vitest) chạy ba spec colocated: `superadmin-resolver.spec.ts` (contract credential của bước superadmin — giá trị `DATABASE_URL` sống trong env của process Docker, argv Docker chỉ mang tên biến), `scripts.spec.ts` (bất biến tĩnh của script text do `scripts.ts` dựng — không giá trị secret nào vào command text, password/URL chỉ đọc qua TÊN biến môi trường; module KHÔNG còn hằng/builder token máy nào — ADR-0031 §5) và `staging-run.spec.ts` (engine lane staging #358 — classifier stack fail-closed, inventory credential bắt buộc đầy đủ, origin Hyperdrive fail-closed #349, đọc/ghi evidence; pure functions + exec inject, không chạy Pulumi thật).
- Target `test-integration` (argv-hygiene, `tests/integrations/`) là kiểm thật bắt buộc Docker: chạy đúng script provision/migrate/bootstrap mà `index.ts` render với sentinel credentials — shim `docker` ghi argv của mọi lời gọi và watcher quét `/proc/<pid>/cmdline` suốt luồng; assert không sentinel nào vào argv/output/script text, đồng thời trạng thái database vẫn đúng (idempotency, xoay password verify thật qua scram, bootstrap tenant). Vắng Docker là suite ĐỎ, không skip.
- Không có system-test suite nào khai `pact-broker-api-deploy:local-up` làm prerequisite (xác nhận qua project graph) — bằng chứng serving của unit là healthcheck `/health` mà `wait: true` của container bắt buộc trong `local-up`.

## Related Documentation

- [`docs/architecture/local-development/README.md`](../../docs/architecture/local-development/README.md) — nền tảng local platform.
- [`docs/architecture/local-development/01-platform.md`](../../docs/architecture/local-development/01-platform.md) — ownership, cách ly worktree, contract outputs mà stack này đọc.
- [`docs/architecture/local-development/03-operations.md`](../../docs/architecture/local-development/03-operations.md) — vận hành lane, teardown, data-volume lifecycle (§ bất biến cross-stack).
- [`docs/applications/pact-broker/README.md`](../../docs/applications/pact-broker/README.md) — application được deploy.
- [`docs/applications/pact-broker/03-operations.md`](../../docs/applications/pact-broker/03-operations.md) — chuẩn migration/bootstrap mà chương trình mirror.
- [`deploys/auth-deploy/README.md`](../auth-deploy/README.md) — issuer OIDC mà API verify access token chống lại (ADR-0031 §1, #206).
