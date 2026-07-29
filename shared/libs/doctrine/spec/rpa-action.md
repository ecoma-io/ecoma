---
title: "Ecoma RPA Spec: Action"
status: design-end-state
lang: vi
---

# Ecoma RPA Spec: Action

## 1. Định nghĩa

Action là **một đơn vị tương tác môi trường có danh tính, có ý định, có bằng chứng**. Hai mặt của nó:

| | Action Definition | Action Instance | |---|---|---| | Là gì | Loại hành động trong vocabulary (click, type…) | Một lần thực thi cụ thể trong session | | Danh tính | id + version (entity hạng nhất, thư viện) | id + vị trí trong action log |

## 2. Vocabulary lõi (taxonomy mở)

| Nhóm | Action | Lớp mặc định | |---|---|---| | Quan sát | `observe`, `extract`, `wait_for`, `assert` | `read` — luôn an toàn | | Điều hướng | `navigate`, `scroll`, `switch_context` (tab/window/frame) | `read`* | | Thao tác | `click`, `type`, `select`, `press_keys`, `drag`, `hover` | `reversible`* | | Dữ liệu | `upload`, `download`, `clipboard` | khai báo | | Tổng hợp | **Macro** — chuỗi action đặt tên, có id + version + lineage riêng | = max của các con |

\* Mặc định của vocabulary; **App Profile override theo ngữ cảnh** (click nút "Send" là irreversible dù `click` mặc định reversible — xem §4).

- Driver mới có thể đăng ký action mới vào taxonomy (vocabulary versioned, Apache 2.0).
- Macro là cơ chế composition duy nhất — không có "sub-script" riêng.

## 3. Cấu trúc Action Instance

| Trường | Nội dung | Bắt buộc | |---|---|---| | `definition` | Tham chiếu Action Definition@version | ✅ | | `intent` | Ý định ngữ nghĩa bằng NL ("bấm nút gửi form liên hệ") — nhiên liệu của self-healing và của người đọc audit | ✅ | | `target` | **Semantic locator** (Driver & Perception spec §4) | ✅ nếu có đích | | `params` | Tham số (text gõ, phím, tọa độ kéo…) — secret chỉ được là **credential handle**, không bao giờ là giá trị (Sandbox spec) | ⬜ | | `reversibility` | `read` / `reversible` / `compensable` (+ compensation ref) / `irreversible`. **Không khai = irreversible** (nguyên tắc #3) | ✅ resolve theo cascade | | `preconditions` | Assert trạng thái scene trước khi chạy — nền của resume/reconcile | ⬜ | | `evidence` | Hash snapshot scene trước/sau (structural + visual, đã masking) — engine tự ghi | ✅ tự động | | `actor` | Identity người/agent/script đã phát action — **cùng schema cho cả ba** (nguyên tắc #1) | ✅ tự động |

## 4. Nguồn phân lớp reversibility (thứ tự resolve)

```
khai báo tại instance → Macro → App Profile → mặc định vocabulary → irreversible
```

- **App Profile** (entity hạng nhất, id + version, thư viện tenant + phân phối qua Ecoma Hub, block type `app-profile`, catalog cộng đồng Apache/CC0): tri thức theo ứng dụng — map phần tử → lớp reversibility, locator ổn định, luồng đã biết. Tương đương "template" của Platform; per-tenant learning bồi vào profile của tenant, catalog cộng đồng lo cold-start cho app phổ biến (Salesforce, SAP GUI…).
- Suy luận tự động (vision model đoán nút "Delete" là irreversible) chỉ được **đề xuất** vào profile qua vòng duyệt — không tự quyết ở runtime.

## 5. Action log

- **Append-only, content-addressed**: mỗi entry = instance + evidence hash + timestamp + kết quả. Log chính là provenance; khi tích hợp, log chiếu thẳng thành **Session effect stream** (Handoff §8) — không có bước chuyển đổi.
- **Commit point** = entry irreversible đầu tiên có kết quả thành công.
- Evidence đủ để replay-as-audit (Session spec §6): xem lại từng bước như video có cấu trúc.
- Secret đã bị masking từ tầng perception — log sạch từ gốc, không phải redact hậu kỳ (Sandbox spec §3).

## 6. Non-goals

- Action không biết script hay agent phát ra nó — chỉ biết actor identity.
- Action không tự quyết reversibility bằng suy luận runtime — chỉ resolve theo chuỗi khai báo §4.

## 7. Nhật ký quyết định

| Vấn đề | Chốt | |---|---| | Đơn vị composition | Chỉ Macro (id + lineage), không có sub-script | | Không khai reversibility | Bảo thủ: coi là irreversible | | Ngữ cảnh hóa lớp | App Profile override vocabulary; suy luận AI chỉ được đề xuất vào profile | | Log ↔ Platform | Action log chiếu 1:1 thành Session effect — một định dạng, không chuyển đổi | | Bằng chứng | Evidence trước/sau bắt buộc, tự động, đã masking |

## Litmus (spec-level, theo L5)

1. Action không khai reversibility ở mọi mắt xích của chuỗi §4 — có bị đối xử là `irreversible` không, ở cả standalone lẫn tích hợp?
2. Vision model đoán một nút là irreversible — có đường nào giá trị đó vào runtime mà không qua vòng duyệt App Profile?
3. Chỉ vào một entry bất kỳ trong action log: đọc được _ai/cái gì, ý định gì, màn hình trước-sau ra sao_, và không đọc được secret nào?
