---
title: "Human Surface — Work Surface"
status: design-end-state
canonical-sha: 8db91e02b5cf
---

# Human Surface — Work Surface

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

## 6. Hệ quả giao diện của cơ chế

Pixel thuộc về design system. **Những điều dưới đây thì không** — mỗi điều bị ép
bởi một cơ chế đã khai ở nơi khác trong bộ hồ sơ này, và một bề mặt phá vỡ một
trong số đó là mâu thuẫn với một lời hứa của sản phẩm, chứ không phải trái ý
thích của ai. Phân biệt này quan trọng vì hai loại hỏng theo hai kiểu khác nhau:
một lỗi thị giác thì ai nhìn cũng thấy, còn một bề mặt lặng lẽ mâu thuẫn cơ chế
thì vẫn render, vẫn qua review, và vẫn trông đúng với mọi người chưa đọc cái spec
mà nó vi phạm.

**Mỗi hàng đều nêu tên cơ chế nó suy ra từ đó, và đó chính là điểm mấu chốt.** Một
nguyên tắc có nguồn được nêu tên thì suy lại được, kiểm được và cãi được. Một
nguyên tắc đứng bằng thẩm quyền của chính nó là thị hiếu mang giọng điệu của
luật, và nó trôi ngay lần đầu có ai đó cầm một lý do dễ coi để bỏ qua.

| Một bề mặt không được…                                 | Vì cơ chế nói rằng                                                                                                                                                        | Suy ra từ          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| trình bày một Judgment như thứ sửa được                | Judgment là append-only và gắn vĩnh viễn vào output; sửa sai là **một Judgment mới** với basis `re_review`, và một Judgment sau **không mở lại một Gate đã đóng**         | Checkpoint §1, §3  |
| để một escalation rời khỏi tầm nhìn mà chưa được xử lý | terminal handler là bắt buộc chính để không đường nào kết thúc trong im lặng; bỏ qua là một hành động **sinh entry**, không phải cuộn qua, thu gọn hay để cũ đi           | Escalation §1, §4  |
| render mức tin cậy thành một con số trần               | con số quyết định một Gate được ghi dưới dạng **(các cell đã đọc, estimator identity)**, và tenant là biên cứng — nên nó không so sánh được giữa các tenant               | Calibration §1, §5 |
| tự quyết định một lượt review có blind hay không       | `blind` là **giá trị template theo từng stage, không phải luật engine** — sampling mặc định blind để chặn anchoring, quick review mặc định sighted. Bề mặt đọc cờ đó      | Checkpoint §2      |
| chào một hành động mà cơ chế sẽ từ chối                | `distinct_filler_from` nghĩa là filler tạo ra output không được duyệt chính nó. Render cái nút rồi để lệnh ghi thất bại là dạy người dùng rằng hành động đó có tồn tại    | Checkpoint §2      |
| đổi bất cứ thứ gì ngoài bảng §3 mà không sinh entry    | **không có đường ghi riêng cho UI**; thứ có hệ quả lao động là một entry, thứ không có là preference phía client                                                          | §0, §3, §7         |
| trộn dữ liệu test run vào một view production          | bảng production **không thấy** write của test run — projection tách theo nhãn, nên bề mặt trộn hai thứ lại sẽ hiện một con số không ai hành động được                     | Event Log §3       |
| hiện một item đang kẹt mà không hiện cái gì chặn nó    | một Work Item mang **blocked-by** — gate đang chờ, một lease, một escalation, một conflict. "Kẹt mà không nêu lý do" là đúng sự im lặng của Escalation, tái xuất ở bề mặt | §1, Escalation §1  |

Danh sách này **mở** theo đúng cách taxonomy escalation mở: một cơ chế mới có hệ
quả lên bề mặt thì thêm một hàng ở đây, chứ không mọc ra một cái nhà thứ hai. Thứ
nó **không phải** là chỗ cho một luật mà chỗ dựa duy nhất là "trông đẹp hơn" —
luật như vậy không có phần suy dẫn nào để điền vào cột thứ ba, và chính cái cột
trống đó là phép thử.

## 7. Non-goals

- Không thiết kế màn hình/pixel (việc của design system + Track E). **Các nguyên
  tắc ở §6 không phải cùng một thứ** và không đi ra khỏi phạm vi cùng với pixel:
  chúng là hệ quả của cơ chế, và đây là nhà của chúng.
- **Không store UI phía server, không ngoại lệ nào**: không cache nào là nguồn sự thật; thứ có hệ quả lao động (watch) là **entry**, thứ không có (thứ tự cột, độ rộng, theme, bộ lọc đã lưu của riêng mắt người dùng) sống **client-side**. Án văn hai chiều: đẩy _mọi_ preference thành entry là write-amplification lên chính nguồn sự thật cho thứ 0 giá trị lao động (J6); giữ _một_ store server ngoài log là nguồn sự thật thứ hai (E5, Event Log §7). Cắt theo _hệ quả lao động_ là đường duy nhất không phạm vế nào.
- Không "chat với AI" như bề mặt chính — đó là Channel (bề mặt của _bên được phục vụ_, không phải của _người lao động_).
- Không project-management kéo-thả tự do: Work Item **sinh từ process** — "tạo việc tay" = trigger `manual` đã có, không có đường tạo việc ngoài cơ chế.

## 8. Nhật ký quyết định

| Vấn đề                                         | Chốt                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mô hình bề mặt                                 | **Work-management-first** (owner insight): 1 object model (Work Item + Action Item), 2 view chuẩn (My Work / Org Work) — inbox = một view, không phải khái niệm nền                                                                                                                                                                                                                                                                                          |
| Vì sao không phải cơ chế mới                   | Mọi trường của Work Item đã nằm trong Task/Attempt/Escalation/Lease — spec chỉ đặt tên phép chiếu                                                                                                                                                                                                                                                                                                                                                            |
| Buyer surface                                  | Org Work là bề mặt của **người mua** (chủ agency — ICP); My Work là bề mặt của người làm                                                                                                                                                                                                                                                                                                                                                                     |
| Khác biệt cạnh tranh                           | n8n/Dify: executions-list kỹ thuật; Asana/Monday: không AI workforce + Gate — khoảng trống định vị của ecoma                                                                                                                                                                                                                                                                                                                                                 |
| ◆G4                                            | = freeze projection read-API của spec này                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Preference**                                 | Cắt theo **hệ quả lao động**: watch = entry (định tuyến noti); hiển thị thuần = client-side. Không tồn tại store UI phía server — E5 kín mà không tốn write-amplification (J6)                                                                                                                                                                                                                                                                               |
| **Ai sở hữu các nguyên tắc giao diện suy dẫn** | **Tài liệu này (§6), không phải design system.** Chúng là hệ quả của cơ chế nên nằm cạnh cơ chế, mỗi cái mang chỗ dẫn cho phép suy lại. Đặt chúng lẫn giữa quy ước thị giác sẽ khiến chúng đọc như sở thích, mà sở thích thì bị bỏ qua vì những lý do dễ coi. Design system giữ pixel và trích dẫn §6; một thẻ trong `practice-index.json` định tuyến luật này tới người đang dựng bề mặt, vì một người đọc ở tầng view không bao giờ tự nhiên mở cây này ra |

## Litmus (spec-level, theo L5)

1. Xóa mọi cache/DB của bề mặt → dựng lại toàn bộ Work/Action Items từ log tương đương?
2. Một hành động bất kỳ trên bề mặt tạo **đúng entry** như làm qua API trần — không đường ghi riêng nào tồn tại?
3. Sếp trả lời "việc của khách X đang ở đâu, tắc chỗ nào, ai đang giữ" chỉ bằng Org Work — không mở log thô?
4. Nhân viên mở My Work: item sắp theo SLA, mỗi item một hành động chính rõ ràng; approve-with-edit sinh Judgment kèm diff?
5. Người không có capability trong scope: không thấy Work Item của scope đó, kể cả số đếm?
6. Lấy một hàng bất kỳ của §6 và dựng đúng cái bề mặt phá vỡ nó — có thứ gì đỏ lên không? Nếu thứ duy nhất đứng giữa sản phẩm và bề mặt đó là một reviewer tình cờ đã đọc spec cơ chế, thì nguyên tắc mới chỉ được viết chứ chưa được giữ.
7. Lấy một luật ai đó đề xuất cho bề mặt: cột thứ ba của §6 có điền được bằng một chỗ dẫn thật không? Nếu không, đó là một sở thích thị giác và thuộc về design system, bất kể nó được phát biểu bằng giọng nào.
