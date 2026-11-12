# Backoffice Infrastructure

Adapter của composition `backoffice` (`@ecoma-io/backoffice-infrastructure`): đọc binding Hyperdrive `DB_BACKOFFICE` và dựng pool `pg`, store phiên BFF, verify access token của `auth`, client sang hai service nội bộ (`account`, `staff-access`) và đường ghi/đọc authorization audit.

Nx project `@ecoma-io/backoffice-infrastructure`, tags `type:infrastructure`, `scope:backoffice`, `runtime:edge`. Dependency: `@ecoma-io/backoffice-application` (cài port audit), `@ecoma-io/backoffice-domain`, `@ecoma-io/account-contracts`, `@ecoma-io/internal-auth-contracts`, `@ecoma-io/staff-access-contracts`, `pg`, `jose`.

## Purpose

- Tập trung mọi chạm hạ tầng của BFF vào một lib framework-agnostic: module nhận giá trị đã đọc (env của Worker, connection string) từ caller thay vì đọc biến toàn cục, nên composition root giữ nguyên ở `apps/backoffice` (`server/db.ts`).
- Hiện thực port `AuthorizationAuditPort` của tầng application bằng đường ghi thật trên `db-backoffice`.

## Responsibilities

- **Pool Hyperdrive** (`hyperdrive-pool.ts`): `DB_BACKOFFICE_BINDING = 'DB_BACKOFFICE'`, `backofficeHyperdrive` kiểm hình dạng binding từ `env` dưới dạng `unknown` (trả `null` khi thiếu/sai — caller fail closed), `createPool`/`withBackofficePool`, `attachPoolErrorHandler`, `buildPoolOptions`.
- **Đọc dữ liệu** (`queries.ts`): `listPermissions`, `listRoles`, `listStaff`, `loadPrincipalAuthorization`, `loadPrincipalAuthorizationProjection` — SQL đọc authorization projection và dữ liệu read route từ `db-backoffice`.
- **Audit** (`authorization-audit.ts`): `recordDecision`, `recordAuthorizationFailure`, `recordPrivilegedSuccess`, `recordStaleWriteDenial`, `listAuthorizationAudit`; re-export type audit từ `@ecoma-io/backoffice-application` vì hợp đồng audit thuộc tầng enforcement.
- **Phiên BFF** (`auth/session-store.ts`): bảng `backoffice.bff_sessions`, cookie chỉ mang session ID (entropy 256-bit, base64url), DB giữ token set với `id_hash = SHA-256(id)`; `SESSION_COOKIE_NAME`, `SESSION_ABSOLUTE_SECONDS`, `SESSION_IDLE_SECONDS`, `SESSION_ID_BYTES`, CSRF double-submit (`CSRF_COOKIE_NAME`, `CSRF_HEADER_NAME`, `createCsrfToken`, `csrfMatches`), `insertSession`, `loadSessionByHash`, `touchSession`, `revokeSessionByHash`, `replaceAccessToken`, `sessionDeadlines`, `isSessionLive`.
- **Verify token** (`auth/jwks.ts`, `auth/verify.ts`): JWKS client cache theo TTL với re-fetch khi gặp `kid` lạ (một verify sai không bao giờ được gây ra bởi cache), `verifyAccessToken` trả ba class kết quả — `VerifiedAccessToken`/`InvalidTokenResult`/`UnavailableTokenResult`.
- **Client service nội bộ** (`account/client.ts`, `staff-access/client.ts`): `fetchAccountProfiles` qua binding `ACCOUNT_SERVICE` và `fetchStaffDirectory`/`fetchRoleCatalog`/`fetchPermissionCatalog`/`fetchStaffEntitlements`/`fetchStaffAssignments`/`fetchAuditEntries` qua binding `STAFF_ACCESS_SERVICE`; ký envelope HMAC qua `@ecoma-io/internal-auth-contracts`, validate response bằng `validateAccountProfilesResponse` của `@ecoma-io/account-contracts`; trả discriminated result thay vì ném, chế độ fail-closed hay degrade do caller quyết.

Consumer hiện tại: `apps/backoffice` — `server/db.ts`, `server/api/` (audit, auth login/callback/logout, entitlements, me, staff), `nuxt.config.ts` (alias), tests dưới `tests/integrations/`.

## Boundaries

- Không chứa route hay middleware HTTP — `apps/backoffice` đọc `env` ra khỏi `H3Event` và gọi lib.
- Không sở hữu nghiệp vụ staff/RBAC: dữ liệu staff/role/permission được đọc qua contract của `staff-access`, không qua database của context khác.
- Không định nghĩa envelope HMAC — ký và verify qua `@ecoma-io/internal-auth-contracts`; validate response qua `@ecoma-io/account-contracts`.

## Development

```bash
pnpm nx run @ecoma-io/backoffice-infrastructure:lint
pnpm nx run @ecoma-io/backoffice-infrastructure:typecheck  # tsc --build --emitDeclarationOnly
```

Mã nguồn nằm dưới `src/`; migration SQL của `db-backoffice` thuộc `apps/backoffice/db/`, không thuộc lib này.

## Testing

```bash
pnpm nx run @ecoma-io/backoffice-infrastructure:test      # vitest — spec colocated trong src/
```

Spec colocated: `hyperdrive-pool.spec.ts`, `queries.spec.ts`, `auth/session-store.spec.ts`, `auth/jwks.spec.ts`, `auth/verify.spec.ts`, `account/client.spec.ts`, `staff-access/client.spec.ts`; hành vi trên PostgreSQL thật là phạm vi integration suite app-owned của `apps/backoffice`.

## Related Documentation

- [`docs/applications/backoffice/01-architecture.md`](../../docs/applications/backoffice/01-architecture.md) — §4 integrations và adapters, §5 persistence implementation, §6 runtime security.
- [`docs/applications/backoffice/README.md`](../../docs/applications/backoffice/README.md) — component doc của composition `backoffice`.
- [`libs/backoffice-application/README.md`](../backoffice-application/README.md) — port audit mà lib này hiện thực.
- [`libs/account-contracts/README.md`](../account-contracts/README.md) — contract `profiles` mà client `account` tiêu thụ.
- [`apps/backoffice/db/README.md`](../../apps/backoffice/db/README.md) — schema và migration của `db-backoffice`.
