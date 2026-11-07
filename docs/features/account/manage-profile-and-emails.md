# Quản lý profile và email

> **Product area:** `account/` · **Mô tả một dòng:** chủ tài khoản tự xem và sửa profile của mình, và tự quản lý các địa chỉ email dùng để đăng nhập.
>
> Đặc tả domain → [`domains/account/`](../../domains/account/README.md) · quy tắc viết → [`../README.md`](../README.md).

## 1. Problem

Người dùng không tự sửa được tên hiển thị của mình và không tự thêm hay bỏ được địa chỉ email. Mọi thay đổi phải qua hỗ trợ, và người dùng không kiểm soát được địa chỉ nào dùng để đăng nhập.

Khi nhiều người dùng tự thêm email, hệ thống cũng phải tránh hai rủi ro: dùng form thêm email để dò xem địa chỉ nào đã có tài khoản, và gửi thư xác minh hàng loạt tới hộp thư của người khác.

## 2. Outcome

Người dùng đã đăng nhập sửa được profile và quản lý được danh sách email của chính mình.

- Profile gồm tên hiển thị và ảnh đại diện dạng URL. Chưa có profile thì người dùng thấy trạng thái trống, không phải lỗi.
- Chỉnh sửa profile là cập nhật từng phần: trường không gửi giữ nguyên giá trị cũ.
- Địa chỉ email trong danh sách được che bớt; địa chỉ đã thu hồi bị lọc khỏi danh sách ở tầng UI (route API vẫn trả các hàng đó).
- Người dùng thêm được địa chỉ mới; địa chỉ mới ở trạng thái chờ xác minh và nhận được mã xác minh.
- Danh sách phân biệt địa chỉ dùng để đăng nhập với địa chỉ phụ.
- Người dùng không xoá được địa chỉ đăng nhập đã xác minh, và không xoá được địa chỉ đã xác minh cuối cùng của mình.
- Phản hồi khi thêm email **không** cho biết địa chỉ đó đã có chủ hay bị chặn vì gửi quá nhanh.
- Mọi thay đổi ghi audit; subject luôn lấy từ session, không bao giờ từ body do client gửi.

## 3. Scope

### Bao gồm

- Xem profile; cập nhật tên hiển thị và ảnh đại diện qua URL `https`.
- Liệt kê email của chính mình ở dạng đã che, kèm trạng thái và cờ địa chỉ đăng nhập.
- Thêm email mới, có giới hạn số địa chỉ đang chờ trong một cửa sổ thời gian.
- Gửi lại mã xác minh, có khoảng chờ giữa hai lần gửi.
- Xoá email; từ chối khi đó là địa chỉ xác minh cuối cùng, với bảo vệ nguyên tử dưới tranh chấp đồng thời.
- Chống enumeration ở route thêm email: mọi kết quả nghiệp vụ trả về cùng một hình dạng phản hồi.
- Kiểm tra CSRF và trả 401 khi chưa đăng nhập.

### Không bao gồm

- **Chưa có UI nhập mã xác minh email.** Route xác minh tồn tại và hoạt động ở tầng server, nhưng trang email không có ô nhập mã và không gọi route đó. Nút duy nhất trên địa chỉ đang chờ là "Resend link", và nội dung chữ nói "link" trong khi server phát mã 8 chữ số. Vì vậy, từ góc người dùng, **địa chỉ mới không thể trở thành đã xác minh bằng UI**.
- **Chưa có upload ảnh đại diện.** UI chỉ hiển thị ảnh khi `avatarUrl` đã có; không có input file, và UI không bao giờ gửi một `avatarUrl` mới.
- **Không có xác thực hai yếu tố.** Passkey, TOTP và recovery code render qua adapter mock và các điều khiển đang `disabled`.
- **Không có đổi mật khẩu**, vì sản phẩm không có mật khẩu.
- Đăng xuất và session thuộc [Quản lý session đang hoạt động](./manage-active-sessions.md); application đã cấp quyền thuộc [Truy cập application qua OIDC](../identity/oidc-application-access.md).

## 4. Acceptance Scenarios

```text
Cho  người dùng đã đăng nhập và chưa có profile
Khi  mở trang profile
Thì  thấy trạng thái "chưa có thông tin", không phải lỗi
```

```text
Cho  người dùng đã có profile
Khi  lưu một tên hiển thị mới
Thì  profile được cập nhật và lần đọc sau trả giá trị mới
```

```text
Cho  người dùng gửi ảnh đại diện không dùng `https`, hoặc tên rỗng, hoặc tên quá dài
Khi  lưu
Thì  nhận 400 và không có gì được ghi
```

```text
Cho  body cập nhật profile có chứa `sub` của người khác
Khi  request được xử lý
Thì  trường đó bị bỏ qua; chỉ `sub` từ session quyết định profile nào bị sửa
```

```text
Cho  người dùng đã đăng nhập
Khi  xem danh sách email
Thì  thấy các địa chỉ của mình ở dạng che bớt, kèm trạng thái và cờ địa chỉ đăng nhập;
     địa chỉ đã thu hồi không được hiển thị
```

```text
Cho  người dùng thêm một địa chỉ mới
Khi  request thành công
Thì  một hàng ở trạng thái chờ được tạo và một mã xác minh được gửi
```

```text
Cho  địa chỉ đã thuộc tài khoản khác, hoặc người dùng đã vượt giới hạn địa chỉ đang chờ
Khi  thêm địa chỉ đó
Thì  phản hồi giống hệt trường hợp thành công; không có hàng nào được tạo
```

```text
Cho  người dùng vừa gửi lại mã xác minh
Khi  gửi lại lần nữa trong khoảng chờ
Thì  nhận phản hồi thành công nhưng không có thư thứ hai được gửi
```

```text
Cho  người dùng đã có nhiều địa chỉ đã xác minh
Khi  xoá một địa chỉ đã xác minh không phải địa chỉ đăng nhập
Thì  địa chỉ đó bị thu hồi và biến mất khỏi danh sách
```

```text
Cho  địa chỉ đã xác minh cuối cùng của người dùng
Khi  xoá địa chỉ đó
Thì  nhận 400 với lý do `last_verified_email` và địa chỉ vẫn còn
```

```text
Cho  hai request xoá hai địa chỉ đã xác minh chạy đồng thời
Khi  cả hai hoàn tất
Thì  đúng một địa chỉ bị thu hồi; địa chỉ còn lại vẫn đã xác minh
```

```text
Cho  người dùng xoá một địa chỉ không thuộc mình
Khi  request tới
Thì  nhận 404 và không có gì bị thay đổi
```

## 5. Domain & Application Mapping

| Domain / Application                            | Vai trò trong Feature                                                                                                       | Canonical                                                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `account` (bounded context)                     | Sở hữu profile, địa chỉ email, trạng thái xác minh, ràng buộc một địa chỉ đã xác minh chỉ thuộc một account, security event | [`domains/account/`](../../domains/account/README.md)                                                            |
| `transactional-mail` (bounded context)          | Gửi mã xác minh qua template thư đăng nhập                                                                                  | [`applications/transactional-mail/01-architecture.md`](../../applications/transactional-mail/01-architecture.md) |
| `apps/account`                                  | Deploy unit phục vụ UI profile/email và BFF route tương ứng                                                                 | [`applications/account/01-architecture.md`](../../applications/account/01-architecture.md)                       |
| `libs/account-domain`, `libs/account-contracts` | Rule domain và contract nội bộ                                                                                              | [`05-code-architecture.md`](../../architecture/05-code-architecture.md)                                          |

## 6. Verification Mapping

| Scenario                                                                                                                                        | Test file / suite                                                                                  | Loại test      | Nx target          |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------- | ------------------ |
| Profile trống → cập nhật → đọc lại; validation 400; partial update; `sub` từ body bị bỏ qua                                                     | `apps/account/tests/integrations/data-domain-bff-e2e.spec.ts`                                      | integration    | `test-integration` |
| Liệt kê email che bớt; thêm địa chỉ chờ kèm một thư và một audit; idempotent khi đã sở hữu; im lặng khi thuộc người khác; 400 khi sai định dạng | cùng file trên                                                                                     | integration    | `test-integration` |
| Xác minh email: thành công, sai mã bị khoá, mã sai mục đích bị từ chối, không thuộc mình trả 404                                                | cùng file trên                                                                                     | integration    | `test-integration` |
| Gửi lại mã: cooldown, gửi thật kèm audit, không thuộc mình trả 404                                                                              | cùng file trên                                                                                     | integration    | `test-integration` |
| Xoá email: địa chỉ xác minh cuối cùng trả 400; tranh chấp đồng thời để lại đúng một địa chỉ; xoá địa chỉ chờ idempotent                         | cùng file trên                                                                                     | integration    | `test-integration` |
| Không đăng nhập trả 401; CSRF sai trả 403                                                                                                       | cùng file trên                                                                                     | integration    | `test-integration` |
| Nút xoá địa chỉ đăng nhập bị vô hiệu kèm lý do hiển thị                                                                                         | `apps/account/app/pages/interactive-controls.spec.ts`                                              | unit/component | `test`             |
| Trạng thái loading/error/empty/ready của trang profile và email                                                                                 | `apps/account/app/pages/data-page-states.spec.ts`                                                  | unit/component | `test`             |
| Migration `privacy_requests`/dữ liệu tài khoản áp dụng được, role runtime chỉ có DML                                                            | `apps/account/tests/databases/migrations.spec.ts`, `apps/account/tests/integrations/roles.spec.ts` | database       | `test-integration` |

**Giới hạn của verification hiện tại:**

- Verify email được kiểm chứng ở tầng integration route, **không** ở tầng người dùng, vì chưa có UI nhập mã. Không scenario nào trong §4 mô tả người dùng tự xác minh được một địa chỉ mới.
- Không có test nào kiểm chứng upload avatar (không tồn tại) hay thay đổi `avatarUrl` từ UI.
- Hành vi loại địa chỉ đã thu hồi khỏi danh sách chỉ nằm ở `apps/account/app/account-data/real-adapter.ts`: route API vẫn trả các hàng đó, và không test nào assert việc lọc.
- Nhánh vượt giới hạn số địa chỉ đang chờ không có test nào: chỉ hàm đếm số địa chỉ chờ có unit test, còn nhánh im lặng trong route thêm email thì không được phủ ở tầng nào.
- System test `identity-login-e2e` chỉ chạm route đăng nhập; không suite system-test nào mở trang profile hay email.
- Sự tồn tại của các spec trên không chứng minh chúng đã chạy và pass. Kết luận `Verified` cần kết quả chạy của `test` và `test-integration`.
