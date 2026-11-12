# Pact Broker API Domain

Thư viện domain của bounded context `pact-broker` cho deploy unit `pact-broker-api` (`@ecoma-io/pact-broker-api-domain`): HAL vocabulary, matrix semantics tri-state của `can-i-deploy` và input schemas. Ngữ nghĩa nghiệp vụ của context là nội dung canonical của [`docs/domains/pact-broker/`](../../docs/domains/pact-broker/README.md).

Nx project `@ecoma-io/pact-broker-api-domain`, tags `type:domain`, `scope:pact`, `runtime:edge`; dependency runtime duy nhất là `zod` cho validation schemas.

## Purpose

- Tập trung hình dạng dữ liệu Pact protocol (`HalResource`, `PactResponse`, `MatrixResponse`, `CanIDeployResponse`…) và ngữ nghĩa tổng hợp matrix mà cả route layer và application layer cùng đọc.
- Giữ tương thích Pact CLI: schema validation giữ nguyên regex/limit của upstream — name `[a-zA-Z0-9._-]` max 255, tag, branch cho phép `/`, sha 64-hex, environment name max 100 (mapping chi tiết trong [`UPSTREAM_MAPPING.md`](../../docs/applications/pact-broker/UPSTREAM_MAPPING.md)).

## Responsibilities

- **HAL** (`hal.ts`): `HalBuilder`, `getBaseUrl` — dựng link/resource của broker API.
- **Matrix summary** (`matrix-summary.ts`): `toSummaryRows`, `summarizeMatrix` — tri-state `deployable: boolean | null` của `can-i-deploy`; `matrix-row.ts`: `decorateMatrixRow`.
- **Kiểu protocol** (`types.ts`): HAL link/resource, pact content/response, verification result, matrix row/version, `CanIDeployResponse`, `PacticipantResponse`.
- **Validation** (`validation.ts`): `nameSchema`, `versionSchema`, `tagSchema`, `branchSchema`, `shaSchema`, `idSchema`, `parseId`, `environmentNameSchema`.

Consumer: `apps/pact-broker-api` (toàn bộ route group dưới `src/routes/`), `libs/pact-broker-api-application` (`can-i-deploy.ts`, `publish-pact.ts`), `libs/pact-broker-api-infrastructure` (`repo/matrix-repo.ts`).

## Boundaries

- Không import Nx project khác; không SQL, không HTTP framework (Hono), không Node builtin và không I/O.
- Không tự quyết nghĩa trị nghiệp vụ của `can-i-deploy`: quy tắc tri-state và fail-closed là nội dung của [`docs/domains/pact-broker/domain-model.md`](../../docs/domains/pact-broker/domain-model.md) §2.3 — thư viện chỉ tổng hợp và trả `deployable` đúng tri-state.

## Development

```bash
pnpm nx run @ecoma-io/pact-broker-api-domain:lint
pnpm nx run @ecoma-io/pact-broker-api-domain:typecheck   # tsc --build --emitDeclarationOnly
```

Entry công khai duy nhất là `src/index.ts` (`main` của package); thêm module mới đi kèm spec colocated và export tường minh qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/pact-broker-api-domain:test        # vitest — spec colocated trong src/
```

Spec colocated: `hal.spec.ts`, `matrix-summary.spec.ts`, `validation.spec.ts`.

## Related Documentation

- [`docs/domains/pact-broker/README.md`](../../docs/domains/pact-broker/README.md) — bounded context `pact-broker` với hai deploy unit.
- [`docs/domains/pact-broker/domain-model.md`](../../docs/domains/pact-broker/domain-model.md) — pact, verification, matrix, `can-i-deploy` tri-state, tenant/membership của broker.
- [`docs/applications/pact-broker/README.md`](../../docs/applications/pact-broker/README.md) — solution spec của deploy unit `pact-broker-api`.
- [`docs/applications/pact-broker/UPSTREAM_MAPPING.md`](../../docs/applications/pact-broker/UPSTREAM_MAPPING.md) — ánh xạ từng module upstream sang đích Ecoma.
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — dependency rule và Nx tag (§3, §6.3).
