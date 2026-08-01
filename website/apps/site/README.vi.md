---
name: site
subsystem: website
lang: vi
description: Vỏ trang ecoma.io — ứng dụng Nuxt tại `/` (ADR-0004) xuất bản bề mặt tiếp thị bằng en/vi/zh khi Website Charter hạ cánh.
---

> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# site

Vỏ trang ecoma.io: ứng dụng Nuxt tại `/` sẽ xuất bản storefront khi Website
Charter hạ cánh. Hôm nay nó chứng minh hệ thống đường ống charter sẽ xây
trên đó — topology URL (`/`, `/vi`, `/zh`), hình dạng i18n, và bề mặt SEO
(hreflang, canonical, `robots.txt`) — với một trang trạng thái trung thực
và không một dòng copy tiếp thị.

<!-- readme:why -->

## Tại sao tồn tại

ADR-0004 giao trang tại `/` cho Nuxt (SSG với ISR). Website Charter, bị giữ
kín, sở hữu funnel và copy; app này là seam biến các quyết định đã ghi thành
một artifact chạy được, deploy được — và là artifact `site-e2e` gác cổng, để
hợp đồng SEO không thể mục nát vô hình khi build nội dung diễn ra sau đó.

<!-- readme:consumers -->

## Ai tiêu thụ

Khách ghé trang và crawler của ecoma.io — mỗi ngôn ngữ một trang, với
`html lang`, hreflang alternates, canonical và `og:locale` sinh từ
`useLocaleHead` thay vì viết tay. Project Nx `site-e2e` tiêu thụ bản build
`dist/` làm cổng chặn của nó.

<!-- readme:ecosystem -->

## Nó nằm ở đâu

`website/apps/site`, tag `type:app`, `scope:website`. Ngôn ngữ derive từ
`languages.config.json` ở gốc repo lúc build; base URL canonical derive từ
trường `homepage` của `package.json` gốc. Cả hai được đọc, không bao giờ sao
chép (Rule 14). Mechanics và seam preview-`noindex` ở
[`./CLAUDE.md`](./CLAUDE.md); sổ deferral của khu vực ở
[`../../CLAUDE.md`](../../CLAUDE.md). Các target: `lint`, `typecheck`, `test`,
`build`, `serve` — cộng `e2e` trong project riêng của nó.

<!-- readme:boundary -->

## Nó không phải là gì

Không phải bề mặt doctrine (`shared/apps/doctrine-site` sở hữu `/doctrine`)
và không phải design system (`shared/apps/design-system` sở hữu mount
`/design`). Nó không import lib shared nào — một bề mặt, không phải một
consumer. Và nó không phải Website Charter: funnel, copy và công việc ICP
hạ cánh ở đó, không phải trong shell này.

<!-- readme:status -->

## Trạng thái

Scaffold shell — SSG qua `nuxt generate`; ISR, sitemap, và nội dung storefront
thật là các seam được dành sẵn (xem sổ deferral trong
[`./CLAUDE.md`](./CLAUDE.md)).
