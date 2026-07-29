---
title: "Ecoma Spec: Memory"
status: design-end-state
lang: vi
---

# Ecoma Spec: Memory

## 0. Kích hoạt & ranh giới khái niệm

- Tenant policy `memory: enabled | disabled` — **tắt mặc định ở engine**; template vertical bật đúng chỗ (CSKH bật memory-per-customer). Tắt = zero overhead, không thu thập ngầm (K5: đơn giản = không âm thầm tích PII).
- **Memory ≠ Knowledge ≠ Calibration**: Memory = quan sát tích lũy về _bên-được-phục-vụ_, chưa curate, có decay. Knowledge = tri thức đã tốt nghiệp, có Curator. Calibration = số liệu về _người-lao-động_.
- **Án văn cấm**: subject **không bao giờ** là Filler-trong-vai-lao-động ("model X hay hỏng", "anh A chậm deadline") — đánh giá lao động đã có nhà là calibration (nguồn Judgment/outcome); cho memory ghi chồng = nguồn sự thật thứ hai + sổ đen cảm tính né hệ có kiểm.

## 1. Subject

- Taxonomy mở, 3 loại chuẩn: `external_user` (khách qua Channel), `external_org` (account B2B), `tenant_self` (buffer quan sát nội bộ — nguồn distill tự nhiên lên Knowledge).
- Định danh: subject = **Party** (Tenant & Identity §5) — hợp nhất channel identity qua merge-có-Gate; cross-subject isolation dựa trên party id.
- Instance biết subject qua **subject binding** từ correlation (Trigger & Channel §3).

## 2. Memory entry

`(subject, nội dung, provenance → bằng chứng trong log, confidence, classification, decay_policy, lineage)`

| Luật            | Cơ chế                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Chống bịa       | **Provenance bắt buộc**: entry phải trỏ về event/artifact gốc — "nhớ vì đâu". Không nguồn = không vào, về cấu trúc                           |
| Chống poisoning | Lời subject tự khai ("tôi luôn được giảm 50%") = claim basis trọng số thấp — **không tự thăng thành fact**; thăng qua Gate có verifier/người |
| Bất biến        | Entry là artifact CAS + event ghi nhận; sửa = **supersede có lineage**; mâu thuẫn → **Conflict event**                                       |
| Mật             | Mặc định `confidential`; egress/leakage-gate áp nguyên; erasure của subject = **crypto-shredding** (Event Log §4)                            |

## 3. Ghi nhớ là lao động

- Candidate do agent **hoặc người** đề xuất (người ghi chú "khách này ghét gọi sáng thứ 2" — cùng đường, đối xứng) → **Gate**: chuyện vặt auto-pass theo calibration của extractor, chuyện nặng review — triage policy cascade.
- Extraction (LLM lọc "có gì đáng nhớ" sau tương tác) là **policy/sampling theo cascade** — không bắt buộc; extraction rubric là nội dung shareable qua template/block, **memory data thì không bao giờ** (per-tenant, invariant 4).

## 4. Truy hồi

- Contract khai `memory_requirements` — đứng cạnh `knowledge_requirements` và context envelope (Handoff §3): **một cửa, ba nguồn ngữ cảnh**. Người nhận bản render, AI nhận structured — cùng scope.
- **Cross-subject isolation**: scope retrieval = subject của instance (+ `tenant_self`) — khách A không bao giờ thấy chuyện khách B, về cấu trúc, không nhờ prompt.
- Tìm ngữ nghĩa qua **vector adapter của Knowledge** (án văn không tự chế giữ nguyên); "memory bank per subject" = projection rebuild được.

## 5. Vòng đời — sinh, già, chết, tốt nghiệp

```
Tương tác → candidate (Gate) → Memory entry (decay, confidence)
 ├─ dùng + outcome tốt → confidence tăng
 ├─ outcome xấu lan ngược → memory calibration sụt → đề xuất đào thải (Curator task)
 ├─ hết decay → rời projection active (log không đục)
 ├─ mâu thuẫn → Conflict → supersede lineage
 └─ dùng nhiều + bền → DISTILL lên Knowledge: Curator task có Gate;
 generalize từ NHIỀU subject bắt buộc qua leakage-gate (k-anonymity bằng floor propagation)
```

- **Chiều workspace của distill** (vách mềm — Tenant & Identity §3): task distill khai `scope`; **mặc định = workspace hẹp nhất chứa mọi subject nguồn** (K5 — không khai thì hẹp nhất, không phải rộng nhất). Generalize xuyên workspace là **khai tường minh** + leakage-gate + Curator có capability tương ứng. Hệ quả cho beachhead agency: quan sát về client A không bao giờ _vô tình_ tốt nghiệp thành tri thức phục vụ client B — cross-subject isolation (§4) chặn theo chiều ngang, luật này chặn theo chiều dọc (lúc khái quát hóa). Collection đích thừa hưởng scope (Knowledge §1).

Mirror đúng distillation agent→script: Memory là quan sát, Knowledge là tri thức đã tốt nghiệp.

## 6. Ánh xạ 5 loại "memory" thị trường

| Thị trường gọi         | Ecoma trả lời bằng                                             |
| ---------------------- | -------------------------------------------------------------- |
| Working memory         | Attempt + artifact trung gian (sẵn có)                         |
| Conversation history   | Chuỗi Task luân phiên durable + projection transcript (sẵn có) |
| Episodic               | **Event Log chính là episodic memory** — query log/provenance  |
| Structured per-subject | DataTable (Working Data spec)                                  |
| Semantic long-term     | **Module này**                                                 |

## 7. Non-goals

- Không store riêng, không schema-per-user kiểu Astron; App Profile ("memory về app") ở lại domain RPA.
- Không memory về Filler-trong-vai-lao-động (án văn §0).
- Memory data không phải block type; không học/không share cross-tenant.
- Không auto-memorize ở bất kỳ cấu hình mặc định engine nào.

## 8. Litmus

1. Đổi filler (người↔AI, model cũ↔mới) trên cùng Role — trí nhớ về khách còn nguyên?
2. Chỉ vào một entry bất kỳ: truy được _bằng chứng gốc_ trong log?
3. Khách cố cài fact giả qua chat — có đường nào thành fact mà không qua Gate?
4. Kịch bản nào để khách A thấy hồi ức về khách B?
   4b. Distill từ nhiều subject của client A có đường nào thành tri thức dùng cho client B (workspace khác) mà không khai tường minh?
5. Khách đòi quên — một lệnh hủy khóa xóa sạch khả năng đọc, log không đục?

## 9. Nhật ký quyết định

| Vấn đề              | Chốt                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Mặc định            | Tắt ở engine; template vertical bật — K5                                                                                                 |
| Subject             | Taxonomy mở: external_user / external_org / tenant_self; **cấm filler-as-subject** (án văn: tránh nguồn sự thật thứ hai với calibration) |
| Chủ sở hữu          | Tổ chức theo subject — không thuộc filler (khác Astron, hệ quả litmus #1)                                                                |
| Chống bịa/poisoning | Provenance bắt buộc + claim trọng số thấp + Gate                                                                                         |
| Già & chết          | Decay + memory calibration từ outcome + supersede/Conflict                                                                               |
| Tốt nghiệp          | Distill lên Knowledge qua Curator task; generalize đa-subject qua leakage-gate; **scope mặc định = workspace hẹp nhất**                  |
| Hạ tầng             | Zero store mới — Event Log + CAS + vector adapter + projection                                                                           |
