# Pact Broker API Infrastructure

Tầng infrastructure của bounded context `pact-broker` cho deploy unit `pact-broker-api` (`@ecoma-io/pact-broker-api-infrastructure`): PostgreSQL repositories và connection factory, chạy trong Worker qua Hyperdrive.

Nx project `@ecoma-io/pact-broker-api-infrastructure`, tags `type:infrastructure`, `scope:pact`, `runtime:edge`; dependencies là `@ecoma-io/pact-broker-api-application`, `@ecoma-io/pact-broker-api-domain`, `@ecoma-io/tenant-kernel-domain` và driver `pg`.

## Purpose

- Cài các port của `@ecoma-io/pact-broker-api-application` lên PostgreSQL: `TokenRepo`, `MembershipRepo`/`TenantLookup`, `EntitlementSyncRepo`.
- Trả record/DTO thô mà route layer của app shape hoá thành HAL — thư viện không dựng HTTP response.

## Responsibilities

- **Connection factory** (`db/client.ts`): `createPool` — mỗi isolate một `Pool` từ Hyperdrive connection string; `isConnectionTerminatedError` phân loại lỗi mất kết nối để caller tự retry.
- **Repos tenant/machine credential** (`repo/tenant-repo.ts`, `repo/token-repo.ts`): `PgTenantRepo`, `PgTokenRepo`, `insertAuditEvent`; `PactBrokerTenantError` khi tenant thiếu/không active.
- **Repos domain pact** (`repo/pact-repo.ts`, `repo/version-repo.ts`, `repo/verification-repo.ts`, `repo/environment-repo.ts`, `repo/webhook-repo.ts`, `repo/matrix-repo.ts`): pact content/full, version/tag/pacticipant/deployment record, verification, environment, webhook, matrix query.
- **Repos sync/audit** (`repo/entitlement-sync-repo.ts`, `repo/audit-repo.ts`): `PgEntitlementSyncRepo` cho state apply event entitlement, `PgAuditRepo` append-only.

Consumer: `apps/pact-broker-api` — composition root `src/main.ts` dựng pool và truyền vào mọi route; `src/entitlement-consumer.ts` và các route group (`pacts`, `matrix`, `contracts`, `environments`, `verifications`, `webhooks`, `pacticipants`, `admin`).

## Boundaries

- Không import app entry, không Hono, không mở kết nối nào tự động — caller sở hữu lifecycle của `Pool`; Pool sống theo isolate và có thể mất bất cứ lúc nào, mọi truy vấn tự chịu retry phía caller.
- Migration không đi qua client này: Hyperdrive không hỗ trợ advisory lock (invariant 13, [`docs/architecture/01-architecture.md`](../../docs/architecture/01-architecture.md) §9) — migration chạy từ CI runner bằng `db/apply.mts` với chuỗi kết nối trực tiếp.
- SQL nằm trong các repo là bản chép của schema trong `apps/pact-broker-api/db/migrations/`; không có logic authorization nào ở đây — scope/tenant check thuộc application layer.
- Binding Hyperdrive `HYPERDRIVE` được khai trong `apps/pact-broker-api/wrangler.jsonc` của app consumer, không phải trong thư viện này.

## Development

```bash
pnpm nx run @ecoma-io/pact-broker-api-infrastructure:lint
pnpm nx run @ecoma-io/pact-broker-api-infrastructure:typecheck   # tsc --build --emitDeclarationOnly
```

Entry công khai duy nhất là `src/index.ts` (`main` của package); thêm repo mới đi kèm export tường minh qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/pact-broker-api-infrastructure:test        # vitest — passWithNoTests
```

Không có spec colocated trong thư viện; hành vi repository được verify bởi suite app-owned của `apps/pact-broker-api` — `tests/databases/tenant-repo.spec.ts` (PostgreSQL thật qua testcontainers) và `tests/integrations/` (API qua `app.request()` với token thật + PostgreSQL testcontainers), chạy qua target `test-integration` của app.

## Related Documentation

- [`docs/applications/pact-broker/01-architecture.md`](../../docs/applications/pact-broker/01-architecture.md) — data model `db-pact-broker` (§3), auth model (§5.2), bindings (§8).
- [`docs/applications/pact-broker/03-operations.md`](../../docs/applications/pact-broker/03-operations.md) — migration và provisioning của `db-pact-broker`.
- [`docs/domains/pact-broker/README.md`](../../docs/domains/pact-broker/README.md) — bounded context `pact-broker`.
- [`apps/pact-broker-api/`](../../apps/pact-broker-api/) — composition root sở hữu Pool và binding.
- [`docs/architecture/01-architecture.md`](../../docs/architecture/01-architecture.md) — invariants hệ thống áp cho Hyperdrive và PostgreSQL (§9).
