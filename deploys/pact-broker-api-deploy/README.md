# Pact Broker API Deploy

Pulumi deployment project provision **deploy unit của `apps/pact-broker-api` trên lane LOCAL**: database `db-pact-broker`, hai role PostgreSQL, migration, bootstrap tenant `ecoma`, cấp token máy cho consumer local, image và container WIC (worker-in-container). Đây là deploy project (`type:deployment`), không phải application hay bounded context. Chương trình Pulumi nằm ở `index.ts`, entry lifecycle ở `local.ts`, image ở `Dockerfile` với entrypoint `wic-entrypoint.sh`, lời gọi Docker của bước superadmin dựng bằng module thuần `superadmin-resolver.ts`.

Nx project `pact-broker-api-deploy`, tags `type:deployment`, `scope:pact`, `runtime:native`. Chỉ có lane local (`configurations: local`); `apps/pact-broker-api/wrangler.jsonc` không khai env `staging`/`production` nào, và cả hai lane đó đều không nằm trong chương trình này.

## Purpose

- Đưa `apps/pact-broker-api` (Worker `ecoma-pact-broker-api`, Hono + `pg` qua Hyperdrive) lên local platform với đủ vòng đời: provision database → migration → bootstrap tenant → cấp token máy → image → container → readiness.
- Chuẩn bị đúng dữ liệu mà consumer local cần trước khi container lên: tenant canonical `ecoma` và đúng một token máy active cho `(tenant ecoma, name pact-broker-app-bff)`.

## Responsibilities

- **Secret lifecycle** (`local.ts`): khi `up`, sinh và persist vào stack config — mật khẩu hai role PostgreSQL (migrator/runtime, xoay mỗi lần `up`); `machineToken` SET-IF-ABSENT nên plaintext ổn định theo environment (rotation là hành động của người vận hành), và `pact-broker-app-deploy` đọc lại giá trị này qua cross-stack `pulumi config get`; `tenantOwnerSub` — `sub` của superadmin sở hữu tenant `ecoma`, là định danh không phải credential. Hai password migrator của `account-deploy` và `staff-access-deploy` được ĐỌC cross-stack (fail-closed khi stack đó chưa up) để bước resolve superadmin kiểm hai môi trường đó.
- **Resolve superadmin** (`superadmin-resolver.ts`, `local.ts`): container ephemeral gắn platform network chạy đúng đường canonical `tools/dx` (`bootstrap-superadmin --resolve-if-bootstrapped --json`) — môi trường đã bootstrap thì chỉ đọc `sub`, môi trường mới thì bootstrap đầy đủ; hai `DATABASE_URL` đi qua env của process Docker, argv chỉ mang TÊN biến (credential không nằm trong argv).
- **Provisioning** (`index.ts`): tạo `db-pact-broker` + hai role `ecoma_pact_broker_{migrator,runtime}` qua `docker exec` psql trong container PostgreSQL của platform (guard-create bằng shell `if`, password `ALTER` idempotent), revoke CONNECT của PUBLIC, grant per-role, hardening schema public; mật khẩu hai role đi qua map `environment` của `command.local.Command` (bọc `pulumi.secret`) và câu `ALTER ROLE ... PASSWORD` được nạp vào psql qua STDIN của `docker exec -i` — script text (và argv của `sh -c`) chỉ chứa TÊN biến môi trường, script dựng bởi module thuần `scripts.ts`.
- **Migration + provisioning service-owned** (`index.ts`): container ephemeral chạy đúng `apps/pact-broker-api/db/apply.mts` (advisory lock `hashtext('db-pact-broker')`), rồi `db/bootstrap-tenant.mts` (tenant `ecoma` idempotent theo ADR-0020, `CANONICAL_TENANT_OWNER_SUB` qua env) và `db/provision-machine-token.mts` — DB chỉ nhận hash SHA-256, plaintext đổi là revoke-then-insert, re-run cùng plaintext là no-op, token đã revoke tay không hồi sinh.
- **Image + container WIC** (`Dockerfile`, `wic-entrypoint.sh`, `index.ts`): image mỏng ghim `node:24-bookworm-slim` theo digest + `ca-certificates`; repo mount read-only, bundle `apps/pact-broker-api/dist` mount bind trực tiếp, runtime tree mirror ghi được nằm trong volume `/state` (ephemeral, một-shot `chown 1000:1000` chạy trước container); MỘT process `wrangler dev` chạy worker `ecoma-pact-broker-api` (cổng nội bộ 4204). Container: alias DNS hằng `ecoma-pact-api`, KHÔNG có label `traefik.*` và KHÔNG publish cổng ra host (consumer là `pact-broker-app` fetch server-side qua alias và Pact CLI trong network), biến `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` bọc `pulumi.secret` qua container `envs`, healthcheck `GET /health` (liveness không chạm DB) và `wait: true` — `pulumi up` chỉ xanh khi healthcheck `healthy`.
- **Platform dependency**: đọc outputs platform qua `StackReference` (`networkName`, `namespace`) fail-closed; so namespace platform với worktree namespace, lệch là lỗi deploy; target `local-up` dependsOn `platform-deploy:local-up`, build bundle `@ecoma-io/pact-broker-api`, `account-deploy:local-up` và `staff-access-deploy:local-up` (credential migrator cho bước resolve superadmin).
- **Multi-worktree**: mọi Docker resource mang namespace theo worktree và ownership labels để `pnpm dx local-cleanup` phân loại được.
- Stack exports: `provisionCommandName`, `migrateCommandName`, `bootstrapTenantCommandName`, `machineTokenProvisionCommandName`, `imageDigest`, `containerName`, `containerId`, `stateVolumeName`, `namespaceVerified`.

## Boundaries

- Không provision hạ tầng Cloudflare (Hyperdrive, Worker, route) — chương trình này chỉ phủ lane local.
- Không sở hữu code của `apps/pact-broker-api` — container chạy bundle do app đó build; sửa hành vi app thì sửa app.
- Không sở hữu consumer của broker — `pact-broker-app-deploy` đọc token từ stack config của stack này; hợp đồng `(alias ecoma-pact-api, port 4204)` là hai hằng đối xứng ở hai stack.
- Hợp đồng bootstrap/tenant/machine-token ở system level không được restatement ở đây → `docs/applications/pact-broker/03-operations.md` §Bootstrap và `docs/architecture/02-delivery.md` §3.2.

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

## Testing

Targets đã xác nhận từ project graph: `local-up`, `local-down`, `test`, `test-integration`, `lint`, `typecheck`.

- Kiểm tĩnh: `lint` + `typecheck`; `test` (vitest) chạy hai spec colocated: `superadmin-resolver.spec.ts` (contract credential của bước superadmin — giá trị `DATABASE_URL` sống trong env của process Docker, argv Docker chỉ mang tên biến) và `scripts.spec.ts` (bất biến tĩnh của script text do `scripts.ts` dựng — không giá trị secret nào vào command text, password/URL/token máy chỉ đọc qua TÊN biến môi trường).
- Target `test-integration` (argv-hygiene, `tests/integrations/`) là kiểm thật bắt buộc Docker: chạy đúng script provision/migrate/bootstrap/token mà `index.ts` render với sentinel credentials — shim `docker` ghi argv của mọi lời gọi và watcher quét `/proc/<pid>/cmdline` suốt luồng; assert không sentinel nào vào argv/output/script text, đồng thời trạng thái database vẫn đúng (idempotency, xoay password verify thật qua scram, bootstrap tenant, lifecycle token máy created → no-op → rotated). Vắng Docker là suite ĐỎ, không skip.
- Không có system-test suite nào khai `pact-broker-api-deploy:local-up` làm prerequisite (xác nhận qua project graph) — bằng chứng serving của unit là healthcheck `/health` mà `wait: true` của container bắt buộc trong `local-up`.

## Related Documentation

- [`docs/architecture/local-development/README.md`](../../docs/architecture/local-development/README.md) — nền tảng local platform.
- [`docs/architecture/local-development/01-platform.md`](../../docs/architecture/local-development/01-platform.md) — ownership, cách ly worktree, contract outputs mà stack này đọc.
- [`docs/architecture/local-development/03-operations.md`](../../docs/architecture/local-development/03-operations.md) — vận hành lane, teardown, data-volume lifecycle (§ bất biến cross-stack).
- [`docs/applications/pact-broker/README.md`](../../docs/applications/pact-broker/README.md) — application được deploy.
- [`docs/applications/pact-broker/03-operations.md`](../../docs/applications/pact-broker/03-operations.md) — chuẩn migration/bootstrap/machine-token mà chương trình mirror.
