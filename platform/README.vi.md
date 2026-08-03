---
name: platform
lang: vi
description: Khu vực Platform — engine của Ecoma tách theo trục layer hexagonal, cùng bộ suite conformance làm trọng tài cho mỗi gate mà roadmap đã mở.
---

> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# platform

Khu vực giữ engine của hệ điều hành lao động: từ vựng domain của nó, các
port mà từ vựng đó phơi ra, các adapter đứng sau những port ấy, và các suite
làm trọng tài cho các gate. Cấu trúc bên trong không phải thói quen — nó là
một quyết định, ghi tại
[ADR-0008](../shared/libs/doctrine/method/subsystem-structure.md), và cây này
hiện thực hóa đúng từng hàng của quyết định đó.

<!-- readme:why -->

## Tại sao tồn tại

Một khu vực là một thư mục cấp cao nhất, và nó bén rễ trong chính thay đổi
đưa project đầu tiên của nó vào, chứ không phải để dành trước. `platform/`
xứng đáng có mặt lúc này vì engine phải sống ở nơi không phải bề mặt sản
phẩm cũng không phải substrate dùng chung: `shared/` bắt buộc phải importable
từ mọi scope, mà một engine ai cũng import được là một engine không ai thay
thế nổi. Bên trong, việc tách theo trục layer hexagonal thay vì theo tính
năng khiến chiều của mọi import tương lai được quyết định một lần — tại tag
`layer:` — thay vì tranh luận lại ở từng pull request.

<!-- readme:consumers -->

## Ai tiêu thụ

Chưa có gì bên ngoài khu vực, và đó đúng là trạng thái mong đợi ở thời điểm
này: `engine-domain`, `engine-ports` và `engine-adapters` sẽ được application
service cùng composition root tiêu thụ khi chúng ra đời, còn `conformance-g0`
tiêu thụ trực tiếp port và adapter, bởi nó phải chạy được trước khi bất kỳ
application service nào tồn tại. Các cổng của workspace thì tiêu thụ cả cây
ngay hôm nay — mọi project ở đây mang `lint`, `test`, `typecheck` và `build`,
riêng suite mang thêm `conformance`, đúng target mà `dev-cli conformance`
chạy.

<!-- readme:ecosystem -->

## Nó nằm ở đâu

Gốc repository là cha của nó, giống như với `shared/` và `website/`. Một
contract mà hai domain cùng dùng không bao giờ sống trong domain nào cả — nó
thuộc về `shared/packages/`, cấp phép Apache 2.0, cũng là nơi duy nhất mà một
khu vực sản phẩm thứ hai được phép phụ thuộc vào. Bên trong cây này, chiều là
`layer:domain` → `layer:port` → `layer:adapter`; composition root, vốn có
việc là ráp adapter vào port, cố ý không mang tag layer nào. Cơ chế theo thư
mục nằm ở [`platform/CLAUDE.md`](./CLAUDE.md).

<!-- readme:boundary -->

## Nó cố ý không làm gì

Nó không giữ tầng `packages/`: tầng đó dành cho đơn vị mà bên thứ ba nhận
được, và ở đây chưa có gì được hứa cho ai. Nó cũng không giữ bề mặt sản phẩm
— storefront là `website/`, còn trang doctrine và design system là các app
shell dùng chung. Và nó không quyết định wire contract: từ vựng domain và
wire contract là hai thứ khác nhau, nên schema giao thức sống cùng bindings
của chính nó chứ không nằm trong cây này.

<!-- readme:status -->

## Trạng thái

Đã scaffold, cố ý còn rỗng. `engine-domain` mang sẵn các seam package mà lần
tách sau này sẽ cắt theo, `engine-ports` và `engine-adapters` chỉ mang vai
trò của mình chứ chưa gì khác, và `conformance-g0` mang một khung suite đã
đặt tên, phần khẳng định của nó sẽ hạ cánh cùng chính các interface mà nó
kiểm. Ranh giới layer và licence ở đây **do review giữ, không do máy kiểm** —
mọi library đều là Go, và không gì trong workspace phân tích import Go. Cơ
chế theo thư mục nằm ở [`./CLAUDE.md`](./CLAUDE.md).
