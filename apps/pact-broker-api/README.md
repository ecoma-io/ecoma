# Pact Broker API

Component API của bounded context `pact-broker` — Cloudflare Worker (Hono) API-only, tương thích Pact CLI: lưu pact, verification, deployment record, trả `can-i-deploy`. Component pair `pact-broker-api` + `pact-broker-app` được mô tả chung trong `docs/applications/pact-broker/`; domain model và quyết định tenant/machine token nằm tại `docs/domains/pact-broker/`.

Nx project `@ecoma-io/pact-broker-api`, tags `type:composition`, `scope:pact`, `runtime:edge`.

## Purpose

- Worker `ecoma-pact-broker-api` (`wrangler.jsonc`, entry `dist/main.js` sinh bởi `@nx/esbuild`): composition root `src/main.ts` dựng middleware chain cố ý — request-id, security headers, body-limit 5 MiB đếm byte thật trên stream, CORS chỉ khi `PACT_BROKER_DASHBOARD_ORIGIN` được cấu hình, auth per route-group.
- Route group mount theo contract Pact CLI: index discovery `/`, `/pacticipants`, `/pacts` (publish, verification results), `/matrix` (`can-i-deploy`), `/environments`, `/contracts`, `/webhooks`, `/admin` (machine token, membership) — 404 đồng nhất HAL-shaped, không leak route tồn tại hay không.
- Auth machine token ba scope (`read`/`write`/`admin`) gắn ở từng route group, không global: `/health` và index discovery đạt được không credential.
- Config fail-closed (`src/config.ts`): thiếu Hyperdrive binding là `PactBrokerConfigurationError` → mọi request nghiệp vụ trả 503.

## Responsibilities

- **API surface**: đọc HAL/matrix (`read`), publish/deploy/webhook CRUD (`write`), quản trị token và membership (`admin`); danh sách route đầy đủ trong `src/routes/`.
- **Queue consumer** `ecoma-staff-access-entitlement-events` (binding `ENTITLEMENT_EVENTS_QUEUE`): cùng entry module với `fetch`; parse envelope `EntitlementEvent`, compare-and-drop theo revision, upsert membership role `Member` cho tenant canonical `ecoma`, ghi revision đã áp dụng; lỗi hợp đồng để Queue retry theo `max_retries` + DLQ `ecoma-staff-access-entitlement-events-dlq`.
- **Persistence**: `db/` là nguồn sự thật migration của `db-pact-broker` (PostgreSQL qua Hyperdrive binding `HYPERDRIVE`, id khai chuỗi rỗng); access qua `pg` với Pool theo request — pool được tạo trong request và `end()` khi request kết thúc (issue #118: socket driver gắn với request context tạo ra nó, không được tái sử dụng xuyên request).
- **Bootstrap và provisioning machine token**: `db/bootstrap-tenant.mts` tạo tenant canonical `ecoma` (ADR-0020), `db/provision-machine-token.mts` cấp token cho deploy unit — cả hai chạy từ runner, không từ Worker.
- Webhook CRUD luôn mở; execution outbound bị khoá cứng trong code cho tới khi có SSRF guard (`PACT_BROKER_WEBHOOKS_ENABLED=true` bị từ chối, `src/config.ts`).
- Log một dòng JSON có request-id; không bao giờ log token hay body request/response.

## Boundaries

- API-only: không phục vụ dashboard — UI/BFF là Worker riêng `apps/pact-broker-app`; CORS chỉ mở cho origin dashboard được khai, mặc định không ACAO nào được phát.
- Không có endpoint đọc public nào: mọi Pact data theo tenant, auth middleware chạy trước mọi lookup nghiệp vụ.
- Database duy nhất `db-pact-broker`; không đọc database của service khác — dữ liệu entitlement đến qua Queue event, không qua shared database access.
- Migration và bootstrap chạy ở CI runner, không qua Hyperdrive (`db/apply.mts`, `db/bootstrap-tenant.mts`); consumer entitlement của `staff-access-relay` là producer phía đối diện của cùng Queue.

## Development

```bash
pnpm nx run @ecoma-io/pact-broker-api:build                        # esbuild → dist/main.js
pnpm nx run @ecoma-io/pact-broker-api:lint
pnpm nx run @ecoma-io/pact-broker-api:typecheck                    # tsc --build (phần TS)
pnpm nx run @ecoma-io/pact-broker-api:typecheck-db                 # tsc --noEmit -p tsconfig.db.json
pnpm nx run @ecoma-io/pact-broker-api:db:migrate                   # db/apply.mts — cần DATABASE_URL migrator
pnpm nx run @ecoma-io/pact-broker-api:db:bootstrap                 # db/bootstrap-tenant.mts — tenant canonical `ecoma`
pnpm nx run @ecoma-io/pact-broker-api:db:provision-machine-token   # db/provision-machine-token.mts
```

- Dev server dùng port khai trong `dev` của `wrangler.jsonc` (4204); biến cấu hình: `PACT_BROKER_DASHBOARD_ORIGIN` (CORS dashboard), `PACT_BROKER_WEBHOOKS_ENABLED` (chỉ nhận `true`/`false` tường minh, `true` bị từ chối khi chưa có SSRF guard).
- `db:*` mutate database thật; `db:bootstrap` và `db:provision-machine-token` chạy từ CI runner/ops box với credential hợp lệ, không bao giờ từ Worker.

## Testing

```bash
pnpm nx run @ecoma-io/pact-broker-api:test             # vitest — unit colocated trong src/
pnpm nx run @ecoma-io/pact-broker-api:test-integration # tests/integrations + tests/databases — PostgreSQL thật (testcontainers)
```

- Suite `tests/databases/` ghim migration, tenant repo và bootstrap/provision machine token; suite `tests/integrations/` boot app thật qua harness và ghim hành vi API.
- Phân loại test và canonical target theo `docs/architecture/06-testing.md`.

## Related Documentation

- [`docs/applications/pact-broker/README.md`](../../docs/applications/pact-broker/README.md) — component doc pair; [`01-architecture.md`](../../docs/applications/pact-broker/01-architecture.md) (ranh giới deploy unit, data model, auth model), [`02-requirements.md`](../../docs/applications/pact-broker/02-requirements.md), [`03-operations.md`](../../docs/applications/pact-broker/03-operations.md), [`UPSTREAM_MAPPING.md`](../../docs/applications/pact-broker/UPSTREAM_MAPPING.md) (ánh xạ module upstream).
- [`docs/domains/pact-broker/README.md`](../../docs/domains/pact-broker/README.md) — bounded context `pact-broker`; [`domain-model.md`](../../docs/domains/pact-broker/domain-model.md) — tenant isolation, machine token, `can-i-deploy` fail-closed.
- [`docs/domains/staff-access/README.md`](../../docs/domains/staff-access/README.md) — context nguồn của entitlement event mà queue consumer áp dụng.
- [`apps/pact-broker-app/README.md`](../pact-broker-app/README.md) — dashboard BFF gọi API này.
- [`docs/architecture/01-architecture.md`](../../docs/architecture/01-architecture.md) — topology deploy và data ownership.
