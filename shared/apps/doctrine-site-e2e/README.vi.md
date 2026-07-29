---
name: doctrine-site-e2e
subsystem: shared
lang: vi
description: Bộ Playwright chạy trên bản build của doctrine site, chốt rằng quá trình lắp ráp tạo ra những trang trình duyệt mở được.
---

> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# doctrine-site-e2e

<!-- readme:why -->

## Vì sao nó tồn tại

Trang doctrine được một công cụ lắp ráp từ Markdown. Không gì ở tầng unit nói
được rằng việc lắp ráp đã chạy đúng — rằng trang đầu trả lời đúng đường dẫn
mount, rằng sidebar dẫn tới được một tài liệu, rằng giấy phép hiện ra đúng chỗ
người đọc gặp. Đó là những sự kiện về một artifact đã build, trong một trình
duyệt thật, và đây là nơi kiểm chúng.

<!-- readme:consumers -->

## Ai tiêu dùng nó

CI, dưới dạng một cổng chặn, và bất kỳ ai sửa `doctrine-site` ở máy mình.

<!-- readme:ecosystem -->

## Nó nằm ở đâu

Cạnh `doctrine-site` trong `shared/apps`, đối xứng với `design-system-e2e` cạnh
`design-system`. Project e2e không bao giờ nằm chung chỗ với code nó chạy — nó
chạy một artifact đã build, từ bên ngoài.

<!-- readme:boundary -->

## Nó cố ý không làm gì

- **Không khẳng định về nội dung.** Một tài liệu nói đúng hay sai là câu hỏi
  dành cho tài liệu, không dành cho trình duyệt.
- **Không phủ tầng unit.** Logic điều hướng đã được chốt trong
  `@ecoma-io/doctrine`.
- **Không build.** Nx target build trước qua `dependsOn`.

<!-- readme:status -->

## Trạng thái

Đang chạy: bốn phép kiểm trên phần vỏ. Chúng lớn lên cùng trang web, không đi
trước nó. Cơ chế ở phạm vi thư mục nằm trong [`./CLAUDE.md`](./CLAUDE.md).
