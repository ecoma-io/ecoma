---
title: Các bước đầu tiên
description: Walkthrough nhanh từ trang chủ đến việc đọc một tài liệu.
---

# Các bước đầu tiên

Walkthrough này đưa bạn từ trang chủ công khai đến một tài liệu trong ứng dụng
docs, đi qua toàn bộ bề mặt công khai.

## 1. Mở trang chủ

Mở `https://ecoma.io` (hoặc `http://localhost:4200` khi phát triển cục bộ).
Gốc `/` là **locale-resolution entry point**: nó không phục vụ nội dung mà
chuyển tiếp đến một bề mặt đã bản địa hoá như `/en` hoặc `/vi`.

## 2. Chọn ngôn ngữ

Header hiển thị bộ chuyển đổi ngôn ngữ cho các locale có sẵn. Chọn Tiếng Anh
để đến `/en` hoặc Tiếng Việt để đến `/vi`.

## 3. Mở docs

Từ global navigation trong header, chọn **Docs**. Bạn sẽ ở `/vi/docs` — trang
điểm đến của tài liệu.

## 4. Chọn một phần

Trang điểm đến liệt kê các phần của tài liệu:

- Bắt đầu
- Khái niệm
- Hướng dẫn

Mở **Khái niệm** rồi trang **Web công khai** để tìm hiểu mô hình URL.

## 5. Đọc một tài liệu

Một trang tài liệu gồm nhiều phần:

- breadcrumbs, ví dụ `Docs → Khái niệm → Web công khai`,
- mục lục **Nội dung** ở cột phải trên màn hình rộng,
- nội dung được render, và
- điều hướng Trước / Tiếp ở cuối trang.

Dùng liên kết **Trước** và **Tiếp** để di chuyển theo thứ tự xác định trong
một phần mà không rời khỏi locale hiện tại.

---

_Trước: [Cài đặt](/vi/docs/getting-started/installation) · Tiếp:
[Khái niệm](/vi/docs/concepts)_
