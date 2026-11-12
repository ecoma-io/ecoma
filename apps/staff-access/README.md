# Staff Access

API service của bounded context `staff-access` — Cloudflare Worker (Hono) nội bộ: sổ staff, catalog role/permission, staff-role assignment, entitlement read model và authorization audit, phục vụ composition `backoffice` qua internal API. Domain model tại `docs/domains/staff-access/`; thiết kế component là nội dung canonical của `docs/applications/staff-access/`.

Nx project `@ecoma-io/staff-access`, tags `type:composition`, `scope:staff-access`, `runtime:edge`.

## Purpose

- Worker `ecoma-staff-access` (`wrangler.jsonc`, entry `dist/main.js` sinh bởi `@nx/esbuild`) với Hyperdrive binding `DB_STAFF_ACCESS` tới PostgreSQL `db-staff-access`.
- Bề mặt HTTP thật (`src/routes.ts`, mọi wire shape bắt buộc theo `@ecoma-io/staff-access-contracts`): `GET /health`, `GET /ready`, staff directory (`GET /staff`, `GET /staff/:id`), catalog role/permission (`GET /roles`, `GET /roles/:id`, `GET /permissions`, `GET /permissions/:id`), assignment (`GET /staff/:id/assignments`, `POST /staff/:id/assignments`, `POST /assignments/revoke`), entitlement (`GET /staff/:id/entitlements`, `GET /staff/:id/entitlements/:product`), audit (`GET /audit/entries`), và settle outbox (`POST /outbox/:event_id/settle`).
- Ghi privileged (create/revoke assignment) chạy trong một transaction: assignment và audit entry cùng một commit — grant/revoke không tồn tại không audit.
- Thiết kế component, authn/authz và exposure contract là nội dung canonical của `docs/applications/staff-access/01-architecture.md`.

## Responsibilities

- **Serving path**: mỗi request một client `withStaffAccessClient(config, ...)` đóng trong `finally` — không reuse client giữa các request.
- **Entitlement read model**: đọc entitlement theo staff và theo product cho consumer BFF.
- **Outbox settlement**: `POST /outbox/:event_id/settle` nhận receipt từ relay/consumer và đánh dấu event đã settle trong `staff_access.entitlement_outbox_events`.
- **Persistence**: `db/` là nguồn sự thật migration của `db-staff-access` (schema `staff_access`, ba role `ecoma_owner`/`ecoma_staff_access_migrator`/`ecoma_staff_access_runtime`, chặn chéo `REVOKE CONNECT`).
- **Health/readiness**: `/health` không credential và không chạm DB; `/ready` probe phụ thuộc thật.
- Secrets khai trong `wrangler.jsonc` cho đường internal HMAC envelope: `AUTH_INTERNAL_SECRET`, `AUTH_INTERNAL_KID`, `AUTH_INTERNAL_PREVIOUS_SECRET`, `AUTH_INTERNAL_PREVIOUS_KID`, `AUTH_INTERNAL_SKEW_SECONDS`.

## Boundaries

- Worker không publish port ra host và không mang label `traefik.*`: consumer duy nhất là BFF fetch server-side qua alias DNS nội bộ `ecoma-staff-access` trong platform network; khi có consumer mới, guard riêng (service-token/internal authn) phải thêm trước khi expose — network isolation không được dùng làm authn.
- Check permission (`staff.read`/`role.read`/`permission.read`) và ánh xạ identity → staff id là việc của caller BFF; service không tự nghiệm token tại đây (ADR-0009: không có internal authorization-result contract).
- Không sở hữu nghiệp vụ staff/role/entitlement — business model tại `docs/domains/staff-access/domain-model.md`; relay outbox entitlement là việc của Worker riêng `apps/staff-access-relay`.
- Không đọc database của service khác; tiêu thụ `account` (displayName) và `auth` (verify token) qua contract.

## Development

```bash
pnpm nx run @ecoma-io/staff-access:build          # esbuild → dist/main.js
pnpm nx run @ecoma-io/staff-access:lint
pnpm nx run @ecoma-io/staff-access:typecheck      # tsc --build (phần TS)
pnpm nx run @ecoma-io/staff-access:typecheck-db   # tsc --noEmit -p tsconfig.db.json
pnpm nx run @ecoma-io/staff-access:db:migrate     # db/apply.mts — cần DATABASE_URL migrator
```

- Dev server dùng port khai trong `dev` của `wrangler.jsonc` (4206); Hyperdrive binding khai id chuỗi rỗng, connection string local đi qua biến `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_STAFF_ACCESS`.
- `db:migrate` mutate database thật và chạy từ runner có kết nối trực tiếp tới PostgreSQL, không qua Hyperdrive.

## Testing

```bash
pnpm nx run @ecoma-io/staff-access:test             # vitest — unit colocated trong src/
pnpm nx run @ecoma-io/staff-access:test-integration # tests/integrations + tests/databases — PostgreSQL thật (testcontainers)
```

- `tests/databases/` ghim migration và repo; `tests/integrations/` ghim hành vi route trên app thật qua harness.
- Phân loại test và canonical target theo `docs/architecture/06-testing.md`.

## Related Documentation

- [`docs/applications/staff-access/README.md`](../../docs/applications/staff-access/README.md) — component doc; [`01-architecture.md`](../../docs/applications/staff-access/01-architecture.md), [`02-requirements.md`](../../docs/applications/staff-access/02-requirements.md), [`03-operations.md`](../../docs/applications/staff-access/03-operations.md).
- [`docs/domains/staff-access/README.md`](../../docs/domains/staff-access/README.md) — bounded context `staff-access`; [`domain-model.md`](../../docs/domains/staff-access/domain-model.md); ADR index tại [`adr/`](../../docs/domains/staff-access/adr/README.md).
- [`apps/staff-access/db/README.md`](./db/README.md) — schema `staff_access`, role, migration.
- [`apps/staff-access-relay/README.md`](../staff-access-relay/README.md) — relay outbox entitlement của cùng context.
- [`docs/applications/backoffice/README.md`](../../docs/applications/backoffice/README.md) — composition consumer của API này.
- [`docs/architecture/01-architecture.md`](../../docs/architecture/01-architecture.md) — topology deploy và data ownership.
