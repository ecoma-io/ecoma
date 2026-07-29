---
name: doctrine-site
subsystem: shared
lang: vi
description: Bản dựng VitePress công bố cây doctrine tại ecoma.io/doctrine — chỉ hiển thị, không bao giờ soạn nội dung.
---

> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# doctrine-site

<!-- readme:why -->

## Vì sao nó tồn tại

Thiết kế của ecoma được chốt trong tài liệu, và những tài liệu đó được công bố.
Đây là bề mặt công bố chúng: một bản dựng tĩnh, cắt theo mỗi lần release, mount
thành một đường dẫn trên cùng một domain, cạnh design system.

Nó chỉ hiển thị, không làm gì khác. Mọi trang nó hiện ra đều đến từ
`shared/libs/doctrine`, nên một tài liệu không thể tồn tại trên trang web mà
không tồn tại trong cây mà workspace kiểm được.

<!-- readme:consumers -->

## Ai tiêu dùng nó

Người đọc, qua `ecoma.io/doctrine`. Edge router sở hữu điểm mount; app này chỉ
cần khớp với nó.

`doctrine-site-e2e` chạy trên bản đã build và là người tiêu dùng tự động duy
nhất.

<!-- readme:ecosystem -->

## Nó nằm ở đâu

Trong `shared/`, cùng lý do với cây tài liệu: bộ trần phủ mọi khu vực sản phẩm,
nên cả nội dung lẫn bề mặt của nó đều không thuộc riêng sản phẩm nào. Tiền lệ
khớp chính xác — `/design` do `shared/apps/design-system` phục vụ, đứng trên
`shared/libs/core-ui`.

<!-- readme:boundary -->

## Nó cố ý không làm gì

- **Không soạn nội dung.** Nội dung thuộc về thư viện; một trang chỉ viết ở đây
  sẽ là doctrine không nằm dưới gate nào.
- **Không tự suy thứ tự mục.** Thứ tự đọc các mục được khai báo và đối chiếu
  hai chiều với cây; sắp theo bảng chữ cái sẽ đặt `charter` trước `north-star`.
  Thứ tự _bên trong_ một mục thì được dẫn xuất, vì một danh sách hai mươi mấy
  spec giữ bằng tay sẽ trôi mà không ai kiểm.
- **Không runtime.** Đầu ra tĩnh, do tầng triển khai phục vụ.

<!-- readme:status -->

## Trạng thái

Đang chạy thật: mọi trang đều đến từ `shared/libs/doctrine`, và app này không
giữ tài liệu nào của riêng nó. Cơ chế ở phạm vi thư mục nằm trong
[`./CLAUDE.md`](./CLAUDE.md).
