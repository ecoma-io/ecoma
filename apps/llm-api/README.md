# LLM API

Component `llm-api` — API inference LLM phục vụ dưới base path `/llm`, chạy trên Cloudflare Workers với runtime TypeScript (Hono + driver `pg` qua Hyperdrive), bundle esbuild ra `build/index.js`. Component này host implementation và persistence của một số bounded context LLM; ownership domain luôn thuộc `docs/domains/` — mapping host/consume được ghi canonical trong `docs/applications/llm-api/`.

Nx project `@ecoma-io/llm-api`, tags `type:composition`, `scope:llm-api`, `runtime:edge`.

## Purpose

- Đưa lên Edge một Worker `ecoma-llm-api` (`wrangler.jsonc`, entry `build/index.js` sinh bởi Nx target `build` — esbuild bundle từ `src/index.ts`) với HTTP contract đóng băng: `GET /health`, `GET /ready`, `GET /v1/models`, `GET /llm/v1/models`; path khác → 404 bất kể method; method không GET trên một path đã định nghĩa → 405 kèm `Allow: GET` (HEAD cũng 405).
- Readiness fail-closed: `/ready` và `/v1/models` chỉ trả 200 khi cả ba Hyperdrive binding probe `SELECT 1` thành công (timeout 3s per binding, `src/readiness.ts`); một binding thiếu, lỗi hay timeout đều đưa về 503.
- Thiết kế component — hai plane, execution state, persistence ba database — là nội dung canonical của `docs/applications/llm-api/`; README này chỉ định vị phần tử trong Nx project.

## Responsibilities

- **Liveness** `GET /health` — không chạm database, trả lời cả khi mọi binding xuống.
- **Readiness** `GET /ready` — probe cả ba Hyperdrive binding; kết quả per-binding nằm trong `src/readiness.ts`.
- **Catalog endpoint** `GET /v1/models` và `GET /llm/v1/models` — cùng handler; 200 `application/json` với catalogue model `active` thật từ marketplace, owner là tên tenant ánh xạ từ gateway (Issue #23; danh sách rỗng `{"object":"list","data":[]}` là hợp lệ khi chưa có offer nào `active`), 503 fail-closed khi DB chưa ready, catalogue lỗi hay một offer không ánh xạ được owner.
- **Persistence**: `db/` là nguồn sự thật migration của ba database mà deploy unit sở hữu — `db-llm-gateway` (schema `llm_financial`, `llm_seller`), `db-llm-tenant` (schema `llm_tenant`), `db-llm-marketplace` (schema `llm_marketplace`); runner `db/apply.mts` chọn đúng một target mỗi lần gọi.
- Ba Hyperdrive binding khai trong `wrangler.jsonc` với id chuỗi rỗng: `DB_LLM_GATEWAY`, `DB_LLM_TENANT`, `DB_LLM_MARKETPLACE`; connection string local đi qua biến `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>`, thiếu biến lúc `wrangler dev` là lỗi boot tường minh.
- Runtime TypeScript khai `nodejs_compat` (driver `pg` cần `node:buffer`, `node:events`, `node:stream`). Mỗi phép gọi SQL mở một `pg.Client` mới rồi đóng (`src/connections.ts`) — không pool: pg Pool tái dùng client idle qua workerd không ổn định (đo trực tiếp), còn runtime Rust bị thay thế cũng mở một socket mới cho mỗi câu SQL, nên lifecycle per-operation là bản port trung thực.
- Log chỉ cấu trúc tối thiểu; không bao giờ log prompt/response body, connection string hay credential.

## Boundaries

- Worker này không sở hữu bounded context nào — nó host implementation và persistence; business model của từng context LLM nằm tại `docs/domains/<context>/domain-model.md` (catalog §2 của `docs/domains/README.md`).
- Migration chạy từ CI runner bằng credential migrator của từng database, không qua Hyperdrive (Hyperdrive không hỗ trợ advisory lock); khi provision, query cache của Hyperdrive phải giữ OFF — cache không invalidate khi ghi trên dữ liệu quota/settlement.
- `/health` và `/ready` là deployment-internal: `/llm/health` và `/llm/ready` không tồn tại, mọi path `/llm/*` khác hai route đã định nghĩa trả 404.
- Topology deploy và data ownership cấp hệ thống → `docs/architecture/01-architecture.md` §2, §4, §7.

## Development

```bash
pnpm nx run @ecoma-io/llm-api:build          # esbuild bundle → build/index.js
pnpm nx run @ecoma-io/llm-api:lint           # oxlint
pnpm nx run @ecoma-io/llm-api:typecheck      # tsc --build cho solution (app src/ + spec)
pnpm nx run @ecoma-io/llm-api:typecheck-db   # tsc --noEmit -p tsconfig.db.json
pnpm nx run @ecoma-io/llm-api:db:migrate -- gateway   # hoặc tenant | marketplace, cần DATABASE_URL migrator của DB đó
```

- Artifact `build/index.js` là entry mà `wrangler.jsonc` `main` trỏ vào; bundle external `node:buffer`, `node:events`, `node:stream` (do `nodejs_compat` cấp khi chạy).
- `db:migrate` mutate database thật và luôn không cacheable; target chạy ở runner có kết nối trực tiếp tới PostgreSQL, không qua Hyperdrive.

## Testing

```bash
pnpm nx run @ecoma-io/llm-api:test             # vitest — unit test colocated trong src/ (port của 9 unit test Rust cũ)
pnpm nx run @ecoma-io/llm-api:test-integration # tests/integrations + tests/databases — PostgreSQL thật (testcontainers)
```

- `test-integration` dependsOn `build`: suite HTTP contract boot runtime Worker thật từ artifact `build/index.js`.
- Phân loại test và canonical target theo `docs/architecture/06-testing.md`.

## Related Documentation

- [`docs/applications/llm-api/README.md`](../../docs/applications/llm-api/README.md) — component doc; [`01-architecture.md`](../../docs/applications/llm-api/01-architecture.md) (composition, planes, persistence), [`02-requirements.md`](../../docs/applications/llm-api/02-requirements.md), [`03-operations.md`](../../docs/applications/llm-api/03-operations.md).
- [`apps/llm-api/db/README.md`](./db/README.md) — ba database, runner migration, quyền role.
- Bounded context được host/consume (catalog → [`docs/domains/README.md`](../../docs/domains/README.md) §2): [`llm-inference`](../../docs/domains/llm-inference/README.md), [`llm-usage`](../../docs/domains/llm-usage/README.md), [`llm-financial`](../../docs/domains/llm-financial/README.md), [`llm-consumer-tenant`](../../docs/domains/llm-consumer-tenant/README.md), [`llm-consumer-routing`](../../docs/domains/llm-consumer-routing/README.md), [`llm-marketplace`](../../docs/domains/llm-marketplace/README.md), [`llm-seller-pricing`](../../docs/domains/llm-seller-pricing/README.md), [`llm-seller-governance`](../../docs/domains/llm-seller-governance/README.md).
- [`docs/architecture/01-architecture.md`](../../docs/architecture/01-architecture.md) — topology deploy, data ownership, hostname `/llm`.
