# Gửi yêu cầu về quyền riêng tư

> **Feature area:** `account/` · **Mô tả một dòng:** người dùng gửi và theo dõi yêu cầu về dữ liệu cá nhân của mình — xuất, chỉnh sửa, xoá, hạn chế xử lý hoặc phản đối.
>
> Đặc tả domain → [`domains/account/`](../../domains/account/README.md) · quy tắc viết → [`../README.md`](../README.md).

## 1. Problem

Người dùng cần một kênh chính thức để yêu cầu xem, sửa hoặc xoá dữ liệu cá nhân của mình, và cần biết yêu cầu đã được ghi nhận hay chưa. Nếu kênh đó là email hỗ trợ, người dùng không có bản ghi nào về việc mình đã yêu cầu gì và khi nào.

## 2. Outcome

Người dùng đã đăng nhập gửi được yêu cầu về quyền riêng tư và theo dõi trạng thái của nó.

- Năm loại yêu cầu được hỗ trợ: export, correct, delete, restrict, object.
- Mỗi yêu cầu được tạo với trạng thái `pending`, kèm hạn xử lý tính từ lúc tạo.
- Danh sách hiển thị loại, ngày gửi, hạn xử lý và trạng thái của từng yêu cầu, mới nhất trước.
- Mỗi loại chỉ có tối đa một yêu cầu đang mở tại một thời điểm; gửi trùng không tạo bản ghi thứ hai.
- Giới hạn số yêu cầu trong một giờ.
- Giao diện nói rõ **đã gửi yêu cầu không có nghĩa yêu cầu đã được thực hiện**.

## 3. Scope

### Bao gồm

- Tạo yêu cầu thuộc năm loại trong allowlist; loại ngoài danh sách bị từ chối.
- Trạng thái thuộc bốn giá trị: `pending`, `in-progress`, `completed`, `rejected`.
- Liệt kê yêu cầu của chính mình, mới nhất trước.
- Hạn xử lý 30 ngày, ghi một lần lúc tạo và không được gia hạn.
- Ràng buộc một yêu cầu đang mở cho mỗi loại, thực thi bằng unique index có điều kiện.
- Giới hạn số yêu cầu mỗi giờ; yêu cầu trùng loại đang mở trả thành công mà không tạo bản ghi mới.
- Audit khi tạo yêu cầu.

### Không bao gồm

- **Không có fulfillment.** Hệ thống không có thành phần nào chuyển yêu cầu sang `in-progress`, `completed` hay `rejected`, và không tạo ra artifact export, bản chỉnh sửa, hay thực hiện xoá. Không có job, worker hay route nào làm việc đó. Vì vậy Feature này là **submission và tracking**, không phải thực hiện yêu cầu.
- **Không có thông báo cho người dùng khi trạng thái đổi**, vì trạng thái không đổi.
- **Không có huỷ yêu cầu.**
- **Không trả về định danh yêu cầu.** Phản hồi v1 không mang `id`, nên adapter thật đặt `id: ''` cho mọi mục; nhiều yêu cầu dùng chung một khoá trong danh sách. Đây là giới hạn hiện tại, không phải hành vi mong muốn.
- **Không bao gồm việc thực hiện yêu cầu xoá hay xuất dữ liệu ở bất kỳ hình thức nào.**
- Session hiện tại và đăng xuất thuộc [Quản lý session đang hoạt động](./manage-active-sessions.md).

## 4. Acceptance Scenarios

```text
Cho  người dùng đã đăng nhập và chưa có yêu cầu nào
Khi  mở trang quyền riêng tư
Thì  thấy năm loại yêu cầu có thể gửi và danh sách trống
```

```text
Cho  người dùng chọn một loại yêu cầu và xác nhận
Khi  gửi
Thì  nhận phản hồi thành công và danh sách có một mục mới ở trạng thái `pending`
     với hạn xử lý 30 ngày kể từ lúc tạo
```

```text
Cho  người dùng đã có một yêu cầu cùng loại đang mở
Khi  gửi lại cùng loại
Thì  nhận phản hồi thành công nhưng không có bản ghi mới và không có audit thứ hai
```

```text
Cho  người dùng đã gửi nhiều yêu cầu trong một giờ và vượt giới hạn
Khi  gửi thêm
Thì  nhận 429 và không có bản ghi mới
```

```text
Cho  người dùng mở danh sách yêu cầu
Khi  danh sách hiển thị
Thì  các mục xếp mới nhất trước, mỗi mục có loại, ngày gửi, hạn xử lý và trạng thái
```

```text
Cho  yêu cầu vừa được gửi
Khi  người dùng đọc giao diện
Thì  giao diện nói rõ yêu cầu đã được ghi nhận, chưa được thực hiện
```

## 5. Domain & Application Mapping

| Domain / Application        | Vai trò trong Feature                                                             | Canonical                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `account` (bounded context) | Sở hữu `privacy_requests`, allowlist loại yêu cầu, hạn xử lý và giới hạn tần suất | [`domains/account/`](../../domains/account/README.md)                                      |
| `apps/account`              | Deploy unit phục vụ trang quyền riêng tư và BFF route tạo/liệt kê                 | [`applications/account/01-architecture.md`](../../applications/account/01-architecture.md) |
| `libs/account-domain`       | Rule domain dùng chung                                                            | [`05-code-architecture.md`](../../architecture/05-code-architecture.md)                    |

Không có domain hay application nào khác tham gia, vì yêu cầu không được chuyển sang bất kỳ quy trình xử lý nào.

## 6. Verification Mapping

| Scenario                                                                                                                        | Test file / suite                                                                                  | Loại test      | Nx target          |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------- | ------------------ |
| Allowlist loại yêu cầu, trạng thái, thứ tự mới nhất trước, hạn 30 ngày, trùng loại idempotent, giới hạn mỗi giờ, hình dạng view | `apps/account/server/lib/data-domain.spec.ts`                                                      | unit           | `test`             |
| Adapter mock tạo yêu cầu ở trạng thái `pending`                                                                                 | `apps/account/app/account-data/mock-adapter.spec.ts`                                               | unit           | `test`             |
| Trạng thái loading/error/empty/ready của trang quyền riêng tư                                                                   | `apps/account/app/pages/data-page-states.spec.ts`                                                  | unit/component | `test`             |
| Bảng `privacy_requests` được tạo bởi migration; role runtime không có quyền `DELETE`                                            | `apps/account/tests/databases/migrations.spec.ts`, `apps/account/tests/integrations/roles.spec.ts` | database       | `test-integration` |

**Giới hạn của verification hiện tại:**

- **Không có integration test cho route `/api/privacy-requests`.** `data-domain-bff-e2e.spec.ts` không đăng ký route này và không kiểm chứng nó; toàn bộ bằng chứng nằm ở unit test trên helper lưu trữ và adapter mock.
- Không có test nào kiểm chứng hành vi fulfillment, vì fulfillment chưa tồn tại.
- Không có system test nào mở trang quyền riêng tư.
- Trạng thái `in-progress`, `completed` và `rejected` chỉ biểu diễn được qua dữ liệu có sẵn, không qua hành vi của ứng dụng.
- Sự tồn tại của các spec trên không chứng minh chúng đã chạy và pass. Kết luận `Verified` cần kết quả chạy của `test` và `test-integration`.
