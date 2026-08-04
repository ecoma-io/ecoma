---
name: rba
lang: vi
description: Khu vực RPA — hôm nay chỉ có một vỏ desktop, tồn tại để chứng minh toolchain Rust và Tauri trước khi các giao diện nó sẽ chứa được đóng băng.
---

> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# rba

Khu vực mà North Star đặt tên cho robotic process automation: driver, session
và self-healing giúp một Filler thao tác trên phần mềm vốn dựng cho con người.

**Gần như chưa có gì trong đó ở đây, và sự trống rỗng ấy chính là chủ ý.** Điều
kiện vào của track RPA không phải "engine xong" — mà là ◆G0 đã đóng băng hai
giao diện: Filler interface và Session effect. Khởi động cơ chế trước cái mốc
đó sẽ đẻ ra codepath thứ hai, đúng thứ mà các nguyên tắc RPA cấm thẳng.

Hôm nay ở đây có đúng một project, `apps/rba-desktop`: một vỏ desktop không
mang cơ chế RPA nào. Nó tồn tại vì toolchain phải được chứng minh ở đâu đó, và
chứng minh lúc chưa có gì để hỏng là lúc rẻ nhất.

## Vì sao vỏ đến trước cơ chế

Workspace vốn đã cài toolchain Rust trong CI, đã có sẵn `Cargo.toml`, và đã có
`shared/libs/core-tauri` cho window chrome của desktop. Cho tới project này,
không dòng Rust nào được biên dịch — lane đã khai mà chưa từng chạy, tức là
chưa từng được kiểm.

Một toolchain chứng minh muộn là toolchain hỏng vào đúng thời điểm tệ nhất:
ngày driver RPA thật đầu tiên cần tới nó, dưới áp lực thời hạn, khi bản thân cơ
chế còn đang nghi ngờ. Đưa một vỏ rỗng vào bây giờ tách hai thất bại đó ra, để
khi driver đến thì thứ duy nhất mới là driver.

## Cái gì cố tình vắng mặt

Không driver, không perception, không session, không xử lý credential, không
Filler. Mỗi thứ đó đều có spec trong cây doctrine và một gate đóng băng giao
diện của nó; chưa mốc đóng băng nào diễn ra. Code viết dựa trên một giao diện
chưa đóng băng là code sẽ phải viết lại, và roadmap nói đúng điều đó ở hàng
kiểm soát track này.

## Bố cục

| Đường dẫn           | Là gì                                                                      |
| ------------------- | -------------------------------------------------------------------------- |
| `apps/rba-desktop/` | Vỏ desktop Tauri — một webview, design system dùng chung, và không gì khác |

Cơ chế dành cho agent ở khu vực này nằm trong [`CLAUDE.md`](./CLAUDE.md).
