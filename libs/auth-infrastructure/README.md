# Auth Infrastructure

Adapter truy cập `db-auth` và khoá ký ES256 của authorization server `auth` (`@ecoma-io/auth-infrastructure`): store transaction/code/grant/client/revocation/audit trên PostgreSQL, brand type chống nhầm pool, và cài đặt port `SigningKeyProvider` của `auth-domain`.

Nx project `@ecoma-io/auth-infrastructure`, tags `type:infrastructure`, `scope:auth`, `runtime:edge`. Dependency: `@ecoma-io/auth-application` (port `AuthStore` cần hiện thực), `@ecoma-io/auth-domain`, `@ecoma-io/internal-auth-contracts`, `postgres` (postgres.js), `jose` — chiều `infrastructure → application` là chiều hợp lệ theo bảng dependency của `docs/architecture/05-code-architecture.md` §3.

## Purpose

- Hiện thực port `AuthStore` của tầng application bằng SQL thật trên `db-auth`, để orchestration giữ nguyên thuần khiết.
- Nạp private key PKCS#8 qua `jose` theo ba luật bắt buộc: không sinh ephemeral key lúc startup, thiếu secret thì fail-closed (không cấp token), private key không xuất hiện trong log/JWKS/config — `db-auth` chỉ giữ metadata khoá.

## Responsibilities

- **Transaction và code** (`authorization-transaction-store.ts`, `authorization-code-cas.ts`): insert/tìm theo băm handle, chuyển trạng thái có điều kiện, redeem authorization code dạng CAS — hai request cùng "hoàn tất" là bất khả thi ở tầng SQL.
- **Adapter** (`auth-store-adapter.ts`): `createAuthorizationStore` dựng `AuthStore` từ các store của lib cho pool của isolate.
- **Grant, client, revocation, audit** (`oauth-grant-store.ts`, `oauth-client-store.ts`, `token-revocation-store.ts`, `authorization-audit-store.ts`): tìm grant active, client đã đăng ký, kiểm revocation tại điểm phát hành, ghi audit.
- **PostgreSQL** (`postgres.ts`): brand `PostgresClientLike` bằng `unique symbol` để kho nonce không thể nhận một pool sai hình dạng; kiểm nonce-expiry từ `@ecoma-io/internal-auth-contracts`.
- **Signing key** (`signing-key.ts`): class `SigningKeyProvider` — bản cài đặt tham chiếu của port trong `auth-domain`.

Consumer hiện tại: `apps/auth` — `src/main.ts`, `src/oidc/adapter.ts`, `src/oidc/provider.ts`, `src/oidc/runtime.ts`, `src/oidc/issuance-gate.ts`, `src/connected-applications-handler.ts` và các integration suite dưới `tests/integrations/`.

## Boundaries

- Không chứa orchestration hay handler HTTP — thứ tự bước thuộc `libs/auth-application`, mapping sang HTTP thuộc `apps/auth`.
- Không định nghĩa wire contract; xác thực request nội bộ đi qua `libs/internal-auth-contracts`.
- Chỉ chạm `db-auth` — database của scope khác không thuộc adapter này.

## Development

```bash
pnpm nx run @ecoma-io/auth-infrastructure:lint
pnpm nx run @ecoma-io/auth-infrastructure:typecheck  # tsc --build --emitDeclarationOnly
```

Mã nguồn nằm dưới `src/`; migration SQL của `db-auth` thuộc `apps/auth/migrations/`, không thuộc lib này.

## Testing

```bash
pnpm nx run @ecoma-io/auth-infrastructure:test       # vitest — spec colocated trong src/
```

Spec colocated: `postgres.spec.ts`, `signing-key.spec.ts`; hành vi trên PostgreSQL thật là phạm vi của integration suite app-owned (`apps/auth/tests/integrations/`).

## Related Documentation

- [`docs/applications/auth/01-architecture.md`](../../docs/applications/auth/01-architecture.md) — §3 data model `db-auth` (single-use, signing key metadata), §5.1.8 envelope nội bộ.
- [`docs/applications/auth/README.md`](../../docs/applications/auth/README.md) — deploy unit `auth`, Hyperdrive → `db-auth`.
- [`libs/auth-application/README.md`](../auth-application/README.md) — port `AuthStore` mà lib này hiện thực.
- [`docs/domains/auth/domain-model.md`](../../docs/domains/auth/domain-model.md) — vòng đời code/grant/token mà store phục vụ.
