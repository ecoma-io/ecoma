---
name: core-tauri
subsystem: shared
lang: vi
description: Composable điều khiển window chrome của Tauri, làm nền cho TitleBar của @ecoma-io/ui.
---

> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# core-tauri

Phần plumbing webview Tauri dùng chung cho các desktop app: composable điều
khiển window chrome làm nền cho `TitleBar` của `@ecoma-io/ui` (minimize /
maximize / close, trạng thái maximized). Hiện là substrate desktop-shell duy
nhất của workspace.

<!-- readme:why -->

## Tại sao nó tồn tại

Mọi desktop shell frameless đều cần đúng một bộ điều khiển window chrome nối
vào `TitleBar` — minimize, maximize, close, và trạng thái maximized quyết
định icon của nút. Nếu mỗi Tauri host app tự wiring lấy phần này thì các bản
sẽ trôi dạt theo thời gian (khác nhau ở thời điểm refresh `isMaximized`,
khác nhau ở xử lý lỗi). Lib này tồn tại để phần wiring đó được viết một lần
và dùng chung cho mọi desktop shell trong workspace.

<!-- readme:consumers -->

## Ai đang consume nó

Phần wiring `TitleBar` của một Tauri host app gọi `useWindowControls`
(`src/window-controls.ts`) để điều khiển component `TitleBar` của
`@ecoma-io/ui`. Hiện chưa có host app nào trong repo — lib này được build
trước khi có consumer đầu tiên, giữ làm substrate cho desktop shell Tauri
đầu tiên sẽ xuất hiện.

<!-- readme:ecosystem -->

## Vị trí trong hệ sinh thái

Một lib trong `shared/libs`: bất kỳ domain sản phẩm nào cũng import được qua
`@ecoma-io/core-tauri`, không bao giờ theo chiều ngược lại (`shared/*` không
bao giờ reach vào một domain sản phẩm — xem `shared/CLAUDE.md`). Nó ghép cặp
với `TitleBar` của `@ecoma-io/ui`: component đó sở hữu giao diện của phần
chrome, lib này sở hữu việc điều khiển cửa sổ OS thật đứng sau nó. Đây là
substrate desktop-shell duy nhất trong workspace hiện nay — một backend
desktop-shell thứ hai sẽ implement cùng hình dạng `UseWindowControls` thay
vì lib này có thêm một backend thứ hai.

<!-- readme:boundary -->

## Những gì nó cố tình không làm

- Không có tầng preload/IPC — webview của Tauri điều khiển cửa sổ của chính
  nó trực tiếp qua `@tauri-apps/api/window`, nên `useWindowControls` chính là
  toàn bộ cầu nối; việc phân tầng đó thuộc về các shell thực sự cần một bước
  IPC.
- Không cấu hình frameless — việc đó nằm ở `tauri.conf.json` của host app
  (`app.windows[].decorations: false`) và phần shell Rust của app đó.
- Không có chính sách kích thước window — đó là quyết định sản phẩm của
  từng app (xem Design System › Principles §4 của core-ui).
- Không mang kiểu dữ liệu Tauri nào trong bề mặt public — `UseWindowControls`
  là một hình dạng thuần (ref `isMaximized` + ba hàm) để một backend
  desktop-shell thứ hai có thể implement mà không phải sửa phần wiring
  `TitleBar` của host app.

<!-- readme:status -->

## Trạng thái

Đã build xong, có unit test (mock `@tauri-apps/api/window` ở ranh giới
module), chưa có host app nào trong repo dùng đến. Bằng chứng chạy thật
thuộc về e2e của host app khi có, không phải của lib này. Cơ chế và các
invariant: [`CLAUDE.md`](./CLAUDE.md).
