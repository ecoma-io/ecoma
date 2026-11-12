# Deployment

Deployment primitives và contracts dùng chung thật (`@ecoma-io/deployment`): namespace worktree ổn định, ownership labels cho cleanup, contract outputs của platform stack, context Pulumi cô lập theo worktree, entry lifecycle colocated, secret primitives và hai biên escaping. Mọi deploy project (`deploys/*`) và tooling lifecycle của `tools/dx` import lib này qua tên package.

Lib chỉ chứa primitive có **ít nhất hai consumer thật**; logic single-consumer sống ở deploy project sở hữu nó (ví dụ teardown volume PostgreSQL ở `deploys/platform-deploy/platform-down.ts`). Ranh giới là một chiều: `deploys/* → lib`, `tools/dx → lib`; lib **không** import `tools/dx` hay project deploy nào — contract test của lib chặn, và không consumer nào ở dưới nó.

Nx project `@ecoma-io/deployment`, tags `type:tooling`, `scope:shared`, `runtime:native`. Dependency npm duy nhất là `@node-rs/xxhash` (xxHash64 cho namespace).

## Purpose

- Cho nhiều deploy unit chạy song song trên một host mà không đụng tài nguyên của nhau: namespace suy từ absolute worktree root đã normalize, mọi tên Docker resource và tên Pulumi stack mang namespace đó.
- Là tầng đáng tin nhất dưới mọi consumer: không import package workspace nào khác (Node builtin + import tương đối là hai hình hợp lệ duy nhất).

## Responsibilities

Module xuất khẩu (mỗi module một trách nhiệm, spec colocated):

- **Namespace và tên resource** (`deploy-namespace.ts`): `namespaceFromCanonicalPath`, `worktreeNamespace`, `dockerResourceName`, `pulumiStackName`, `normalizeWorktreeRoot`, hằng `NAMESPACE_LENGTH`, `RESOURCE_PREFIX`.
- **Escaping** (`shell-quote.ts`): `shellQuote` (POSIX shell) và `sqlQuote` (SQL literal) — hai biên độc lập.
- **Ownership labels** (`deploy-labels.ts`): `LABEL_MANAGED_BY`, `LABEL_PREFIX`, `OWNERSHIP_LABELS`, `classifyOwnership`, `labelsFromInspect`, `ownershipLabels` — dữ liệu cho `pnpm dx local-cleanup`.
- **Contract OAuth local** (`local-auth-contract.ts`): `LOCAL_BACKOFFICE_CLIENT_ID` — `client_id` share giữa `auth`/`backoffice` trên lane local.
- **Contract outputs platform** (`platform-outputs-contract.ts`): `PlatformOutputs` và key `.env` (`ROOT_HOST_ENV_KEY`, `ROOT_DOMAIN_ENV_KEY`, `POSTGRES_PASSWORD_ENV_KEY`, `LOCAL_ENV_OWNED_KEYS`, `LOCAL_ROOT_HOSTNAME`, `TRAEFIK_INTERNAL_PORT`, `buildRootHost`, `extractTraefikHostPort`).
- **Context Pulumi** (`pulumi-context.ts`): `resolveContext`, `ensureStack`, `pulumiRun`, `pulumiEnv`, `fullStackRef`, `hasPulumiState`, `localStateDir`, `localPassphrasePath`, `resolveLocalPassphrase`, `writeWorktreePassphrase`, `exec`/`execStreaming`, kiểu `LocalDeployContext`, `LocalPassphrase`, `ExecOptions`/`ExecResult`.
- **Entry lifecycle colocated** (`local-entry.ts`): `EntryFoundation`, `resolveEntryFoundation`, `ensureStackForEntry`, `pulumiUpForEntry`, `pulumiDestroyForEntry`, `setStackConfig`, `deployProjectDir`.
- **Secret primitives** (`local-env.ts`): `generateAppSecret`, `generateInternalHmacSecret`, `generatePostgresPassword`, `isConfigKeyMissing`, `readRootHostFromEnv`.

Consumer hiện tại: toàn bộ 17 project trong `deploys/` (ví dụ `platform-deploy`, `account-deploy`, `auth-deploy`, `backoffice-deploy`) và `tools/dx` (`src/workers/worker-config.ts`, `src/workers/worker-orchestration.ts`, `src/deployment/local-platform/local-cleanup.ts`).

## Boundaries

- Không nhận code lifecycle chỉ để cho import compile: một consumer sống ngay tại owner của nó (smoke script ở `system-tests/local-smoke`, `platform-down` ở `deploys/platform-deploy`).
- Cạnh `deploys/* → libs/deployment` không nằm trong `validateDeploymentGraph` — đây là tooling chạy cùng lúc với deploy, không phải prerequisite lifecycle giữa hai stack.
- Không chứa logic nghiệp vụ của deploy unit nào; giá trị provision thật (image, resource, secret) thuộc từng project `deploys/*`.

## Development

```bash
pnpm nx run @ecoma-io/deployment:lint
pnpm nx run @ecoma-io/deployment:typecheck           # tsc --build --emitDeclarationOnly
```

Mã nguồn nằm dưới `src/`; helper dùng chung mới phải có ít nhất hai consumer thật, và lib không được thêm import tới `@ecoma-io/*` nào.

## Testing

```bash
pnpm nx run @ecoma-io/deployment:test                # vitest — spec colocated trong src/
```

Spec colocated phủ từng module, trong đó `dependency-direction.spec.ts` đọc nguồn lib trực tiếp để chặn mọi import workspace ngược chiều.

## Related Documentation

- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — §3 "Lib deployment dùng chung", §6.1 `type:tooling` vs `type:deployment`, §6.2 `runtime:native`.
- [`docs/architecture/local-development/01-platform.md`](../../docs/architecture/local-development/01-platform.md) — namespace, contract outputs và cách lib được dùng khi provision platform local.
- [`docs/architecture/local-development/03-operations.md`](../../docs/architecture/local-development/03-operations.md) — lifecycle deploy/teardown/cleanup mà `deploy-labels` và `local-entry` phục vụ.
- [`deploys/platform-deploy/`](../../deploys/platform-deploy/) — consumer nền tảng của contract outputs.
