---
name: site-e2e
subsystem: website
lang: vi
description: Cổng Playwright chặn trên shell ecoma.io đã build — nó chốt hợp đồng SEO của site (lang, hreflang, canonical, robots) ở mức artifact.
---

> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# site-e2e

Cổng Playwright chặn trên shell trang ecoma.io đã build (`site`). Nó lái
artifact `dist/` do `nuxt generate` sinh ra và chốt hợp đồng SEO mà một
build nội dung tương lai không được làm thoái lui: `html lang` theo locale,
hreflang alternates kèm `x-default`, canonical trỏ về origin sản xuất,
switcher ngôn ngữ, và `robots.txt`.

<!-- readme:why -->

## Tại sao tồn tại

Bề mặt SEO của shell được `@nuxtjs/i18n` sinh từ một file cấu hình — một
`<link rel="alternate">` viết tay hay một canonical thiếu trong build nội
dung sau này sẽ lọt qua mọi lint. Đọc HTML đã build thay vì nguồn chốt đúng
thứ thực sự ra tay, cùng lý do các suite e2e khác quét artifact thay vì mã
nguồn.

<!-- readme:consumers -->

## Ai tiêu thụ

Mọi thay đổi đụng `site` — `nx affected` chạy suite này mỗi khi build của
app đổi, và target `e2e` phụ thuộc build đó, nên artifact đang kiểm không
bao giờ cũ.

<!-- readme:ecosystem -->

## Nó nằm ở đâu

`website/apps/site-e2e`, tag `type:e2e`, `scope:website`. Nó chạy qua
`dev-cli run-e2e` (xvfb trên Linux, shim trình duyệt một chỗ) và phục vụ
`dist/` đã build qua `vite preview` tại port 4176. Mechanics ở
[`./CLAUDE.md`](./CLAUDE.md).

<!-- readme:boundary -->

## Cái gì ngoài phạm vi

Nửa preview-`noindex` của hợp đồng robots: chứng minh
`NUXT_PUBLIC_PREVIEW=true` thêm robots meta cần một build thứ hai, nên nó
được kiểm bằng tay và ghi trong `site/CLAUDE.md` — suite không bao giờ
nhận coverage nó không có.

<!-- readme:status -->

## Trạng thái

Một file suite (`shell.e2e.test.ts`) phủ hợp đồng SEO của shell — mechanics ở
[`./CLAUDE.md`](./CLAUDE.md), suite ở [`./src`](./src).
