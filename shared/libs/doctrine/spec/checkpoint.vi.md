---
title: "Primitive: Checkpoint"
status: design-end-state
canonical-sha: bd8478f53b84
---

# Primitive: Checkpoint

> vòng đối kháng trước (patch sau review đối kháng): bỏ quy tắc cứng "stage người đứng cuối" (vi phạm nguyên tắc #1); thêm **identity lineage** chống reset calibration; approve-with-edit sinh artifact dẫn xuất; đồng bộ 4 nguyên tắc.

## 0. Bốn nguyên tắc cơ chế (canonical: North Star §3)

1. **Engine đối xứng tuyệt đối** giữa người, AI, và rule/code. Bất đối xứng (mặc định, ngưỡng, bật/tắt, thứ tự) chỉ tồn tại ở tầng policy/template.
2. **Cái gì cần tích lũy học phải là entity hạng nhất có danh tính ổn định — và danh tính có lineage** (Criterion, Verifier identity, Judgment basis, Conflict).
3. **Engine ép tham số tồn tại, template ép giá trị** (SLA, sampling rate, threshold).
4. **Độ phức tạp là quyền lựa chọn của user**: engine mang cơ chế đầy đủ, mặc định tối giản, năng lực nâng cao là opt-in qua khai báo (giá trị mặc định thừa kế theo cascade — xem Composition spec).

## 1. Mô hình khái niệm

| Entity        | Là gì                                                                                                                                                                 | Vòng đời                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Gate**      | Cổng quyết định output của Task chảy tiếp hay không. Kết cục: auto-pass / review / retry / escalate                                                                   | Blocking, đóng khi pass/fail                                       |
| **Judgment**  | Bản ghi đánh giá: verifier, criterion, verdict (theo thang khai báo), basis, provenance                                                                               | Append-only, gắn vào output vĩnh viễn; thêm được sau khi task done |
| **Criterion** | Tiêu chí đánh giá độc lập với Checkpoint: id ổn định + version + mô tả NL + loại (`contract`/`quality`). Tenant có **thư viện criterion** tái sử dụng xuyên quy trình | Version hóa; đổi nghĩa = version mới                               |
| **Conflict**  | Event sinh ra khi hai Judgment mâu thuẫn (người-vs-AI, AI-vs-AI, đương thời-vs-outcome)                                                                               | Nguồn tín hiệu sửa rubric                                          |

- Gate **tiêu thụ** Judgment. Judgment hậu kiểm **không mở lại Gate** — chỉ làm nhãn; sai nghiêm trọng sau done → alert/task bồi hoàn riêng.
- Rubric của một Gate = tập tham chiếu tới Criterion (kèm trọng số) — không sở hữu criterion.
- **Calibration bám criterion-id, không bám rubric** → sửa rubric chỉ reset criterion đổi nghĩa; criterion dùng chung xuyên quy trình thì calibration tích lũy chung → giảm cold-start per-tenant.

## 2. Cấu trúc Gate

| Trường     | Nội dung                                                                                                                                          | Bắt buộc |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `rubric`   | Danh sách tham chiếu Criterion + trọng số. `contract` criteria là hard gate                                                                       | ✅       |
| `stages`   | Chuỗi stage tuần tự; mỗi stage: verifiers song song + `aggregation` (`all_pass`/`quorum(n)`/`weighted ≥ T`). Mỗi verifier gán tập criterion riêng | ✅       |
| `policy`   | Ánh xạ calibrated confidence → hành động (§4)                                                                                                     | ✅       |
| `on_fail`  | §5                                                                                                                                                | ✅       |
| `budget`   | Trần chi phí verify                                                                                                                               | ✅       |
| `sla`      | Thời hạn + escalation cho awaiting_review. **Engine bắt buộc khai báo**; con số từ template                                                       | ✅       |
| `sampling` | Tỉ lệ kiểm xác suất dải auto-pass. Engine bắt buộc khai báo; template mặc định 10%, blind                                                         | ✅       |

**Verifier:**

- Danh tính = `(type, id, version, config_hash)` — đổi bất kỳ config nào (prompt, temperature, model version) = danh tính mới cho calibration.
- **Identity lineage** (chống reset flywheel): danh tính mới khai báo `parent_identity`; calibration **kế thừa từ cha với hệ số decay** (tham số của lớp C, template cấp giá trị). Vòng tối ưu chuẩn: đề xuất config mới → chạy shadow (Role spec §4) → graduation thay cha. Không có lineage thì mỗi lần tối ưu prompt là một lần đốt sạch dữ liệu đã học.
- Khai báo **fallback chain** (verifier rẻ hơn): vượt budget → đi xuống chain; hết chain → quyết bằng Judgment đã có + cờ `degraded` (hạ trọng số calibration).
- Thứ tự stage **tự do về cơ chế** — stage người đứng trước, giữa, hay cuối đều hợp lệ (người gác nhanh rồi AI kiểm compliance sâu là ca có thật). "Người đứng cuối để AI lọc rác trước" là **mặc định của template**, không phải luật engine.
- **Separation of duties**: stage/assignment khai được `distinct_filler_from: <role/stage>` — filler đã sản xuất không được tự chấm chính mình khi tenant yêu cầu (chống một người lấp hai role tự approve). Engine ép khả năng tồn tại; bật/tắt là giá trị template — đối xứng: áp cho cả người lẫn agent.
- Do người thiết kế quy trình cài; template vertical cấp mặc định.
- Cảnh báo lỗi tương quan: nhiều model cùng họ chấm cùng criterion ≈ một model. Giá trị multi-verifier nằm ở **criterion khác nhau mỗi verifier** (factual/tone/compliance).

**Review assignment:** thuộc tính `blind: true/false` cấu hình theo stage — reviewer có thấy Judgment trước đó không. Sampling mặc định blind (chống anchoring, giữ calibration sạch); quick review mặc định thấy (AI highlight chỗ nghi ngờ) — cả hai mặc định là **giá trị template**, không phải luật engine.

## 3. Judgment schema

| Trường          | Nội dung                                                                                                                                                                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verifier`      | Danh tính đầy đủ (type, id, version, config_hash)                                                                                                                                                                                                                                                                      |
| `criterion_ref` | Criterion id + version được chấm                                                                                                                                                                                                                                                                                       |
| `verdict`       | Giá trị theo **thang do verifier khai báo** (scalar 0–1, categorical approve/edit/reject, boolean…) — lớp C quy đổi mọi thang về xác suất người-tenant-đồng-ý                                                                                                                                                          |
| `basis`         | `contemporaneous` / `re_review` / `outcome` — taxonomy mở, trọng số theo basis là tham số calibration (prior: outcome cao nhất), không hardcode. Taxonomy mở ôm luôn cộng tác: **comment/annotation = Judgment `basis: comment`, không verdict, mặc định trọng số 0** — bàn luận có dấu vết mà không nhiễm calibration |
| `edit_diff`     | Với verdict approve-with-edit: diff lưu đầy đủ — nhãn giá trị nhất cho tối ưu prompt. Bản sửa là **artifact dẫn xuất mới** trong provenance (artifact gốc immutable, không sửa tại chỗ)                                                                                                                                |
| `feedback`      | Có cấu trúc, bám criterion-id: fail ở đâu + lý do + gợi ý sửa — đưa vào retry và mine được cho Intelligence                                                                                                                                                                                                            |
| `provenance`    | Metadata mở: batch size, thời gian xem, blind?, degraded?, thiết bị… — calibration tự quyết dùng gì                                                                                                                                                                                                                    |

**Quyền tạo Judgment** = capability `judge` gắn vào Role (đối xứng: agent cũng cấp được — vd agent theo dõi outcome tự ghi nhãn). Ai đang "dạy" hệ thống luôn kiểm soát và truy vết được.

## 4. Confidence — pipeline 3 lớp

| Lớp                      | Nội dung                                                                                                                | Vai trò                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| A. Self-report           | Model tự chấm/logprob                                                                                                   | Tín hiệu phụ, không đứng một mình                                             |
| B. External verify       | Contract criteria (hard gate) + verifier chấm quality theo rubric                                                       | Nguồn chính của raw                                                           |
| C. Empirical calibration | Lịch sử tenant theo (criterion-id, role, task_type, verifier-identity, basis) → quy đổi raw thành xác suất người đồng ý | Flywheel per-tenant; cold-start giảm nhờ criterion dùng chung xuyên quy trình |

Chưa đủ dữ liệu C → prior bảo thủ từ template (mọi thứ qua review).

**Policy triage mặc định:** ≥T_high → auto-pass + sampling; T_low–T_high → quick review (diff view, one-tap, gom lô — data vẫn ghi **từng item** kèm provenance); <T_low → retry rồi review; contract fail → retry ngay. Tự siết: reject trong mẫu sampling vượt ngưỡng → hạ T_high + **phát event audit** (đảo ngược được) + cảnh báo — cơ chế thống kê thuần, không cần ML.

## 5. `on_fail` (thứ tự mặc định, cấu hình được)

1. **retry** (tối đa N) — feedback có cấu trúc đưa vào lượt chạy lại
2. **reroute** — Role khác cùng contract (AI hoặc người): cơ chế "đổi AI↔người không sửa flow"
3. **escalate** — theo chuỗi Escalation của Role
4. **halt + compensate** — liên kết spec Handoff

## 6. Trạng thái Gate

`pending → verifying(stage k) → [awaiting_review] → passed | failed → (retry/reroute/escalated)`

- `awaiting_review` durable, SLA bắt buộc; quá hạn chỉ được **escalate hoặc halt — không bao giờ auto-pass vì timeout**.
- Judgment hậu kiểm không đổi trạng thái Gate.
- Conflict event sinh tự động khi Judgment mâu thuẫn — không chặn flow, chỉ ghi nhận + nguồn tín hiệu sửa rubric (case n=1 tự approve thứ AI chấm thấp là một instance).

## 7. Non-goals

- Gate không định tuyến việc (Role/Task), không định nghĩa contract dữ liệu (Handoff).
- Không sinh rubric/criterion tự động — thuộc tầng Pair-design.
- Judgment hậu kiểm không tự kích hoạt làm lại việc.

## 8. Nhật ký quyết định

| Vấn đề                         | Chốt                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------- |
| Verify trong/ngoài transaction | Ngoài — Judgment là stream async, Gate chờ đủ Judgment                            |
| Criteria format                | Criterion entity hạng nhất, thư viện tenant, calibration bám criterion-id         |
| Thang điểm khác loại           | Verifier khai báo thang; lớp C quy đổi về xác suất người-đồng-ý                   |
| Hậu kiểm                       | `basis` taxonomy mở; trọng số là tham số calibration, prior outcome cao nhất      |
| Sampling                       | Engine bắt buộc khai báo, template mặc định 10% blind, áp **mọi Role** (đối xứng) |
| Pass-with-edit                 | Verdict thứ ba + edit_diff                                                        |
| Budget overflow                | Fallback chain → degraded flag                                                    |
| Model drift                    | Verifier identity gồm version + config_hash                                       |
| Batch approve                  | Ghi từng item + provenance                                                        |
| Quyền hậu kiểm                 | Capability `judge` của Role                                                       |
| SLA                            | Engine ép tồn tại, template ép giá trị                                            |

## Litmus (spec-level, theo L5)

1. Không tồn tại đường nào timeout/bế tắc → pass (kể cả auto-siết, kể cả sampling)?
2. Reviewer ở stage blind không cách nào thấy Judgment trước đó?
3. Mọi thay đổi ngưỡng runtime (tự siết/nới) đều phát event đảo ngược được?
