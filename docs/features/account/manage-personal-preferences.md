# Quản lý tuỳ chọn cá nhân

> **Product area:** `account/` · **Mô tả một dòng:** người dùng chọn ngôn ngữ và múi giờ của mình, và chọn có nhận email từ sản phẩm hay không.
>
> Đặc tả domain → [`domains/account/`](../../domains/account/README.md) · quy tắc viết → [`../README.md`](../README.md).

## 1. Problem

Người dùng đọc giao diện bằng ngôn ngữ mình chọn và cần thời gian hiển thị theo múi giờ của mình. Những lựa chọn đó phải theo người dùng qua mọi thiết bị, nên chúng phải được lưu ở server chứ không chỉ trong trình duyệt.

Người dùng cũng cần một nơi duy nhất để nói mình có muốn nhận email từ sản phẩm hay không, và cần hiểu rằng tắt nó không chặn email giao dịch như mã đăng nhập.

## 2. Outcome

Người dùng đã đăng nhập đọc và đặt được tuỳ chọn cá nhân của chính mình.

- **Ngôn ngữ** — người dùng chọn giữa các ngôn ngữ được hỗ trợ; giá trị ngoài danh sách bị từ chối thay vì tự thay bằng mặc định.
- **Múi giờ** — người dùng nhập tên IANA; giá trị không có trong tz database bị từ chối.
- **Tuỳ chọn email** — người dùng bật/tắt ý định nhận email từ sản phẩm.
- Lần lưu đầu tiên phải nêu rõ ngôn ngữ; hệ thống không tự chọn thay.
- Cập nhật là từng phần: trường không gửi giữ nguyên giá trị cũ.
- Subject luôn lấy từ session; `sub` do client gửi không được dùng.
- Mọi thay đổi ghi audit với metadata cấu trúc, không ghi giá trị người dùng nhập.

## 3. Scope

### Bao gồm

- Xem tuỳ chọn hiện tại; trạng thái "chưa cấu hình" phân biệt được với "đã cấu hình".
- Cập nhật ngôn ngữ và múi giờ. Ngôn ngữ có CHECK `en`/`vi` ở database; múi giờ chỉ được kiểm hình dạng ở database, còn tư cách thành viên IANA do BFF validate.
- Hiển thị lỗi rõ ràng khi giá trị đã lưu không còn hợp lệ, thay vì âm thầm thay bằng giá trị khác.
- Đọc và ghi tuỳ chọn nhận email từ sản phẩm.

### Không bao gồm

- **Chế độ màu chưa dùng được.** Trang hiển thị nhóm chọn màu ở trạng thái `disabled` kèm ghi chú "chưa áp dụng", và không có nơi nào trong giao diện đọc giá trị này. Server vẫn nhận và lưu `colorMode`, nhưng nó không thay đổi giao diện.
- **Các loại thông báo không phải tuỳ chọn độc lập.** Trang hiển thị ba công tắc — email dịch vụ, cập nhật sản phẩm, marketing — nhưng tầng lưu trữ chỉ có một khái niệm: **kênh** `email` hoặc `push`. Mọi lần ghi đều thành một hàng kênh `email` với giá trị OR của các công tắc được gửi. Hệ quả quan sát được: bật "Product updates" rồi đọc lại thì công tắc tự trở về tắt, vì lần đọc trả `productUpdates: false` cố định. Tắt "Service email" cũng tắt luôn kênh dùng chung. **Không mô tả ba công tắc này như ba sở thích độc lập.**
- **Chưa có UI chọn kênh `push`.**
- **Ngôn ngữ trong giao diện chọn có thể nhiều hơn ngôn ngữ server chấp nhận.** Registry ngôn ngữ của UI liệt kê thêm `zh-CN`, trong khi allowlist của server và ràng buộc database chỉ nhận `en` và `vi`. Chọn ngôn ngữ đó sẽ nhận lỗi chung. Đây là giới hạn đang mở, được ghi nhận trong chính registry.
- Đổi ngôn ngữ hiển thị của trang đăng nhập và các trang auth thuộc phạm vi riêng, không thuộc Feature này.

## 4. Acceptance Scenarios

```text
Cho  người dùng đã đăng nhập và chưa cấu hình tuỳ chọn nào
Khi  mở trang tuỳ chọn
Thì  thấy trạng thái chưa cấu hình, không phải giá trị mặc định giả
```

```text
Cho  người dùng chưa có hàng tuỳ chọn
Khi  lưu mà không gửi ngôn ngữ
Thì  nhận 400 với lý do `locale_required` và không có gì được ghi
```

```text
Cho  người dùng đã có tuỳ chọn
Khi  chỉ đổi múi giờ
Thì  ngôn ngữ cũ được giữ nguyên
```

```text
Cho  ngôn ngữ không nằm trong allowlist của server
Khi  lưu
Thì  nhận 400 và giá trị cũ được giữ nguyên
```

```text
Cho  tên múi giờ không có trong IANA tz database, hoặc chuỗi rỗng
Khi  lưu
Thì  nhận 400
```

```text
Cho  body cập nhật có chứa `sub` của người khác
Khi  request được xử lý
Thì  trường đó bị bỏ qua; chỉ session quyết định tuỳ chọn nào bị sửa
```

```text
Cho  người dùng bật ý định nhận email từ sản phẩm
Khi  lưu
Thì  một hàng kênh `email` được ghi và audit ghi nhận thay đổi
```

```text
Cho  người dùng mở nhóm chọn chế độ màu
Khi  trang hiển thị
Thì  nhóm đó ở trạng thái vô hiệu kèm ghi chú rằng màu chưa được áp dụng
```

## 5. Domain & Application Mapping

| Domain / Application        | Vai trò trong Feature                                                                                        | Canonical                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `account` (bounded context) | Sở hữu `user_preferences` và `notification_preferences`; quyết định allowlist ngôn ngữ và validation múi giờ | [`domains/account/`](../../domains/account/README.md)                                      |
| `apps/account`              | Deploy unit phục vụ trang tuỳ chọn, trang thông báo và BFF route tương ứng                                   | [`applications/account/01-architecture.md`](../../applications/account/01-architecture.md) |
| `libs/account-domain`       | Rule domain dùng chung                                                                                       | [`05-code-architecture.md`](../../architecture/05-code-architecture.md)                    |

## 6. Verification Mapping

| Scenario                                                                                                                             | Test file / suite                                             | Loại test      | Nx target          |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | -------------- | ------------------ |
| Tuỳ chọn trống → `locale_required` → cập nhật từng phần → allowlist/múi giờ/chế độ màu sai trả 400; alias IANA hợp lệ được chấp nhận | `apps/account/tests/integrations/data-domain-bff-e2e.spec.ts` | integration    | `test-integration` |
| `sub` từ body bị bỏ qua                                                                                                              | cùng file trên                                                | integration    | `test-integration` |
| Ngôn ngữ đã lưu nhưng không hợp lệ được hiển thị thành lỗi, không tự thay                                                            | `apps/account/app/pages/preferences.spec.ts`                  | unit/component | `test`             |
| Một lần lưu chỉ ghi một lần; chế độ màu bị vô hiệu                                                                                   | `apps/account/app/pages/interactive-controls.spec.ts`         | unit/component | `test`             |
| Công tắc thông báo tự trở về trạng thái trước khi lần ghi thất bại                                                                   | `apps/account/app/pages/interactive-controls.spec.ts`         | unit/component | `test`             |
| Ghi/đọc tuỳ chọn thông báo ở tầng lưu trữ (một hàng mỗi kênh; các công tắc được gộp bằng OR khi đọc)                                 | `apps/account/server/lib/data-domain.spec.ts`                 | unit           | `test`             |
| Trạng thái loading/error/empty/ready của trang tuỳ chọn và thông báo                                                                 | `apps/account/app/pages/data-page-states.spec.ts`             | unit/component | `test`             |

**Giới hạn của verification hiện tại:**

- **Route `/api/notifications` không có test integration.** `data-domain-bff-e2e.spec.ts` có đăng ký và assert `/api/preferences`, nhưng **không** đăng ký hay kiểm chứng route notifications. Hành vi lưu thông báo chỉ được kiểm ở mức unit trên helper lưu trữ.
- Không test nào kiểm chứng việc áp dụng chế độ màu vào giao diện, vì việc áp dụng chưa tồn tại.
- Không có system test nào mở trang tuỳ chọn.
- Sự tồn tại của các spec trên không chứng minh chúng đã chạy và pass. Kết luận `Verified` cần kết quả chạy của `test` và `test-integration`.
