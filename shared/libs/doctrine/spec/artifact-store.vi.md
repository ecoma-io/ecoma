---
title: "Subsystem: Artifact Store"
status: design-end-state
canonical-sha: 5c237fa979ea
---

# Subsystem: Artifact Store

> Platform, **subsystem của Core engine (tầng 1)** — không phải domain, không phải module opt-in: mọi thứ đứng trên nó. Tuân 4 nguyên tắc (canonical: North Star §3). Định vị: Astron/Dify có "resource storage" như tính năng; ecoma có Artifact Store như **nền vô hình có quản trị** — retention, residency, GC là cơ chế, không phải vận hành thủ công.

## 1. Kiến trúc — tách sự thật khỏi bytes

| Lớp                   | Chứa                                                                            | Tính chất                                  |
| --------------------- | ------------------------------------------------------------------------------- | ------------------------------------------ |
| **Event log** (đã có) | Metadata, provenance, Judgment, hash của mọi artifact                           | Nguồn sự thật, nhỏ, append-only, vĩnh viễn |
| **Blob store**        | Bytes thực của artifact/chunk/evidence/scene/definition, khóa bằng content hash | To, có vòng đời                            |

Hệ quả then chốt: **mất blob ≠ mất lịch sử** — hash trong event log vẫn chứng minh được "cái gì đã tồn tại, ai tạo, dùng ở đâu" kể cả khi bytes đã bị dọn theo policy.

## 2. Backend — adapter taxonomy mở

- Engine chỉ biết interface tối giản theo hash: `put / get / exists / delete`. Backend cắm qua adapter: filesystem (self-host đơn giản nhất), S3-compatible, cloud blob… — cùng pattern driver/model/channel; adapter có identity + version.
- Ghi kiểu streaming/multipart cho binary lớn (video, dataset) — khớp quyết định "reference + verification depth" của Handoff; evidence RPA "hash stream ngay, blob upload lười" đổ về đúng subsystem này.

## 3. Vòng đời — "hash vĩnh viễn, bytes theo policy"

- **GC theo tham chiếu**: blob còn được instance đang chạy / provenance trong cửa sổ retention / lockfile / pin tham chiếu → giữ; hết tham chiếu → GC (đúng logic uninstall của Block §7 — một cơ chế, mọi loại).
- **Retention theo loại artifact** (engine ép policy tồn tại, template cấp giá trị): deliverable ≠ evidence RPA ≠ scene trung gian — evidence nặng có đường cold-storage hoặc xóa-bytes-giữ-hash sau N ngày.
- Xóa bytes là hành động có dấu vết (event log ghi "blob dọn theo policy P") — audit không bao giờ gặp lỗ đen không giải thích.

## 4. Tenant, mật, residency

- Namespace blob **theo tenant**; mã hóa at-rest theo khóa tenant (khóa do tenant tự quản là extension point EE).
- **Dedup chỉ trong phạm vi tenant** — dedup cross-tenant bị cấm tường minh: content-addressing chéo tenant là side-channel (dò được tenant khác có cùng nội dung), vi phạm invariant 4.
- **Storage policy theo classification** (nối lattice của Knowledge §3): mức mật quyết vùng lưu (residency), backend được phép, và yêu cầu mã hóa — `secret` không nằm trên backend ngoài danh sách duyệt.

## 5. Nguồn ngoài

- Artifact có thể _trỏ_ vào hệ ngoài (Drive, SharePoint, URL): reference **bắt buộc kèm hash snapshot lúc ingest**. Nguồn ngoài mutable — lần đọc sau hash lệch = **Violation** (nội dung đã đổi dưới chân), xử theo policy handoff; muốn ổn định thì materialize bytes vào store (một hành động tường minh).

## 6. Truy cập

- Đường máy: mọi consumer (executor, verifier, inbox render) đọc qua engine bằng hash + quyền ngữ cảnh (tham gia task/process, grant theo Role với knowledge). Không có URL công khai mặc định; link chia sẻ ra ngoài = **external effect** (chịu egress theo classification).
- Quyền duyệt-xem-tự-do ngoài ngữ cảnh task: theo cơ chế hợp-grant + read-event — **Tenant & Identity §4**.

## 7. Ranh giới

- **Hub (OCI) là kho phân phối** — tĩnh, cross-tenant, immutable+yank; **Artifact Store là kho runtime** — per-tenant, có vòng đời. Cài block = pull từ Hub → materialize vào store của tenant. Không trộn hai vai.
- Store không diễn giải nội dung (việc của Perception/verifier/renderer) — chỉ bytes + hash.

## 8. Non-goals

- Không phải file manager/DMS cho người dùng cuối; không public bucket mặc định.
- Không dedup cross-tenant; không xóa im lặng (mọi GC có event).
- Không tự materialize nguồn ngoài (hành động tường minh).

## 9. Nhật ký quyết định

| Vấn đề           | Chốt                                                                           |
| ---------------- | ------------------------------------------------------------------------------ |
| Vị trí           | Subsystem Core engine tầng 1 — không phải domain/module                        |
| Sự thật vs bytes | Event log giữ sự thật vĩnh viễn; blob có vòng đời — mất blob không mất lịch sử |
| GC               | Theo tham chiếu + retention theo loại; xóa có event                            |
| Dedup            | Chỉ trong tenant — cross-tenant là side-channel, cấm                           |
| Mật              | Storage policy theo classification lattice; mã hóa per-tenant; residency       |
| Nguồn ngoài      | Reference + hash snapshot bắt buộc; lệch = Violation                           |
| Hub              | Kho phân phối ≠ kho runtime — hai vai tách bạch                                |

## Litmus (spec-level, theo L5)

1. Xóa blob theo policy — provenance và hash vẫn chứng minh được lịch sử đầy đủ?
2. Không tồn tại đường dedup cross-tenant (kể cả cùng content hash)?
3. Nguồn ngoài đổi nội dung — hash lệch phát hiện lúc đọc, thành Violation?

## FMEA (theo F8)

| Hỏng                     | Phát hiện                     | Phục hồi                                                                     |
| ------------------------ | ----------------------------- | ---------------------------------------------------------------------------- |
| Blob mất                 | `exists(hash)` fail           | Re-materialize từ nguồn; nếu bytes-gone: hash vẫn chứng minh lịch sử + event |
| Backend down             | put/get lỗi                   | Retry → on_fail/escalate của task; không mất sự thật (ở log)                 |
| Nguồn ngoài đổi nội dung | Hash mismatch lúc đọc         | Violation theo policy handoff                                                |
| GC nhầm tham chiếu       | GC 2 pha + event từng lần xóa | Khôi phục backup; sự thật không mất                                          |
