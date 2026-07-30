---
title: "RPA: Driver & Perception"
status: design-end-state
canonical-sha: bd73d460c1b0
---

# RPA: Driver & Perception

## 1. Driver contract

Driver = adapter tới một loại môi trường. Interface Apache 2.0 — bên thứ ba viết driver tự do.

| Khai báo           | Nội dung                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `identity`         | (type, id, version) + **lineage** như mọi identity — driver cũng có calibration (độ tin cậy resolve, tỉ lệ action fail) |
| `environment`      | browser / desktop / taxonomy mở (mobile, terminal, VM…)                                                                 |
| `actions`          | Tập Action Definition hỗ trợ (có thể đăng ký action mới vào vocabulary)                                                 |
| `perception_modes` | structural / visual / cả hai                                                                                            |
| `capture`          | Có bắt được hành động người không (điều kiện của takeover & record)                                                     |

Driver **không** biết script/agent/session policy — chỉ nhận action, trả kết quả + perception.

## 2. Scene — biểu diễn hợp nhất của môi trường

Perception trả về **Scene**: một snapshot có cấu trúc, content-addressed (hash = evidence trong action log):

| Lớp        | Nguồn                                                                       | Dùng cho                                         |
| ---------- | --------------------------------------------------------------------------- | ------------------------------------------------ |
| Structural | DOM / accessibility tree / UI automation tree                               | Script resolve nhanh-rẻ; masking theo field type |
| Visual     | Screenshot (đã masking vùng nhạy cảm **trước khi** rời tầng perception)     | Agent vision; evidence cho người xem audit       |
| Semantic   | Chú thích của vision model trên hai lớp trên (nhãn phần tử, vùng chức năng) | Resolve tầng cuối; sinh intent                   |

- Masking xảy ra **tại tầng perception** (Sandbox spec §3) — mọi consumer phía sau (agent, log, evidence, người xem replay) đều chỉ thấy scene sạch. Một chốt chặn duy nhất.
- Scene diff (trước/sau action) là đơn vị bằng chứng và là tín hiệu drift.

## 3. Environment fingerprint

Hash cấu trúc của scene (bố cục, phiên bản app nhận diện được) — dùng cho: resume/reconcile (Session §3), phát hiện app đổi version (UI drift smell, Self-healing §5), và khóa App Profile version tương thích.

## 4. Semantic locator — cơ chế trung tâm

Target của action không phải một selector — là **một khối 4 tầng, tự xuống thang**:

| Tầng                 | Nội dung                                                          | Chi phí | Độ bền trước UI đổi |
| -------------------- | ----------------------------------------------------------------- | ------- | ------------------- |
| 1. Structural anchor | Selector/a11y path (nhiều anchor dự phòng)                        | ~0      | Thấp                |
| 2. Relational        | Vị trí tương đối phần tử neo ("nút bên phải trường Email")        | Thấp    | Trung               |
| 3. Visual anchor     | Mẫu hình ảnh / vùng                                               | Trung   | Trung-cao           |
| 4. Semantic intent   | NL: "nút gửi form liên hệ" — resolve bằng vision model trên scene | Cao     | **Cao nhất**        |

**Resolution cascade**: thử 1 → 2 → 3 → 4. Mỗi lần resolve ghi lại **tầng nào thắng**:

- Tầng 1 thắng đều đặn = script khỏe.
- Phải rơi xuống tầng 3–4 = **tín hiệu drift** → kích self-healing đề xuất anchor mới (vá tầng 1 từ kết quả tầng 4) — script tự trẻ hóa.
- Tầng 4 cũng fail = không tìm được đích → escalate.

Đây là lý do script và agent là **hai đầu một trục chứ không phải hai hệ**: script = locator nghiêng tầng 1, agent = locator nghiêng tầng 4; self-healing chỉ là dòng chảy tri thức từ tầng 4 xuống tầng 1.

## 5. Non-goals

- Không xây vision model — adapter, taxonomy mở, model identity có version (calibration như verifier bên Platform).
- Perception không quyết định hành động — chỉ mô tả; quyết định thuộc executor.
- Driver không giữ state phiên — state thuộc Session.

## 6. Nhật ký quyết định

| Vấn đề               | Chốt                                                            |
| -------------------- | --------------------------------------------------------------- |
| Biểu diễn môi trường | Scene 3 lớp hợp nhất, content-addressed, masking tại nguồn      |
| Target               | Semantic locator 4 tầng, cascade tự xuống thang, ghi tầng thắng |
| Script vs agent      | Một trục trên cùng locator — không phải hai hệ                  |
| Drift                | Đo bằng phân phối tầng-thắng + environment fingerprint          |
| Driver ngoài         | Interface Apache 2.0; driver có identity + calibration          |

## Litmus (spec-level, theo L5)

1. Có consumer nào (agent, log, evidence, người xem replay, live-view) nhận Scene **trước** bước masking?
2. Locator rơi xuống tầng 3–4 lặp lại — hệ có tự sinh tín hiệu drift, hay chỉ chạy chậm hơn trong im lặng?
3. Tầng 4 cũng không resolve được — kết cục là escalate, không bao giờ là đoán bừa một phần tử?
