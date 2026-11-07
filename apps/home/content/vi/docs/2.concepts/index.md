---
title: Khái niệm
description: Các ý tưởng nền tảng của nền tảng web công khai Ecoma.
---

# Khái niệm

Phần này giải thích những ý tưởng định hình nền tảng. Nên đọc trước các hướng
dẫn để walkthrough thực tế dễ hiểu hơn.

## Nội dung

- [Web công khai](/vi/docs/concepts/public-web) — mô hình URL công khai và cách
  `/<locale>/<mount>/<path>` được parse và dựng.
- [Nội dung và ngôn ngữ](/vi/docs/concepts/content-and-locales) — cách nội dung
  tài liệu được bản địa hoá và cách content path ánh xạ sang public route.

## Vì sao có hai trang này

Bề mặt công khai của Ecoma được xây từ một tập contract nghiêm ngặt: locale
luôn là segment đầu tiên, mount xác định application, và phần còn lại của path
là opaque với nền tảng. Hiểu các contract đó giải thích gần như mọi quyết định
bạn gặp về sau.

---

_Tiếp: [Web công khai](/vi/docs/concepts/public-web)_
