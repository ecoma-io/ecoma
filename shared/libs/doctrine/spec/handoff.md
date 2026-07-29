---
title: "Ecoma Primitive Spec: Handoff"
status: design-end-state
lang: vi
---

# Ecoma Primitive Spec: Handoff

## 0. Bốn nguyên tắc cơ chế (canonical: North Star §3)

1. **Engine đối xứng tuyệt đối** giữa người, AI, và rule/code. Bất đối xứng chỉ sống ở tầng policy/template.
2. **Cái cần tích lũy học là entity hạng nhất có danh tính ổn định — và danh tính có lineage.**
3. **Engine ép tham số tồn tại, template ép giá trị.**
4. **Độ phức tạp là quyền lựa chọn của user**: cơ chế đầy đủ, mặc định tối giản qua default cascade, nâng cao là opt-in.

Bước deterministic = Role được lấp bởi `rule`/code. Engine không có nhánh `if deterministic` — khác biệt hành vi nổi lên từ khai báo (§11).

## 1. Định nghĩa

Handoff là **sự chuyển giao một Artifact từ Role sản xuất sang Role tiêu thụ, dưới một Contract tường minh**. Người cần _ngữ cảnh kể được_, AI cần _cấu trúc kiểm được_ — Contract chứa cả hai. Đây là điểm hợp nhất hai lực lượng lao động ở mức dữ liệu.

## 2. Mô hình khái niệm

| Entity               | Là gì                                                                                                                                                | Danh tính                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **Contract**         | Schema + semantic + context requirements. Entity hạng nhất, version hóa, thư viện tenant, tái sử dụng xuyên quy trình                                | id + version; quy trình **pin** version |
| **Artifact**         | Reference + hash (content-addressed) + metadata + provenance chain. Immutable sau khi Gate đóng. Lưu trữ vật lý: [artifact-store](artifact-store.md) | content hash                            |
| **Handoff instance** | (artifact, contract@version, producer, consumer, trạng thái)                                                                                         | id, append event log                    |
| **Violation**        | Vi phạm khách quan lớp Schema tại runtime                                                                                                            | gắn handoff instance                    |
| **Effect**           | Tác động ra ngoài hệ thống do Task khai báo, mang lớp reversibility                                                                                  | khai báo trong Task                     |
| **Compensation**     | Hành động bồi hoàn khai báo trước cho Effect/Handoff                                                                                                 | Task của một Role                       |

## 3. Contract — ba lớp

| Lớp                      | Nội dung                                                                                                                                                                                                                                                                                                                                                                         | Ai kiểm                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Schema**               | Kiểu, ràng buộc máy kiểm được. Nguồn duy nhất của contract criteria mà Gate (Checkpoint) tiêu thụ làm hard gate                                                                                                                                                                                                                                                                  | Engine, deterministic                                                                                                                                                                                                                                                                                                                                                                                          |
| **`test_behavior`**      | Hành vi của contract khi chạy trong **test run scope** (Test Harness §1): `mock` (engine trả fixture) · `dry_run` (adapter chạy nhưng không phát effect ra ngoài — **đòi adapter khai `supports_dry_run`**, không hỗ trợ thì resolve về `forbidden`) · `forbidden` (gửi mail, HTTP bên thứ ba, chuyển tiền, ghi hệ ngoài). Chạy thật trong test đòi khai tường minh + capability | **Tùy chọn ở văn bản; engine resolve thiếu khai = `forbidden`** (fail-safe). Static analysis **cảnh báo** contract có effect rời hệ mà không khai tường minh. *Án văn *: bắt-buộc-ở-schema sẽ làm **mọi contract đã pin** fail validation = breaking vô cớ, trong khi mặc định đã fail-closed nên thiếu khai **không tạo rủi ro** — reject dành cho chỗ thiếu-khai _là_ rủi ro (manifest `scope` của Block §2) |
| **Semantic**             | Mô tả NL từng trường: nghĩa, mục đích, ví dụ đúng/sai                                                                                                                                                                                                                                                                                                                            | Verifier (quality criteria) + người                                                                                                                                                                                                                                                                                                                                                                            |
| **Context requirements** | Trường context consumer cần nhận (projection từ envelope §5). Deterministic consumer khai ∅                                                                                                                                                                                                                                                                                      | Consumer                                                                                                                                                                                                                                                                                                                                                                                                       |

Contract khai báo thêm **verification depth** từng criterion: `metadata` / `sampled` / `full` — độ sâu kiểm là lựa chọn chi phí của user.

## 4. Vòng đời

```
offered → validating → accepted → in_use
 ↘ violated → (coerce | reject | escalate)
accepted → bounced
```

- **Coercion là Task của một Role** (AI hoặc người). Engine không tự sửa artifact — mọi sửa đổi truy vết về một Role.
- **Bounce — tách đôi theo bản chất consumer:**
- Consumer deterministic: bounce = **Violation** (schema fail) — khách quan, luôn hợp lệ.
- Consumer reasoning/người: bounce = **Judgment `basis: consumer`** — chủ quan, nuôi calibration của Gate thượng nguồn (Gate pass mà bounce nhiều = Gate lỏng).
- **Trọng tài**: N bounce (engine ép khai báo N, template cấp giá trị) trên cùng lineage giữa cùng cặp → engine sinh **Conflict**, escalate lên **Arbiter Role** khai báo trong quy trình (mặc định: process owner). Bounce không lật Gate cũ — tạo vòng làm lại mới có dấu vết.
- **Phân định thời điểm**: consumer deterministic fail _trong lúc validating_ = Violation (lỗi hàng); fail _sau khi đã accepted_ = runtime failure của chính task consumer, đi theo on_fail của task đó — không phải bounce.
- Tại `accepted`, ownership chuyển sang consumer — ranh giới trách nhiệm tường minh.
- Artifact immutable sau khi Gate đóng: mọi chỉnh sửa (kể cả approve-with-edit ở Checkpoint) sinh **artifact dẫn xuất mới** nối vào provenance, không sửa tại chỗ.

## 5. Context envelope — tích lũy tự động, giao theo projection

- Engine **tự tích lũy** envelope dọc chuỗi (mục tiêu gốc, ràng buộc, quyết định mỗi bước) vào provenance — không mất mát, không cần soạn tay; producer chỉ bổ sung.
- Consumer nhận **projection**: engine chiếu envelope xuống đúng context requirements trong contract. Deterministic step: requirement ∅ → zero overhead.
- Chống phình: **Distiller = Task của Role** (chưng cất envelope), kích hoạt theo policy độ dài/số bước — opt-in. Bản đầy đủ vẫn nằm trong provenance.

## 6. Topology

- Handoff là **point-to-point**. Fan-out = nhiều instance từ một artifact.
- **Fan-in là Task của Role** (merger, AI hoặc người) với contract đầu ra riêng. Không có merge node ma thuật.
- Định tuyến là việc của Role/Task.

## 7. Version & governance

- Semver ngữ nghĩa: thêm optional = minor; đổi nghĩa/kiểu/bỏ = major.
- Quy trình pin version → sửa contract dùng chung **không thể vỡ** quy trình đang chạy; major bump = version mới, quy trình cũ đứng yên.
- Migration tường minh qua **Adapter Role**. Capability `contract_author` kiểm soát tạo version.
- **Version lineage**: calibration bám (contract-id, version) kế thừa từ version cha với hệ số decay (minor: decay ~0; major: decay theo template) — cùng cơ chế lineage của Verifier/Criterion, chống reset flywheel khi contract tiến hóa.
- Quy trình duyệt thay đổi (nếu tenant muốn) là **một workflow ecoma** — governance dogfooding, opt-in. Pinning bảo đảm an toàn; nghi thức duyệt là lựa chọn.

## 8. Effects, reversibility & compensation

- Task khai báo **external effects**; mỗi effect mang lớp `reversible / compensable / irreversible` + compensation tương ứng. Engine ép trường tồn tại, template ép giá trị. **Effect khai mà không phân lớp = coi là `irreversible`** — mặc định bảo thủ, đồng bộ với RPA Action spec (đơn giản hơn luôn nghĩa là an toàn hơn, không bao giờ là lỏng hơn).
- Effect khai được **`serialization_key`** (tùy chọn): engine serialize các effect cùng key xuyên process — hệ ngoài (record CRM, file share) là shared mutable state duy nhất được thừa nhận, và đây là van chống đua tối thiểu; không khai = optimistic, xung đột phát hiện qua Violation/outcome. Cơ chế hóa: serialization_key = **micro-lease** do engine tự quản (Working Data §3 — Lease là primitive khóa duy nhất toàn hệ).
- **Session effect** (effect loại stream): cho task tương tác môi trường qua chuỗi micro-action (phiên RPA, phiên browser, phiên terminal). Action log là provenance; **mỗi action mang lớp reversibility riêng**; commit point của phiên = action irreversible đầu tiên đã chạy. Stream gồm **entry có kiểu**: action / quy công actor–task / đề xuất (proposal — Platform materialize thành Task); learning signal dẫn xuất từ chính log — **không tồn tại kênh thứ ba** ngoài hai giao diện. Đây là giao diện chuẩn để **Ecoma RPA — sản phẩm riêng, domain tách biệt — cắm vào Platform**: Platform không biết selector/vision/driver, chỉ biết một filler đang phát một session effect. Mọi runtime ngoài khác cắm cùng cách.
- Task thuần sản xuất artifact (đa số bước reasoning) không có effect → tự do đảo ngược. Irreversible tập trung ở bước deterministic có side-effect.
- **Design-time**: engine tính tĩnh ranh giới unwind; cảnh báo "effect irreversible đứng sau Gate calibration còn non".
- **Runtime**: effect irreversible được phép đòi **sàn policy ở Gate liền trước** (vd không auto-pass trừ khi calibrated confidence ≥ X) — sàn là opt-in.
- **Unwind**: đi ngược provenance chain, kích hoạt compensation (Task của Role — nhiều bồi hoàn chỉ người làm được). Không vượt qua **commit point** (irreversible effect đã chạy) — từ đó chỉ có bù đắp, không có undo.

## 9. Provenance & lan truyền outcome

- Artifact mang chuỗi xuất xứ đầy đủ: Task, Role, Judgment, contract version.
- Judgment `basis: outcome` gắn vào artifact cuối lan ngược theo provenance về các bước thượng nguồn → tín hiệu calibration cho từng Role/Criterion góp phần. Trọng số attribution là tham số calibration, không hardcode.
- Cho phép "chấm lại sau done" chấm một lần ở cuối mà cả chuỗi được học.

## 10. Non-goals

- Không định tuyến (Role/Task), không đánh giá chất lượng (Checkpoint).
- **Không có shared mutable state giữa các bước** — mọi trao đổi qua Handoff.
- Engine không tự sửa artifact — coercion/merge/adapt/compensate luôn là Task của Role.

## 11. Bảng duality (deterministic vs reasoning — cùng cơ chế, hành vi tự phân hóa)

| Khía cạnh          | Deterministic (Role = rule/code) | Reasoning / người                 |
| ------------------ | -------------------------------- | --------------------------------- |
| Context envelope   | Requirement ∅, zero overhead     | Projection theo contract          |
| Bounce             | = Violation, khách quan          | = Judgment consumer, có trọng tài |
| Verification depth | Schema/metadata đủ               | Sampled/full theo chọn            |
| Effects            | Nơi tập trung irreversible       | Thường effect-free                |

## 12. Nhật ký quyết định

| Vấn đề                         | Chốt                                                                                                                                                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Envelope                       | Tích lũy tự động không mất mát; giao theo projection; Distiller là Role-task opt-in                                                                                                                                                      |
| Bounce                         | Vô hạn về cơ chế; N-bounce → Conflict → Arbiter Role; tách Violation vs Judgment theo bản chất consumer                                                                                                                                  |
| Artifact lớn                   | Luôn reference + content-addressed hash; verification depth là lựa chọn user                                                                                                                                                             |
| Reversibility                  | Gắn vào **effect** không gắn vào bước; 3 lớp; commit point chặn unwind; sàn policy cho Gate trước irreversible                                                                                                                           |
| Contract dùng chung            | Pinning + Adapter Role thay bộ máy duyệt; duyệt là workflow ecoma opt-in; capability `contract_author`                                                                                                                                   |
| **Hành vi trong test** _(24u)_ | Khai tại **contract**, không tại handoff instance — án văn: an-toàn-khi-test là thuộc tính của _loại_ trao đổi, không của một lần trao đổi; mặc định `forbidden` (fail-safe) — test harness không bao giờ phải _đoán_ effect nào an toàn |
| **Bắt buộc hay tùy chọn**      | **Tùy chọn ở văn bản + engine resolve thiếu = `forbidden`**; static analysis cảnh báo. Án văn: schema-bắt-buộc phá mọi contract đã pin (breaking) mà không giảm rủi ro nào, vì mặc định vốn đã fail-closed                               |
| **`dry_run` là của ai**        | Của **adapter** (`supports_dry_run`), không của contract; contract khai `dry_run` mà adapter không hỗ trợ → `forbidden` (K5). Không có luật này thì harness phải _đoán_ — đúng chỗ nó thề không đoán                                     |

## Litmus (spec-level, theo L5)

1. Envelope projection cấp đúng và chỉ đúng những gì contract khai (không rò thừa)?
2. Effect không phân lớp bị đối xử là `irreversible` ở mọi đường (Platform lẫn RPA)?
3. Bounce quá N trên cùng lineage → Conflict + Arbiter, không lật Gate cũ?
4. _(24u, đánh lại số ở)_ Chạy một process trong test run scope với contract gửi email: **không email nào rời hệ**, và log ghi rõ effect bị chặn vì `test_behavior: forbidden` — kể cả khi contract **không khai gì**?
