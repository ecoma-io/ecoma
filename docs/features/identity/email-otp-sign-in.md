# Đăng nhập bằng email OTP

> **Feature area:** `identity/` · **Mô tả một dòng:** người dùng đăng nhập bằng một mã dùng một lần gửi tới email, không cần mật khẩu.
>
> Đặc tả domain → [`domains/account/`](../../domains/account/README.md) · quy tắc viết → [`../README.md`](../README.md).

## 1. Problem

Người dùng phải nhớ và quản lý thêm một mật khẩu cho sản phẩm, dù họ đã có email. Mật khẩu tạo thêm việc phải đặt lại, thêm bề mặt bị đánh cắp, và thêm một bước đăng ký trước khi dùng được sản phẩm.

Một hệ thống gửi mã qua email cũng tạo ra hai rủi ro: kẻ tấn công dùng form đăng nhập để dò xem địa chỉ nào có tài khoản, và form đó trở thành kênh gửi thư hàng loạt tới hộp thư của người khác.

## 2. Outcome

Người dùng nhập địa chỉ email, nhận một mã dùng một lần, nhập mã đó và trở thành người dùng đã xác thực. Không có mật khẩu ở bất kỳ bước nào.

- Phản hồi cho yêu cầu gửi mã **giống hệt nhau** dù địa chỉ có tài khoản hay không, dù tài khoản đang bị treo, dù yêu cầu bị chặn vì gửi quá nhanh. Người dùng không phân biệt được địa chỉ nào tồn tại.
- Mã chỉ được gửi khi địa chỉ đã được xác minh và thuộc một tài khoản đang hoạt động.
- Mã có thời hạn ngắn, chỉ dùng được một lần, và bị vô hiệu sau số lần nhập sai giới hạn.
- Mỗi lần xác thực thành công tạo một browser session mới và thu hồi session trước đó của cùng trình duyệt.
- Người dùng đọc lại được thông tin session của mình và đăng xuất được qua API; UI chưa có điểm vào (xem [Quản lý session đang hoạt động](../account/manage-active-sessions.md)).
- Lỗi gửi thư không làm lộ thông tin và không thay đổi phản hồi cho người dùng.

## 3. Scope

### Bao gồm

- Yêu cầu mã đăng nhập qua email, kèm gửi lại mã.
- Xác thực mã và tạo browser session.
- Đọc thông tin session hiện tại và đăng xuất.
- Anti-enumeration: phản hồi và trạng thái lưu trữ không phân biệt được giữa địa chỉ có và không có tài khoản.
- Giới hạn tần suất theo địa chỉ: khoảng chờ giữa hai lần gửi, và hai cửa sổ giới hạn (ngắn hạn và dài hạn).
- Giới hạn số lần nhập sai, mã hết hạn, mã dùng một lần.
- Session cookie `HttpOnly` và cookie CSRF; đăng xuất trả 403 khi CSRF cookie có mặt nhưng header không khớp, còn thiếu hẳn CSRF cookie thì session vẫn bị thu hồi.
- Chuyển tiếp vào một giao dịch uỷ quyền OIDC đang chờ, khi lần đăng nhập bắt đầu từ application khác — bản thân luồng OIDC thuộc [Truy cập application qua OIDC](./oidc-application-access.md).

### Không bao gồm

- **Gửi email thật chưa được kiểm chứng.** Ở môi trường local và trong system test, `transactional-mailer-job` chạy với provider giả (`MAIL_PROVIDER_KIND=fake`) và test đọc mã từ D1 sink. Không test nào trong repository chứng minh thư tới hộp thư thật.
- **Passkey, TOTP và recovery code chưa hiện thực.** Trang bảo mật render các mục này ở trạng thái "chưa khả dụng" theo `securityCapabilities` (hiện đều `false`) — không có điều khiển thao tác nào, và không có đường mock nào thay thế. Không mô tả chúng như capability đã có.
- **Không có mật khẩu và không có luồng đặt lại mật khẩu.**
- **Không có đăng ký tài khoản trong phạm vi này.** Tài khoản được tạo ngoài luồng đăng nhập; địa chỉ phải đã được xác minh trước khi nhận được mã. Ngoại lệ đã quyết, chưa hiện thực: địa chỉ có **lời mời** còn mở do administrator phát được gửi mã thật qua đúng luồng này, và việc xác minh mã sinh Account kèm email `verified` — kênh và điều kiện thuộc [ADR-0030](../../domains/account/adr/0030-account-creation-channel-invitation.md), hiện thực thuộc #227.
- **Không có xác thực hai yếu tố ở bước đăng nhập.**
- Địa chỉ email đang chờ đăng nhập chỉ nằm trong bộ nhớ của trang; tải lại trang giữa lúc yêu cầu mã và lúc nhập mã làm mất trạng thái đó, và người dùng phải yêu cầu mã mới.

## 4. Acceptance Scenarios

```text
Cho  một địa chỉ email hợp lệ bất kỳ
Khi  yêu cầu mã đăng nhập
Thì  nhận 204 với body rỗng và không có cookie — giống hệt nhau cho địa chỉ đã đăng ký,
     địa chỉ chưa đăng ký, và địa chỉ đang bị giới hạn tần suất
```

```text
Cho  địa chỉ đã xác minh thuộc một tài khoản đang hoạt động
Khi  yêu cầu mã đăng nhập
Thì  một email chứa mã 8 chữ số được tạo, có hiệu lực 10 phút
```

```text
Cho  địa chỉ không có tài khoản, hoặc tài khoản đang bị treo
Khi  yêu cầu mã đăng nhập
Thì  không email nào được gửi, nhưng phản hồi bên ngoài không khác trường hợp thành công
```

```text
Cho  một yêu cầu mã vừa được thực hiện cho cùng địa chỉ
Khi  yêu cầu lại trong vòng 60 giây
Thì  vẫn nhận 204, không mã mới nào được tạo và không email nào được gửi
```

```text
Cho  địa chỉ đã vượt giới hạn tần suất
Khi  yêu cầu thêm mã
Thì  vẫn nhận 204, không mã nào được tạo
```

```text
Cho  người dùng nhận được mã hợp lệ còn hiệu lực
Khi  nhập đúng mã
Thì  trở thành người dùng đã xác thực, nhận session cookie và CSRF cookie,
     và session báo mức xác thực `urn:ecoma:acr:email-otp`
```

```text
Cho  người dùng nhập sai mã
Khi  gửi mã sai
Thì  nhận lỗi chung, không cho biết mã sai hay mã đã hết hạn;
     sau lần sai thứ năm, challenge bị khoá và mã đúng cũng không còn dùng được
```

```text
Cho  một mã đã được dùng thành công trước đó
Khi  gửi lại cùng mã
Thì  bị từ chối
```

```text
Cho  người dùng đang có session
Khi  đăng nhập lại thành công
Thì  session cũ bị thu hồi và thay bằng session mới
```

```text
Cho  người dùng đang có session hợp lệ
Khi  gửi yêu cầu đăng xuất kèm CSRF token khớp
Thì  session bị thu hồi, cả hai cookie bị xoá, và đọc session sau đó trả về chưa xác thực
```

```text
Cho  người dùng đã đăng xuất, hoặc gửi cookie của người khác
Khi  gọi đăng xuất lần nữa
Thì  vẫn thành công — thao tác là idempotent
```

```text
Cho  dịch vụ gửi thư không phản hồi
Khi  yêu cầu mã
Thì  phản hồi cho người dùng không đổi; thất bại chỉ xuất hiện trong log vận hành
```

## 5. Domain & Application Mapping

| Domain / Application                                   | Vai trò trong Feature                                                                                         | Canonical                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `account` (bounded context)                            | Sở hữu account, credential email, challenge OTP, browser session và security event; database `db-account`     | [`domains/account/`](../../domains/account/README.md)                                                            |
| `transactional-mail` (bounded context)                 | Nhận yêu cầu gửi thư qua contract, render template và enqueue việc giao; không gọi provider trên request path | [`applications/transactional-mail/01-architecture.md`](../../applications/transactional-mail/01-architecture.md) |
| `auth` (bounded context)                               | Nhận kết quả xác thực từ `account` khi đăng nhập bắt đầu từ một giao dịch OIDC; không tự xác thực người dùng  | [`domains/auth/`](../../domains/auth/README.md)                                                                  |
| `apps/account`                                         | Deploy unit phục vụ UI đăng nhập và các route API xác thực                                                    | [`domains/account/`](../../domains/account/README.md)                                                            |
| `apps/transactional-mail` + `transactional-mailer-job` | Delivery plane của thư giao dịch                                                                              | [`applications/transactional-mailer-job/`](../../applications/transactional-mailer-job/README.md)                |

`libs/account-domain` giữ rule của session policy và domain error; `libs/account-contracts` giữ contract nội bộ giữa `account` và `auth`.

## 6. Verification Mapping

Hai tầng kiểm chứng tồn tại: integration app-owned (PostgreSQL thật, mail giả) và system test (toàn stack local chạy thật, không dùng browser — các spec gọi origin account qua HTTPS).

| Scenario                                                                               | Test file / suite                                                            | Loại test      | Nx target          |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------- | ------------------ |
| Luồng đầy đủ: yêu cầu mã, xác thực, session, đăng xuất                                 | `apps/account/tests/integrations/otp-flow-e2e.spec.ts`                       | integration    | `test-integration` |
| Anti-enumeration, ghost challenge, cooldown, giới hạn tần suất, race khi gửi đồng thời | `apps/account/tests/integrations/otp-flow-e2e.spec.ts`                       | integration    | `test-integration` |
| Digest, sinh mã không lệch phân phối, chuẩn hoá địa chỉ                                | `apps/account/server/lib/otp.spec.ts`                                        | unit           | `test`             |
| Hết hạn và tranh chấp đồng thời trên challenge                                         | `apps/account/tests/integrations/otp-ttl-concurrency.spec.ts`                | integration    | `test-integration` |
| Session schema, audit append-only                                                      | `apps/account/tests/integrations/session.spec.ts`                            | integration    | `test-integration` |
| Trạng thái UI của trang đăng nhập (nhập email, nhập mã, gửi lại, lỗi)                  | `apps/account/app/pages/login/index.spec.ts`                                 | unit/component | `test`             |
| Trạng thái UI của bước chuyển tiếp                                                     | `apps/account/app/pages/login/continue.spec.ts`                              | unit/component | `test`             |
| Anti-enumeration trên stack thật                                                       | `system-tests/e2e/identity-login-e2e/e2e/challenge-anti-enumeration.spec.ts` | system E2E     | `system-test`      |
| Yêu cầu mã → đọc mã từ mail sink → xác thực → session → đăng xuất                      | `system-tests/e2e/identity-login-e2e/e2e/otp-login-flow.spec.ts`             | system E2E     | `system-test`      |
| Thuộc tính cookie và payload session trên stack thật                                   | `system-tests/e2e/identity-login-e2e/e2e/session-cookie-contract.spec.ts`    | system E2E     | `system-test`      |
| Sai mã, thiếu challenge, body sai định dạng                                            | `system-tests/e2e/identity-login-e2e/e2e/verify-negative-paths.spec.ts`      | system E2E     | `system-test`      |

**Giới hạn của verification hiện tại:**

- System test `identity-login-e2e` là **API-only**: chưa có spec nào điều khiển browser thật, dù Playwright có cấu hình chromium. Hành vi UI chỉ được kiểm ở mức component test, không phải ở tầng người dùng thật.
- Thư không được gửi ra ngoài: provider giả ở local, mã đọc từ D1 sink. Không có bằng chứng delivery thật.
- Sự tồn tại của các spec trên không chứng minh chúng đã chạy và pass. Kết luận `Verified` cần kết quả chạy của `test`, `test-integration` và `system-test` trên stack local thật.
