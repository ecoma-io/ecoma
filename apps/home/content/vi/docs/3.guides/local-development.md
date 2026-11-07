---
title: Phát triển cục bộ
description: Vòng lặp phát triển cụ thể — khởi động app, kiểm tra trang, đổi nội dung, chạy test, build.
---

# Phát triển cục bộ

Hướng dẫn này đi qua vòng lặp phát triển hằng ngày của một public app.

## 1. Khởi động app

Từ root workspace, khởi động dev server của ứng dụng public:

```bash
cd apps/home
pnpm exec nuxt dev
```

Server lắng nghe tại `http://localhost:4200` — port được pin trong `devServer`
của `nuxt.config.ts` ứng dụng. Nx target `serve` chạy cùng một lệnh đó:
`npx nx serve @ecoma-io/home`.

`host` là `0.0.0.0`, nên server cũng phản hồi trên mọi network interface của máy
bạn: mở `http://<lan-ip-của-bạn>:4200` từ thiết bị khác cùng mạng, hoặc
`http://<tailscale-ip-của-bạn>:4200` qua tailnet. Tên MagicDNS kiểu
`http://<machine>.<tailnet>.ts.net:4200` cũng dùng được. Lưu ý dev server không
có authentication — bất kỳ thứ gì truy cập được cổng này đều đọc được app, build
error và source code của nó, nên hãy ưu tiên mạng tin cậy.

## 2. Kiểm tra một trang

Mở một tài liệu trên trình duyệt, ví dụ:

```text
http://localhost:4200/vi/docs/getting-started/installation
```

Quan sát trang đã render: header với global navigation và bộ chuyển ngôn ngữ,
sidebar của docs, breadcrumbs, mục lục, và liên kết trước/tiếp. Dùng _View
Source_ của trình duyệt để xác nhận trang được server-render.

## 3. Thay đổi nội dung

Nội dung Markdown nằm dưới `apps/home/content`. Sửa một trang tiếng Việt và mở
bản tiếng Anh tương ứng để thấy cả hai:

```bash
# chọn một trang, ví dụ
$EDITOR apps/home/content/vi/docs/getting-started/local-development.md
```

`nuxt dev` nhận thay đổi; trang reload với nội dung mới.

## 4. Chạy test

Từ root workspace, chạy unit test:

```bash
pnpm exec nx test home
```

Lệnh này chạy các suite Vitest đặt cạnh ứng dụng home — gồm test path-validation
và content-resolution.

## 5. Build

Ứng dụng public là một Cloudflare Worker có SSR; build production cũng prerender
mọi trang content:

```bash
npx nx build @ecoma-io/home
```

Output nằm trong `apps/home/.output` — entry Worker trong `server/` cùng HTML
đã prerender và asset trong `public/`. Một Nx target tiêu thụ output này:

- `npx nx deploy @ecoma-io/home --configuration=staging` publish nó lên
  Cloudflare như Worker staging (`build` tự chạy trước); dùng
  `--configuration=production` cho Worker production — lệnh deploy không kèm
  configuration sẽ từ chối chạy.

Cần xem lại các trang đã prerender mà không deploy, hãy trỏ bất kỳ static file
server nào vào thư mục output, ví dụ:

```bash
npx serve apps/home/.output/public
```

---

_Trước: [Hướng dẫn](/vi/docs/guides) · Tiếp: [Xây dựng một trang công khai](/vi/docs/guides/building-a-public-page)_
