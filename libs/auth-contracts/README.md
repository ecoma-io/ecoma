# Auth Contracts

Contract surface mà provider `auth` **publish** cho consumer của nó: shape wire của `POST /internal/session/verified`, `POST /internal/consent/context`, `POST /internal/consent/decide`, `POST /internal/connected-applications` và `POST /internal/connected-applications/revoke`. Provider là `auth`; consumer thật là `account`.

Lib này **không** import Nx project nào ngoài `@ecoma-io/internal-auth-contracts`, **không** có domain logic và **không** import `@ecoma-io/auth-domain` — constraint `type:contracts` trong `.oxlintrc.json` cấm phụ thuộc `type:domain` (kể cả transitive). Giá trị trên wire được khai báo độc lập tại đây; ví dụ mảng ACR URN được mirror từ tầng domain và được canh bằng parity test — lệch nhau là test đỏ.

Nx project `@ecoma-io/auth-contracts`, tags `type:contracts`, `scope:auth`, `runtime:universal`.

## Purpose

- Là bản publish duy nhất của các contract internal mà `auth` phục vụ cho `account`, để phía BFF phụ thuộc contract thay vì vào handler của provider.
- Ngăn substitution: payload của mỗi contract được khai đủ chặt để không còn chỗ thêm trường authorization mà không sửa contract.

## Responsibilities

- **`session-verified.ts`** — contract `POST /internal/session/verified`: `SessionVerifiedRequest` đúng sáu trường (`handle`, `sub`, `acr`, `authn_at`, `account_session_ref`, `event_id`), `REQUIRED_SESSION_VERIFIED_FIELDS` và `FORBIDDEN_SESSION_VERIFIED_FIELDS` chặn nhóm tham số authorization, `ACR_URN_VALUES`, `validateSessionVerifiedRequest`.
- **`consent.ts`** — nhóm contract consent và connected applications: `ConsentContextRequest`/`Response`, `ConsentDecision` (`approve` | `deny`), `ConsentDecideRequest`/`Response`, `ConnectedApplicationsRequest`/`Response` với `ConnectedApplicationGrant` (trong đó `id` là định danh công khai do `auth` cấp), `ConnectedApplicationRevokeRequest`.
- **`index.ts`** — barrel export; re-export giao thức envelope HMAC từ `@ecoma-io/internal-auth-contracts` cho caller và callee của contract `auth`.

Consumer hiện tại: `apps/auth` (`src/session-verified-handler.ts`, `src/consent-handler.ts`, `src/connected-applications-handler.ts`, `src/account-client.ts`), `apps/account` (`server/lib/auth-client.ts`, `server/lib/bff-session.ts`, `server/api/consent/`, `server/api/applications/index.get.ts`, `server/api/auth/handoff.post.ts`).

## Boundaries

- Không chứa policy nghiệp vụ của authorization transaction — quyết định consent, vòng đời grant và token thuộc `auth` (`docs/domains/auth/`).
- Không khai lại envelope HMAC: bản cài đặt canonical thuộc `@ecoma-io/internal-auth-contracts` (`scope:platform`).
- Consumer khác scope chỉ được chạm contract của scope khác, không import implementation (`docs/architecture/05-code-architecture.md` §6.3).

## Development

```bash
pnpm nx run @ecoma-io/auth-contracts:lint
pnpm nx run @ecoma-io/auth-contracts:typecheck
```

Mã nguồn nằm dưới `src/`; entry công khai duy nhất là `src/index.ts` (`main` của package).

## Testing

```bash
pnpm nx run @ecoma-io/auth-contracts:test           # vitest — spec colocated trong src/
```

Spec colocated: `session-verified.spec.ts` kiểm validator và nhóm trường bị cấm của contract `session/verified`.

## Related Documentation

- [`docs/applications/auth/01-architecture.md`](../../docs/applications/auth/01-architecture.md) — §5.1 luồng completion, §5.1.7 consent context, §5.1.8 envelope nội bộ.
- [`docs/domains/auth/README.md`](../../docs/domains/auth/README.md) — bounded context `auth`.
- [`libs/internal-auth-contracts/README.md`](../internal-auth-contracts/README.md) — envelope HMAC dùng chung.
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — §4 contracts (provider-owned, độc lập với implementation).
- [`apps/account/README.md`](../../apps/account/README.md) — consumer chính của các contract này.
