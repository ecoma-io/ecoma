# LLM API Deploy

Pulumi deployment project provision **deploy unit của `apps/llm-api`**: ba database `db-llm-gateway`/`db-llm-tenant`/`db-llm-marketplace`, sáu role PostgreSQL, migration theo từng database, image và container WIC (worker-in-container) cho data plane LLM trên **lane LOCAL**; lane **staging** khai ba HyperdriveConfig per-database (issue #359). Đây là deploy project (`type:deployment`), không phải application hay bounded context. Entry `index.ts` là **lane guard** (pattern `auth-deploy` #539): stack `local-*` nạp thân local (`local-program.ts`), stack `staging`/`staging-candidate` nạp thân staging (`staging-program.ts`), stack lạ fail-closed. Entry lifecycle local ở `local.ts`, entry lane E2E ở `lane.ts`, entry staging ở `staging.ts` với engine `staging-run.ts`, image ở `Dockerfile` với entrypoint `wic-entrypoint.sh`, script provision/migrate dựng bằng hàm thuần trong `scripts.ts`.

Nx project `llm-api-deploy`, tags `type:deployment`, `scope:llm-api`, `runtime:native`. Hai lane: local (`configurations: local`) và staging (`configurations: staging`, target `staging-preview`/`staging-up`); `apps/llm-api/wrangler.jsonc` khai `env.staging` (Worker `stg-ecoma-llm-api`, issue #359), env `production` chưa khai (làn promotion M3).

## Purpose

- Đưa `apps/llm-api` (Worker `ecoma-llm-api`) lên local platform với đủ vòng đời: provision ba database → migration cả ba → image → container → readiness.
- Cấp ba binding Hyperdrive local của app (gateway/tenant/marketplace) đúng tên binding trong `apps/llm-api/wrangler.jsonc` để worker boot fail-closed khi thiếu.

## Responsibilities

- **Secret lifecycle** (`local.ts`): khi `up`, sinh và persist vào stack config sáu mật khẩu role PostgreSQL (migrator + runtime cho mỗi database, xoay mỗi lần `up`); stack này KHÔNG giữ password của role `ecoma_owner` dùng chung — account stack sở hữu nó, stack này chỉ guard-create role khi thiếu.
- **Provisioning** (`scripts.ts` → `buildProvisionScript`, `index.ts`): tạo ba database và sáu role `ecoma_llm_{target}_{migrator,runtime}` (`target` ∈ `gateway`/`tenant`/`marketplace`) qua `docker exec` psql trong container PostgreSQL của platform, revoke CONNECT chéo giữa các database, grant per-role, hardening schema public. Mật khẩu đi qua map `environment` của `command.local.Command` — script chỉ chứa TÊN biến, SQL `ALTER ROLE ... PASSWORD` được dựng trong shell rồi nạp psql qua STDIN (`docker exec -i`), không nằm trong argv của process nào.
- **Migration** (`scripts.ts` → `buildMigrateScript`, `index.ts`): MỘT command cho MỖI database — container ephemeral gắn platform network chạy đúng `apps/llm-api/db/apply.mts <target>` (tsx binary của repo, repo mount read-only), advisory lock `hashtext('db-llm-<target>')`; KHÔNG chạy qua binding Hyperdrive (Hyperdrive không hỗ trợ advisory lock). `DATABASE_URL` của migrator đi qua `environment` (không `-e VAR=value` inline trong argv).
- **Image + container WIC** (`Dockerfile`, `wic-entrypoint.sh`, `index.ts`): image mỏng ghim `node:24-bookworm-slim` theo digest + `ca-certificates`; repo mount read-only, bundle `apps/llm-api/build` (`index.js` do Nx target `build` sinh) mount bind trực tiếp, runtime tree mirror ghi được nằm trong volume `/state` (ephemeral, một-shot `chown 1000:1000` chạy trước container). Container: alias DNS hằng `ecoma-llm-api`, cổng nội bộ 4211 (`dev.port` của app), KHÔNG có label `traefik.*` và KHÔNG publish cổng ra host (worker nội bộ), ba biến `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_{DB_LLM_GATEWAY,DB_LLM_TENANT,DB_LLM_MARKETPLACE}` bọc `pulumi.secret` qua container `envs` (không argv, không label, không log), healthcheck `GET /health` (liveness không chạm DB) và `wait: true`.
- **Platform dependency**: đọc outputs platform qua `StackReference` (`networkName`, `namespace`) fail-closed; so namespace platform với worktree namespace, lệch là lỗi deploy; target `local-up` dependsOn `platform-deploy:local-up` và build bundle `@ecoma-io/llm-api`.
- **Staging Hyperdrive** (`staging-program.ts`, engine `staging-run.ts`, entry `staging.ts`, issue #359): trên stack `staging`/`staging-candidate` khai **ba** `cloudflare.HyperdriveConfig` per-database (`db-llm-gateway-staging`/`db-llm-tenant-staging`/`db-llm-marketplace-staging` — §9.1: config per-database per-lane §4.2; ba pool connection rời nhau trên cùng origin host — HD9/HD13 soft limits, `caching: { disabled: true }` tường minh theo invariant 14: query cache OFF trên đường correctness quota/settlement). Origin (host/port/password dùng chung cho ba database) đọc từ stack config và FAIL CLOSED khi chưa có (#349); database và role runtime của từng config là hằng naming của `scripts.ts` (`db-llm-<target>`, `ecoma_llm_<target>_runtime` — Hyperdrive kết nối bằng role runtime, không bao giờ migrator/owner). Credential fail-closed trước khi đụng Pulumi (`ECOMA_PULUMI_STATE_URL_STAGING`, `PULUMI_CONFIG_PASSPHRASE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `CLOUDFLARE_API_TOKEN` — token chỉ passthrough env, không bao giờ vào provider config); mỗi lần chạy ghi một bản ghi evidence JSON append-only vào `.staging-evidence/`. Sau một lần `up` xanh, entry đọc cả ba stack output `<target>HyperdriveConfigId` và surface id thật để operator fill vào `env.staging.hyperdrive[].id` của `apps/llm-api/wrangler.jsonc` (§9.1 — id do Pulumi cung cấp, Wrangler không tạo config; id placeholder toàn-zeros không bao giờ qua đường wiring).
- **Multi-worktree**: mọi Docker resource mang namespace theo worktree và ownership labels để `pnpm dx local-cleanup` phân loại được.
- **Lane E2E** (`lane.ts`, target `test-lane-up`/`test-lane-down`, Issues #23/#24): hội tụ hạ tầng cho suite `system-tests/e2e/llm-inference-e2e` — container mock upstream `ecoma-<ns>-llm-upstream-mock` trên platform network (image `node:24-bookworm-slim` pin digest, repo mount read-only, credential qua env của process docker — argv chỉ mang tên biến, healthcheck `GET /v1/models` kèm Authorization), readiness qua MỘT container waiter ephemeral trong network, config `namespace:llmUpstreamBaseUrl` ghi đè về endpoint URL ĐẦY ĐỦ của mock (`http://ecoma-<ns>-llm-upstream-mock:8787/v1/chat/completions` — worker POST endpoint URL đã đăng ký nguyên vẹn, không ghép path; probe 8b suy `GET {endpoint}/v1/models` từ cùng giá trị và mock match hậu tố nên cả hai chạm đúng route; giá trị qua kênh stdin của `pulumi config set`), rồi chạy cùng entry `local.ts up`. Khi stack output `consumerApiKeyStdout` đã mang dòng plaintext key (show-once của bước 9) VÀ một probe chỉ đọc (`docker exec` psql trong container PostgreSQL platform) còn thấy ÍT NHẤT MỘT row `llm_gateway.api_keys` active (`revoked_at IS NULL`) của tenant consumer canonical, `up` SKIP `local.ts up` nguyên vòng — chạy lại sẽ xoay password role và thay stdout ghi nhận, mất plaintext vĩnh viễn. Output còn mà row mất (database bị reset ngoài vòng đời lane) là nghịch: `up` KHÔNG skip mà chạy `local.ts up` đầy đủ để bootstrap phát key mới qua hợp đồng converge-on-empty của runner bước 9; probe lỗi hạ tầng (docker/psql) thì fail-closed với hướng dẫn, không tự động converge. Suite KHÔNG đụng vòng đời container mock: lifecycle thuộc lane target này. Hệ quả của contract endpoint bất-đáy-biến đổi: bootstrap marketplace coi endpoint target là BẤT BIẾN (fail-closed khi giá trị config đổi) — đổi URL serving là thay đổi chủ đích, phục hồi bằng xoá row `llm_marketplace.upstream_endpoints` (và row key nếu cần bootstrap in lại plaintext) rồi `test-lane-up` cho bootstrap dựng lại; lane không tự xoá row nào.
- Stack exports: `provisionCommandName`, `migrateCommandNames`, `bootstrapCommandNames`, `imageDigest`, `containerName`, `containerId`, `stateVolumeName`, `namespaceVerified`, `consumerApiKeyStdout`.

## Boundaries

- Lane local KHÔNG provision hạ tầng Cloudflare (Hyperdrive, Worker, route) — hạ tầng Cloudflare staging thuộc lane staging của project này (`staging-program.ts`); deploy Worker vẫn là Wrangler (§9.1), không phải đường nào ở đây.
- Không sở hữu code của `apps/llm-api` — container chạy bundle do app đó build; sửa hành vi app thì sửa app.
- Không cấu hình consumer của data plane LLM ở local — base URL nội bộ `http://ecoma-llm-api:4211` là contract để unit consumer dùng, không phải phần của stack này.
- Ngữ nghĩa quota/settlement của llm-api không được restatement ở đây → `docs/applications/llm-api/`.
- Lane staging KHÔNG có down/destroy (teardown staging không có workflow — §7.4.1; checklist tay thuộc runbook #364), KHÔNG chạy migration và KHÔNG chạy bootstrap/seed (migration là lane migrate đúng environment; bootstrap là #352).
- Container mock upstream dùng kind `llm-upstream-mock` trong union `DeployResourceKind` của `libs/deployment` (#187) — tên qua `dockerResourceName`, và `pnpm dx local-cleanup` tự phân loại container mồ côi qua `CLEANUP_KINDS`. `test-lane-down` vẫn là teardown thuộc lane (chạy khi worktree còn sống).

## Development

```bash
pnpm nx run llm-api-deploy:lint
pnpm nx run llm-api-deploy:typecheck
```

Lifecycle mutate Docker/Pulumi state thật — chỉ chạy khi chủ đích thay đổi stack local:

```bash
pnpm nx run llm-api-deploy:staging-preview -c staging  # preview chương trình staging (fail-closed khi thiếu credential/origin #349)
pnpm nx run llm-api-deploy:staging-up -c staging       # up có kiểm soát; sau khi xanh, surface ba id Hyperdrive để wiring wrangler.jsonc
```

KHÔNG có target staging-down/destroy: teardown staging không có workflow (§7.4.1), checklist tay thuộc runbook #364. Lifecycle mutate Docker/Pulumi state thật — chỉ chạy khi chủ đích thay đổi stack:

```bash
pnpm nx run llm-api-deploy:local-up -c local    # provision unit này (kéo platform + build bundle app chạy trước)
pnpm nx run llm-api-deploy:local-down -c local  # destroy của riêng project; no-op exit 0 nếu worktree chưa từng deploy
pnpm nx run llm-api-deploy:test-lane-up -c local    # lane E2E: container mock upstream + serving về mock + local.ts up (skip khi đã hội tụ và row api_keys active còn sống)
pnpm nx run llm-api-deploy:test-lane-down -c local  # xoá container mock của lane E2E; stack vẫn teardown bằng local-down
```

Lệnh `lane.ts up` GIỮ stdout của `local.ts up` (run tạo key in plaintext API key consumer qua chuỗi pulumi — không được chạm captured artifact nào); plaintext chỉ đọc lại được qua `pulumi stack output consumerApiKeyStdout --show-secrets`, và lệnh `state` (dành cho runner suite) là kênh duy nhất in nó ra — envelope `LANE_STATE=<json>` một dòng, do runner suite bắt rồi không forward. Hạn chế còn lại: xoá state Pulumi mà database còn giữ row key là runner bước 9 hội tụ `existing` và không bao giờ in lại plaintext — khi đó `test-lane-up` fail-closed với hướng dẫn phục hồi (xoá row hoặc `local-down` đầy đủ rồi lên lại). Hướng nghịch — database bị reset ngoài vòng đời (row `api_keys` mất) mà state còn giữ output cũ — được guard skip-converged xử lý: probe chỉ đọc thấy row mất là `up` chạy `local.ts up` lại để bootstrap phát key mới, thay vì báo thành công với một key đã chết.

## Testing

Targets đã xác nhận từ project graph: `local-up`, `local-down`, `staging-preview`, `staging-up`, `test-lane-up`, `test-lane-down`, `test`, `test-integration`, `lint`, `typecheck`.

- Kiểm tĩnh: `lint` + `typecheck`; `test` (vitest) chấm script text do `scripts.ts` dựng, builder thuần của `lane-invocation.ts` (`lane.spec.ts`: argv mock/waiter không chứa giá trị credential, parser stdout không ghép raw output vào message) và engine lane staging (`staging-run.spec.ts`: pure functions + exec inject — inventory fail-closed, origin fail-closed #349, id thật vs placeholder toàn-zeros, tên config/output per-target) — không chứa giá trị secret nào, không chạy Pulumi thật.
- `test-integration` là suite argv-hygiene: chạy đúng script provision/migrate thật với sentinel giả, khẳng định không giá trị secret nào lọt vào argv, script text hay output bắt được, đồng thời trạng thái database sau provision + migration vẫn đúng. Suite cần Docker là phụ thuộc cứng — vắng Docker thì suite đỏ.
- Hợp đồng config staging của app (`env.staging` — ba binding, identity `stg-ecoma-llm-api`, không placeholder id) được ghim ở `apps/llm-api/tests/wrangler-staging-config.spec.ts`, thuộc target `test` của app.

## Related Documentation

- [`docs/architecture/local-development/README.md`](../../docs/architecture/local-development/README.md) — nền tảng local platform.
- [`docs/architecture/local-development/01-platform.md`](../../docs/architecture/local-development/01-platform.md) — ownership, cách ly worktree, contract outputs mà stack này đọc.
- [`docs/architecture/local-development/03-operations.md`](../../docs/architecture/local-development/03-operations.md) — vận hành lane, teardown, data-volume lifecycle.
- [`docs/applications/llm-api/README.md`](../../docs/applications/llm-api/README.md) — application được deploy.
- [`docs/applications/llm-api/03-operations.md`](../../docs/applications/llm-api/03-operations.md) — vận hành deploy unit ở delivery lane.
