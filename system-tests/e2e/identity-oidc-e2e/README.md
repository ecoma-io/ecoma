# Identity OIDC E2E

Suite system test (`@ecoma-io/identity-oidc-e2e`) verify năng lực **bề mặt giao thức OAuth 2.0/OIDC** của deploy unit `auth` trên stack local đang chạy thật: discovery document, JWKS, authorize glue, token, revocation, refresh rotation và RP-initiated logout — cùng luồng browser authorize → OTP login → consent → token đi qua `account`.

Theo `docs/architecture/06-testing.md` §3, đây là **system test** — verify cả hệ thống nhiều deploy unit, không phải test của một app đơn lẻ; suite nằm dưới `system-tests/e2e/` với project config, setup, support riêng (§2). Nx tags `type:tooling`, `scope:auth`, `runtime:native`.

## Purpose

- Chứng minh bề mặt protocol của issuer OIDC đang chạy thật trả đúng contract: discovery document khớp cấu hình ECOMA, JWKS chỉ công bố khoá công khai ES256, ranh giới redirectable/non-redirectable của `/authorize` đúng như thiết kế chống open redirect.
- Chứng minh vòng đời grant thật: authorization code single-use, refresh token rotation kèm reuse detection thu hồi cả family, revocation endpoint RFC 7009.
- Chứng minh luồng browser end-to-end: authorize của `auth` → trang login OTP của `account` → consent → callback → đổi code lấy token, verify chữ ký JWT bằng JWKS công bố.

## Responsibilities

- **`protocol-surface.spec.ts`** — discovery document dưới issuer động và ở path RFC 8414 (hai path trả cùng một document); JWKS công bố khoá ES256 trên EC P-256, không có private material, `kid` duy nhất; `GET /session/end` trả form confirm với `xsrf` và action `/session/end/confirm`, không rơi vào ranh giới 4xx.
- **`negative-paths.spec.ts`** — lỗi không redirectable của `/authorize` trả JSON trực tiếp (`invalid_request` khi thiếu `response_type`/`code_challenge`/`code_challenge_method`, `response_type` không hỗ trợ, `redirect_uri` không đúng đăng ký, scope rỗng; `invalid_client` khi `client_id` lạ); lỗi redirectable (scope không được phép) redirect ngược kèm `error=invalid_scope` và echo `state`; token endpoint từ chối code lạ (`invalid_grant`), grant `client_credentials`, PKCE verifier sai; revocation từ chối thiếu định danh client và trả 200 cho token lạ.
- **`oidc-browser-flow.spec.ts`** — luồng browser đầy đủ: `/authorize` (glue) → `/auth` (provider) → trang login OTP của `account` → hop `/authorize/confirm` → handoff → consent → callback (code bị bắt, không để backoffice tiêu thụ) → `POST /token`, verify `id_token` và access token bằng `jose` với JWKS công bố.
- **`refresh-rotation.spec.ts`** — refresh token lần đầu trả token mới; dùng lại token cũ trả `invalid_grant` và thu hồi cả family kể cả token mới nhất; `POST /revocation` với refresh token sống làm lần refresh sau thất bại.
- **Stack gate fail-closed** (`global-setup.ts`): probe `GET /.well-known/openid-configuration` phải 200 JSON với `issuer` bằng đúng origin `https://auth.<host>:<port>` của request — lệch là stack của worktree khác; stack không reachable là kết quả đỏ, không bao giờ skip.
- **Fixture layer** (`e2e/support/local-origin.ts`): seed user verified idempotent vào `db-account` qua `docker exec psql` (không có signup API — fixturization qua dữ liệu), đọc OTP từ mail sink D1 trong container mail-wic, tự dò namespace Docker của worktree qua `docker ps`.

## Boundaries

- Suite không chạm app `backoffice` như một RP: redirect_uri đăng ký trỏ về `office.<host>`, browser tới đó và bị BFF từ chối 401 — code không bị tiêu thụ, test là RP của riêng mình. `backoffice-deploy` chỉ là prerequisite của hành vi đó.
- Truy cập nội bộ stack qua Docker CLI chỉ dành cho hai khả năng protocol công khai không cung cấp: seed user và đọc mail sink; mọi assertion flow đi qua Traefik như black-box.
- Dữ liệu: seed idempotent theo `sub`/`address_hash`; suite không có bước cleanup — user fixture, OTP challenge và grant còn lại trong `db-account`/`db-auth` cho tới khi stack local bị dọn.

## Development

- Thêm spec mới: dùng `stackGet`/`stackPostForm` cho assertion API thuần (Node `https` với `ca` scoped — `request` fixture của Playwright không nhận `ca`), `page` chỉ khi cần browser thật.
- Test browser có OTP delivery nên tự nâng timeout (`test.setTimeout`) — timeout chung của config là 60s.
- `playwright.config.ts` không throw khi thiếu `ROOT_DOMAIN`/`ROOT_HOST` — trả origin `.invalid` vô hại (origin không thể route); fail-closed thật nằm ở `global-setup.ts` với message nêu remedy.
- Mỗi test tạo email riêng (`Date.now()`) để không va chạm rate limit OTP của `account`.

## Testing

Target canonical là `system-test` (`docs/architecture/06-testing.md` §4), suite tự định nghĩa thực thi; `cache: false` có chủ đích — stack local là external state sống ngoài inputs của Nx.

```bash
pnpm nx run @ecoma-io/identity-oidc-e2e:system-test -c local
```

- `dependsOn` kéo `local-up` của đúng năm deploy project mà suite phụ thuộc (`platform-deploy`, `auth-deploy`, `account-deploy`, `backoffice-deploy`, `transactional-mail-deploy`) trước khi Playwright chạy — một invocation tự dựng đủ stack; `-c local` lan configuration vào task prerequisite.
- Prerequisites: các deploy unit trên đang up; `ROOT_DOMAIN`/`ROOT_HOST` qua env hoặc `.env` repo root (platform `local-up` ghi giá trị); cert local `deploys/platform-deploy/local-certs/fbi.com.crt`; client `ecoma-backoffice-local` với redirect_uri `office.<host>` do chính `local-up` của `auth` seed.
- 21 test trong 4 file spec.
- Các suite system-test dùng chung một local stack — chạy batch với `--parallel=1` (§4).

## Related Documentation

- [`docs/architecture/06-testing.md`](../../../docs/architecture/06-testing.md) — taxonomy (§3), canonical targets, selection và prerequisite (§4).
- [`docs/features/identity/oidc-application-access.md`](../../../docs/features/identity/oidc-application-access.md) — capability mà suite verify trên hệ thống chạy thật.
- [`docs/applications/auth/README.md`](../../../docs/applications/auth/README.md) — thiết kế component của issuer OIDC.
- [`docs/domains/auth/README.md`](../../../docs/domains/auth/README.md) — ngữ nghĩa nghiệp vụ của context `auth`.
- [`docs/architecture/local-development/02-account-auth-topology.md`](../../../docs/architecture/local-development/02-account-auth-topology.md) — topology account/auth mà suite đi qua.
- Suite cùng nhóm: [`identity-login-e2e`](../identity-login-e2e/), [`home-public-e2e`](../home-public-e2e/), [`backoffice-access-control-e2e`](../backoffice-access-control-e2e/).
