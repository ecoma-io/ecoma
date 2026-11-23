# Pact Broker App Deploy

Pulumi deployment project provision **deploy unit của `apps/pact-broker-app`**: trên lane LOCAL là image đóng gói artifact `build:development` (Nuxt preset `node-server`) do Nx build sẵn, container phía sau Traefik, database phiên BFF `db-pact-broker-app` và cấu hình OIDC của BFF; trên lane STAGING là HyperdriveConfig `db-pact-broker-app-staging` (#358, §9.1). Đây là deploy project (`type:deployment`), không phải application hay bounded context. Entry `index.ts` là **lane guard** (#358, pattern #453/#539): phân loại stack trước khi nạp thân — `local-program.ts` (lane local), `staging-program.ts` (lane staging), stack lạ là throw; entry lifecycle local ở `local.ts`, entry staging ở `staging.ts` (engine dùng chung `staging-run.ts`), hàm dựng script provision/migrate ở `scripts.ts`, image ở `Dockerfile`.

Nx project `pact-broker-app-deploy`, tags `type:deployment`, `scope:pact`, `runtime:native`. Hai lane: local (`configurations: local`) và staging (`configurations: staging`, #358). Production của app khai trong `apps/pact-broker-app/wrangler.jsonc` (preset `cloudflare-module`) và thuộc delivery lane — không nằm trong chương trình này.

## Purpose

- Đưa `apps/pact-broker-app` (dashboard BFF của pact-broker) lên local platform với vòng lifecycle provision database → migrate → image → container → readiness.
- Sở hữu **database riêng của unit** `db-pact-broker-app` (ADR-0031 §2, #206): hai role PostgreSQL + database + migration của app — invariant 1 theo hình mới trong `docs/applications/pact-broker/01-architecture.md` §9 (một service — một database).
- Ghim đúng cấu hình broker + OIDC của BFF: base URL trỏ alias nội bộ của container `pact-broker-api`; issuer/audience ghim từ platform outputs (structural exact match với auth-deploy); `client_id` đọc cross-stack từ auth-deploy. Thiếu hoặc sai là route tương ứng trả 503 (fail-closed ở tầng app).

## Staging lane (#358)

- **Phủ đúng một resource**: HyperdriveConfig `db-pact-broker-app-staging` cho database riêng của unit `db-pact-broker-app` (inventory §9.1: Hyperdrive config **per-database per-lane** — config chị `db-pact-broker-staging` của `pact-broker-api-deploy` là resource rời). Origin đọc từ stack config (`namespace:originHost`/`originPort`/`originPassword`) và **fail closed** khi chưa có: đường tới origin private là Tunnel/VPC Service của #349, chưa provision lần nào — `pulumi preview` đỏ cho tới khi #349 cấp origin, không có đường "chạy tạm với origin giả".
- **Chỉ `preview`/`up`** — KHÔNG có down/destroy: teardown staging không có workflow (§7.4.1), checklist tay thuộc runbook #364; entry `staging.ts` từ chối tường minh mọi verb khác.
- **Prerequisite vận hành fail-closed** (`staging-run.ts`): `ECOMA_PULUMI_STATE_URL_STAGING` (backend R2, bootstrap một lần ngoài mọi stack — thiếu là chưa bootstrapped, tuyệt đối không fallback), `PULUMI_CONFIG_PASSPHRASE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `CLOUDFLARE_API_TOKEN`. Thiếu bất kỳ khóa nào là từ chối TRƯỚC KHI đụng Pulumi; token không bao giờ vào provider config/state.
- **Evidence append-only**: mỗi lần chạy ghi một bản ghi JSON mới vào `.staging-evidence/` (phase, stack ref, revision, resource changes) — reconstructible, không overwrite.
- **Wiring id về sau**: sau một lần `up` xanh, entry đọc stack output `hyperdriveConfigId` và surface id thật để operator fill vào `env.staging.hyperdrive[0].id` (binding `DB_PACT_BROKER_APP`) của `apps/pact-broker-app/wrangler.jsonc` (§9.1 — id do Pulumi cung cấp, Wrangler không tạo config; deploy với placeholder là lỗi định danh, guard `resource-bindings` chặn). Staging tuyệt đối không trỏ vào Hyperdrive production — mỗi `env` khai binding riêng (Wrangler không inherit giữa các `env.<lane>`).

## Responsibilities

- **Database lifecycle** (`scripts.ts`, `index.ts`, #206): provision hai role `ecoma_pact_broker_app_{migrator,runtime}` + database `db-pact-broker-app` qua `docker exec` vào PostgreSQL platform (idempotent guard-create, ALTER password mỗi lần up), rồi migrate qua container ephemeral trên platform network chạy đúng `tsx --tsconfig tsconfig.db.json runner.mts migrate` của `databases/pact-broker-app-db` (cutover #378; advisory lock riêng, history Drizzle). Container chỉ khởi sau khi migrate xong (`dependsOn`).
- **Secret lifecycle** (`local.ts`): sinh + xoay mật khẩu hai role mỗi lần `up` vào stack config của stack này (`namespace:{runtime,migrator}Password`). Kênh truyền: `--config` qua stdin, `environment` map của `command.local.Command`, URL percent-encode trong hàm dựng — không argv, không log.
- **OIDC client id** (`local.ts`, #206): đọc `namespace:pactBrokerAppClientId` cross-stack từ stack `auth-deploy` (auth seed client public `pact-broker-app`, ADR-0031 §4) rồi persist vào stack config của stack này; thiếu key là fail-closed (lỗi thứ tự lane). `client_id` là định danh công khai OAuth — không phải secret.
- **Image + container** (`Dockerfile`, `index.ts`): image COPY artifact `.output-node/` do `local-build` (→ `@ecoma-io/pact-broker-app:build:development`) build sẵn, từ repo root, fail-loud kiểm entrypoint (builder `default`, `load: true`, `push: false`); container ghim `tag@sha256:<digest>`, `restart: unless-stopped`, alias DNS `ecoma-pact-app`, router Traefik `Host(pact.<rootHostname>)` TLS, healthcheck `GET /health` yêu cầu 2xx (`r.ok`) và `wait: true` — `pulumi up` chỉ xanh khi healthcheck `healthy`. Healthcheck cố ý KHÔNG dùng `/ready`: `/ready` trả 503 khi thiếu cấu hình broker/OIDC, sai làm readiness của container.
- **Env inject** (`index.ts`): `PORT=3000`, `NODE_ENV=production`, `NITRO_PACT_BROKER_API_BASE_URL=http://ecoma-pact-api:4204` (alias + port là contract hai hằng đối xứng với `pact-broker-api-deploy`), `NITRO_PACT_BROKER_APP_DATABASE_URL` (runtime role, percent-encoded, bọc `pulumi.secret`), `NITRO_PACT_BROKER_AUTH_ISSUER`/`_AUDIENCE` (ghim `https://{auth,api}.<rootHostname>:<traefikHostPort>`), `NITRO_PACT_BROKER_AUTH_CLIENT_ID` và `NITRO_PACT_BROKER_AUTH_INTERNAL_ORIGIN=http://ecoma-<ns>-auth:4203` (fetch server-side nội bộ, local-only). KHÔNG có biến token nào (ADR-0031 §5: machine token của BFF đã retire).
- **Platform dependency**: đọc outputs platform qua `StackReference` (`networkName`, `namespace`, `rootHostname`, `traefikHostPort`) fail-closed; so namespace platform với worktree namespace, lệch là lỗi deploy; target `local-up` dependsOn `platform-deploy:local-up`, `pact-broker-api-deploy:local-up` và `auth-deploy:local-up`.
- **Multi-worktree**: mọi Docker resource mang namespace theo worktree và ownership labels để `pnpm dx local-cleanup` phân loại được.
- Stack exports: `imageDigest`, `containerName`, `containerId`, `namespaceVerified`.

## Boundaries

- Lane local không provision hạ tầng Cloudflare nào; lane staging chỉ provision HyperdriveConfig của database mình (§9.1) — KHÔNG deploy Worker, route hay custom domain nào (Worker `stg-ecoma-pact-broker-app` deploy bằng machinery staging dùng chung `tools/delivery`, #535; production là M3).
- Không tạo network, Traefik hay PostgreSQL platform; SỞ HỮU `db-pact-broker-app` bên trong PostgreSQL platform nhưng KHÔNG chạm `db-pact-broker` (của `pact-broker-api`) hay bất kỳ database nào khác.
- Không sở hữu code của `apps/pact-broker-app` — image build từ source của app; sửa hành vi app thì sửa app.
- Ngữ nghĩa nghiệp vụ của dashboard (pact, verification, `can-i-deploy`) không được restatement ở đây → `docs/applications/pact-broker/`.

## Development

```bash
pnpm nx run pact-broker-app-deploy:lint
pnpm nx run pact-broker-app-deploy:typecheck
pnpm nx run pact-broker-app-deploy:test
```

Lifecycle mutate Docker/Pulumi state thật — chỉ chạy khi chủ đích thay đổi stack local:

```bash
pnpm nx run pact-broker-app-deploy:local-up -c local    # provision unit này (kéo platform + auth + pact-broker-api chạy trước)
pnpm nx run pact-broker-app-deploy:local-down -c local  # destroy của riêng project; no-op exit 0 nếu worktree chưa từng deploy
```

Lane staging mutate Pulumi state staging thật — chỉ chạy khi đủ prerequisite vận hành (xem §Staging lane):

```bash
pnpm nx run pact-broker-app-deploy:staging-preview -c staging  # pulumi preview --json trên stack staging, ghi evidence
pnpm nx run pact-broker-app-deploy:staging-up -c staging       # pulumi up --yes; sau đó surface id Hyperdrive để wiring wrangler.jsonc
```

## Testing

- Target `test`: spec colocated `scripts.spec.ts` — bất biến tĩnh của script text (không Docker, không PostgreSQL): script không chứa giá trị secret, chỉ đọc mật khẩu qua TÊN biến env; URL builder percent-encode đúng; migrate script chạy đúng runner của app. Cùng target chạy thêm `staging-run.spec.ts` (engine lane staging #358 — classifier stack fail-closed, inventory credential bắt buộc đầy đủ, origin Hyperdrive fail-closed #349, đọc/ghi evidence; pure functions + exec inject, không chạy Pulumi thật).
- Kiểm tĩnh: `lint` + `typecheck`.
- Không có system-test suite nào khai `pact-broker-app-deploy:local-up` làm prerequisite (xác nhận qua project graph) — bằng chứng serving của unit là healthcheck `/health` mà `wait: true` của container bắt buộc trong `local-up`.

## Related Documentation

- [`docs/architecture/local-development/README.md`](../../docs/architecture/local-development/README.md) — nền tảng local platform.
- [`docs/architecture/local-development/01-platform.md`](../../docs/architecture/local-development/01-platform.md) — ownership, cách ly worktree, contract outputs mà stack này đọc.
- [`docs/architecture/local-development/03-operations.md`](../../docs/architecture/local-development/03-operations.md) — vận hành lane, teardown, data-volume lifecycle (§ bất biến cross-stack).
- [`docs/applications/pact-broker/README.md`](../../docs/applications/pact-broker/README.md) — application được deploy.
- [`deploys/pact-broker-api-deploy/README.md`](../pact-broker-api-deploy/README.md) — unit sở hữu `db-pact-broker` mà BFF gọi qua HTTP.
- [`deploys/auth-deploy/README.md`](../auth-deploy/README.md) — unit seed client OIDC `pact-broker-app` (nguồn client id cross-stack).
