---
title: "Ecoma Spec: Calibration Data Model"
status: design-end-state
lang: vi
---

# Ecoma Spec: Calibration Data Model

## 0. Vị trí & ranh giới E5 (một sự thật một nhà)

- **Calibration là nhà DUY NHẤT của đánh giá lao động** — cặp với án văn cấm memory-về-filler (Memory §0). Không sổ nào khác được ghi "model X hay hỏng / anh A chậm".
- **Không store mới**: mọi cell là **projection từ Event Log** (Judgment/outcome/Conflict/escalation), rebuild được (Event Log §3 — "Calibration input" nay có spec).
- Hai khái niệm cũ là hai lát cắt của cùng một không gian: _calibration profile của Filler_ (Role §3) và _lớp C của verifier_ (Checkpoint §4) — hợp nhất tại §1.

## 1. CalKey & Cell

**CalKey** — khóa hợp nhất, 7 chiều:

| Chiều               | Giá trị                                                                                                                                                   | Nguồn án văn                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `tenant`            | Biên cứng — **không bao giờ vượt**                                                                                                                        | Invariant 4                                                                                                                     |
| `workspace_scope`   | Chiều **bắt buộc tồn tại**; mặc định = **workspace hẹp nhất** (K5 + C6); pool rộng hơn là giá trị template — agency tự chọn gộp/tách learning theo client | Tenant & Identity §3                                                                                                            |
| `subject`           | **(kind, identity@version)** — kind mở: `filler` · `verifier` · `driver` · `detector` (masking) · `chunk/collection` (knowledge) · `contract`             | Hợp nhất Role §3 + Checkpoint §2 + Driver §1 + Sandbox §3 + Knowledge §6 + Handoff §7 — một engine thống kê, nhiều loại chủ thể |
| `role`              | Role đang lấp (∅ với subject không-lao-động như chunk)                                                                                                    | Role §3                                                                                                                         |
| `task_type`         | Loại việc                                                                                                                                                 | Role §3                                                                                                                         |
| `criterion@version` | **Calibration bám criterion-id, không bám rubric** — sửa rubric không reset; criterion dùng chung xuyên quy trình → tích lũy chung (thuốc cold-start #1)  | Checkpoint §1                                                                                                                   |
| `basis`             | Taxonomy mở của Judgment                                                                                                                                  | Checkpoint §3                                                                                                                   |

**Cell** = giá trị tại một CalKey: **sufficient statistics** (n, đếm theo verdict-bucket, momen, log-position cập nhật cuối, trạng thái decay) — không lưu chuỗi thô (chuỗi thô _là_ log). Cell **sparse**: chỉ tồn tại khi có dữ liệu — van chi phí J6 (không gian 7 chiều không bao giờ materialize đặc; lưu trữ ~ số Judgment thực, không ~ tích các chiều).

## 2. Đường vào — duy nhất qua hệ Judgment

| Nguồn                                                                                   | Vào cell thế nào                                                                                                     |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Judgment mọi basis (contemporaneous / re_review / consumer-bounce / override / comment) | Trực tiếp; `comment` trọng số 0 (Checkpoint §3)                                                                      |
| Outcome lan ngược theo provenance                                                       | Về từng Role/Criterion góp phần; trọng số attribution là tham số cascade (Handoff §9)                                |
| Conflict                                                                                | Nhãn bất đồng — tín hiệu sửa rubric, hạ tin cậy tạm cell liên quan                                                   |
| `assistance_request`                                                                    | **Cộng điểm** — giơ tay đúng lúc có profile tốt hơn liều (Escalation §2)                                             |
| Override + outcome xấu                                                                  | Sụt calibration của người override — trách nhiệm đối xứng (Escalation §6)                                            |
| Sampling reject (tự siết)                                                               | Vào cell + phát event hạ T_high đảo được (Checkpoint §4)                                                             |
| Shadow (`shadow: true`)                                                                 | Nuôi cell của shadow filler, không rủi ro production (Role §4)                                                       |
| RPA: takeover diff = approve-with-edit; kết quả cửa duyệt patch; tầng-locator-thắng     | Qua Session effect → Judgment; **calibration Platform bám filler đăng ký, sub-actor cho ML chi tiết** (RPA NS §5/§7) |

**Luật cứng**: không tồn tại đường ghi điểm nào ngoài việc tạo Judgment hợp lệ (capability `judge`, chịu `distinct_filler_from`). "Chấm tay" một filler = tạo Judgment có chữ ký — không sửa số.

**Biên cứng thứ hai: Judgment mang `run_kind: test` KHÔNG BAO GIỜ vào cell.** Nhãn là thuộc tính của entry, nhà canonical ở Event Log §1/§3; spec này chỉ _khai lập trường_ — và lập trường là **loại tuyệt đối**, không cấu hình được. Án văn: cell là tài sản của tổ chức (§0), đầu độc bằng dữ liệu giả (mock filler, Test Harness §3) là phá flywheel **không đảo được** — nên đây là luật engine, không phải giá trị template.

## 3. Trọng số theo basis — tham số, không hardcode

Engine ép bảng trọng số tồn tại; **template cấp giá trị** (prior mặc định: `outcome` cao nhất > `re_review` > `contemporaneous` > `consumer` > self-report; `comment` = 0; `degraded` nhân hệ số hạ). Data model cam kết **lưu đủ provenance** (blind?, batch, degraded, thiết bị…) — dùng thế nào là việc của estimator (§5).

## 4. Lineage, decay & tươi mới

- **Fork kế thừa**: subject identity mới khai `parent_identity` → cell khởi tạo = cell cha × `decay(d)`; **d theo bản chất thay đổi** (template cấp giá trị): đổi config nhỏ / patch chỉ-đổi-locator ≈ 0 (Self-healing §4) · contract minor ≈ 0, major theo template (Handoff §7) · đổi model/hành vi = decay lớn. Sự kiện fork là entry — lineage graph truy được. **Không lineage = mỗi lần tối ưu là một lần đốt flywheel** (nguyên tắc #2).
- **Time-freshness** (khai báo mới, có án văn): môi trường trôi (UI đổi, model provider drift) → engine ép tham số half-life theo thời-gian/khối-lượng tồn tại; template cấp giá trị, mặc định suy giảm chậm (bảo thủ: dữ liệu cũ mất dần sức nặng chứ không bất tử). Không có nó, điểm 2 năm trước quyết auto-pass hôm nay.

## 5. Prior, cold-start & Estimator identity

- Cell thưa/rỗng → **prior bảo thủ từ template** ("mọi thứ qua review" — Checkpoint §4). Ba thuốc cold-start đúng invariant 4: criterion dùng chung + lineage + template prior. **Không bao giờ đọc cross-tenant**; block/template chỉ ship _prior definition_, không bao giờ ship dữ liệu (Block §9).
- **Backoff/pooling giữa các cell là THUẬT TOÁN** — thuộc estimator, không thuộc data model. Ràng buộc duy nhất data model đặt: mọi con số confidence dùng để quyết Gate/graduation phải ghi vào event **`(cell keys đã đọc, estimator identity)`**.
- **Estimator identity = (method, version, params_hash)** — khai báo mới, án văn I-group: đổi công thức ước lượng là đổi hành vi hệ → phải có danh tính, lineage, shadow-so-sánh như mọi thứ tiến hóa khác; không có nó, "sửa công thức" là upgrade ngầm phá auditability.

## 6. Consumer — ai đọc, đọc gì

Gate policy T_high/T_low (Checkpoint §4) · graduation/trust tiers, **giáng tức thì khi sụt** (Role §5) · bảng đối chiếu shadow (Role §4) · cost + quality theo Role — litmus #4 (metering × calibration cùng log-position) · routing (fallback chain, model theo độ chính xác masking — RPA NS §7) · độ tin chunk/collection (Knowledge §6) · độ tin driver/detector.
**Visibility**: dữ liệu đánh giá người là nhạy cảm — mặc định chỉ Role có capability `view_calibration` trong scope; `calibration_visibility_policy` là extension point EE (Tenant & Identity §8).

## 7. Non-goals

- Không công thức thống kê/ML cụ thể (estimator = tầng tiến hóa, có identity §5).
- Không store mới; không calibration cross-tenant; không nhận input ngoài hệ Judgment.
- Không phải công cụ đánh giá nhân sự HR — phục vụ định tuyến/chất lượng, visibility chặt.
- Không chấm bên-được-phục-vụ (đó là Memory — ranh giới Memory §0 chiều ngược lại).

## 8. Nhật ký quyết định

| Vấn đề        | Chốt                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bản chất      | Projection thuần từ log — không store, rebuild được                                                                                                           |
| Hợp nhất key  | Một không gian CalKey 7 chiều; profile-filler và lớp-C-verifier là hai lát cắt                                                                                |
| Subject       | (kind, identity@version) mở — một engine cho filler/verifier/driver/detector/chunk/contract                                                                   |
| Workspace     | Chiều bắt buộc; mặc định hẹp nhất (K5/C6); pool là template value                                                                                             |
| Đường ghi     | Duy nhất qua Judgment hợp lệ — E5, cặp với cấm memory-về-filler                                                                                               |
| **Nhãn test** | Judgment `run_kind: test` **loại tuyệt đối**, không cấu hình được; nhãn có nhà ở Event Log §1/§3 — spec này khai _lập trường_, không khai lại nhãn (chống G6) |
| Decay         | Lineage-decay theo bản chất thay đổi + time-freshness half-life (mới, có án văn)                                                                              |
| Estimator     | Identity (method, version, params_hash) — chống upgrade ngầm công thức                                                                                        |
| Chi phí (J6)  | Cell sparse + sufficient stats + rebuild-từ-log = lưu trữ ~ số Judgment, có van retention                                                                     |

## Litmus (spec-level, theo L5)

1. Xóa toàn bộ cell → rebuild từ log ra kết quả tương đương (projection thuần)?
2. Chỉ vào một con số confidence bất kỳ tại một Gate: truy được (cell keys, estimator@version, các Judgment gốc)?
3. Đổi prompt/model của một filler: cell mới kế thừa cha với decay — không reset về 0, không giữ nguyên 100%?
4. Có đường nào thay đổi điểm một filler mà không tạo Judgment hợp lệ (kể cả admin sửa DB — drift-detect Working Data §2)?
5. Template chọn tách learning theo workspace: ước lượng cho client A không đọc một Judgment nào của client B?

## FMEA (theo F8)

| Hỏng                             | Phát hiện                                                            | Phục hồi                                                                        |
| -------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Projection drift / cell sai      | Checksum theo log-position (Working Data §2)                         | Rebuild từ log, event cảnh báo                                                  |
| Estimator lỗi làm lệch hàng loạt | Estimator có identity + shadow so sánh trước graduation              | Rollback về estimator version cũ — vì có danh tính                              |
| Poisoning bằng Judgment giả      | Capability `judge` + `distinct_filler_from` + Conflict khi mâu thuẫn | Judgment độc bị vô hiệu qua re_review/outcome; actor chịu trách nhiệm trong log |
| Cell cardinality phình           | Sparse + sufficient stats; cảnh báo ngưỡng                           | Retention/gộp theo policy — log vẫn giữ sự thật                                 |
