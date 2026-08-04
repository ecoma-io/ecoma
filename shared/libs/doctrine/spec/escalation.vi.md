---
title: "Primitive: Escalation"
status: design-end-state
canonical-sha: f5d9f63897f0
---

# Primitive: Escalation

> Tuân theo 4 nguyên tắc cơ chế (canonical: North Star §3). Spec trần. Escalation là **công dân hạng nhất** — thứ BPMN coi là exception path thì ecoma coi là mặc định phải khai báo, vì trong hệ human+AI, lệch chuẩn là thường thái: người nghỉ, agent kẹt, confidence sụt, SLA vỡ.

## 1. Định nghĩa

Escalation là **đường đi khai báo trước cho mọi tình huống lệch chuẩn**. Nguyên tắc nền: engine ép mọi Role/Gate/Task có escalation chain với **terminal handler bắt buộc** — không tồn tại trạng thái "kẹt im lặng vô hạn" trong toàn hệ thống.

## 2. Trigger taxonomy (mở — thêm trigger không sửa engine)

| Trigger               | Nguồn phát                                                                                                             | Đã định nghĩa ở        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `sla_breach`          | Task/Gate quá hạn (gồm `awaiting_review`)                                                                              | Checkpoint §6          |
| `unavailable`         | Không Filler nào trong pool sẵn sàng — mang theo chân trời đã khai nếu có, thứ chỉ chú thích chứ không bao giờ hoãn    | Role §3                |
| `low_confidence`      | Calibrated confidence < T_low sau retry                                                                                | Checkpoint §4          |
| `repeated_failure`    | Hết N attempt                                                                                                          | Task §4                |
| `budget_exceeded`     | Hết fallback chain / trần chi phí                                                                                      | Checkpoint, Task       |
| `conflict`            | Judgment mâu thuẫn / N-bounce                                                                                          | Checkpoint, Handoff §4 |
| `irreversible_guard`  | Gate trước irreversible effect không đạt sàn                                                                           | Handoff §8             |
| `assistance_request`  | **Filler tự giơ tay**                                                                                                  | §3                     |
| `unwind_blocked`      | Compensation không thể chạy                                                                                            | Handoff §8             |
| `session_interrupted` | Session effect (phiên RPA/browser) đứt giữa chừng — engine biết chính xác action nào đã chạy, đã qua commit point chưa | Handoff §8             |

**`assistance_request` là trigger quan trọng nhất về triết lý**: agent vốn không tự báo kẹt — cơ chế phải làm cho "xin trợ giúp" là hành động hạng nhất, rẻ, và **được thưởng trong calibration** (agent biết giơ tay đúng lúc có profile tốt hơn agent liều). Người giơ tay cũng đi cùng đường — đối xứng. Đây là cơ chế trực tiếp trị "nghẽn xác minh" ở n=1: hệ thống chủ động nổi đúng thứ cần chú ý thay vì người phải đi soi.

## 3. Escalation là một Task

- Mỗi escalation sinh **một Task thật** gán cho handler — handler là **Role** (người hoặc AI supervisor: đối xứng; AI xử lý tầng escalation đầu, lọc trước khi đến người là pattern mặc định của template).
- Vì là Task nên tự có Gate, SLA, budget, provenance — **chain tự cascade**: escalation task quá hạn thì tự escalate tiếp lên nấc sau. Không cần cơ chế riêng.
- Chain khai báo trên Role, override được ở Task/Gate. Terminal handler: engine ép tồn tại; ở n=1 terminal là chính người đó với policy `nudge → hold` (mặc định template) (nhắc theo nhịp, giữ nguyên trạng — nhất quán Checkpoint: **không bao giờ auto-pass vì bế tắc**, đặc biệt trước irreversible effect).

## 4. Hành động của handler — mọi hành động đều có dấu vết

| Hành động             | Cơ chế ghi nhận                                                                                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reassign`            | Attempt mới, Filler/Role khác (Task §4)                                                                                                                                                      |
| `retry_with_guidance` | Attempt mới + feedback của handler                                                                                                                                                           |
| `adjust`              | Sửa tham số (deadline, budget, threshold) — event log                                                                                                                                        |
| `override_gate`       | Cho qua Gate đang chặn — **bắt buộc sinh Judgment `basis: override`** kèm lý do: người override chịu trách nhiệm bằng chữ ký dữ liệu, và calibration học được cả chất lượng của các override |
| `absorb`              | Chấp nhận rủi ro, đóng escalation kèm lý do — audit trail                                                                                                                                    |
| `halt_compensate`     | Kích hoạt unwind (Handoff §8)                                                                                                                                                                |
| `restructure`         | Handler có `spawn_task`: đẻ task mới thay thế đoạn hỏng — sửa quy trình đang chạy bằng chính cơ chế spawning                                                                                 |

Quyền dùng từng hành động = capability của Role handler (`override_gate` là capability riêng, không mặc định).

**Reassign thay _ai_ hành động; không bao giờ thay _một hành động nghĩa là gì_.** Khi filler bị chặn là một người duyệt **bên ngoài** — một client ký duyệt công việc của agency qua một Channel — `reassign` chuyển Task duyệt sang một Role của agency, và cái pass là một Judgment trung thực mang danh tính của _chính_ filler đó. Điều đó hợp lệ, nhưng không phải là client duyệt: chỗ nào ngữ nghĩa quy trình đòi sự đồng thuận **của chính** bên ngoài, đường của handler là `override_gate` (một chấp nhận trách nhiệm có chữ ký) hoặc `halt` — không bao giờ là một reassign để "client ký duyệt" lặng lẽ biến thành "agency ký duyệt" bên trong một Judgment trông bình thường. Cả hai đường đều trung thực trong log; chỉ đường thứ hai làm "client chưa hề thực sự duyệt" đọc được mà không phải đi diff danh tính verifier.

## 5. Storm control

- **Dedup**: cùng (trigger, nguồn) đang mở → không sinh escalation trùng, chỉ tăng đếm.
- **Correlation**: engine gộp escalation cùng root cause (một model sập → 50 task fail = **một** escalation gộp, không phải 50). Tham số cửa sổ gộp: engine ép tồn tại, template cấp giá trị.
- **Ưu tiên chú ý**: hàng đợi escalation đến người xếp theo (irreversibility của nhánh, priority, tuổi) — tài nguyên chú ý là thứ được tối ưu, đúng invariant.

## 6. Escalation là dữ liệu học

- Mọi escalation đóng lại đều ghi (trigger, đường đi, hành động chốt, thời gian, kết cục) — **process smell detector** của tầng Intelligence: cùng một chỗ escalate lặp lại = quy trình có lỗi thiết kế, đề xuất sửa nằm ở đây (đúng tham vọng ML ban đầu của bạn, giờ có nguồn dữ liệu cụ thể).
- Override bị outcome xấu lan ngược (Handoff §9) → calibration của người hay override ẩu cũng sụt — trách nhiệm đối xứng trọn vẹn.

## 7. Duality

| Khía cạnh        | Deterministic                            | Reasoning / người                                        |
| ---------------- | ---------------------------------------- | -------------------------------------------------------- |
| Trigger chủ đạo  | budget, repeated_failure, unwind_blocked | low_confidence, assistance_request, conflict, sla_breach |
| Handler tầng đầu | Retry/fallback máy móc                   | AI supervisor lọc trước người                            |
| Absorb/override  | Hiếm (fail là fail)                      | Thường — và luôn có chữ ký Judgment                      |

## 8. Non-goals

- Escalation không đánh giá chất lượng (Checkpoint) và không định nghĩa ai đủ năng lực xử lý (Role) — chỉ định nghĩa _đường đi khi lệch chuẩn_.
- Không có "notification" tách rời — thông báo chỉ là surface rendering của escalation task, không phải hệ thống song song.

## 9. Nhật ký quyết định

| Vấn đề                      | Chốt                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| Bản chất                    | Escalation = Task gán cho handler Role → chain tự cascade, đối xứng người/AI                |
| Kẹt im lặng                 | Không tồn tại: terminal handler bắt buộc toàn hệ thống                                      |
| n=1 offline                 | nudge → hold; không bao giờ auto-pass vì bế tắc                                             |
| Agent kẹt                   | `assistance_request` hạng nhất, được thưởng trong calibration                               |
| Override                    | Bắt buộc sinh Judgment `basis: override` — chịu trách nhiệm bằng dữ liệu, outcome lan ngược |
| Storm                       | Dedup + correlation gộp theo root cause + hàng đợi ưu tiên chú ý                            |
| ML đề xuất tối ưu quy trình | Nguồn dữ liệu chính là escalation log (process smell)                                       |

## Litmus (spec-level, theo L5)

1. Storm 50 task cùng nguyên nhân → đúng 1 escalation nhờ correlation window?
2. Mọi chain đều có terminal handler — không tồn tại đáy rỗng ở bất kỳ cấu hình nào?
3. Override luôn là Judgment có chữ ký, xuất hiện trong calibration?
