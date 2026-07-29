---
title: "Ecoma Spec: Human Surface — Work Surface"
status: design-end-state
lang: vi
---

# Ecoma Spec: Human Surface — Work Surface

## 0. Vị trí & luật E5

- Toàn bộ bề mặt là **projection từ Event Log** — 0 store mới, 0 cơ chế mới; spec này chỉ đặt tên các phép chiếu và hành động.
- Mọi hành động trên bề mặt đi qua **đúng engine API** như mọi client khác — không tồn tại đường ghi riêng của UI.
- Đọc qua **projection read-API — chính là ◆G4** (roadmap §1b): freeze API này là gate mở Track E.

## 1. Object model — hai khái niệm, một nguồn

| Khái niệm       | Định nghĩa                                                                                                                                                                                                                                                                                                                                                                                 | Nguồn projection                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| **Work Item**   | Một _công việc_ trong tổ chức = projection của **Task** (process instance kích hoạt = việc gốc; cây con theo Composition). Mang: title, process@version, party/client liên quan, trạng thái (từ Task states), **ai đang giữ** (filler giữ attempt/gate hiện hành), tiến độ (task con xong/tổng), SLA & deadline (Escalation timers), blocked-by (gate chờ / lease / escalation / conflict) | Task + Attempt + Composition + Escalation |
| **Action Item** | Một _việc-cần-TÔI_: gate chờ duyệt của tôi, task tôi claim được, escalation tới tôi, assistance request, conflict cần arbiter, takeover đang mời (RPA attended)                                                                                                                                                                                                                            | Checkpoint + Escalation + Lease + Session |

Luật quan hệ: **mọi Action Item trỏ về đúng một Work Item ngữ cảnh** — không bao giờ là mẩu việc rời rạc; duyệt là duyệt-trong-bối-cảnh.

## 2. Hai view chuẩn — cùng dữ liệu, khác phép chiếu

| View         | Cho ai           | Nội dung                                                                                                                                                    | Ghi chú                                                  |
| ------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **My Work**  | Mọi filler người | Action Items của tôi (sắp theo SLA/priority — _thuật toán sắp là policy template, engine ép trường tồn tại_), việc tôi đang giữ, việc tôi theo dõi (watch)  | Tên cũ: "inbox"                                          |
| **Org Work** | Theo scope RBAC  | **Cây Work Items** của workspace/tenant: nhóm theo process / client / trạng thái; bản đồ nhiệt SLA; ai-đang-giữ-gì; drill-down tới attempt, diff, live view | "Việc nào cần TÔI quyết" của sếp = Org Work ∩ My Actions |

- **Visibility = RBAC capability theo scope** (Tenant & Identity): không capability trong scope → không thấy Work Item của scope, **kể cả số đếm tổng**. Số liệu calibration của người là lớp riêng (`view_calibration`, EE — Tenant §8).
- **n=1 (D5)**: solo operator thấy My Work ≡ Org Work thu gọn — hai view hội tụ, không ai phải học khái niệm thừa.

## 3. Hành động trên bề mặt — mỗi hành động = một entry

| Hành động                                | Cơ chế nguồn                                                                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claim / release                          | Lease (TTL — Working Data §3)                                                                                                                                                                                                  |
| **Approve / Reject / Approve-with-edit** | Judgment (Checkpoint §3); edit diff là dữ liệu vàng nuôi calibration                                                                                                                                                           |
| Request assistance ("tôi không chắc")    | Escalation §2 — **cộng điểm** calibration, bề mặt phải làm nút này _dễ hơn_ liều                                                                                                                                               |
| Escalate / reassign                      | Escalation / capability                                                                                                                                                                                                        |
| Takeover (attended)                      | Session effect — diff sau takeover = approve-with-edit (RPA)                                                                                                                                                                   |
| Comment                                  | Judgment basis `comment`, trọng số 0                                                                                                                                                                                           |
| Watch / unwatch                          | **Entry `watch_changed`**: nó quyết định **ai được notification nào** ⇒ có hệ quả lao động và phải trả lời được "vì sao X được báo việc này". Taxonomy entry vốn mở (Event Log §1); danh sách watch hiện tại là **projection** |

**Diff view**: mọi artifact có trước/sau + provenance chain trích được; live view của session RPA = **Scene projection sạch** (đã chốt — không phải video thô).

## 4. Mobile & notification

- Mobile = **cùng cơ chế, rút gọn view** (đủ: My Actions + diff + approve/reject/assist) — không cơ chế riêng, không app-logic riêng.
- Notification qua **Channel adapter** (Trigger & Channel): noti là **con trỏ** tới Action Item — không mang nội dung theo classification (secret không bao giờ nằm trong push text).

## 5. Realtime & độ trễ

Bề mặt subscribe cập nhật theo **log position** (đọc projection, eventual); hiển thị có thể trễ, **hành động thì không bao giờ ghi tắt** — luôn qua engine API, engine là trọng tài cuối (stale view + hành động hợp lệ = engine từ chối bằng precondition, bề mặt hiển thị lý do).

## 6. Non-goals

- Không thiết kế màn hình/pixel (việc của design system + Track E).
- **Không store UI phía server, không ngoại lệ nào**: không cache nào là nguồn sự thật; thứ có hệ quả lao động (watch) là **entry**, thứ không có (thứ tự cột, độ rộng, theme, bộ lọc đã lưu của riêng mắt người dùng) sống **client-side**. Án văn hai chiều: đẩy _mọi_ preference thành entry là write-amplification lên chính nguồn sự thật cho thứ 0 giá trị lao động (J6); giữ _một_ store server ngoài log là nguồn sự thật thứ hai (E5, Event Log §7). Cắt theo _hệ quả lao động_ là đường duy nhất không phạm vế nào.
- Không "chat với AI" như bề mặt chính — đó là Channel (bề mặt của _bên được phục vụ_, không phải của _người lao động_).
- Không project-management kéo-thả tự do: Work Item **sinh từ process** — "tạo việc tay" = trigger `manual` đã có, không có đường tạo việc ngoài cơ chế.

## 7. Nhật ký quyết định

| Vấn đề                       | Chốt                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mô hình bề mặt               | **Work-management-first** (owner insight): 1 object model (Work Item + Action Item), 2 view chuẩn (My Work / Org Work) — inbox = một view, không phải khái niệm nền            |
| Vì sao không phải cơ chế mới | Mọi trường của Work Item đã nằm trong Task/Attempt/Escalation/Lease — spec chỉ đặt tên phép chiếu                                                                              |
| Buyer surface                | Org Work là bề mặt của **người mua** (chủ agency — ICP); My Work là bề mặt của người làm                                                                                       |
| Khác biệt cạnh tranh         | n8n/Dify: executions-list kỹ thuật; Asana/Monday: không AI workforce + Gate — khoảng trống định vị của ecoma                                                                   |
| ◆G4                          | = freeze projection read-API của spec này                                                                                                                                      |
| **Preference**               | Cắt theo **hệ quả lao động**: watch = entry (định tuyến noti); hiển thị thuần = client-side. Không tồn tại store UI phía server — E5 kín mà không tốn write-amplification (J6) |

## Litmus (spec-level, theo L5)

1. Xóa mọi cache/DB của bề mặt → dựng lại toàn bộ Work/Action Items từ log tương đương?
2. Một hành động bất kỳ trên bề mặt tạo **đúng entry** như làm qua API trần — không đường ghi riêng nào tồn tại?
3. Sếp trả lời "việc của khách X đang ở đâu, tắc chỗ nào, ai đang giữ" chỉ bằng Org Work — không mở log thô?
4. Nhân viên mở My Work: item sắp theo SLA, mỗi item một hành động chính rõ ràng; approve-with-edit sinh Judgment kèm diff?
5. Người không có capability trong scope: không thấy Work Item của scope đó, kể cả số đếm?
