---
title: "Ecoma Spec: Trigger & Channel"
status: design-end-state
lang: vi
---

# Ecoma Spec: Trigger & Channel

## 1. Định nghĩa

| Entity      | Là gì                                                                                                                                           | Danh tính                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Trigger** | Cơ chế khai báo trong Process definition: khi sự kiện X đến thì (a) spawn instance mới, hoặc (b) bơm input vào instance đang chờ                | id + version, thuộc definition |
| **Channel** | Adapter biên cho hội thoại hai chiều với bên ngoài (chat widget, Messenger/Zalo, Slack, email, SMS…) — taxonomy mở, cùng pattern Driver của RPA | (type, id, version) + lineage  |

## 2. Trigger

| Trường             | Nội dung                                                                                                                                                                   | Bắt buộc              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `type`             | Taxonomy mở: `webhook` / `event` / `schedule` / `message_in(channel)` / `manual` / `form`                                                                                  | ✅                    |
| `auth`             | **Engine ép tồn tại**: signature (HMAC), token, mTLS, hoặc `tenant_session` (manual/schedule nội bộ). Không auth hợp lệ = reject tại biên, không sinh instance             | ✅                    |
| `payload_contract` | Payload vào hệ **qua Handoff với Contract** — producer là nguồn ngoài; vi phạm schema = Violation → reject/coerce như mọi handoff. Không có "JSON thô chảy thẳng vào flow" | ✅                    |
| `dedup`            | Event-id + cửa sổ dedup (engine ép tồn tại, template cấp giá trị) — at-least-once từ thế giới ngoài không sinh instance trùng                                              | ✅                    |
| `correlation`      | Biểu thức khóa (vd conversation-id) quyết định: spawn mới hay định tuyến vào instance đang chờ                                                                             | ✅ với type hội thoại |
| `guard`            | Rate/budget tại biên — storm từ ngoài không tràn vào engine (tái dùng tinh thần storm control của Escalation)                                                              | ✅                    |

**Response mode — sync request-response (kiểu API endpoint n8n / BaaS Dify):**

- Trigger `webhook` khai `response_mode: async (mặc định) | sync`. Sync khai thêm: `response_from` (output artifact của một task chỉ định, qua Contract — pin version), `time_budget`, `on_timeout: fail | degrade_to_async` (trả ticket-id, instance chạy tiếp async, durable).
- **Respond là một effect `irreversible`** — thừa kế trọn luật effect: ghi log, egress theo classification, leakage-gate áp được lên response (API endpoint không rò tri thức internal _về cấu trúc_).
- **Không tồn tại đường timeout→pass**: `on_timeout` chỉ fail hoặc degrade — nhất quán invariant "không bao giờ auto-pass vì bế tắc".
- Ràng buộc sync path là **time budget, không phải loại filler**: filler nào vừa budget đều hợp lệ — người bị loại bởi vật lý, không bởi luật engine (đối xứng). Static analysis ép: path tới `response_from` không chứa trạng thái `awaiting`, mọi bước khai budget, spawn trên path bị trần.
- Idempotent tự nhiên: retry cùng event-id trong dedup window → trả **cached response** (artifact content-addressed).

## 3. External participant là một Role — cơ chế hội thoại

Đẩy nguyên tắc đối xứng tới cùng: **khách bên ngoài (end-user) là Filler loại `external`** lấp một Role trong process (vd Role "Khách hàng"), identity = danh tính kênh (messenger-user-id…).

- Hội thoại = **chuỗi Task luân phiên**: Task của Role Agent (AI/người trả lời) → Handoff → Task của Role Khách (chờ reply) → reply của khách = output của task đó → Handoff về Agent. Instance chờ khách = Task `awaiting` durable — khách quay lại sau 3 ngày, trạng thái còn nguyên (cơ chế Task sẵn có, không thêm gì). Correlation đồng thời tạo **subject binding** cho instance — cửa vào của Memory module (Memory spec §1).
- Reply của khách **đi qua Gate được** = input validation/moderation bằng chính Checkpoint — không cần hệ lọc riêng.
- Calibration trên external filler: cơ chế tồn tại (đối xứng), **mặc định tắt** — bật là quyết định policy/privacy của tenant. Định danh chi tiết end-user: **Party** (Tenant & Identity §5) — đã chốt.
- Human handoff của chatbot = `reroute`/`assistance_request` sẵn có — không phải tính năng riêng.

## 4. Channel

- Channel chỉ **dịch**, không giữ logic: inbound → trigger `message_in`; outbound → **effect** (gửi tin mặc định `irreversible`), chịu mọi guard của effect: sàn confidence của Gate liền trước, và **egress theo classification** (Knowledge spec §3).
- Khai `capabilities` (rich text, attachment, typing indicator…) — process dùng vượt capability = lỗi static analysis.
- Channel adapter interface: Apache 2.0, bên thứ ba viết tự do — đúng logic Driver.

## 5. Duality

|             | Deterministic (kiểu n8n)                                 | Conversational (chatbot)                                 |
| ----------- | -------------------------------------------------------- | -------------------------------------------------------- |
| Trigger     | webhook/schedule/event                                   | message_in + correlation                                 |
| Hình dạng   | Pipeline khai trước                                      | Task luân phiên Agent ⇄ Khách, đồ thị mọc theo hội thoại |
| Cùng cơ chế | Handoff-contract tại biên, dedup, guard, effect outbound | Y hệt                                                    |

## 6. Non-goals

- Không xây messaging platform / không phải API gateway tổng quát — Channel chỉ là cửa của process.
- Trigger không chứa logic định tuyến nghiệp vụ (việc của Role/Task) — chỉ auth, hợp lệ hóa, correlation.

## 7. Nhật ký quyết định

| Vấn đề                | Chốt                                                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payload vào hệ        | Luôn là Handoff có Contract — không có đường thô                                                                                                                              |
| Auth                  | Engine ép tồn tại; không auth = reject tại biên                                                                                                                               |
| Hội thoại nhiều lượt  | Correlation + Task `awaiting` durable; end-user = Filler `external` của một Role                                                                                              |
| Moderation input      | = Gate trên output của Role Khách — tái dùng Checkpoint                                                                                                                       |
| Gửi tin ra ngoài      | Effect irreversible mặc định + egress theo classification                                                                                                                     |
| Sync request-response | `response_mode: sync` opt-in; respond = effect; timeout chỉ fail/degrade, không bao giờ pass; ràng buộc = time budget (không phải loại filler); cached response theo event-id |
| Calibration khách     | Cơ chế có, mặc định tắt (privacy)                                                                                                                                             |

## Litmus (spec-level, theo L5)

1. Trigger không auth hợp lệ bị reject tại biên — không sinh instance, có event?
2. Tin nhắn thứ 2 của cùng hội thoại vào đúng instance cũ qua correlation?
3. Sync-response: timeout chỉ fail/degrade — không tồn tại đường thành pass?

## FMEA (theo F8)

| Hỏng                               | Phát hiện                  | Phục hồi                                                  |
| ---------------------------------- | -------------------------- | --------------------------------------------------------- |
| Webhook giả mạo                    | Auth verify fail           | Reject tại biên + event, không sinh instance              |
| Event trùng từ nguồn ngoài         | Dedup window theo event-id | Bỏ qua; sync trả cached response                          |
| Channel adapter down               | Outbound effect fail       | on_fail/escalate; inbound: nguồn retry + dedup hấp thụ    |
| Verifier leakage quá budget (sync) | time_budget                | on_timeout: fail hoặc degrade ticket — không bao giờ pass |
