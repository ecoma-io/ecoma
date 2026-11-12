# Auth Domain

Thư viện domain thuần của bounded context `auth` (`@ecoma-io/auth-domain`): cấu trúc handle X/Y/Z với domain separation, PKCE S256, policy redirect URI, state machine authorization transaction, phân tích authorization request, quyết định consent/grant, revocation policy, issuance policy theo trạng thái `account` và metadata signing key.

Thư viện **không** import Nx project nào ngoài `@ecoma-io/account-contracts` (type-only, cho union trạng thái của contract `status`), **không** SQL, **không** Node builtin, **không** I/O; mã hoá base64url và hash dùng Web API (`TextEncoder`), nên tag runtime là `runtime:edge`.

Nx project `@ecoma-io/auth-domain`, tags `type:domain`, `scope:auth`, `runtime:edge`.

## Purpose

- Tập trung các luật giao thức OAuth 2.0/OIDC mà `auth` phải giữ vào một thư viện thuần, tái sử dụng mà không kéo persistence hay transport.
- Entry công khai duy nhất là `src/index.ts` (`main` của package).

## Responsibilities

Exports công khai (từ `src/index.ts`):

- **Handle X/Y/Z**: `HANDLE_DOMAINS` (login-handoff, consent-continuation, authorization-code), `deriveHandle`, `hashHandle`, `assertHandleBelongsToTransaction`, `lengthPrefixed`, `timingSafeEqual`, `MIN_TRANSACTION_ID_LENGTH`, codec base64url (`handle.ts`) — domain separation giữa ba loại handle là bất biến, gộp chúng là mất state machine.
- **PKCE**: `assertValidCodeVerifier`, `computeS256Challenge`, `parseCodeChallenge`, `verifyCodeChallenge`, `SUPPORTED_CODE_CHALLENGE_METHOD` (`pkce.ts`).
- **Redirect URI**: `assertWellFormedRedirectUri`, `redirectUriMatches`, `LOOPBACK_HOSTS`, kiểu `RedirectUriPolicy` (`redirect-uri.ts`).
- **Authorization transaction**: state machine `AuthorizationTransactionState` với `canTransition`, `assertTransition`, `assertBrowserConfirmed`, `COMPLETABLE_STATES`, `isTerminal` (`transaction.ts`).
- **Authorization request**: `parseAuthorizationRequest`, `filterAllowedScopes`, `assertRegisteredRedirectUri`, `SUPPORTED_GRANT_TYPES`, `SUPPORTED_RESPONSE_TYPE` (`authorize-request.ts`).
- **Grant và consent**: `assertUsableClient`, `assertGrantCoversScope`, `needsConsent`, `isActiveClient`, `assessRiskLevel` (`grant.ts`).
- **Revocation và issuance**: `isIssuable`, `FAIL_CLOSED_ONLY_AT_ISSUANCE`, `assertRevocationCacheTtl` (`revocation.ts`); `allowsIssuance` — mọi trạng thái không phải `active` của contract `status` đều không cấp token (`issuance-policy.ts`).
- **Signing key**: `SIGNING_ALGORITHM`, `SIGNING_CURVE`, `SIGNING_KEY_TYPE` và port `SigningKeyProvider` mà infrastructure cài (`signing-key.ts`).
- **Domain errors**: `OAuthProtocolError`, `AuthConfigurationError`, `OAuthErrorCode` (`errors.ts`).

Consumer hiện tại: `apps/auth` — `src/config.ts`, `src/browser-handlers.ts`, `src/consent-handler.ts`, `src/oidc/interaction.ts`, `src/oidc/issuance-gate.ts`, `src/session-verified-handler.ts`; `libs/auth-application` và `libs/auth-infrastructure`.

## Boundaries

- Không persistence, không adapter transport, không mã hoá khoá ký thật — các lớp đó thuộc `apps/auth` và `libs/auth-infrastructure`.
- Không khai wire contract: shape message internal nằm ở `libs/auth-contracts`, envelope HMAC nằm ở `libs/internal-auth-contracts`.
- Ngữ nghĩa nghiệp vụ canonical của context `auth` (client registration, authorization transaction, consent, grant, vòng đời token) nằm ở `docs/domains/auth/` — thư viện hiện thực một phần tri thức đó bằng code.
- Type-only phụ thuộc `@ecoma-io/account-contracts`: union trạng thái trên wire của contract `status`, không phải logic của `account`.

## Development

```bash
pnpm nx run @ecoma-io/auth-domain:lint
pnpm nx run @ecoma-io/auth-domain:typecheck         # tsc --build --emitDeclarationOnly
```

Mã nguồn nằm dưới `src/`; thêm module mới = thêm file và spec colocated cạnh nó, rồi export qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/auth-domain:test              # vitest — spec colocated trong src/
```

Spec colocated: `handle.spec.ts`, `pkce.spec.ts`, `redirect-uri.spec.ts`, `authorize-request.spec.ts`.

## Related Documentation

- [`docs/domains/auth/README.md`](../../docs/domains/auth/README.md) — bounded context `auth`; [`domain-model.md`](../../docs/domains/auth/domain-model.md) — vòng đời authorization transaction, consent, grant, token.
- [`docs/applications/auth/01-architecture.md`](../../docs/applications/auth/01-architecture.md) — §5.1 luồng login/consent, §6 token validation và revocation.
- [`libs/auth-application/README.md`](../auth-application/README.md) — tầng orchestration tiêu thụ thư viện này.
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — §6.3 rule Nx theo scope, §3 dependency direction của chuỗi domain → application → infrastructure.
