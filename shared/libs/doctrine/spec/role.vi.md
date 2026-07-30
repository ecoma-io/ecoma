---
title: "Primitive: Role"
status: design-end-state
canonical-sha: c766cacbd1b4
---

# Primitive: Role

## 1. Định nghĩa

Role là **hợp đồng năng lực cho một vị trí lao động** — độc lập với việc ai/cái gì đang lấp nó. Tách bạch nền tảng:

|             | Role (vị trí)                             | Filler (người lấp)             |
| ----------- | ----------------------------------------- | ------------------------------ |
| Là gì       | Slot: làm gì, theo tiêu chí nào, quyền gì | Occupant: người / agent / rule |
| Danh tính   | id + version                              | identity riêng (§3)            |
| Đổi cái này | Sửa quy trình                             | **Không sửa quy trình**        |

Đây chính là cơ chế trả lời litmus #1: _đổi một bước từ người sang AI không phải sửa flow_ — vì flow chỉ biết Role, không biết Filler.

## 2. Cấu trúc Role

| Trường              | Nội dung                                                                                                                              | Bắt buộc      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `io_contracts`      | Tham chiếu Contract (Handoff) cho input/output — Role "nói" contract nào                                                              | ✅            |
| `held_criteria`     | Tham chiếu Criterion (Checkpoint) mà output của Role bị chấm theo                                                                     | ✅            |
| `capabilities`      | Quyền hạng nhất: `judge`, `contract_author`, `process_author`, `role_author`, `arbiter`, `spawn_task`, `override_gate`… — taxonomy mở | ✅ (có thể ∅) |
| `assignment_policy` | Cách chọn Filler khi có nhiều: `static` / `queue` / `router:<role>` (định tuyến là Task của một Role) / chiến lược cắm thêm           | ✅            |
| `escalation_chain`  | Chuỗi xử lý khi lệch chuẩn — xem Escalation spec                                                                                      | ✅            |
| `graduation_policy` | Điều kiện thăng/giáng trust tier của Filler (§5) — ngưỡng resolve theo default cascade (Composition §3)                               | ✅            |
| `constraints`       | Trần cost, latency, giờ hoạt động                                                                                                     | ⬜            |

**Role hệ thống không tồn tại**: Arbiter, Distiller, Merger, Adapter, Coercer, Router (đã xuất hiện ở Checkpoint/Handoff) đều chỉ là Role thường với contract phù hợp. Engine không có node đặc quyền — mọi lao động, kể cả lao động vận hành hệ thống, đi qua cùng cơ chế.

## 3. Filler

| Loại      | Identity (khóa calibration)                                    | Availability                                        | Cost                 |
| --------- | -------------------------------------------------------------- | --------------------------------------------------- | -------------------- |
| Người     | user id                                                        | Giờ làm việc, capacity, nghỉ phép — **tự khai báo** | Lương/giờ hoặc /task |
| Agent     | `(model, version, config_hash)` — cùng logic verifier identity | Rate limit, concurrency                             | Token/compute        |
| Rule/code | `(code, version)`                                              | Luôn sẵn sàng (trừ dependency)                      | ~0                   |

- Engine đối xứng tuyệt đối: cả ba khai cùng schema (identity, availability, capacity, cost function). Không có nhánh if-human.
- **Identity lineage** (chống reset flywheel): agent identity mới (đổi prompt/config/model) khai báo `parent_identity`; calibration profile **kế thừa từ cha với hệ số decay** (tham số lớp C, template cấp giá trị). Vòng tiến hóa chuẩn của filler: config mới → shadow (§4) → graduation thay cha. Không có lineage, mỗi lần tầng Intelligence tối ưu prompt là một lần tự đốt calibration — mâu thuẫn chết người với per-tenant learning.
- **Filler từ sản phẩm ngoài**: Ecoma RPA (sản phẩm riêng, domain tách biệt) và mọi runtime ngoài đăng ký filler qua cùng schema này; hành động ra môi trường của chúng đi qua **Session effect** (Handoff §8). Platform không biết công nghệ bên trong filler — chỉ biết identity, availability, cost, và effect stream.
- **Filler loại thứ tư: `process`** — Role được lấp bởi một Process definition@version: task gán role đó = spawn instance con, output = artifact cuối của instance con. Sub-process invocation (sub-workflow kiểu n8n/BPMN) không cần khái niệm riêng; calibration trên process-filler = chất lượng của **cả quy trình con**, và shadow ở cấp process (A/B hai quy trình cạnh tranh, chọn bằng outcome) rơi ra miễn phí từ chính cơ chế shadow sẵn có.
- **Calibration profile** tích lũy theo `(role, filler_identity, task_type, criterion)` — nguồn: toàn bộ hệ Judgment. Đây là câu trả lời litmus #3 (một thang tin cậy duy nhất cho người lẫn AI) và litmus #4 (cost + quality theo Role bất kể ai lấp).
- **`environment: production | test`**: một chiều của Filler identity, **độc lập với trust tier**. Filler `environment: test` (mock filler — Test Harness §3) **không đủ tư cách được gán vào task production**, bất kể tier của nó là gì. Án văn: mức-tin-cậy và môi-trường là hai trục; trộn vào một enum tier sẽ tạo nguồn sự thật thứ hai cho taxonomy tier (E5/G6) và làm bảng §5 nói hai chuyện.
- Một Role có **pool Filler**; một Filler lấp được nhiều Role.

## 4. Shadow mode (litmus #2)

- Role gắn được **shadow filler**: chạy song song với primary trên cùng task, output shadow **không chảy vào flow**, chỉ sinh Artifact + được chấm bởi cùng Gate criteria.
- Engine tự sinh **bảng đối chiếu** primary-vs-shadow theo criterion, cost, latency từ Judgment data — không cần công cụ ngoài.
- Judgment trên shadow output mang provenance `shadow: true` — nuôi calibration của shadow filler mà không rủi ro production.
- Đối xứng: shadow người sau AI cũng hợp lệ (đào tạo nhân sự mới bằng cách chạy bóng quy trình thật).

## 5. Trust tiers & graduation — cơ chế dịch chuyển lực lượng lao động

| Tier         | Output đi đâu                        | Điều kiện lên                         |
| ------------ | ------------------------------------ | ------------------------------------- |
| `shadow`     | Không vào flow, chỉ học              | Calibration đạt ngưỡng so với primary |
| `gated`      | Vào flow, 100% qua review            | Tỉ lệ approve ≥ X trên ≥ N mẫu        |
| `sampled`    | Auto-pass + sampling (Checkpoint §4) | Reject rate trong mẫu ≤ Y             |
| `autonomous` | Auto-pass, sampling tối thiểu        |                                       |

- Thăng/giáng **tự động theo `graduation_policy`** — engine ép policy tồn tại, template cấp ngưỡng; user override được (nguyên tắc #3, #4).
- Giáng lập tức khi calibration sụt (liên thông cơ chế "tự siết" của Checkpoint §4).
- Tier gắn với `(filler, role, task_type)` — một agent autonomous ở việc này vẫn gated ở việc khác.
- Đây là **câu chuyện sản phẩm cốt lõi**: hành trình human → AI không phải quyết định một lần, mà là thang máy có đồng hồ đo, hai chiều, theo từng loại việc.

## 6. Duality

| Khía cạnh    | Rule/code                                                                                                                                                         | Agent / người                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Graduation   | Cùng policy, cùng thang — nhưng calibration nhị phân hội tụ sau rất ít mẫu nên lên autonomous nhanh. **Hệ quả tự nhiên của dữ liệu, không phải đặc quyền engine** | Calibration dạng phân phối, cần nhiều mẫu hơn |
| Availability | Hằng số                                                                                                                                                           | Biến thiên, tự khai                           |
| Calibration  | Nhị phân, hội tụ nhanh                                                                                                                                            | Phân phối, cần mẫu                            |

## 7. Non-goals

- Role không chứa logic thực thi (của Filler) và không chứa trạng thái việc (của Task).
- Không có phân cấp Role kế thừa (inheritance) — composition qua capability và contract, không qua cây kế thừa.

## 8. Nhật ký quyết định

| Vấn đề                  | Chốt                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Slot vs occupant        | Tách Role/Filler; flow chỉ biết Role                                                                                                         |
| Role hệ thống           | Không tồn tại — Arbiter/Distiller/… là Role thường                                                                                           |
| Capability              | Gắn vào Role, Filler thừa hưởng khi lấp; taxonomy mở                                                                                         |
| Thang tin cậy           | Calibration profile theo (role, filler, task_type, criterion), nguồn duy nhất là hệ Judgment                                                 |
| **Environment vs tier** | `environment` là chiều của identity, **không** phải tier thứ 5 — bảng §5 giữ đúng 4 tier; mock filler bị chặn khỏi production bằng chiều này |
| Shadow                  | Cơ chế hạng nhất, đối xứng hai chiều (AI bóng người, người bóng AI)                                                                          |
| Graduation              | 4 tier, tự động hai chiều theo policy khai báo                                                                                               |

## Litmus (spec-level, theo L5)

1. Một Role lần lượt lấp bởi 4 loại filler (người/agent/rule/process) — definition không đổi một ký tự?
2. Graduation policy thăng/giáng filler tự động theo calibration, mỗi lần đổi tier là một event?
3. `distinct_filler_from` chặn được filler tự chấm chính mình ở mọi đường (kể cả qua 2 role)?
