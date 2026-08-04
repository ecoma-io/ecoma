---
name: website
lang: vi
description: Khu vực storefront và tăng trưởng của ecoma.io — vỏ ứng dụng Nuxt tại `/`, cổng Playwright của nó, và seam nơi funnel thuộc Website Charter (đang được giữ kín) sẽ hạ cánh.
---

> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# website

Subsystem mà bản ghi công khai của Website Charter đặt cho bề mặt ecoma.io:
storefront và tăng trưởng, tách mạnh khỏi Hub sản phẩm. Nửa kiến trúc của
charter đã được publish
([Website Charter](../shared/libs/doctrine/charter/website.md)); nửa funnel
của nó vẫn giữ kín. Thứ tồn tại ở đây hôm nay là seam mà nửa published mô tả —
topology URL, hình dạng i18n, và các app shell sẽ xuất bản bề mặt tiếp thị
khi funnel hạ cánh.

<!-- readme:why -->

## Tại sao tồn tại

Deploy charter phân hoạch sản phẩm thành các bề mặt tại URL cố định: website
tại `/` (ADR-0004 — Nuxt, SSG với ISR), doctrine tại `/doctrine`
(ADR-0007 — VitePress), design system tại một mount. Các bề mặt đó cần một
cây sở hữu, và corpus map ghi cây đó là khu vực này — không phải
`shared/apps`. Đặt bề mặt ở đây giữ storefront khỏi substrate dùng chung, vốn
phải importable từ mọi scope: một bề mặt tăng trưởng do copy tiếp thị sở hữu
không có gì để xuất cho `core-ui`.

<!-- readme:consumers -->

## Ai tiêu thụ

Khách ghé trang và crawler tìm kiếm — shell phục vụ cả người đọc lẫn bề mặt
SEO (hreflang, canonical, `robots.txt`) trong một lần. Các cổng của workspace
cũng tiêu thụ nó: mọi project ở đây mang đủ bộ kiểm tra
(`lint`, `test`, `typecheck`, `build`, cộng `e2e` trong project riêng), và hành vi
hreflang/canonical của app `site` được `site-e2e` chốt giữ để một build nội
dung tương lai không thể làm nó thoái lui trong im lặng.

<!-- readme:ecosystem -->

## Nó nằm ở đâu

Gốc repository là cha của `website/`, ngang hàng `shared/` và `cloud/`.
Topology URL và các quyết định i18n được ghi tại
[`website/CLAUDE.md`](./CLAUDE.md), nơi cũng giữ sổ deferral — tên mount của
design system (`/design` vs `/design-system`), việc di cư build theo locale
của bề mặt doctrine, sitemap, và ISR đều có seam dành sẵn ở đó. Không gì ở
đây import lib shared: shell là một bề mặt, không phải một consumer.

<!-- readme:boundary -->

## Cái gì ngoài phạm vi

Chính funnel — copy, tăng trưởng theo ICP, và các quyết định render thuộc về
Website Charter, và nửa funnel sở hữu phần copy bị giữ kín. Bề mặt doctrine sống ở
`shared/apps/doctrine-site`, không phải ở đây, và edge router (không phải cây
này) sở hữu mọi mount. System charter là duy nhất và thuộc về Hub;
`website/` ghi khu vực, không bao giờ ghi funnel.

<!-- readme:status -->

## Trạng thái

Scaffold shell: `website/apps/site` (Nuxt 4 + `@nuxtjs/i18n`, ngôn ngữ derive
từ `languages.config.json`) và `website/apps/site-e2e` (cổng Playwright). Mọi
nội dung ngoài một trang trạng thái kêu to đều bị hoãn theo charter. Khu vực
này là một seam sẵn sàng được lấp đầy, không phải một sản phẩm đang xuất bản
copy tiếp thị.
