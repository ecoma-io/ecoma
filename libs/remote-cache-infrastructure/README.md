# Remote Cache Infrastructure

Tầng infrastructure của bounded context `remote-cache` (`@ecoma-io/remote-cache-infrastructure`): PostgreSQL adapter qua Hyperdrive cho control plane và data plane của `remote-cache`.

Nx project `@ecoma-io/remote-cache-infrastructure`, tags `type:infrastructure`, `scope:remote-cache`, `runtime:edge`; dependencies là `@ecoma-io/remote-cache-domain` và driver `postgres` (postgres.js).

## Purpose

- Cấp client factory và repository cho database `db-remote-cache` mà composition root `apps/remote-cache-api` dùng qua Hyperdrive binding `DB_REMOTE_CACHE`.
- Giữ SQL là bản chép của schema trong `apps/remote-cache-api/db/migrations/` — không có hằng "tự chế"; mọi thao tác lọc theo `project_id` của API key đã xác thực.

## Responsibilities

- **Client factory** (`postgres.ts`): `createRemoteCachePostgresClient`, `withRemoteCacheClient`, kiểu `RemoteCacheClient`, `RemoteCacheClientConfig`, `RemoteCacheHyperdriveBinding`, `RemoteCacheQueryable`; `configuration-error.ts`: `RemoteCacheConfigurationError` cho cấu hình thiếu/sai.
- **Control plane repos** (`tenant-repository.ts`, `project-repository.ts`, `api-key-repository.ts`): `getTenantById`, `getProjectById`, `getProjectByTenantAndName`, `insertProject`, `listProjectsByTenant`, `getApiKeyById`, `getApiKeyByTokenHash`, `insertApiKey`, `revokeApiKey`, `parseApiKeyScopes`, `apiKeyHasWriteScope`.
- **Data plane repos** (`cache-entry-repository.ts`): `getCacheEntryByProjectAndHash`, `insertCacheEntry`, `listCacheEntriesByProject` — metadata của artifact cache, phạm vi project.
- **Quota/usage repos** (`quota-limit-repository.ts`, `usage-counter-repository.ts`): `getQuotaLimitByProject`, `upsertQuotaLimit`, `getUsageCounterByProject`, `upsertUsageCounter`, `rebuildUsageCounter` — bộ đếm dựng lại được từ `cache_entries`.
- **Audit repo** (`audit-log-repository.ts`): `insertAuditLog` — append-only, chỉ INSERT.

Consumer: `apps/remote-cache-api` — composition root `src/main.ts` boot qua `withRemoteCacheClient`; route group `src/routes.ts` (control plane), `src/cache-routes.ts` (data plane) và `src/lifecycle.ts` (kiểm lifecycle tenant).

## Boundaries

- Chỉ qua Hyperdrive binding: thư viện nhận connection từ caller, không tự tạo kết nối hay giữ state nào ngoài postgres.js client; binding `DB_REMOTE_CACHE` được khai trong `apps/remote-cache-api/wrangler.jsonc` của app consumer, không phải trong thư viện này.
- Không có logic authorization: schema CHECK và policy của app enforce cùng một quy tắc; repos chỉ mở read/insert cho đúng bảng của mình, không quyết định policy.
- Migration không đi qua client này: Hyperdrive không hỗ trợ advisory lock (invariant 13, [`docs/architecture/01-architecture.md`](../../docs/architecture/01-architecture.md) §9) — migration chạy bằng runner của app với chuỗi kết nối trực tiếp.
- Không import Hono, không dựng HTTP response: repos trả record thô cho route layer shape hoá theo `@ecoma-io/remote-cache-contracts`.

## Development

```bash
pnpm nx run @ecoma-io/remote-cache-infrastructure:lint
pnpm nx run @ecoma-io/remote-cache-infrastructure:typecheck   # tsc --build --emitDeclarationOnly
```

Entry công khai duy nhất là `src/index.ts` (`main` của package); thêm repo mới đi kèm export tường minh qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/remote-cache-infrastructure:test        # vitest — spec colocated trong src/
```

Spec colocated: `postgres.spec.ts` (factory và cấu hình fail-closed). Hành vi qua PostgreSQL thật thuộc suite app-owned của `apps/remote-cache-api` — `tests/databases/` (roles, migration) và `tests/integrations/` (`cache-p43.spec.ts`, `roles.spec.ts`), chạy qua target `test-integration` của app.

## Related Documentation

- [`docs/domains/remote-cache/README.md`](../../docs/domains/remote-cache/README.md) — bounded context `remote-cache`.
- [`docs/domains/remote-cache/domain-model.md`](../../docs/domains/remote-cache/domain-model.md) — khái niệm và invariant của tenant/project/API key/quota.
- [`docs/applications/remote-cache/01-architecture.md`](../../docs/applications/remote-cache/01-architecture.md) — storage partitioning (§5), configuration (§6), security boundaries (§10).
- [`docs/applications/remote-cache/03-operations.md`](../../docs/applications/remote-cache/03-operations.md) — vận hành của deploy unit `remote-cache`.
- [`apps/remote-cache-api/`](../../apps/remote-cache-api/) — composition root sở hữu binding và lifecycle của client.
- [`docs/architecture/01-architecture.md`](../../docs/architecture/01-architecture.md) — invariants hệ thống áp cho Hyperdrive (§9).
