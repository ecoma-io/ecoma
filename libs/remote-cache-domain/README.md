# Remote Cache Domain

Thư viện domain thuần của bounded context `remote-cache` (`@ecoma-io/remote-cache-domain`): value object, invariant vòng đời và constraint thuần của tenant, project, membership, API key machine credential. Ngữ nghĩa nghiệp vụ là nội dung canonical của [`docs/domains/remote-cache/`](../../docs/domains/remote-cache/README.md) — thư viện hiện thực một phần tri thức đó bằng code.

Nx project `@ecoma-io/remote-cache-domain`, tags `type:domain`, `scope:remote-cache`, `runtime:universal`; `package.json` không có dependency nào.

## Purpose

- Ghim hình dạng và tập giá trị mà cả domain, contract và storage cùng phải đọc giống nhau: lifecycle state của tenant và scope của API key machine credential.
- Cung cấp đường enforce fail-closed cho lifecycle: credential của tenant/project không ở trạng thái `active` phải bị từ chối.

## Responsibilities

- **Lifecycle state** (`tenant-status.ts`): `REMOTE_CACHE_TENANT_STATUS` (`active`, `suspended`, `deleted`), `REMOTE_CACHE_TENANT_STATUSES`, `isRemoteCacheTenantStatus`, `isRemoteCacheTenantStatusActive`, `REMOTE_CACHE_TENANT_STATUS_REJECTED`.
- **Scope API key** (`api-key-scope.ts`): `REMOTE_CACHE_API_KEY_SCOPES`, `REMOTE_CACHE_API_KEY_SCOPE_PATTERN`, `isRemoteCacheApiKeyScopeList`, `hasRemoteCacheWriteScope`.
- **Lỗi** (`errors.ts`): `remoteCacheDomainError`, `isRemoteCacheDomainError`, catalog `REMOTE_CACHE_DOMAIN_ERROR_MESSAGES`.

Consumer: `libs/remote-cache-infrastructure` (`api-key-repository.ts`) và `apps/remote-cache-api` (`src/lifecycle.ts`, `src/main.ts`, `src/cache-routes.ts`, `src/routes.ts`).

## Boundaries

- Thuần TypeScript: không import Nx project khác, không SQL, không Node builtin, không I/O; mọi tham số thời gian do caller truyền vào, domain không đọc đồng hồ.
- Module này chỉ định nghĩa hình dạng và tập giá trị — **đường enforce** (authn + kiểm lifecycle) thuộc tầng serving, không nằm ở domain lib.
- API key là machine credential của chính context này: scope chỉ gồm read/write per project, **không** phản chiếu permission catalog của `staff-access` — hai vocabulary khác nhau, trộn là sai.
- Quy tắc đặt trạng thái và enforcement được chốt ở [ADR-0017](../../docs/domains/remote-cache/adr/0017-lifecycle-enforcement.md); ownership của context ở [ADR-0015](../../docs/domains/remote-cache/adr/0015-remote-cache-bounded-context.md). Thư viện không chứa logic quota/usage/audit.

## Development

```bash
pnpm nx run @ecoma-io/remote-cache-domain:lint
pnpm nx run @ecoma-io/remote-cache-domain:typecheck   # tsc --build --emitDeclarationOnly
```

Entry công khai duy nhất là `src/index.ts` (`main` của package); thêm module mới đi kèm spec colocated và export tường minh qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/remote-cache-domain:test        # vitest — spec colocated trong src/
```

Spec colocated: `tenant-status.spec.ts`, `api-key-scope.spec.ts`, `errors.spec.ts`.

## Related Documentation

- [`docs/domains/remote-cache/README.md`](../../docs/domains/remote-cache/README.md) — bounded context `remote-cache`, trách nhiệm và ranh giới với context khác.
- [`docs/domains/remote-cache/domain-model.md`](../../docs/domains/remote-cache/domain-model.md) — khái niệm, lifecycle và invariant.
- [`docs/domains/remote-cache/adr/`](../../docs/domains/remote-cache/adr/) — index ADR của context (bounded context, lifecycle enforcement).
- [`docs/applications/remote-cache/README.md`](../../docs/applications/remote-cache/README.md) — application gồm control plane, data plane và admin UI composition.
- [`libs/remote-cache-contracts/`](../remote-cache-contracts/) — wire contract phía control plane, mirror vocabulary nhưng không import lib này.
