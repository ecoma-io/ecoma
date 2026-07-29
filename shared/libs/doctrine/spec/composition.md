---
title: "Ecoma Composition Spec: Process"
status: design-end-state
lang: vi
---

# Ecoma Composition Spec: Process

## 1. Process Definition là một Artifact

- Definition = bản khai báo đồ thị: các Role tham chiếu, Task template, Handoff (contract@version), Gate, Escalation chain, spawn_policy, effects, **và Trigger** (cửa khởi động — ecoma-spec-trigger-channel.md).
- Nó là **Artifact tuân theo Contract chuẩn `process-definition`** — nghĩa là tự động có: content-addressed hash, immutability, provenance, version + pinning, và có thể đi qua Gate. Không cần cơ chế mới.
- Capability `process_author` kiểm soát ai tạo/sửa version.

## 2. Instance semantics

- Instance **pin definition version lúc khởi chạy** — definition đổi không ảnh hưởng instance đang chạy 3 tuần (cùng logic Contract pinning, Handoff §7).
- Migration instance sang version mới là **hành động tường minh**: một Task gán cho Role có `process_author` (người hoặc AI), với Gate riêng. Không có auto-migrate ngầm.

## 3. Default cascade — cơ chế của nguyên tắc #4

- Mọi tham số engine ép tồn tại (SLA, budget, threshold, sampling, spawn_policy, N-bounce…) resolve theo chuỗi thừa kế:

```
tenant defaults → template (vertical) → process → role → task
```

- Mức dưới override mức trên; không khai = thừa kế. **Độ phức tạp là quyền lựa chọn** nghĩa là: user đơn giản chỉ chạm mức template; power user override đến từng task. Flow deterministic 20 bước khai đúng phần khác biệt.
- **Mức template = tập Block tenant đã cài** (Ecoma Hub), resolve theo thứ tự ưu tiên tenant khai; Template theo vertical chỉ là một Block được curate (ecoma-spec-block.md).
- Giá trị resolve được **snapshot vào instance lúc khởi chạy** (đổi tenant default không đổi instance đang chạy).

## 4. Static analysis — "compiler" của labor OS

Engine kiểm tra tĩnh definition trước khi cho khởi chạy, và cảnh báo lúc thiết kế:

| Kiểm tra                                                                                                                                                            | Nguồn cơ chế                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Contract producer/consumer khớp version                                                                                                                             | Handoff §7                  |
| Ranh giới unwind + đoạn không đảo ngược được                                                                                                                        | Handoff §8                  |
| Irreversible effect có sàn policy ở Gate liền trước chưa                                                                                                            | Handoff §8                  |
| Escalation chain có terminal handler                                                                                                                                | Escalation §3               |
| Role tham chiếu có pool Filler khả dụng                                                                                                                             | Role §3                     |
| Chu trình vô hạn / spawn không trần                                                                                                                                 | Task §5                     |
| Trigger có auth + correlation (với type hội thoại)                                                                                                                  | Trigger & Channel §2        |
| Collection tham chiếu nằm trong grant của Role; module knowledge có bật                                                                                             | Knowledge §2                |
| External effect tiêu thụ tri thức vượt sàn classification                                                                                                           | Knowledge §3                |
| Đường sync-response bị chặn thời gian: không `awaiting`, budget khai đủ, spawn bị trần                                                                              | Trigger & Channel §2        |
| Critical section của Lease không chứa `awaiting`; chuỗi acquire nhiều lease bị cảnh báo                                                                             | Working Data §3             |
| Query DataTable: bảng-chạm-vào ⊆ grant của Role; aggregate từ bảng mật có leakage-gate trước egress                                                                 | Working Data §1             |
| Migration major khai đường nghịch **hoặc** cờ `irreversible_migration`                                                                                              | North Star §8               |
| Contract khai `test_behavior: dry_run` mà adapter đích không khai `supports_dry_run` → **lỗi thiết kế** (resolve về `forbidden` lúc chạy, nhưng bắt được từ lúc vẽ) | Handoff §3, Test Harness §5 |
| Contract có effect **rời khỏi hệ** mà không khai `test_behavior` → **cảnh báo** (không reject: mặc định đã fail-closed)                                             | Handoff §3                  |

## 5. Pair-design = một workflow ecoma (dogfooding)

Thiết kế và sửa quy trình **chính là một process** chạy trên chính engine:

| Role trong workflow thiết kế | Filler điển hình | Việc                                                                             |
| ---------------------------- | ---------------- | -------------------------------------------------------------------------------- |
| Drafter                      | AI               | Sinh/sửa definition từ mô tả tự nhiên hoặc từ đề xuất của tầng Intelligence      |
| Validator                    | Rule             | Chạy static analysis (§4) — hard gate                                            |
| Reviewer                     | Người            | Duyệt trên canvas, sửa trực tiếp (= approve-with-edit, sinh definition dẫn xuất) |

- Vì definition là Artifact có Gate: **mọi thay đổi quy trình có Judgment, provenance, và học được** — Intelligence quan sát được cả "quy trình về quy trình": đề xuất sửa nào của AI hay bị người sửa lại, mô tả kiểu nào sinh definition đạt.
- Người và AI hoán đổi được cả ở đây (AI review definition người vẽ) — đối xứng đến tận tầng thiết kế. Đây là chỗ đứng cơ chế của quyết định sản phẩm "pair-design", không cần hệ thống riêng.

## 6. Ranh giới runtime ngoài — Ecoma RPA là instance đầu tiên

Mọi runtime ngoài (Ecoma RPA, external agent, engine automation khác) cắm vào Platform qua đúng **2 giao diện chuẩn** — không có đường tắt riêng cho bất kỳ sản phẩm nào, kể cả sản phẩm cùng monorepo. Learning signal và đề xuất đi **bên trong** Session effect stream (entry có kiểu) — không tồn tại kênh thứ ba:

|                                  | Ecoma Platform                                           | Ecoma RPA                                                                                                                                                                        |
| -------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain                           | Điều phối lao động: 5 primitive + composition + surfaces | Thực thi tương tác môi trường: browser/desktop automation, computer-use, driver                                                                                                  |
| Quan hệ                          | **Sử dụng** Ecoma RPA như một nguồn Filler               | **Cắm vào** Platform, sản phẩm độc lập, dùng riêng được                                                                                                                          |
| Giao diện cắm (chỉ 2, chuẩn hóa) |                                                          | (1) **Filler interface** (Role §3): identity + lineage, availability, capacity, cost; (2) **Session effect** (Handoff §8): action stream, reversibility per action, commit point |

- Platform **không biết** selector, vision model, hay driver — mọi chi tiết đó là domain của RPA. RPA **không biết** Gate, calibration, escalation — nó chỉ nhận task và phát effect stream.
- Hệ quả quan trọng: ranh giới này **chứng minh cơ chế plug-in là tổng quát** — external agent, n8n node, hay bất kỳ runtime nào cắm vào Platform bằng đúng 2 giao diện đó. Ecoma RPA chỉ là khách hàng đầu tiên và là bài test của chính giao diện.

## 7. Non-goals

- Composition không thêm khái niệm runtime mới — mọi thứ ở đây là cách dùng 5 primitive.
- Không có "process engine" tách biệt "task engine" — một engine, definition chỉ là artifact được diễn dịch.

## 8. Nhật ký quyết định

| Vấn đề                           | Chốt                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------ |
| Process là gì                    | Artifact tuân contract `process-definition` — không phải primitive thứ 6       |
| Definition đổi khi instance chạy | Pin lúc khởi chạy; migration là Task tường minh có Gate                        |
| Mặc định tối giản                | Default cascade 5 mức, snapshot vào instance                                   |
| Pair-design                      | Là workflow ecoma: Drafter(AI)/Validator(rule)/Reviewer(người), hoán đổi được  |
| RPA                              | Sản phẩm riêng, domain riêng; cắm qua đúng 2 giao diện Filler + Session effect |

## Litmus (spec-level, theo L5)

1. Static analysis bắt đủ mọi dòng trong bảng §4 trên một definition mẫu cố tình sai?
2. Đổi definition khi 3 instance đang chạy — cả 3 đứng yên trên pin cũ, migration là task tường minh?
3. Artifact do pair-design sinh ra có tuân contract `process-definition` và qua đúng static analysis như tay viết?
