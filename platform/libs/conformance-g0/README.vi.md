---
name: conformance-g0
subsystem: platform
lang: vi
description: Bộ suite làm trọng tài cho gate đầu tiên — schema entry của Event Log, contract log-store và blob-CAS trên cả hai stack, Lease, và Principal identity.
---

> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# conformance-g0

Một gate là một văn bản đã đóng băng cộng với một suite chạy độc lập; một gate
không có suite là một gate trên giấy. Project này chính là suite đó cho gate
đầu tiên, và phạm vi của nó là đóng chứ không mở.

<!-- readme:why -->

## Tại sao nó tồn tại

Đóng băng một interface là một lời hứa, và một lời hứa không ai kiểm được thì
chỉ là một tài liệu. Năm vùng contract mà suite này phủ đúng bằng thứ gate
đóng băng: schema entry của Event Log, contract port log-store trên cả hai
stack, contract blob-CAS trên cả hai blob backend, contract Lease, và
Principal identity. Không gì khác, không bao giờ, dưới gate này — phần mọc
thêm đã khai lúc đóng băng là lời hứa đang được giữ, phần mọc thêm sau đó là
phá vỡ.

<!-- readme:consumers -->

## Ai đang consume nó

Bộ thực thi conformance, vốn tìm ra project này qua target `conformance` và
tag gate của nó, rồi báo cáo nó trong sổ gate. Người đề nghị lật các tài liệu
của gate sang trạng thái đóng băng cũng consume nó: suite này xanh là điều
kiện tiên quyết của hành động ấy, không phải việc làm sau.

<!-- readme:ecosystem -->

## Vị trí trong hệ sinh thái

Bên trong khu vực `platform/`, đứng cạnh — không bao giờ nằm bên trong — thứ
mà nó làm trọng tài. Nó lái trực tiếp `engine-ports` và `engine-adapters` và
không phụ thuộc application service nào, vì nó phải chạy được trước khi có một
cái. Cơ chế dành cho người sửa file ở đây nằm tại [`./CLAUDE.md`](./CLAUDE.md).

<!-- readme:boundary -->

## Nó cố ý không làm gì

Nó không mang tag `layer:`: một contract port buộc phải với tới adapter để
chạy trên cả hai stack, và bất kỳ tag layer nào cũng sẽ cấm đúng điều đó. Nó
cũng không thực hiện việc đóng băng — đó vẫn là một hành động của con người,
kèm hệ quả. Và nó không làm trọng tài cho phần hành vi lưu trữ mà gate để ngỏ;
các contract SQL-read, metrics-projection và key-store sống ở
`engine-adapters` dưới dạng test thông thường.

<!-- readme:status -->

## Trạng thái

Một bộ khung trung thực: năm file, mỗi file một vùng contract, mỗi file nêu
tên các ca kiểm của mình dưới dạng TODO. **Chưa có hàm test nào** — một test
rỗng mà pass sẽ báo cáo một contract là đã kiểm trong khi chẳng có gì kiểm cả,
nên `go test` chỉ đơn giản xanh trên không ca nào, và sổ gate đọc ra một suite,
chưa đóng băng gì. Phần khẳng định sẽ hạ cánh cùng chính các interface mà nó
kiểm. Cơ chế theo thư mục nằm ở [`./CLAUDE.md`](./CLAUDE.md).
