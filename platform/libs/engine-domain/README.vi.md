---
name: engine-domain
subsystem: platform
lang: vi
description: Từ vựng domain của engine — các primitive mà mọi layer khác đều được viết theo, mỗi khái niệm một package Go.
---

> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# engine-domain

Nửa thuần khiết của engine: các khái niệm, và không có gì nói chuyện với bất
kỳ ai. Mỗi khái niệm một package Go — `eventlog`, `role`, `task`,
`checkpoint`, `handoff`, `escalation`, `calibration`, `composition`, `tenant`,
`lease`, `keytree`.

<!-- readme:why -->

## Tại sao nó tồn tại

Mọi layer khác đều được viết theo các primitive này, nên chúng buộc phải diễn
đạt được mà không cần biết ai lưu chúng hay cái gì tải chúng qua dây. Giữ
chúng trong một library riêng là thứ khiến điều đó kiểm chứng được thay vì chỉ
là nguyện vọng: một library `layer:domain` chỉ được với tới domain và util,
nên một phụ thuộc rò rỉ lộ ra ở compiler chứ không phải ở buổi review.

<!-- readme:consumers -->

## Ai đang consume nó

`engine-ports` đặt tên các interface của nó bằng chính từ vựng này,
`engine-adapters` hiện thực những interface ấy, còn application service và
composition root ra đời sau sẽ điều phối bên trên chúng. Không gì ngoài khu
vực `platform/` tiêu thụ nó, và bản thân nó không tiêu thụ gì cả.

<!-- readme:ecosystem -->

## Vị trí trong hệ sinh thái

Đứng đầu chiều `layer:domain` → `layer:port` → `layer:adapter`. Ranh giới
package bên trong là một seam đã đặt tên: một package được nâng thành library
riêng — giữ nguyên import path — khi nó có một consumer độc lập, và chỉ khi
đó. Cơ chế dành cho người sửa file ở đây nằm tại
[`./CLAUDE.md`](./CLAUDE.md).

<!-- readme:boundary -->

## Nó cố ý không làm gì

Nó không thực hiện I/O và không nói bất kỳ wire format nào. Nó sở hữu khái
niệm Filler nhưng không bao giờ sở hữu wire contract của Filler — đó là hai
thứ khác nhau, và việc ánh xạ giữa chúng thuộc về application service. Nó cũng
không giữ logic trong package gốc: một type không nằm trong seam nào là một
type đã lặng lẽ rút khỏi chính lần tách mà các seam tồn tại vì nó.

<!-- readme:status -->

## Trạng thái

Đã scaffold. Mười một package đều tồn tại, mỗi package có tài liệu nói nó sẽ
giữ gì và hiện chưa có type nào. Nội dung sẽ hạ cánh cùng đặc tả mà từng
package hiện thực. Cơ chế theo thư mục nằm ở [`./CLAUDE.md`](./CLAUDE.md).
