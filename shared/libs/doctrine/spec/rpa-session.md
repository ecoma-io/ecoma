---
title: "Ecoma RPA Spec: Session"
status: design-end-state
lang: vi
---

# Ecoma RPA Spec: Session

## 1. Định nghĩa

Session là **một phiên tương tác liên tục với môi trường**: có driver gắn kèm, action log riêng, sandbox riêng, và trạng thái sống qua gián đoạn. Mọi action thuộc về đúng một session.

## 2. Vòng đời

```
created → attached(driver, sandbox) → running ⇄ paused
 ⇄ human_control
 → completed | failed | interrupted
```

| Trạng thái | Ghi chú | |---|---| | `running` | Executor (script hoặc agent — Self-healing spec) phát action | | `paused` | Durable: state = (vị trí log, evidence cuối, environment fingerprint). Sống qua restart | | `human_control` | **Takeover là trạng thái hạng nhất** (§4) | | `interrupted` | Đứt ngoài ý muốn — engine biết chính xác action nào đã chạy, đã qua commit point chưa (nhờ evidence), phát `session_interrupted` |

Session sống trên một **Node** (RPA North Star §4 — topology): node đứt kết nối server ≠ session interrupted — session tiếp tục/durable cục bộ, Session effect stream buffer và resume theo cursor khi nối lại (at-least-once, entry content-addressed tự dedupe). `interrupted` chỉ khi bản thân session/node chết.

## 3. Resume & reconcile — cơ chế chống môi trường trôi

Môi trường có thể đổi trong lúc pause (trang timeout, dữ liệu người khác sửa). Resume không bao giờ chạy mù:

1. Re-perceive scene hiện tại.
2. Chạy `preconditions` của action kế tiếp (Action spec §3).
3. Khớp → tiếp tục. Lệch → **healing loop** (Self-healing spec) hoặc escalate — theo policy cascade, mặc định bảo thủ: lệch trước commit point cho heal, lệch sau commit point escalate.

## 4. Human takeover — đối xứng đến từng cú click

- Người nhảy vào điều khiển tay giữa phiên; mọi hành động của người được driver bắt lại thành **Action instance trong cùng log**, `actor` = user identity (nguyên tắc #1). Input vào field nhạy cảm bị redact ngay tại tầng capture (Sandbox spec §3) — áp cả cho record mode.
- Handback → engine re-perceive rồi executor tiếp tục.
- Khi tích hợp: entry trong giai đoạn `human_control` mang actor người và được quy công vào **escalation task** (assistance_request) — một session phục vụ được nhiều Task của Platform; quy công theo entry `quy công actor–task` trong Session effect stream (Handoff §8).
- **Takeover diff là nhãn học**: chuỗi action người làm tay so với action executor định làm/đã fail = một Judgment kiểu approve-with-edit (actor = người) phát về lõi ML qua learning signal — nhãn quý nhất để tối ưu config agent (RPA North Star §7).
- Khi tích hợp: yêu cầu takeover chiếu thành `assistance_request` (Escalation) — người xử lý chính là một Filler, có calibration. Standalone: notification qua consumer nội bộ. **Một cơ chế, hai surface.**

## 5. Record mode — script sinh từ demonstration

- Session chạy chế độ `record`: người thao tác, runtime bắt thành action log (kèm intent do người chú thích hoặc AI đề xuất chú thích).
- **Script = sự tổng quát hóa của một action log** (Self-healing spec §2) — nghĩa là script sinh từ demonstration của người và script sinh từ lần chạy thành công của agent là **cùng một entity, cùng một đường**. Record-and-replay không phải tính năng riêng; nó là một nguồn action log.

## 6. Replay & dry-run

- **Replay-as-audit**: dựng lại phiên từ log + evidence — từng bước kèm ảnh scene trước/sau (đã masking). Trả lời trọn "ai/cái gì làm gì, lúc nào, màn hình ra sao".
- **Dry-run**: chạy lại phiên nhưng chỉ thực thi action `read`; action ghi được simulate và đánh dấu. Công cụ chuẩn để test script/App Profile mới an toàn — và là chế độ chạy của **shadow filler** khi tích hợp (Role §4: shadow không được đụng production).

## 7. Session scope (liên kết Sandbox spec)

Mỗi session khai báo scope: domain/app được phép, lớp action tối đa được phép (một session có thể **read-only** — rail chuẩn cho agent tự đẻ task RPA qua spawn_policy), credential handle được cấp. Engine ép scope tồn tại; template cấp giá trị.

## 8. Non-goals

- Session không biết quy trình lớn hơn nó — không role, không gate (việc của Platform).
- Không có nhiều executor đồng thời trong một session — chuyển giao script ⇄ agent ⇄ người là tuần tự, có dấu vết trong log.

## 9. Nhật ký quyết định

| Vấn đề | Chốt | |---|---| | Resume | Không bao giờ mù: re-perceive + precondition; policy lệch theo commit point | | Takeover | Trạng thái hạng nhất; hành động người vào cùng log; chiếu thành assistance_request khi tích hợp | | Record | Không phải tính năng riêng — một nguồn action log; script = tổng quát hóa log | | Shadow khi tích hợp | Chạy bằng dry-run mode | | Read-only session | Cơ chế scope, dùng làm rail cho dynamic spawning |

## Litmus (spec-level, theo L5)

1. Resume sau pause dài: có đường nào chạy tiếp mà **không** re-perceive + kiểm precondition?
2. Đứt giữa phiên đã qua commit point — hệ nói được chính xác action nào đã chạy, và **không** tự chạy lại?
3. Hành động của người trong `human_control` và của executor nằm cùng một log, phân biệt nhau **chỉ** bằng actor?
