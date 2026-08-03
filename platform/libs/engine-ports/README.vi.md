---
name: engine-ports
subsystem: platform
lang: vi
description: Các interface mà domain của engine phơi ra bên ngoài — log store, blob store, lease, key store — đặt tên theo nhu cầu chứ không theo công nghệ.
---

> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# engine-ports

Những gì engine cần từ thế giới bên ngoài, viết bằng từ vựng của chính nó:
một log store append-only, một blob store định địa chỉ theo nội dung, một
lease, một key store, một bề mặt đọc SQL, một metrics projection.

<!-- readme:why -->

## Tại sao nó tồn tại

Port là thứ khiến một backend thay thế được. Tách nó khỏi cả các khái niệm lẫn
các hiện thực là điều cho phép cùng một engine chạy trên stack nhỏ và stack
tham chiếu mà không cần một nhánh rẽ nào bên trong — và cho phép một bộ suite
contract lái cả hai từ cùng một tập ca kiểm. Viết chúng bên trong
`engine-domain` sẽ kéo mối bận tâm lưu trữ vào tầng thuần khiết; viết bên
trong `engine-adapters` thì chẳng còn gì để thay.

<!-- readme:consumers -->

## Ai đang consume nó

`engine-adapters` hiện thực nó, `conformance-g0` lái trực tiếp nó, còn
application service và composition root ra đời sau sẽ điều phối bên trên nó.
Nó chỉ tiêu thụ `engine-domain` và không gì khác.

<!-- readme:ecosystem -->

## Vị trí trong hệ sinh thái

Ở giữa chiều `layer:domain` → `layer:port` → `layer:adapter`, bên trong khu
vực `platform/`. Cơ chế dành cho người sửa file ở đây nằm tại
[`./CLAUDE.md`](./CLAUDE.md).

<!-- readme:boundary -->

## Nó cố ý không làm gì

Nó không nêu tên công nghệ nào — không driver, không dialect, không hình dạng
URL. Nó cũng không giữ contract test: một suite không bao giờ sống bên trong
project mà nó làm trọng tài. Và nó chưa có vector port: `engine-ports/vector`
là một seam đã đặt tên, sẽ tới cùng Knowledge — consumer đầu tiên của nó —
thay vì là một contract thiết kế cho không ai cả.

<!-- readme:status -->

## Trạng thái

Đã scaffold, và cố ý chưa có interface nào. Mỗi interface sẽ hạ cánh cùng đặc
tả mà nó phục vụ, còn những interface thuộc phạm vi gate sẽ hạ cánh cùng bộ
suite giữ chúng đúng contract. Cơ chế theo thư mục nằm ở
[`./CLAUDE.md`](./CLAUDE.md).
