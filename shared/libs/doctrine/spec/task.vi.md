---
title: "Primitive: Task"
status: design-end-state
canonical-sha: dc880bf73a59
---

# Primitive: Task

## 1. Định nghĩa

Task là **một instance việc gán cho một Role**: tiêu thụ artifact vào (qua Handoff), sản xuất artifact ra (theo Contract), đi qua Gate (Checkpoint), khai báo Effect (Handoff §8).

## 2. Cấu trúc

| Trường                        | Nội dung                                                                                                                                                            | Bắt buộc                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `role`                        | Role đảm nhiệm                                                                                                                                                      | ✅                                |
| `inputs` / `output_contract`  | Handoff vào / Contract ra (pin version)                                                                                                                             | ✅                                |
| `gate`                        | Gate của Checkpoint                                                                                                                                                 | ✅ (tối thiểu auto-pass, vẫn log) |
| `effects`                     | External effects + lớp reversibility + compensation                                                                                                                 | ✅ (có thể ∅)                     |
| `budget` / `sla` / `priority` | Engine ép tồn tại; giá trị resolve theo **default cascade** `tenant → template → process → role → task` (Composition spec §3) — flow 20 bước không phải khai 20 lần | ✅                                |
| `idempotency_key`             | Cho retry an toàn với task có effect                                                                                                                                | ✅ nếu effects ≠ ∅                |
| `spawn_policy`                | Quyền và giới hạn đẻ subtask (§5)                                                                                                                                   | ✅ (mặc định: cấm)                |

## 3. Vòng đời — durable ở mọi trạng thái

```
created → assigned(filler) → in_progress → produced → gated → done
 ↘ suspended ⇄ (resume) ↘ failed → on_fail (Checkpoint §5)
```

- Mọi trạng thái sống qua restart/deploy/tuần lễ — task người treo 2 tuần là bình thường, không phải exception. Trạng thái sống trong engine, không trong đầu người (điều kiện đảo chiều n=1 đã bàn).
- `assigned` ghi **filler identity đầy đủ** — provenance và calibration cần nó.
- Cancel ở bất kỳ trạng thái nào → kích hoạt unwind theo Handoff §8 nếu effect đã chạy.

## 4. Attempt — entity hạng nhất

- Mỗi lượt thực thi là một **Attempt**: (filler identity, feedback nhận vào, artifact ra, judgment, cost, thời gian).
- Retry (Checkpoint on_fail) = Attempt mới **mang feedback có cấu trúc của Attempt trước** — retry mù bị cơ chế loại trừ.
- Reroute = Attempt mới với Filler/Role khác, cùng task id — lịch sử "AI thử 2 lần fail, người làm được" nằm nguyên trong một Task, là nhãn so sánh quý nhất cho calibration.
- **Danh tính được ghi là cái đã chạy, không phải cái được yêu cầu.** Một filler identity có thể gọi tên thứ do bên thứ ba resolve — model hosted sau một tên trôi, runtime ngoài sau một adapter — và thứ được phục vụ dưới tên đó đổi được mà không ai ở đây khai. Attempt vì thế ghi danh tính **thực sự được phục vụ** bên cạnh cái được yêu cầu, kèm bằng chứng adapter lấy được; chỗ không phân biệt nổi thì **ghi chính sự không phân biệt nổi đó**, không im lặng bỏ qua. Đây là bù trừ của Knowledge §4 áp cho lao động: thứ resolve live vẫn tái tạo được vì version _thực sự tiêu thụ_ nằm trong provenance, còn một entry khẳng định version không ai kiểm được là lời hứa log không giữ. Là **ghi nhận, không phải giấy phép** — không gì ở đây cho một danh tính không kiểm được đi qua gate lẽ ra nó trượt; nửa hành vi đã có án: adapter resolve ra hành vi khác thì đổi `config_hash` (Role §3, Checkpoint §8).
- Toàn bộ Attempt nằm trong provenance của artifact cuối.

## 5. Dynamic spawning — cơ chế hợp nhất deterministic/reasoning

Đây là quyết định kiến trúc quan trọng nhất của spec này:

- **Quy trình deterministic** = đồ thị task **khai báo trước toàn bộ** (như n8n).
- **Quy trình reasoning** = Filler (agent hoặc người) có capability `spawn_task` được **đẻ subtask lúc runtime**: tự phân rã việc, tự chọn nhánh — "rẽ nhánh phi định trước" mà BPMN không có.
- Subtask là **Task thật**: có Role, Gate, Handoff, budget riêng — không phải tool-call vô hình trong đầu agent. Reasoning của agent trở nên **nhìn thấy được, kiểm được, escalate được** bằng đúng bộ máy đang kiểm mọi thứ khác.
- **Rails (nguyên tắc #4 — phức tạp là lựa chọn của user):** `spawn_policy` khai báo: tập Role được phép gán, độ sâu tối đa, trần budget tích lũy, effect được phép (mặc định: subtask không được có irreversible effect trừ khi cho phép tường minh). Engine ép policy tồn tại; template cấp giá trị từ chặt đến mở.
- **Ranh giới "hành vi bên trong filler" vs Task** (đóng lỗ tool-call): một bước nội bộ của agent filler — gọi tool, truy hồi, suy luận nhiều lượt — là **hành vi bên trong filler**, ghi **sub-actor** trong provenance (y hệt chuyển giao script⇄agent⇄người bên RPA, RPA North Star §5), **không** phải Task. Hai biên cứng không thương lượng: (1) **mọi tác động ra ngoài hệ là Effect khai báo của Task** (Handoff §8) — không side-effect nào lọt qua đường tool-call, và effect không phân lớp = irreversible; (2) **mọi lao động cần Role/Gate/calibration riêng phải là Task** (`spawn_task`) — không được giấu lao động vào trong filler để né Gate. Tool đọc-thuần chỉ chạm được tri thức/hồi ức trong **grant của Role** (Knowledge §2, Memory §4). Hệ quả: giao thức tool bên ngoài (MCP và tương đương) là **công nghệ của agent runtime — một adapter có identity + version**, không phải giao diện thứ ba của hệ.
- Hệ quả seamless: một flow trộn tự nhiên — bước 1-3 tĩnh, bước 4 là agent tự đẻ 7 subtask (2 cái gán cho người!), bước 5 tĩnh tiếp. Cùng event log, cùng cơ chế quan sát, không có ranh giới hệ thống nào giữa hai "chế độ". Agent đẻ subtask gán cho người = **AI điều phối người** — đối xứng trọn vẹn, và là điều không hệ thống nào hiện nay có.

## 6. Duality

Task RPA không phải loại task riêng: là Task thường với filler từ Ecoma RPA (sản phẩm riêng) + **session effect** (Handoff §8) — action log là provenance, commit point tính theo action.

| Khía cạnh | Deterministic            | Reasoning / người               |
| --------- | ------------------------ | ------------------------------- |
| Đồ thị    | Khai báo trước 100%      | Mọc runtime trong rails         |
| Retry     | Idempotency key, máy móc | Attempt + feedback              |
| Gate      | Thường auto-pass + log   | Đầy đủ theo calibration         |
| Surface   | Vô hình (chạy nền)       | Inbox (người) / runtime (agent) |

## 7. Non-goals

- Task không định nghĩa năng lực (Role), không định nghĩa contract (Handoff), không đánh giá (Checkpoint).
- Không có task "ngoài luồng": mọi việc hệ thống biết đến đều là Task — kể cả việc vận hành (coercion, merge, distill, arbitrate, compensate, migrate).

## 8. Nhật ký quyết định

| Vấn đề                     | Chốt                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Retry semantics            | Attempt là entity hạng nhất, retry luôn mang feedback                                                                                         |
| Deterministic vs reasoning | Một cơ chế: đồ thị khai báo trước vs mọc runtime qua `spawn_task` trong rails                                                                 |
| Subtask của agent          | Task thật, kiểm được — không phải tool-call vô hình                                                                                           |
| AI điều phối người         | Hợp lệ mặc nhiên nhờ đối xứng (agent spawn task gán Role người lấp)                                                                           |
| Tool-call của agent        | Hành vi bên trong filler (sub-actor), **không** phải Task — nhưng mọi tác động ra ngoài vẫn phải là Effect khai báo; tool protocol là adapter |
| Idempotency                | Bắt buộc khi có effect                                                                                                                        |
| Trạng thái                 | Durable mọi trạng thái, suspended nhiều tuần là first-class                                                                                   |

## Litmus (spec-level, theo L5)

1. Attempt N+1 luôn nhìn thấy feedback của Attempt N?
2. Dynamic spawning chạm trần budget/depth → dừng + escalate, không im lặng?
3. Re-run task có external effect — idempotency key chặn effect đôi?
4. Tool-call nội bộ của agent có đường nào tạo tác động ra ngoài mà Task không khai Effect, hoặc chạm dữ liệu ngoài grant của Role?
