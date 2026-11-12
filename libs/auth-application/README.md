# Auth Application

Tầng orchestration của authorization server `auth` (`@ecoma-io/auth-application`): thứ tự các bước của giao dịch uỷ quyền và phát hành token, tách khỏi HTTP handler và khỏi truy cập database. Thư viện giữ port `AuthStore` (truy cập `db-auth`) và port `AccountClient` (hỏi trạng thái `account`), để hai implementation nằm ngoài tầng này.

Nx project `@ecoma-io/auth-application`, tags `type:application`, `scope:auth`, `runtime:edge`. Dependency: `@ecoma-io/auth-domain` (luật thuần), `@ecoma-io/account-contracts` (union trạng thái của contract `status`), `@ecoma-io/auth-contracts`, `jose` (ký JWT ES256).

## Purpose

- Giữ **thứ tự** các bước là một phần của hợp đồng bảo mật: không lỗi nào được redirect trước khi `redirect_uri` được kiểm; `account` không trả lời được thì không phát hành token (fail-closed); grant hiện có phải phủ hết scope mới bỏ qua consent.
- Tách phần quyết định khỏi phần thực thi để unit test không cần Worker, database hay HTTP.

## Responsibilities

- **Giao dịch uỷ quyền** (`authorization-service.ts`): `beginAuthorization`, `confirmBrowser`, `completeAuthorization`, `exchangeAuthorizationCode`, `createOpaqueId`; hằng `TRANSACTION_TTL_MS` và `AUTHORIZATION_CODE_TTL_MS`; port `AuthStore` (tìm transaction theo băm handle X, CAS chuyển trạng thái) và port `AccountClient` (`verifySession`, `checkStatus` fail-closed).
- **Phát hành token** (`token-service.ts`): access token JWT tự chứa ký ES256 (`JWT_SIGNING_ALG`), refresh token opaque với trạng thái ở `db-auth`, `buildJwks`, `issueAccessToken`, `createRefreshToken`, trần `MAX_ACCESS_TOKEN_TTL_SECONDS = 900` bị từ chối khi vượt (độ trễ thu hồi của access token).
- **Test support** (`signing-key-test-support.ts`): dựng `SigningKeyProvider` bằng đường `jose` thật cho spec colocated; chỉ spec import, `tsconfig.lib.json` loại khỏi bundle.

Consumer hiện tại: `apps/auth` — `src/browser-handlers.ts`, `src/consent-handler.ts`, `src/session-verified-handler.ts`; `libs/auth-infrastructure` cài port `AuthStore` qua adapter `createAuthorizationStore`.

## Boundaries

- Không import infrastructure: cấm transitive theo tag trong `.oxlintrc.json`; adapter cần use case nên chiều `infrastructure → application` là chiều hợp lệ duy nhất.
- Không biết SQL, Hyperdrive hay binding; mọi I/O đi qua port, composition root ở `apps/auth`.
- Ngữ nghĩa giao thức (authorization transaction, consent, grant, token) canonical ở `docs/domains/auth/` và `docs/applications/auth/01-architecture.md` — thư viện hiện thực phần orchestration, không định nghĩa lại ngữ nghĩa.

## Development

```bash
pnpm nx run @ecoma-io/auth-application:lint
pnpm nx run @ecoma-io/auth-application:typecheck    # tsc --build --emitDeclarationOnly
```

Mã nguồn nằm dưới `src/`; thêm use case mới = thêm file và spec colocated, rồi export qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/auth-application:test         # vitest — spec colocated trong src/
```

Spec colocated: `authorization-service.spec.ts`, `token-service.spec.ts`.

## Related Documentation

- [`docs/applications/auth/01-architecture.md`](../../docs/applications/auth/01-architecture.md) — §5.1 luồng login/consent, §6 token validation và revocation, §6.2 mô hình verify của resource server.
- [`docs/domains/auth/README.md`](../../docs/domains/auth/README.md) — bounded context `auth`; [`domain-model.md`](../../docs/domains/auth/domain-model.md).
- [`libs/auth-domain/README.md`](../auth-domain/README.md) — luật thuần mà tầng này điều phối.
- [`libs/auth-infrastructure/README.md`](../auth-infrastructure/README.md) — adapter cài port `AuthStore`.
