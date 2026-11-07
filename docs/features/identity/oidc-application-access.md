# Truy cập application qua OIDC

> **Product area:** `identity/` · **Mô tả một dòng:** người dùng đăng nhập một lần rồi cấp quyền cho một application, application nhận token để gọi API thay mặt họ.
>
> Đặc tả domain → [`domains/auth/`](../../domains/auth/README.md) · [`domains/account/`](../../domains/account/README.md) · quy tắc viết → [`../README.md`](../README.md).

## 1. Problem

Mỗi application nội bộ tự quản lý đăng nhập và mật khẩu riêng. Người dùng phải đăng nhập lại ở từng application, quản trị viên phải thu hồi quyền ở từng nơi, và không có cách nào để người dùng thấy application nào đang có quyền truy cập dữ liệu của mình.

Application cũng cần một cách lấy token đáng tin thay mặt người dùng mà không phải tự xử lý mật khẩu hay session.

## 2. Outcome

Một authorization server OIDC độc lập cấp quyền cho các application.

- Application chuyển browser của người dùng tới authorization server; người dùng **luôn** phải đăng nhập lại tại đó, kể cả khi đã có session ở nơi khác. Application không thể im lặng lấy quyền.
- Trước khi cấp quyền, người dùng thấy tên application, danh sách quyền application yêu cầu và cảnh báo khi quyền đó rủi ro cao.
- Người dùng từ chối được; khi đó application nhận tín hiệu từ chối thay vì một trang lỗi.
- Application nhận access token, ID token và refresh token. Refresh token được xoay vòng sau mỗi lần dùng; dùng lại refresh token cũ làm mất hiệu lực toàn bộ chuỗi token của lần cấp quyền đó.
- Tài khoản bị treo giữa chừng không nhận được token, dù đã đăng nhập thành công ở bước trước.
- Người dùng thấy danh sách application đã cấp quyền và thu hồi được từng application; token của application bị thu hồi mất hiệu lực.
- Application tra cứu được cấu hình discovery và public key để tự xác minh token.

## 3. Scope

### Bao gồm

- Authorization Code Flow với PKCE `S256` bắt buộc; chỉ hỗ trợ response type `code`; client là public client.
- Authorization request được validate trước khi redirect (client, redirect URI, PKCE, scope); lỗi trước ranh giới redirect trả JSON, lỗi sau đó redirect kèm `error` và `state` gốc.
- Bắt buộc đăng nhập tại authorization server cho mọi lượt authorization, kể cả khi đã có session.
- Màn hình consent hiển thị tên application, quyền theo từng scope và cảnh báo rủi ro cao; approve và deny đều được ghi nhận.
- Cấp access token, ID token (mang `sub`, `acr`, `auth_time`, `nonce`) và refresh token; authorization code dùng một lần.
- Refresh token rotation và reuse detection ở cấp token family.
- Revocation endpoint (RFC 7009) và end-session endpoint.
- Discovery document (`/.well-known/openid-configuration`, kèm biến thể RFC 8414) và JWKS chỉ chứa public key ES256.
- Danh sách connected applications và thu hồi grant; thu hồi grant, đánh dấu token bị revoke và ghi audit trong cùng một transaction.
- State của provider lưu trong PostgreSQL, không phụ thuộc node-local state.

### Không bao gồm

- **Không có đăng ký client qua UI hay API.** Client được seed lúc deploy, chỉ client `public` và `active` trong database mới dùng được; provider dựng lỗi ở request đầu tiên nếu không có client public nào. Tự đăng ký application là capability chưa có.
- **Tên application trên màn hình consent hiện là `client_id`, không phải tên hiển thị.** Danh sách connected applications thì hiển thị tên thật. Đây là hành vi hiện tại, không phải hành vi mong muốn.
- **Không có userinfo endpoint và không có introspection.** Discovery document chỉ quảng bá những gì được hỗ trợ.
- **Không hỗ trợ `client_credentials` hay implicit flow.**
- **Không có silent SSO.** Mỗi lượt authorization đều bắt buộc đăng nhập. Màn hình consent chỉ xuất hiện khi chưa có grant đang hiệu lực bao phủ trọn scope được yêu cầu; một grant còn hiệu lực và đủ scope thì lượt authorization đi thẳng tới bước cấp code.
- **`GET /authorize/complete` không tồn tại.** Route này được nhắc trong một số tài liệu domain và comment cũ; hiện trả 404 và có unit test khẳng định điều đó. Việc hoàn tất giao dịch do provider resume, không qua route đó.
- Đăng nhập bằng email OTP thuộc [Đăng nhập bằng email OTP](./email-otp-sign-in.md); Feature này bắt đầu từ lúc application khởi tạo authorization request.
- Badge `highRisk` trên trang connected applications luôn là `false` trong adapter thật.

## 4. Acceptance Scenarios

```text
Cho  một client đã đăng ký, có redirect URI và PKCE challenge
Khi  browser mở authorization endpoint
Thì  browser được chuyển tới trang đăng nhập của account cho giao dịch đó,
     và một cookie gắn giao dịch với browser được đặt
```

```text
Cho  người dùng đã có session hợp lệ
Khi  bắt đầu một authorization request mới
Thì  vẫn phải xác nhận đăng nhập — session sẵn có không tự động cấp quyền
```

```text
Cho  authorization request có client hoặc redirect URI không hợp lệ
Khi  request được gửi
Thì  không có redirect nào tới client; lỗi được trả trước ranh giới redirect
```

```text
Cho  authorization request yêu cầu scope mà client không được phép
Khi  request được gửi
Thì  browser được redirect về client với `error=invalid_scope` và `state` gốc
```

```text
Cho  người dùng đã đăng nhập đang ở màn hình consent
Khi  màn hình hiển thị
Thì  thấy tên application, danh sách quyền được yêu cầu, và cảnh báo khi quyền rủi ro cao
```

```text
Cho  người dùng chọn approve
Khi  quyết định được gửi
Thì  browser quay lại redirect URI đã đăng ký kèm authorization code, `state` gốc và `iss`
```

```text
Cho  người dùng chọn deny
Khi  quyết định được gửi
Thì  browser quay lại client với `access_denied` và `state` gốc, không có grant nào được tạo
```

```text
Cho  một authorization code hợp lệ kèm code verifier
Khi  client gọi token endpoint
Thì  nhận access token, ID token mang `sub`/`acr`/`auth_time`/`nonce`, và refresh token
```

```text
Cho  authorization code đã được đổi thành token
Khi  đổi lại lần nữa
Thì  bị từ chối với `invalid_grant`
```

```text
Cho  một refresh token hợp lệ
Khi  dùng nó
Thì  nhận refresh token mới và refresh token cũ ngừng hoạt động
```

```text
Cho  một refresh token đã bị xoay vòng
Khi  trình lại giá trị cũ
Thì  bị từ chối và toàn bộ token family bị thu hồi, kể cả refresh token hiện hành
```

```text
Cho  access token hoặc refresh token đang có hiệu lực
Khi  gửi tới revocation endpoint
Thì  request thành công và refresh token đó không dùng được nữa
```

```text
Cho  tài khoản bị treo giữa lúc đăng nhập và lúc cấp token
Khi  hệ thống chuẩn bị cấp token
Thì  việc cấp token bị từ chối
```

```text
Cho  người dùng đã cấp quyền cho một số application
Khi  mở danh sách connected applications và thu hồi một application
Thì  mục đó biến mất và token của application đó ngừng hoạt động
```

```text
Cho  một client đọc discovery document và JWKS
Khi  nó đọc
Thì  discovery chỉ quảng bá capability được hỗ trợ, và JWKS chỉ chứa public key ES256 với `kid` duy nhất
```

## 5. Domain & Application Mapping

| Domain / Application        | Vai trò trong Feature                                                                                                 | Canonical                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `auth` (bounded context)    | Sở hữu authorization server: client registry, authorization transaction, grant, token, revocation; database `db-auth` | [`domains/auth/`](../../domains/auth/README.md)                                            |
| `account` (bounded context) | Sở hữu đăng nhập và session; quyết định consent UI đọc context qua `auth`                                             | [`domains/account/`](../../domains/account/README.md)                                      |
| `apps/auth`                 | Deploy unit của authorization server (issuer `https://auth.ecoma.io`)                                                 | [`applications/auth/01-architecture.md`](../../applications/auth/01-architecture.md)       |
| `apps/account`              | Deploy unit phục vụ trang `/login`, `/login/continue`, `/consent` và trang `/applications`                            | [`applications/account/01-architecture.md`](../../applications/account/01-architecture.md) |
| `libs/auth-*`               | Domain, application, infrastructure của context `auth` — provider glue, transaction store, grant store                | [`05-code-architecture.md`](../../architecture/05-code-architecture.md) §6.3               |

`account` không tự cấp quyền: nó chuyển kết quả xác thực đã ký sang `auth` qua internal contract, và `auth` mới là bên phát token.

## 6. Verification Mapping

Ba tầng tồn tại: unit, integration app-owned (PostgreSQL thật) và system test trên stack local thật — trong đó chỉ `oidc-browser-flow.spec.ts` điều khiển browser thật.

| Scenario                                                                                                              | Test file / suite                                                                                                                                        | Loại test                                               | Nx target          |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------ |
| Luồng authorize → login → consent → token, cả approve và deny                                                         | `apps/auth/tests/integrations/oidc-fullflow.spec.ts`                                                                                                     | integration                                             | `test-integration` |
| Authorization code dùng một lần dưới tranh chấp đồng thời                                                             | `apps/auth/tests/integrations/authorization-code-cas.spec.ts`                                                                                            | integration                                             | `test-integration` |
| Discovery document và entrypoint theo tài liệu được quảng bá                                                          | `apps/auth/tests/integrations/discovery-entrypoint.spec.ts`                                                                                              | integration                                             | `test-integration` |
| Issuance gate, gate wiring, adapter state                                                                             | `apps/auth/tests/integrations/oidc-issuance-gates-coverage.spec.ts`, `oidc-runtime-gate.spec.ts`, `issuance-gate-wiring.spec.ts`, `oidc-adapter.spec.ts` | integration                                             | `test-integration` |
| Tài khoản bị treo hoặc đổi trạng thái giữa luồng                                                                      | `apps/auth/tests/integrations/oidc-midflow-suspension.spec.ts`, `mid-flow-state-change.spec.ts`                                                          | integration                                             | `test-integration` |
| Handoff session-verified, consent context/decide, replay                                                              | `apps/auth/tests/integrations/internal-handlers.spec.ts`                                                                                                 | integration                                             | `test-integration` |
| End-session                                                                                                           | `apps/auth/tests/integrations/oidc-end-session.spec.ts`                                                                                                  | integration                                             | `test-integration` |
| Connected applications list/revoke                                                                                    | `apps/auth/tests/integrations/connected-applications-handler.spec.ts`                                                                                    | integration                                             | `test-integration` |
| Luồng browser đầy đủ: authorize, login form, OTP, continue, consent, callback, token, xác minh JWT bằng JWKS, refresh | `system-tests/e2e/identity-oidc-e2e/e2e/oidc-browser-flow.spec.ts`                                                                                       | system E2E (browser thật)                               | `system-test`      |
| Discovery, JWKS, end-session trên stack thật                                                                          | `system-tests/e2e/identity-oidc-e2e/e2e/protocol-surface.spec.ts`                                                                                        | system E2E (API)                                        | `system-test`      |
| Rotation, reuse detection, revocation                                                                                 | `system-tests/e2e/identity-oidc-e2e/e2e/refresh-rotation.spec.ts`                                                                                        | system E2E (browser để lấy grant, API cho phần còn lại) | `system-test`      |
| Client/redirect/scope/code sai                                                                                        | `system-tests/e2e/identity-oidc-e2e/e2e/negative-paths.spec.ts`                                                                                          | system E2E (API)                                        | `system-test`      |
| Trạng thái UI của trang consent                                                                                       | `apps/account/app/pages/consent.spec.ts`                                                                                                                 | unit/component                                          | `test`             |

**Giới hạn của verification hiện tại:**

- Không có test nào chạy một **client application thật** ngoài bộ test; system test tự gọi authorization server và token endpoint, không dùng SDK OIDC của bên thứ ba.
- Việc thu hồi grant từ trang connected applications chỉ có integration test ở phía `auth`; system test không mở trang `/applications`.
- Việc **bắt buộc đăng nhập lại** dù đã có session ở nơi khác không có test nào assert: luồng browser đi từ trạng thái chưa đăng nhập, nên không chứng minh được hành vi khi session đã tồn tại.
- Sự tồn tại của các spec trên không chứng minh chúng đã chạy và pass. Kết luận `Verified` cần kết quả chạy của `test`, `test-integration` và `system-test` trên stack local thật.
