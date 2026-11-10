# Quản lý session đang hoạt động

> **Feature area:** `account/` · **Mô tả một dòng:** người dùng thấy mình đang đăng nhập ở đâu và thu hồi được các session không phải thiết bị hiện tại.
>
> Đặc tả domain → [`domains/account/`](../../domains/account/README.md) · quy tắc viết → [`../README.md`](../README.md).

## 1. Problem

Người dùng không biết tài khoản của mình đang đăng nhập ở bao nhiêu nơi. Khi nghi ngờ một thiết bị bị lộ hoặc bỏ quên đăng xuất ở máy khác, họ không có cách nào tự cắt quyền truy cập đó mà không đổi mật khẩu — và sản phẩm không có mật khẩu.

## 2. Outcome

Người dùng đã đăng nhập xem được danh sách session còn hiệu lực của chính mình và thu hồi từng session.

- Danh sách chỉ gồm session còn sống; session đã quá hạn tuyệt đối không hiện.
- Đúng một session được đánh dấu là thiết bị hiện tại.
- Người dùng thu hồi được session khác; session hiện tại của họ vẫn dùng được sau thao tác đó.
- Danh sách không làm lộ session reference hay cookie material. Mỗi mục có một định danh công khai là digest một chiều của session reference, dùng được làm input cho thao tác thu hồi nhưng không dùng lại được để mạo danh.
- Thu hồi một session không tồn tại hiện không gây lỗi cho người dùng.
- Mọi thao tác thu hồi ghi audit, phân biệt thu hồi session khác với thu hồi session hiện tại.

## 3. Scope

### Bao gồm

- Liệt kê session còn hiệu lực của chính mình.
- Xác định session hiện tại dựa trên session cookie của request.
- Thu hồi session khác.
- Trả 404 cho định danh session không tồn tại hoặc đã chết, không ghi audit.
- Chặn thao tác trên session không thuộc mình — định danh công khai chỉ giải được trong phạm vi subject của session hiện tại.

### Không bao gồm

- **UI không cho thu hồi session hiện tại.** Server hỗ trợ: thu hồi session hiện tại trả thành công và xoá cả hai cookie, tức là đăng xuất thiết bị này. Nhưng nút thu hồi chỉ render cho session không phải hiện tại, và adapter mock còn từ chối thao tác đó. Từ góc người dùng, **không có đường nào trên UI để thu hồi session hiện tại**.
- **Không có nút đăng xuất ở bất kỳ đâu trong ứng dụng.** Route đăng xuất tồn tại nhưng không có thành phần giao diện nào gọi tới.
- **Không hiển thị thiết bị hay vị trí thật.** Schema session không lưu user agent hay vị trí, nên adapter thật luôn trả `Unknown device` và bỏ trống vị trí; dòng vị trí bị ẩn.
- **`lastSeenAt` là giá trị suy ra**, không phải thời điểm quan sát thật: nó được tính từ hạn session trừ đi cửa sổ idle. Không mô tả nó như "lần hoạt động cuối".
- **Không có thu hồi hàng loạt hay "đăng xuất khỏi mọi thiết bị".**
- Không hiển thị session của application khác; grant của authorization server thuộc [Truy cập application qua OIDC](../identity/oidc-application-access.md).

## 4. Acceptance Scenarios

```text
Cho  người dùng đang đăng nhập ở nhiều thiết bị
Khi  mở danh sách session
Thì  chỉ thấy các session còn hiệu lực, và đúng một mục được đánh dấu là thiết bị hiện tại
```

```text
Cho  một session đã quá hạn tuyệt đối
Khi  người dùng mở danh sách
Thì  session đó không xuất hiện
```

```text
Cho  người dùng thu hồi một session khác
Khi  thao tác thành công
Thì  nhận phản hồi thành công, cookie của người dùng không đổi, và người dùng vẫn đang đăng nhập
```

```text
Cho  người dùng thu hồi session hiện tại qua API
Khi  thao tác thành công
Thì  cả hai cookie bị xoá và request kế tiếp nhận 401
```

```text
Cho  người dùng thu hồi một định danh session không tồn tại
Khi  request tới
Thì  nhận 404 và không có audit entry nào được ghi
```

```text
Cho  người dùng mở danh sách session
Khi  danh sách hiển thị
Thì  mỗi mục có định danh công khai, nhưng không có session reference, hash hay giá trị cookie nào
```

```text
Cho  người dùng đang xem danh sách session
Khi  giao diện hiển thị
Thì  session hiện tại không có nút thu hồi
```

## 5. Domain & Application Mapping

| Domain / Application        | Vai trò trong Feature                                                                              | Canonical                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `account` (bounded context) | Sở hữu `account_sessions`, session policy, audit security event và định danh công khai của session | [`domains/account/`](../../domains/account/README.md)                                      |
| `apps/account`              | Deploy unit phục vụ trang session và BFF route list/revoke                                         | [`applications/account/01-architecture.md`](../../applications/account/01-architecture.md) |
| `libs/account-domain`       | Rule session policy, cửa sổ idle và hạn tuyệt đối                                                  | [`05-code-architecture.md`](../../architecture/05-code-architecture.md)                    |

## 6. Verification Mapping

| Scenario                                                                                                             | Test file / suite                                             | Loại test      | Nx target          |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------- | ------------------ |
| Danh sách chỉ gồm session còn sống; định danh công khai 64-hex; không lộ `session_ref`; đúng một session là hiện tại | `apps/account/tests/integrations/data-domain-bff-e2e.spec.ts` | integration    | `test-integration` |
| Thu hồi session khác trả 204, không xoá cookie, người dùng vẫn đăng nhập                                             | cùng file trên                                                | integration    | `test-integration` |
| Thu hồi session hiện tại trả 204, xoá cả hai cookie, request kế tiếp trả 401                                         | cùng file trên                                                | integration    | `test-integration` |
| Thu hồi định danh không tồn tại trả 404, không audit                                                                 | cùng file trên                                                | integration    | `test-integration` |
| Không đăng nhập trả 401; CSRF sai trả 403                                                                            | cùng file trên                                                | integration    | `test-integration` |
| Session reference và `id_hash` không bao giờ xuất hiện trong view công khai                                          | `apps/account/server/lib/data-domain.spec.ts`                 | unit           | `test`             |
| UI không render nút thu hồi cho session hiện tại                                                                     | `apps/account/app/pages/interactive-controls.spec.ts`         | unit/component | `test`             |
| Trạng thái loading/error/empty/ready của trang session                                                               | `apps/account/app/pages/data-page-states.spec.ts`             | unit/component | `test`             |

**Giới hạn của verification hiện tại:**

- Thu hồi session hiện tại chỉ được kiểm chứng qua API; không có test nào kiểm chứng một hành vi UI tương ứng, vì UI không có hành vi đó.
- Không có test nào kiểm chứng hành vi của danh sách khi session hết hạn giữa hai lần đọc, kể cả khi hết hạn tuyệt đối hay bị thu hồi từ nơi khác: view chỉ được assert trên dữ liệu còn hiệu lực.
- Không có system test nào mở trang session.
- Sự tồn tại của các spec trên không chứng minh chúng đã chạy và pass. Kết luận `Verified` cần kết quả chạy của `test` và `test-integration`.
