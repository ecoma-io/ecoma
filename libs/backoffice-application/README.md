# Backoffice Application

Tầng use case của composition `backoffice` (`@ecoma-io/backoffice-application`): enforcement authorization tách khỏi `h3`/Nitro, luồng login-in-progress của BFF, cache displayName và gate onboarding — tất cả ở dạng thuần hoặc qua port, không phụ thuộc framework HTTP.

Nx project `@ecoma-io/backoffice-application`, tags `type:application`, `scope:backoffice`, `runtime:edge`. Dependency runtime duy nhất là `@ecoma-io/backoffice-domain` (policy thuần); `pg` nằm ở devDependencies cho shape `Pool` của port login flow.

## Purpose

- Giữ phần quyết định của BFF ở dạng test được không cần HTTP: `evaluatePermission` ném `AuthorizationDeniedError`/`AuthorizationUnavailableError` thay vì `createError`, còn wrapper `apps/backoffice/server/authorization.ts` map sang HTTP error.
- Khai port cho những thứ tầng application cần nhưng không sở hữu: audit, và store của luồng login.

## Responsibilities

- **Enforcement** (`authorization.ts`): `evaluatePermission` — checkpoint authorization của protected request; audit đi qua port `AuthorizationAuditPort`, lỗi audit propagate nguyên vẹn; kiểu `PrincipalAuthorization` (assignments + `actorSub`).
- **Port audit** (`authorization-audit-port.ts`): `AuthorizationAuditPort`, `AuthorizationAuditContext`, `DecisionAuditInput`, `AuthorizationFailureAuditInput`, `EnforcementDenialAuditInput` và hằng `AUTHORIZATION_AUDIT_ID_MAX_LENGTH = 128`, `AUTHORIZATION_FAILURE_INVALID_ACTOR`, `ENFORCEMENT_DENIAL_STALE_WRITE = 'stale_write_blocked'`.
- **Luồng login** (`login-flow.ts`): `state` + PKCE (S256) lưu server-side gắn cookie dùng một lần (`LOGIN_FLOW_COOKIE_NAME = '__Host-backoffice-login'`, `LOGIN_FLOW_TTL_SECONDS = 600`); `createFlowValue`, `codeChallenge`, `hashFlowIdentifier`, `insertLoginFlow`, `consumeLoginFlow`, `loginFlowCookie`, `clearLoginFlowCookie`.
- **Cache displayName** (`display-name-cache.ts`): `DISPLAY_NAME_CACHE_TTL_SECONDS = 120`, `cachedDisplayName`, `storeDisplayNames`, `resetDisplayNameCacheForTests`.
- **Gate onboarding** (`onboarding.ts`): `needsDisplayName` — `true` khi sub của phiên chưa có displayName (entry `displayName: null` hoặc không có row profile); gate không đọc trạng thái nào khác và không cứng route.

Consumer hiện tại: `apps/backoffice` — `server/authorization.ts`, `server/api/auth/login.get.ts`, `server/api/auth/callback.get.ts`, `server/api/me.get.ts`, `server/api/onboarding-status.get.ts`, `server/api/staff.get.ts`; `libs/backoffice-infrastructure` cài `AuthorizationAuditPort`.

## Boundaries

- Không import `@ecoma-io/backoffice-infrastructure`: `type:application` bị cấm phụ thuộc `type:infrastructure` — implementation thật của audit nằm ở infrastructure và chỉ được biết qua interface.
- Không chứa HTTP handler, cookie framework hay Nuxt — mapping sang HTTP và route thuộc `apps/backoffice`.
- Không sở hữu nghiệp vụ staff/RBAC: policy thuần nằm ở `@ecoma-io/backoffice-domain`, canonical ở `docs/domains/staff-access/`.

## Development

```bash
pnpm nx run @ecoma-io/backoffice-application:lint
pnpm nx run @ecoma-io/backoffice-application:typecheck   # tsc --build --emitDeclarationOnly
```

Mã nguồn nằm dưới `src/`; thêm use case mới = thêm file và spec colocated, rồi export qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/backoffice-application:test      # vitest — spec colocated trong src/
```

Spec colocated: `login-flow.spec.ts`, `display-name-cache.spec.ts`, `onboarding.spec.ts`.

## Related Documentation

- [`docs/applications/backoffice/01-architecture.md`](../../docs/applications/backoffice/01-architecture.md) — §2.1 onboarding staff và gate displayName, §7 execution/failure model.
- [`docs/applications/backoffice/README.md`](../../docs/applications/backoffice/README.md) — component doc của composition `backoffice`.
- [`libs/backoffice-domain/README.md`](../backoffice-domain/README.md) — policy thuần mà tầng này áp dụng.
- [`libs/backoffice-infrastructure/README.md`](../backoffice-infrastructure/README.md) — adapter cài `AuthorizationAuditPort`.
