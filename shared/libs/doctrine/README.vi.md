---
name: doctrine
subsystem: shared
lang: vi
description: Bộ trần được công bố — North Star, spec, charter, rubric — cùng phần logic thuần biến cây tài liệu đó thành điều hướng.
---

> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# doctrine

<!-- readme:why -->

## Vì sao nó tồn tại

Thiết kế của ecoma được chốt trong tài liệu trước khi được chốt trong code: các
North Star, spec mà mỗi cơ chế phải thoả, charter triển khai, và rubric mà các
vòng review chạy theo. Những tài liệu đó được công bố, nên chúng cần một chỗ ở
đi cùng phiên bản với code mà chúng chi phối, thay vì nằm cạnh đó trong một thư
mục nào đó.

Cho chúng một project riêng — thay vì thả Markdown thẳng vào trang web hiển thị
chúng — đổi lấy đúng một thứ đáng giá: cây tài liệu trở thành thứ workspace
kiểm được. Một tài liệu tồn tại nhưng không đến được người đọc chính là cách một
trang tài liệu hỏng, và nó hỏng trong im lặng, vì không ai báo về một trang họ
chưa từng biết là có. Phần logic ở đây từ chối hình dạng đó thay vì cứ render
vòng qua nó.

<!-- readme:consumers -->

## Ai tiêu dùng nó

`shared/apps/doctrine-site`, và không ai khác. Nó đọc cây thư mục, đưa danh sách
tài liệu vào đây, rồi render thứ nhận về.

Vì project này là một node Nx thật và trang web import nó, sửa một tài liệu là
một thay đổi mà `nx affected` nhìn thấy được — đó cũng chính là lý do nội dung
sống trong một thư viện chứ không nằm bên trong app hiển thị nó.

<!-- readme:ecosystem -->

## Nó nằm ở đâu

Trong `shared/`, vì bộ trần phủ mọi khu vực sản phẩm — platform, RPA lẫn Hub —
mà `shared/` đúng là nơi workspace giữ những thứ không thuộc riêng sản phẩm nào.

Bản thân module là thuần: nó nhận một danh sách tài liệu và trả về các mục đã
sắp thứ tự, không bao giờ chạm tới filesystem. Đọc cây thư mục là việc của bên
gọi, và chính điều đó khiến mọi luật ở đây kiểm được mà không cần một thư mục
mẫu nằm trên đĩa.

<!-- readme:boundary -->

## Nó cố ý không làm gì

- **Không đọc filesystem.** Bên gọi đọc; chỗ này quyết định.
- **Không có thứ tự mục cài sẵn.** Thứ tự đến từ tham số, và được kiểm **hai
  chiều** với cây thư mục. Một giá trị mặc định nhét vào đây sẽ là một khẳng
  định về nội dung mà project này không nhìn thấy.
- **Không có bảng tra tiêu đề.** Tiêu đề lấy từ chính heading của mỗi tài liệu,
  nên đổi heading là đổi luôn mục điều hướng, và không tồn tại chỗ thứ hai để
  sửa.
- **Không tạo mục riêng cho bản dịch.** `role.vi.md` chính là `role.md` ở một
  ngôn ngữ khác, nên nó được báo kèm tài liệu mà nó dịch chứ không bao giờ thành
  một mục điều hướng riêng — liệt cả ba là cho người đọc thấy một spec ba lần.
- **Không render.** Theme, routing và tìm kiếm thuộc về trang web.

<!-- readme:status -->

## Trạng thái

Đang chạy thật: các tài liệu đã nằm ở đây và `shared/apps/doctrine-site` dựng
toàn bộ điều hướng bằng cách gọi module này. Cơ chế ở phạm vi thư mục nằm trong
[`./CLAUDE.md`](./CLAUDE.md).
