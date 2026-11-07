# THIRD-PARTY-NOTICES

Tài liệu này ghi lại nguồn gốc và giấy phép của mọi thành phần bên thứ ba có mặt trong
`libs/ui-app-shell`. Mọi mục dưới đây được xác minh riêng, không suy diễn từ giấy phép MIT của
repository nguồn.

## 1. Mã nguồn port từ repository nguồn

Phần lớn shell, layout, sidebar, navigation, breadcrumb, settings panel, theme CSS và các
component shadcn-vue trong `src/lib/shell/`, `src/lib/ui/` và `src/styles/app-shell.css` được
port/adapt từ:

- Name: nuxt-shadcn-dashboard
- Author: Dian Pratama
- Source: https://github.com/dianprata/nuxt-shadcn-dashboard
- Commit: 54988681e50feaa4935828882da93faff06cf042
- License: MIT (khai báo trong `LICENSE` của repository nguồn và trường `license` của
  `package.json` nguồn)

### MIT License (repository nguồn)

Copyright (c) 2024 Dian Pratama

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### shadcn-vue components

Các primitive trong `src/lib/ui/` là bản shadcn-vue đã được repository nguồn sao chép vào mã
nguồn của nó (shadcn-vue, MIT). Bản port ở đây giữ nguyên nguồn đó, nên nghĩa vụ ghi công của
shadcn-vue được thoả qua thông báo MIT của repository nguồn ở trên.

- shadcn-vue — https://github.com/radix-vue/shadcn-vue — MIT

## 2. Dependencies runtime

Đây là các gói mà `libs/ui-app-shell` khai báo trong `dependencies` và gọi trực tiếp lúc chạy.
Phiên bản ghi kèm là phiên bản đã resolve trong lockfile tại thời điểm viết.

| Package                    | Version | License                        |
| -------------------------- | ------- | ------------------------------ |
| `@vueuse/core`             | 15.0.0  | MIT                            |
| `class-variance-authority` | 0.7.1   | Apache-2.0                     |
| `clsx`                     | 2.1.1   | MIT                            |
| `@lucide/vue`              | 1.57.0  | ISC + MIT (xem phần ngay dưới) |
| `reka-ui`                  | 2.11.0  | MIT                            |
| `tailwind-merge`           | 3.7.0   | MIT                            |
| `tw-animate-css`           | 1.4.0   | MIT                            |
| `vaul-vue`                 | 0.4.1   | MIT (xem mục 3)                |

### `class-variance-authority` (Apache-2.0)

Khác với phần còn lại, gói này dùng Giấy phép Apache phiên bản 2.0. Bản sao đầy đủ của giấy
phép nằm trong `node_modules` của gói (`LICENSE`), không được phát hành lại trong repository
này. Khi phân phối sản phẩm phái sinh, cần giữ nguyên thông báo giấy phép và tệp `NOTICE` (nếu
có) theo điều 4 của Apache-2.0.

### `@lucide/vue` (ISC, và MIT cho phần icon gốc Feather)

Gói này là bản kế nhiệm của `lucide-vue-next`, thứ trước đây được khai báo ở đây. npm đánh dấu
`lucide-vue-next` là deprecated với nội dung "Package deprecated. Please use @lucide/vue
instead.", nên cả hai `package.json` (thư viện và workspace) đã chuyển sang `@lucide/vue`; không
còn gói deprecated nào trong `pnpm-lock.yaml`.

Giấy phép của gói gồm **hai** phần, và cả hai đều áp dụng ở đây — bản thân mã nguồn gói là ISC,
còn một danh sách icon cụ thể là tác phẩm phái sinh từ Feather và giữ giấy phép MIT:

Phần 1 — ISC, toàn văn trong `LICENSE` của gói:

> ISC License
>
> Copyright (c) 2026 Lucide Icons and Contributors
>
> Permission to use, copy, modify, and/or distribute this software for any purpose with or
> without fee is hereby granted, provided that the above copyright notice and this permission
> notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS
> SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL
> THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY
> DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF
> CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
> PERFORMANCE OF THIS SOFTWARE.

Phần 2 — MIT, áp dụng cho các icon được liệt kê trong chính tệp `LICENSE` của gói là phái sinh
từ Feather:

> The MIT License (MIT) (for the icons listed above)
>
> Copyright (c) 2013-present Cole Bemis
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software
> and associated documentation files (the "Software"), to deal in the Software without
> restriction, including without limitation the rights to use, copy, modify, merge, publish,
> distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
> Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
> BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
> DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

**Áp dụng cho thư viện này**: thư viện dùng tám icon — `Settings`, `Check`, `Search`, `Circle`,
`ChevronRight`, `PanelLeft`, `X`, `MoreHorizontal`. Bảy trong số đó có tên trong danh sách gốc
Feather của gói (`check`, `search`, `circle`, `chevron-right`, `sidebar` — tên cũ của
`PanelLeft` —, `x`, `more-horizontal`), nên phần MIT ở trên áp dụng cho chúng; `Settings` không
nằm trong danh sách đó và chỉ chịu phần ISC. Bảy icon này cũng là lý do phần MIT không thể bỏ
qua khi phân phối.

**Lưu ý về icon**: giấy phép trên áp dụng cho bộ icon của Lucide. Một số icon là **nhãn hiệu
thương mại** của bên thứ ba (brand icons) và có thể chịu điều khoản riêng của chủ nhãn hiệu,
ngoài phạm vi ISC/MIT. Bản port ở đây chỉ dùng icon hình học/UI chung của Lucide, không dùng
brand icon. Nếu sau này thêm brand icon, phải kiểm tra riêng quyền sử dụng nhãn hiệu.

**Ghi chú kỹ thuật khi chuyển gói**: hình học SVG của tám icon trên là **giống hệt** giữa
`lucide-vue-next@1.0.0` và `@lucide/vue@1.57.0` (đối chiếu `renderToString` từng icon, cùng
`viewBox`, cùng đường dẫn). Khác biệt duy nhất là tên class tiện ích mà gói tự thêm vào `<svg>`:
bản cũ thêm `lucide-<tên>-icon`, bản mới thêm `lucide-<tên>` (kèm class alias cũ cho vài icon).
Không có CSS nào trong repository đọc các class đó, nên việc chuyển gói không đổi kích thước,
khoảng cách hay cấu trúc layout.

## 3. `vaul-vue` — giấy phép không có trong tarball

Gói `vaul-vue@0.4.1` là dependency runtime thật (các component `Drawer*` trong `src/lib/ui/drawer/`
gọi trực tiếp). Bản phát hành trên npm **không có** trường `license` trong `package.json` và
**không kèm** tệp LICENSE nào — nên không thể xác minh giấy phép chỉ từ artifact đã cài.

Đối chiếu với repository thượng nguồn (nguồn có thẩm quyền cho gói này):

- Repository: https://github.com/Elliot-Alexander/vaul-vue (trường `repository.url` trong tarball
  trỏ tới đây)
- Repository này có tệp `LICENSE` ở gốc, nội dung là **MIT License**,
  `Copyright (c) 2025 unovue`
- README của gói không nhắc gì tới giấy phép

Kết luận: ghi nhận **MIT** theo khai báo của repository thượng nguồn. Đây là điểm chưa được
artifact đã cài xác nhận; nếu cần độ chắc chắn pháp lý cao hơn, nên lấy trực tiếp tệp `LICENSE`
từ repository thượng nguồn và lưu kèm khi phân phối. Gói này cũng là peer của `reka-ui ^2.0.0`
(đã có trong danh sách trên).

## 4. Fonts và assets

- **Fonts**: thư viện **không** đóng gói font nào. `--font-sans` và `--font-mono` chỉ trỏ tới
  `Geist` / `Geist Mono`, do ứng dụng tiêu thụ cung cấp (ví dụ qua `@nuxt/fonts`). Nghĩa vụ giấy
  phép của font thuộc về phía ứng dụng tiêu thụ, không thuộc thư viện này.
- **Hình ảnh**: thư viện **không** phát hành hình ảnh, icon raster hay SVG asset nào. Không có
  tham chiếu `url()` tới asset trong `src/styles/app-shell.css`. Mọi hình khối đều dựng bằng CSS.
- **Logo thương hiệu**: `AppShell` nhận logo/thương hiệu qua slot, không nhúng asset thương hiệu.
  Nội dung slot do ứng dụng tiêu thụ chịu trách nhiệm về quyền sử dụng.

## 5. Cách xác minh

Mọi trường giấy phép ở mục 2 đọc trực tiếp từ `package.json` và tệp `LICENSE` trong
`node_modules`, không sao chép từ tài liệu bên thứ ba. Riêng `vaul-vue` được đối chiếu thượng
nguồn vì artifact thiếu thông tin (mục 3).
