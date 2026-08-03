---
name: engine-adapters
subsystem: platform
lang: vi
description: Các hiện thực đứng sau port của engine — mỗi backend một cái, cho cả hai hình dạng triển khai — cùng các contract port làm trọng tài cho litmus thoát milestone.
---

> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# engine-adapters

Nơi engine cuối cùng cũng chạm vào thứ có thật: một store, một filesystem, một
bucket đối tượng. Mỗi port có một hiện thực cho từng hình dạng triển khai,
không bao giờ dùng một hiện thực chung khoác hai cái tên.

<!-- readme:why -->

## Tại sao nó tồn tại

Có hai hình dạng triển khai được xuất bản — stack nhỏ và stack tham chiếu — và
lời hứa rằng chúng hành xử như nhau chỉ đáng bằng thứ mà một bài test chứng
minh được. Giữ mọi hiện thực trong một project, đứng sau `engine-ports`, là
điều khiến lời hứa đó chứng minh được: các ca contract chỉ viết một lần rồi
chạy lần lượt trên từng backend. Nó cũng giữ lựa chọn backend nằm ngoài mọi
tầng khác, vốn là toàn bộ lý do có port.

<!-- readme:consumers -->

## Ai đang consume nó

Composition root ráp chúng vào port; ngoài ra không gì import một adapter, vì
với tới một store bằng đường khác chính là điều mà ranh giới port sinh ra để
chặn. `conformance-g0` cũng với tới chúng — một contract port không thể chạy
nếu không có hiện thực đứng sau. Nó tiêu thụ `engine-ports` và
`engine-domain`.

<!-- readme:ecosystem -->

## Vị trí trong hệ sinh thái

Đứng cuối chiều `layer:domain` → `layer:port` → `layer:adapter`, bên trong khu
vực `platform/`. Cơ chế dành cho người sửa file ở đây nằm tại
[`./CLAUDE.md`](./CLAUDE.md).

<!-- readme:boundary -->

## Nó cố ý không làm gì

Nó không làm trọng tài cho gate nào. Ba contract port sống ở đây — SQL-read,
metrics-projection và key-store — và chúng đo litmus thoát của một milestone
chứ không đo một gate, nên chúng là integration test thông thường dưới target
`test` và không mang target `conformance`: một suite làm trọng tài cho một
gate có tên, hoặc không cho gì cả. Nó cũng không giữ logic ứng dụng; việc điều
phối bên trên port thuộc về tầng cao hơn.

<!-- readme:status -->

## Trạng thái

Đã scaffold, và cố ý chưa có adapter nào. Mỗi adapter sẽ hạ cánh cùng port mà
nó hiện thực, theo cặp — backend của stack nhỏ và backend của stack tham chiếu
— và các ca contract của nó tới cùng lúc, đặt tên `*_integration_test.go`. Cơ
chế theo thư mục nằm ở [`./CLAUDE.md`](./CLAUDE.md).
