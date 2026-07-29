---
title: "Ecoma Hub — North Star"
status: design-end-state
lang: vi
---

# Ecoma Hub — North Star

## 1. Tuyên bố end state

**Ecoma Hub là hạ tầng đóng gói–phân phối–chia sẻ mọi entity của hệ ecoma dưới dạng Block: một registry protocol duy nhất (content-addressed, ký danh, transparency log), một public instance immutable, N private mirror, một index/marketplace — nơi cộng đồng nối dài đuôi tri thức quy trình và publisher sống được bằng việc bảo trì nó. Hub vắng mặt, mọi runtime đã cài vẫn chạy vĩnh viễn.**

## 2. Bài toán

- "Template" là khái niệm chịu lực của default cascade nhưng cần một cơ chế phân phối thật; App Profile cần catalog; long-tail connector/quy trình không thể do một công ty tự viết.
- Tri thức quy trình (criteria, ngưỡng, escalation chain, App Profile) **là loại nội dung bị lão hóa** — app đổi UI, quy định đổi. Chia sẻ mà không có kinh tế bảo trì = nghĩa địa template. Hub ghép cơ chế phân phối với động cơ kinh tế (marketplace) để nội dung sống.

## 3. Nguyên tắc cơ chế (kế thừa canonical North Star §3, chuyên biệt hóa)

1. **Hub không bao giờ chạm runtime**: không entitlement check lúc chạy, không phone-home, không license key trong engine. Thương mại hóa dừng ở tầng phân phối (pull/update).
2. **Digest là sự thật, semver là giao diện người**: máy pin digest (lockfile), người nói `name@range`. Public instance immutable — đã publish không xóa, chỉ `yank` (ẩn khỏi resolve, pin cũ sống mãi).
3. **Không tin publisher**: tenant re-run static analysis khi cài; manifest khai ≠ phân tích phát hiện → reject. Chữ ký + transparency log chống giả mạo xuyên mirror.
4. **Trust nội dung tái dùng cơ chế sẵn có**: filler trong block khởi động ở tier `gated/shadow` (không calibration tenant); block chứa irreversible effect bị ép sàn Gate — không có hệ kiểm duyệt runtime riêng.
5. **Hub mù dữ liệu tenant**: không thấy calibration, không nhận telemetry trừ opt-in; publisher chỉ thấy installs/revenue.

## 4. Kiến trúc ba tầng

| Tầng            | Nội dung                                                                                           | Ghi chú                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Registry**    | Kho artifact chuẩn OCI: digest, chữ ký publisher (sigstore keyless), attestation, transparency log | Private = mọi OCI registry sẵn có; air-gap mirror bằng lệnh chuẩn                                       |
| **Index**       | Catalog: search, namespace publisher/name, trang block, badge verified, version history            | Namespace sở hữu qua publisher identity — chống squatting bằng định danh, tranh chấp là policy vận hành |
| **Marketplace** | Listing, giá, **entitlement**, thanh toán, payout revenue-share                                    | Lớp thương mại mỏng trên index — không phải hệ thống riêng                                              |

Frontend của Index/Marketplace là app thuộc `hub/apps/` (domain này sở hữu); public instance được operator mount tại `ecoma.io/hub` qua edge — SEO long-tail của catalog (Website Charter §3b), **code không rời domain**; render **tĩnh-first (SSG+ISR revalidate theo registry event)** — hệ quả trực tiếp của tính bất biến nội dung: trang block-version cache vĩnh viễn, chỉ con trỏ revalidate.

Kênh dev song song: block phát triển trên git (fork/PR = lineage + review); `pack` → ký → push OCI là bước phát hành. Escape hatch: `add git+https://…@<sha>` gắn nhãn `unverified` cho dev/nội bộ.

## 5. Client interface — một và duy nhất

Platform và RPA (kể cả RPA standalone — nguyên tắc #5 của RPA) nói với Hub qua đúng ba động từ: **`resolve` / `pull` / `verify`**. Hub không biết block chạy thế nào; runtime không biết block được lưu/bán thế nào. Interface + manifest schema là **Apache 2.0** — bên thứ ba dựng registry tương thích tự do.

## 6. Marketplace — cơ chế

- **Entitlement kiểm duy nhất tại phân phối** (pull/update, kể cả mirror pull namespace trả phí). Hết hạn subscription → bản đã cài chạy mãi (pin digest), chỉ mất update stream.
- Mô hình giá: free (Apache/CC0) / one-time (entitlement vĩnh viễn theo major) / subscription (quyền pull update stream) / site license (theo tổ chức, listing private).
- **Không DRM**: definition là văn bản, copy được về kỹ thuật — giá trị bán là update stream + bảo trì (App Profile theo kịp UI đổi) + trust publisher verified. Subscription App Profile chính là câu trả lời kinh tế cho "ai bảo trì automation khi UI đổi".
- Hai tầng license nội dung: catalog free = Apache/CC0; block trả phí = EULA của publisher — khai tường minh lúc publish.
- Publisher thấy installs/revenue, không bao giờ thấy dữ liệu/calibration tenant.

## 7. Trust & chuỗi cung ứng

- Publish: pack (schema + **full static analysis ngay lúc pack**) → ký → push → index. Knowledge Collection trong block: **public instance chỉ nhận classification `public`** (declassify-qua-Gate đứng chắn trước mọi lần publish); private registry theo policy tenant.
- Badge **verified**: vòng review là **một workflow ecoma** — Hub tự vận hành như một tenant Platform cho quy trình curation (dogfooding); kết quả là attestation ký đính vào artifact.
- **Chống tự-duyệt (bắt buộc, vì đây là cửa duy nhất cho artifact `code`)**: Role reviewer khai `distinct_filler_from` publisher (Checkpoint §2) và do operator lấp — publisher **không bao giờ** lấp Role duyệt block của chính mình; mỗi kết quả là Judgment có chữ ký, calibration của reviewer chịu outcome lan ngược như mọi Role.
- **Thu hồi (`unverify`)** là hành động có event: digest đã ký **không đổi** (bất biến), nhưng badge rụng, artifact `code` của publisher đó **quay lại mặc định reject**, và index xử như `yank` — pin cũ sống, resolve mới không thấy.
- **Suite do publisher cung cấp — biên cứng**: block/template được phép mang **conformance suite riêng** để chứng minh nó chạy đúng (Test Harness §8). Ba giới hạn không thương lượng: (1) suite là **bằng chứng phụ, không bao giờ là điều kiện đủ** — badge do **Judgment của reviewer** cấp; (2) suite chạy trong **test run scope của operator**: `test_behavior` **`forbidden` toàn phần**, **0 credential handle**, trần thời gian/tài nguyên/chi phí model; (3) với trust class **`code`**, vòng duyệt **chặn bởi spec `runtime sandbox`** (ledger) — nếu không sẽ có **vòng tròn**: muốn verified phải chạy code, mà chạy code lại đòi verified. Án văn: cửa verified là cửa **duy nhất** cho artifact `code`, nên chính nó không được trở thành đường thực thi code chưa duyệt (persona `publisher block độc`, nhóm N).
- Artifact **code** (driver, custom rule filler) là trust class riêng: mặc định reject nếu publisher chưa verified (giá trị template), cài phải opt-in tường minh của admin — code không static-analysis kín được như definition.
- Install phía tenant: verify chữ ký/log → re-analyze → **scope disclosure** (irreversible? credential? domain? spawn?) hiển thị trước khi cài → materialize có provenance → quarantine bằng trust tiers → lockfile.

## 8. Litmus của Hub

1. Rút phích Hub — mọi tenant đã cài vẫn chạy đủ, vĩnh viễn?
2. Cùng một block cài được từ public, private mirror, và air-gap — cùng digest, cùng chữ ký verify được?
3. Block khai thiếu năng lực trong manifest → tenant install **reject**, không phải warning?
4. Publisher biến mất — người mua giữ nguyên mọi thứ đã cài?
5. Hai block mang hai version Contract khác nhau cùng cài — không xung đột (nhờ pinning per-entity)?
6. Publisher có đường nào tự duyệt block của chính mình để lấy badge verified? Badge thu hồi được, và artifact `code` mất quyền cài mặc định ngay sau đó?

## 9. Non-goals

- Không chạm runtime; không license key/phone-home trong engine.
- Không nhận telemetry mặc định; không học cross-tenant; ML nội bộ của index (ranking/search) không bao giờ chạm calibration tenant.
- Không phải CI/CD hay git host — dev ở git, Hub chỉ nhận artifact đã pack.
- Không hứa refund/chính sách thương mại trong spec cơ chế — đó là vận hành.

## 10. Phân phối

- Monorepo: area `hub/` (convention area-first). **License: theo luật phân loại canonical tại North Star §8** — "cắm vào → Apache 2.0" (protocol `resolve/pull/verify`, manifest schema, client library) / "chạy → SUL" (hub service). Spec này **không khai lại** để không sinh nguồn sự thật thứ hai (E5,).
- Dòng doanh thu #4 của hệ: **marketplace revenue share** (tỉ lệ là quyết định kinh doanh; tiền lệ ngành 70/30–80/20).
