# Remote Cache Contracts

Wire contract phía control plane của bounded context `remote-cache` (`@ecoma-io/remote-cache-contracts`): schema và validator cho create/list project trong tenant của API key.

Nx project `@ecoma-io/remote-cache-contracts`, tags `type:contracts`, `scope:remote-cache`, `runtime:universal`; `package.json` không có dependency nào — đúng ràng buộc `type:contracts` của `.oxlintrc.json`: không phụ thuộc bất kỳ project implementation nào, kể cả transitive.

## Purpose

- Định nghĩa hình dạng request/response của control plane mà consumer (composition root `apps/remote-cache-api`) dùng để nhận và trả dữ liệu qua validator, không ghép field bằng tay.
- Giữ vocabulary ở mức hình thức wire tự chứa: scope API key và tenant status được khai báo lại ở đây thay vì import từ domain lib.

## Responsibilities

- **Validator request/response** (`project-control-plane-contract.ts`): `validateCreateRemoteCacheProjectRequest`, `validateRemoteCacheProjectListRequest`, `validateRemoteCacheProjectListResponse`, `validateRemoteCacheProject`.
- **Hằng wire**: `PROJECT_LIST_DEFAULT_LIMIT`, `PROJECT_LIST_MAX_LIMIT`, `REMOTE_CACHE_PROJECT_NAME_PATTERN`, `FORBIDDEN_PROJECT_CREDENTIAL_FIELDS`.
- **Vocabulary mirror**: `REMOTE_CACHE_API_KEY_SCOPES`, `REMOTE_CACHE_TENANT_STATUSES` với các guard `isRemoteCacheApiKeyScope`, `isRemoteCacheTenantStatus`, `isRemoteCacheProjectName` — cùng tập giá trị với `@ecoma-io/remote-cache-domain` nhưng khai báo độc lập.
- Kiểu rejection reason đóng: `RemoteCacheControlPlaneRejectionReason` và `RemoteCacheControlPlaneValidation`.

Consumer: `apps/remote-cache-api` — route group control plane `src/routes.ts` dùng validator cho create/list project.

## Boundaries

- Không import implementation nào: vocabulary được khai báo lại ở mức hình thức wire, tự chứa trong project; mỗi lib ghim tập giá trị của mình trong spec colocated của chính nó, và không có cơ chế compile-time nào bắt lệch giữa hai tập.
- Phạm vi của contract là control plane create/list project trong tenant của key; data plane cache, quota và hardening không thuộc bề mặt wire này.
- Chỉ chứa schema, validator và hằng: không SQL, không HTTP handler, không Cloudflare binding, không authorization logic; authorization của control plane thuộc `apps/remote-cache-api` và domain lib.

## Development

```bash
pnpm nx run @ecoma-io/remote-cache-contracts:lint
pnpm nx run @ecoma-io/remote-cache-contracts:typecheck   # tsc --build --emitDeclarationOnly
```

Entry công khai duy nhất là `src/index.ts` (`main` của package); thêm contract mới đi kèm spec colocated và export tường minh qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/remote-cache-contracts:test        # vitest — spec colocated trong src/
```

Spec colocated: `project-control-plane-contract.spec.ts` — phủ accept/reject từng trường hợp validation, gồm tập scope rỗng/trùng/lệch vocabulary.

## Related Documentation

- [`docs/domains/remote-cache/README.md`](../../docs/domains/remote-cache/README.md) — bounded context `remote-cache`.
- [`docs/domains/remote-cache/domain-model.md`](../../docs/domains/remote-cache/domain-model.md) — khái niệm tenant/project/membership/API key của context.
- [`docs/domains/remote-cache/adr/`](../../docs/domains/remote-cache/adr/) — index ADR của context (bounded context, lifecycle enforcement).
- [`docs/applications/remote-cache/README.md`](../../docs/applications/remote-cache/README.md) — application gồm control plane, data plane và admin UI composition.
- [`docs/applications/remote-cache/01-architecture.md`](../../docs/applications/remote-cache/01-architecture.md) — public interface của control plane (§3).
- [`libs/remote-cache-domain/`](../remote-cache-domain/) — lib mirror phía domain.
