# LLM API Deploy

Pulumi deployment project provision **deploy unit của `apps/llm-api` trên lane LOCAL**: ba database `db-llm-gateway`/`db-llm-tenant`/`db-llm-marketplace`, sáu role PostgreSQL, migration theo từng database, image và container WIC (worker-in-container) cho data plane LLM. Đây là deploy project (`type:deployment`), không phải application hay bounded context. Chương trình Pulumi nằm ở `index.ts`, entry lifecycle ở `local.ts`, entry lane E2E ở `lane.ts`, image ở `Dockerfile` với entrypoint `wic-entrypoint.sh`, script provision/migrate dựng bằng hàm thuần trong `scripts.ts`.

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
- **Lane E2E** (`lane.ts`, target `test-lane-up`/`test-lane-down`, Issues #23/#24): hội tụ hạ tầng cho suite `system-tests/e2e/llm-inference-e2e` — container mock upstream `ecoma-<ns>-llm-upstream-mock` trên platform network (image `node:24-bookworm-slim` pin digest, repo mount read-only, credential qua env của process docker — argv chỉ mang tên biến, healthcheck `GET /v1/models` kèm Authorization), readiness qua MỘT container waiter ephemeral trong network, config `namespace:llmUpstreamBaseUrl` ghi đè về endpoint URL ĐẦY ĐỦ của mock (`http://ecoma-<ns>-llm-upstream-mock:8787/v1/chat/completions` — worker POST endpoint URL đã đăng ký nguyên vẹn, không ghép path; probe 8b suy `GET {endpoint}/v1/models` từ cùng giá trị và mock match hậu tố nên cả hai chạm đúng route; giá trị qua kênh stdin của `pulumi config set`), rồi chạy cùng entry `local.ts up`. Khi stack output `consumerApiKeyStdout` đã mang dòng plaintext key (show-once của bước 9) VÀ một probe chỉ đọc (`docker exec` psql trong container PostgreSQL platform) còn thấy ÍT NHẤT MỘT row `llm_gateway.api_keys` active (`revoked_at IS NULL`) của tenant consumer canonical, `up` SKIP `local.ts up` nguyên vòng — chạy lại sẽ xoay password role và thay stdout ghi nhận, mất plaintext vĩnh viễn. Output còn mà row mất (database bị reset ngoài vòng đời lane) là nghịch: `up` KHÔNG skip mà chạy `local.ts up` đầy đủ để bootstrap phát key mới qua hợp đồng converge-on-empty của runner bước 9; probe lỗi hạ tầng (docker/psql) thì fail-closed với hướng dẫn, không tự động converge. Suite KHÔNG đụng vòng đời container mock: lifecycle thuộc lane target này. Hệ quả của contract endpoint bất-đáy-biến đổi: bootstrap marketplace coi endpoint target là BẤT BIẾN (fail-closed khi giá trị config đổi) — đổi URL serving là thay đổi chủ đích, phục hồi bằng xoá row `llm_marketplace.upstream_endpoints` (và row key nếu cần bootstrap in lại plaintext) rồi `test-lane-up` cho bootstrap dựng lại; lane không tự xoá row nào.
- Stack exports: `provisionCommandName`, `migrateCommandNames`, `bootstrapCommandNames`, `imageDigest`, `containerName`, `containerId`, `stateVolumeName`, `namespaceVerified`, `consumerApiKeyStdout`.

## Boundaries

- Không provision hạ tầng Cloudflare (Hyperdrive, Worker, route) — chương trình này chỉ phủ lane local.
- Không sở hữu code của `apps/llm-api` — container chạy bundle do app đó build; sửa hành vi app thì sửa app.
- Không cấu hình consumer của data plane LLM ở local — base URL nội bộ `http://ecoma-llm-api:4211` là contract để unit consumer dùng, không phải phần của stack này.
- Ngữ nghĩa quota/settlement của llm-api không được restatement ở đây → `docs/applications/llm-api/`.
- Container mock upstream GHÉP TÊN tại `lane.ts` với hình dạng `ecoma-<ns>-<kind>` vì kind `llm-upstream-mock` chưa nằm trong union đóng `DeployResourceKind` của `libs/deployment` — thêm kind là thay đổi lib dùng chung, ngoài phạm vi lane E2E. Hệ quả: `pnpm dx local-cleanup` chưa tự phân loại container này — dọn chính thức là `test-lane-down`.

## Development

```bash
pnpm nx run llm-api-deploy:lint
pnpm nx run llm-api-deploy:typecheck
```

Lifecycle mutate Docker/Pulumi state thật — chỉ chạy khi chủ đích thay đổi stack local:

```bash
pnpm nx run llm-api-deploy:local-up -c local    # provision unit này (kéo platform + build bundle app chạy trước)
pnpm nx run llm-api-deploy:local-down -c local  # destroy của riêng project; no-op exit 0 nếu worktree chưa từng deploy
pnpm nx run llm-api-deploy:test-lane-up -c local    # lane E2E: container mock upstream + serving về mock + local.ts up (skip khi đã hội tụ và row api_keys active còn sống)
pnpm nx run llm-api-deploy:test-lane-down -c local  # xoá container mock của lane E2E; stack vẫn teardown bằng local-down
```

Lệnh `lane.ts up` GIỮ stdout của `local.ts up` (run tạo key in plaintext API key consumer qua chuỗi pulumi — không được chạm captured artifact nào); plaintext chỉ đọc lại được qua `pulumi stack output consumerApiKeyStdout --show-secrets`, và lệnh `state` (dành cho runner suite) là kênh duy nhất in nó ra — envelope `LANE_STATE=<json>` một dòng, do runner suite bắt rồi không forward. Hạn chế còn lại: xoá state Pulumi mà database còn giữ row key là runner bước 9 hội tụ `existing` và không bao giờ in lại plaintext — khi đó `test-lane-up` fail-closed với hướng dẫn phục hồi (xoá row hoặc `local-down` đầy đủ rồi lên lại). Hướng nghịch — database bị reset ngoài vòng đời (row `api_keys` mất) mà state còn giữ output cũ — được guard skip-converged xử lý: probe chỉ đọc thấy row mất là `up` chạy `local.ts up` lại để bootstrap phát key mới, thay vì báo thành công với một key đã chết.

## Testing

Targets đã xác nhận từ project graph: `local-up`, `local-down`, `test-lane-up`, `test-lane-down`, `test`, `test-integration`, `lint`, `typecheck`.

- Kiểm tĩnh: `lint` + `typecheck`; `test` (vitest) chấm script text do `scripts.ts` dựng và builder thuần của `lane-invocation.ts` (`lane.spec.ts`: argv mock/waiter không chứa giá trị credential, parser stdout không ghép raw output vào message) — không chứa giá trị secret nào.
- `test-integration` là suite argv-hygiene: chạy đúng script provision/migrate thật với sentinel giả, khẳng định không giá trị secret nào lọt vào argv, script text hay output bắt được, đồng thời trạng thái database sau provision + migration vẫn đúng. Suite cần Docker là phụ thuộc cứng — vắng Docker thì suite đỏ.

## Related Documentation

- [`docs/architecture/local-development/README.md`](../../docs/architecture/local-development/README.md) — nền tảng local platform.
- [`docs/architecture/local-development/01-platform.md`](../../docs/architecture/local-development/01-platform.md) — ownership, cách ly worktree, contract outputs mà stack này đọc.
- [`docs/architecture/local-development/03-operations.md`](../../docs/architecture/local-development/03-operations.md) — vận hành lane, teardown, data-volume lifecycle.
- [`docs/applications/llm-api/README.md`](../../docs/applications/llm-api/README.md) — application được deploy.
- [`docs/applications/llm-api/03-operations.md`](../../docs/applications/llm-api/03-operations.md) — vận hành deploy unit ở delivery lane.
