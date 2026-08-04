---
name: rba-desktop
subsystem: rba
lang: vi
description: Vỏ desktop Ecoma RBA — một cửa sổ Tauri chứa design system dùng chung, và là project duy nhất biên dịch Rust trong workspace này.
---

> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# rba-desktop

Một cửa sổ desktop render design system dùng chung, và không làm gì khác.

<!-- readme:why -->

## Vì sao nó tồn tại

Để chứng minh một toolchain khi việc chứng minh còn rẻ.

Workspace này cài toolchain Rust trong CI vô điều kiện, có sẵn `Cargo.toml` ở
cấp workspace, và đã ship `core-tauri` cho window chrome của desktop — mà
trước project này thì không biên dịch dòng Rust nào. Một lane đã cấu hình
nhưng chưa từng chạy thì không phân biệt được với một lane đã hỏng; thay đổi
đầu tiên phát hiện ra điều đó lẽ ra sẽ là driver RPA thật đầu tiên — thời điểm
tệ nhất có thể để biết toolchain có vấn đề.

Vỏ này tách thất bại đó khỏi thất bại của cơ chế. Khi driver đến, phần đóng
gói, cửa sổ, việc hợp thành design system và bản build Rust đều đã biết là
tốt, và thứ duy nhất chưa được chứng minh là chính driver.

Nó **không** phải điểm khởi động track RPA. Điều kiện vào của track đó là ◆G0
đóng băng Filler interface và Session effect, và chưa cái nào diễn ra. Xem
[`../../CLAUDE.md`](../../CLAUDE.md) để biết điều đó cấm những gì.

<!-- readme:consumers -->

## Ai tiêu thụ nó

Không ai, theo đúng thiết kế — nó là application, mà application là lá.

Phụ thuộc của chính nó chạy theo chiều ngược lại: nó tiêu thụ `@ecoma-io/ui`
cho primitive và token, và sẽ tiêu thụ `@ecoma-io/core-tauri` cho window
control khi vỏ mọc thêm phần chrome cần tới. Hai thứ đó là lý do vỏ này đáng
có: chúng là bằng chứng thật đầu tiên rằng design system hợp thành được bên
trong một webview Tauri chứ không chỉ bên trong Storybook.

<!-- readme:ecosystem -->

## Nó nằm ở đâu

Project đầu tiên và duy nhất của khu vực `rba/`, đồng thời là crate Rust duy
nhất của workspace. Cả hai điều đó khiến nó gánh trọng lượng lớn hơn kích cỡ:
nó là nơi duy nhất giữ tag `scope:rba`, và là nơi duy nhất chạy `cargo`,
`clippy` và `rustfmt`.

Frontend là Vite + Vue 3, đúng stack mà Storybook host của design system dùng,
nên một component hành xử giống nhau ở cả hai nơi. Phía Rust là một composition
root mỏng: một `run()` dựng cửa sổ, và một `main` gọi nó.

<!-- readme:boundary -->

## Cái gì nó cố tình không làm

- **Không cơ chế RPA** — không driver, không perception, không session, không
  xử lý credential, không Filler. Những thứ đó chờ mốc đóng băng ◆G0.
- **Không logic nghiệp vụ của riêng nó.** Bất cứ thứ gì đáng test đều thuộc về
  một lib mà các bề mặt khác dùng chung được; một cái vỏ tích tụ logic sẽ thành
  nơi tồn tại bản sao thứ hai của một thứ gì đó.
- **Không bundle trong CI của pull request.** `bundle` dựng installer thật và
  là target của lane release; gate cho mỗi thay đổi là `lint` (chạy
  `cargo fmt --check` và `clippy`) và `test` (`cargo test`).

<!-- readme:status -->

## Trạng thái

Scaffold, và được dán nhãn trung thực là scaffold: cửa sổ mở ra, render một
tiêu đề, và mang đúng một unit test Rust.

`release-desktop.yml` dựng installer `.deb`/`.dmg`/`.msi` thật trên cả ba nền
tảng rồi tải lên làm artifact của run. Chúng **chưa ký** và không đi đâu cả:
danh tính ký và kênh phân phối chưa tồn tại, mà cũng không cần cái nào để
chứng minh pipeline đóng gói chạy được. Bộ icon là placeholder sinh từ
`product-ecoma-rba.svg`.

Build nó cần các header phát triển GTK/WebKit mà Tauri liên kết tới; một máy
thiếu chúng thậm chí không `cargo check` được crate này. Cơ chế dành cho agent,
gồm cả việc lỗi nào là môi trường chứ không phải code, nằm trong
[`./CLAUDE.md`](./CLAUDE.md).
