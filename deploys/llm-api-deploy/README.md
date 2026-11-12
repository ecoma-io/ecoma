# LLM API Deploy

Pulumi deployment project provision **deploy unit của `apps/llm-api` trên lane LOCAL**: ba database `db-llm-gateway`/`db-llm-tenant`/`db-llm-marketplace`, sáu role PostgreSQL, migration theo từng database, image và container WIC (worker-in-container) cho data plane LLM. Đây là deploy project (`type:deployment`), không phải application hay bounded context. Chương trình Pulumi nằm ở `index.ts`, entry lifecycle ở `local.ts`, image ở `Dockerfile` với entrypoint `wic-entrypoint.sh`, script provision/migrate dựng bằng hàm thuần trong `scripts.ts`.

Nx project `llm-api-deploy`, tags `type:deployment`, `scope:llm-api`, `runtime:native`. Chỉ có lane local (`configurations: local`); `apps/llm-api/wrangler.jsonc` không khai env `staging`/`production` nào, và cả hai lane đó đều không nằm trong chương trình này.

## Purpose

- Đưa `apps/llm-api` (Worker `ecoma-llm-api`) lên local platform với đủ vòng đời: provision ba database → migration cả ba → image → container → readiness.
- Cấp ba binding Hyperdrive local của app (gateway/tenant/marketplace) đúng tên binding trong `apps/llm-api/wrangler.jsonc` để worker boot fail-closed khi thiếu.

## Responsibilities

- **Secret lifecycle** (`local.ts`): khi `up`, sinh và persist vào stack config sáu mật khẩu role PostgreSQL (migrator + runtime cho mỗi database, xoay mỗi lần `up`); stack này KHÔNG giữ password của role `ecoma_owner` dùng chung — account stack sở hữu nó, stack này chỉ guard-create role khi thiếu.
- **Provisioning** (`scripts.ts` → `buildProvisionScript`, `index.ts`): tạo ba database và sáu role `ecoma_llm_{target}_{migrator,runtime}` (`target` ∈ `gateway`/`tenant`/`marketplace`) qua `docker exec` psql trong container PostgreSQL của platform, revoke CONNECT chéo giữa các database, grant per-role, hardening schema public. Mật khẩu đi qua map `environment` của `command.local.Command` — script chỉ chứa TÊN biến, SQL `ALTER ROLE ... PASSWORD` được dựng trong shell rồi nạp psql qua STDIN (`docker exec -i`), không nằm trong argv của process nào.
- **Migration** (`scripts.ts` → `buildMigrateScript`, `index.ts`): MỘT command cho MỖI database — container ephemeral gắn platform network chạy đúng `apps/llm-api/db/apply.mts <target>` (tsx binary của repo, repo mount read-only), advisory lock `hashtext('db-llm-<target>')`; KHÔNG chạy qua binding Hyperdrive (Hyperdrive không hỗ trợ advisory lock). `DATABASE_URL` của migrator đi qua `environment` (không `-e VAR=value` inline trong argv).
- **Image + container WIC** (`Dockerfile`, `wic-entrypoint.sh`, `index.ts`): image mỏng ghim `node:24-bookworm-slim` theo digest + `ca-certificates`; repo mount read-only, bundle `apps/llm-api/build` (`index.js` do Nx target `build` sinh) mount bind trực tiếp, runtime tree mirror ghi được nằm trong volume `/state` (ephemeral, một-shot `chown 1000:1000` chạy trước container). Container: alias DNS hằng `ecoma-llm-api`, cổng nội bộ 4211 (`dev.port` của app), KHÔNG có label `traefik.*` và KHÔNG publish cổng ra host (worker nội bộ), ba biến `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_{DB_LLM_GATEWAY,DB_LLM_TENANT,DB_LLM_MARKETPLACE}` bọc `pulumi.secret` qua container `envs` (không argv, không label, không log), healthcheck `GET /health` (liveness không chạm DB) và `wait: true`.
- **Platform dependency**: đọc outputs platform qua `StackReference` (`networkName`, `namespace`) fail-closed; so namespace platform với worktree namespace, lệch là lỗi deploy; target `local-up` dependsOn `platform-deploy:local-up` và build bundle `@ecoma-io/llm-api`.
- **Multi-worktree**: mọi Docker resource mang namespace theo worktree và ownership labels để `pnpm dx local-cleanup` phân loại được.
- Stack exports: `provisionCommandName`, `migrateCommandNames`, `imageDigest`, `containerName`, `containerId`, `stateVolumeName`, `namespaceVerified`.

## Boundaries

- Không provision hạ tầng Cloudflare (Hyperdrive, Worker, route) — chương trình này chỉ phủ lane local.
- Không sở hữu code của `apps/llm-api` — container chạy bundle do app đó build; sửa hành vi app thì sửa app.
- Không cấu hình consumer của data plane LLM ở local — base URL nội bộ `http://ecoma-llm-api:4211` là contract để unit consumer dùng, không phải phần của stack này.
- Ngữ nghĩa quota/settlement của llm-api không được restatement ở đây → `docs/applications/llm-api/`.

## Development

```bash
pnpm nx run llm-api-deploy:lint
pnpm nx run llm-api-deploy:typecheck
```

Lifecycle mutate Docker/Pulumi state thật — chỉ chạy khi chủ đích thay đổi stack local:

```bash
pnpm nx run llm-api-deploy:local-up -c local    # provision unit này (kéo platform + build bundle app chạy trước)
pnpm nx run llm-api-deploy:local-down -c local  # destroy của riêng project; no-op exit 0 nếu worktree chưa từng deploy
```

## Testing

Targets đã xác nhận từ project graph: `local-up`, `local-down`, `test`, `test-integration`, `lint`, `typecheck`.

- Kiểm tĩnh: `lint` + `typecheck`; `test` (vitest) chấm script text do `scripts.ts` dựng — không chứa giá trị secret nào.
- `test-integration` là suite argv-hygiene: chạy đúng script provision/migrate thật với sentinel giả, khẳng định không giá trị secret nào lọt vào argv, script text hay output bắt được, đồng thời trạng thái database sau provision + migration vẫn đúng. Suite cần Docker là phụ thuộc cứng — vắng Docker thì suite đỏ.

## Related Documentation

- [`docs/architecture/local-development/README.md`](../../docs/architecture/local-development/README.md) — nền tảng local platform.
- [`docs/architecture/local-development/01-platform.md`](../../docs/architecture/local-development/01-platform.md) — ownership, cách ly worktree, contract outputs mà stack này đọc.
- [`docs/architecture/local-development/03-operations.md`](../../docs/architecture/local-development/03-operations.md) — vận hành lane, teardown, data-volume lifecycle.
- [`docs/applications/llm-api/README.md`](../../docs/applications/llm-api/README.md) — application được deploy.
- [`docs/applications/llm-api/03-operations.md`](../../docs/applications/llm-api/03-operations.md) — vận hành deploy unit ở delivery lane.
