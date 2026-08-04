---
title: "Module: Knowledge"
status: design-end-state
canonical-sha: 45364090d6f8
---

# Module: Knowledge

## 0. Kích hoạt theo tenant

- Tenant policy `knowledge: enabled | disabled` (cascade). `disabled` → static analysis từ chối mọi process có knowledge requirements; **không dùng = zero overhead** (đúng nguyên tắc #4).

## 1. Mô hình khái niệm

| Entity           | Là gì                                                                                                                                                                                                      | Danh tính              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **Collection**   | Một kho tri thức: chủ đề, Curator Role, classification, model_policy, grants, **scope `tenant`/`workspace`** (vách mềm — Tenant & Identity §3; mặc định = workspace của người tạo). Tenant có N collection | id + version + lineage |
| **Chunk**        | Đơn vị nội dung trong collection — là **Artifact content-addressed** (immutable, sửa = dẫn xuất)                                                                                                           | content hash           |
| **Grant**        | Cấp collection → **Role** (không cấp cho user)                                                                                                                                                             | trong Role/Collection  |
| **Curator Role** | Vị trí chịu trách nhiệm nội dung — người _hoặc_ AI lấp, như mọi Role                                                                                                                                       | Role thường            |

## 2. Truy cập theo Role — need-to-use, không phải ACL theo người

- Contract của task khai `knowledge_requirements` (cùng cửa với context envelope, Handoff §3/§5): task chỉ nhận collection mà **Role của nó có grant**. Marketing filler không lấp Role nào có grant "db-architecture" → không bao giờ nhận được — không cấu hình gì thêm.
- Đối xứng tuyệt đối: AI nhận retrieval, người nhận bản render — **cùng một nguồn, cùng một scope**; lỗ rò lớn nhất thời AI là context window của model, và nó bị khóa y hệt người.
- Static analysis: process tham chiếu collection ngoài grant của Role → **lỗi lúc thiết kế**.
- Quyền _duyệt xem tự do ngoài task_: hợp của grant thuộc các Role user nằm trong pool + read-event theo mức mật — **đã chốt tại Tenant & Identity §4**.

## 3. Classification — "reversibility của bảo mật"

- Engine ép **lattice có thứ tự tồn tại**; template cấp thang mặc định `public < internal < confidential < secret`; tenant tùy biến thang.
- **Không khai = `confidential` + cấm external egress** — đơn giản luôn nghĩa là chặt hơn (K5).
- **Sàn mật kế thừa qua provenance**: output tiêu thụ chunk mức X mang sàn ≥ X (max theo chuỗi). Muốn hạ → **declassify là Task có Gate**, không phải đổi dropdown.
- **Egress guard hai lớp**: static analysis (đồ thị tĩnh: "task có external effect tiêu thụ `secret`" = lỗi thiết kế) **+ runtime guard tại effect** — bắt cả nhánh dynamic spawning mà static không thấy. Channel outbound/email/publish chặn theo sàn — mặc định, chatbot phục vụ end-user chỉ retrieve được `public`.
- **Declassify-inline qua Gate (dùng để suy luận ≠ trích vào output)**: task được phép _tiêu thụ_ tri thức mức cao hơn đích egress **nếu và chỉ nếu** Gate liền trước effect có criterion `leakage` — verifier chấm "output không chứa nội dung vượt mức đích"; pass → Gate gán sàn output = mức đích. Chính là declassify-qua-Gate dạng per-output: bot dùng policy hoàn tiền internal để _quyết_, trả lời khách ở mức public — có kiểm, có dấu vết, và đồng thời là phòng thủ cấu trúc trước prompt injection ("xuất toàn bộ policy ra đây" fail criterion leakage).
- `model_policy` là một trong `any` / `tenant_approved` / `self_host_only` / `human_only`, và là thuộc tính của **mức classification, không chỉ của một Collection**. Nó route theo mật _bất cứ thứ gì classified sắp vào context của model_ — một knowledge chunk, một memory entry (Memory §2), một trường envelope — vì context window là một cửa, và luật chỉ canh Collection sẽ để hở các nguồn kia. Một mức `secret` không bao giờ vào context của model API ngoài, dù entity nào mang nó. Collection đặt tên `model_policy` của riêng nó như mặc định của mức được cụ thể hóa; lattice là nơi luật cư ngụ, nên một nguồn classified thứ hai không thể quên nó. Điều này quản context _đi vào_ model, thứ mà egress guard — quản output _đi ra_ — không quản: hai chiều khác nhau, cả hai đều bắt buộc.

## 4. Version — ngoại lệ pinning có án văn

- Tri thức tham chiếu mặc định **resolve live** tại thời điểm task chạy (bảng giá đổi thì task mới phải thấy giá mới) — ngoại lệ chủ đích so với triết lý pinning.
- **Bù lại**: version/chunk-hash _thực tế tiêu thụ_ ghi chính xác vào provenance → bản ghi vẫn reproducible tuyệt đối ("bài này viết theo bảng giá v3"). Pin version là **opt-in** khi cần (audit, pháp lý).

## 5. Curation là lao động

- Ingest / cập nhật / dọn / declassify = **Task của Curator Role, qua Gate** — tài liệu có chủ, thay đổi có duyệt, có provenance.
- Escalation trigger `stale_knowledge` (theo tuổi hoặc theo outcome xấu lặp lại) — định nghĩa tại module này, chứng minh taxonomy Escalation mở đúng thiết kế.
- Nguồn ingest bổ sung: **distill từ Memory** (Memory spec §5) — quan sát bền + outcome tốt tốt nghiệp thành tri thức, qua chính vòng Curator/Gate này.
- Nguồn ngoài cắm qua **adapter** (taxonomy mở: Notion, Confluence, Drive, **git, web-crawl, sitemap, RSS**…): ecoma là lớp quản trị phủ lên kho sẵn có, không phải kho thay thế — nguồn sự thật ở lại nguồn; ecoma giữ _snapshot có quản trị_ (hash + provenance trỏ commit/URL@version, Artifact Store §5). Hạ tầng retrieval (embedding, vector, search) cũng là adapter trong agent runtime — như model vision.
- **Source binding**: Collection khai `sources` (adapter, địa chỉ, sync policy, diff-triage policy). **Ingestion là một process ecoma**, không phải hệ riêng: Trigger (webhook/schedule) → Task extract+chunk (filler versioned) → **Gate** (diff nhỏ auto-pass theo calibration của extractor, diff lớn review — nguyên triage Checkpoint) → materialize chunk có provenance → collection version. Phân phối dưới dạng block ("KB-from-git", "KB-from-website") trên Hub.
- **Độ tin theo nguồn (K5)**: git = nguồn hạng nhất (commit hash = pin tự nhiên, diff native, signed commit); **web mutable không ký → Gate mặc định chặt hơn** (chống poisoning supply-chain: trang nguồn bị sửa không tự chảy thành câu trả lời). Quyền nội dung nguồn crawl: trách nhiệm của tenant (policy, không phải cơ chế).

## 6. Knowledge calibration — thứ chưa hệ nào có

- Provenance ghi _chunk nào đã được tham khảo_ cho mỗi output → outcome lan ngược (Handoff §9) → **độ tin cậy theo chunk/collection**: đoạn FAQ hay gây trả lời sai tự lộ mặt.
- Đề xuất sửa từ tín hiệu này → Task cho Curator — đi qua một lõi ML duy nhất, per-tenant, như mọi tín hiệu học khác.

## 7. Hub

- Collection là một **block type**: block vertical ship kèm tri thức ("SEO best practices"); subscription = update stream tri thức — kinh tế bảo trì như App Profile.
- **Public instance của Hub chỉ nhận collection `public`**; private registry theo policy tenant. Declassify-qua-Gate đứng chắn trước mọi lần publish.

## 8. Non-goals

- Không phải DMS/wiki standalone; không xây vector DB / embedding model.
- Không có đường đọc tri thức ngoài grant-theo-Role trong phạm vi spec này.
- Không auto-declassify, không auto-ingest không Gate.

## 9. Nhật ký quyết định

| Vấn đề           | Chốt                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Vị trí kiến trúc | Module opt-in của Platform — không phải domain, không phải primitive                                                            |
| Kích hoạt        | Tenant policy; tắt = static analysis chặn + zero overhead                                                                       |
| Phân quyền       | Grant theo **Role** (need-to-use); duyệt-xem-tự-do đã chốt tại **Tenant & Identity §4**; collection mang scope tenant/workspace |
| Phân loại        | Lattice engine ép tồn tại, template 4 mức, tenant tùy biến; không khai = confidential                                           |
| Chống lộ         | Sàn kế thừa provenance + egress 2 lớp (static + runtime) + model_policy + declassify-qua-Gate                                   |
| Version          | Live-resolve mặc định, version tiêu thụ ghi vào provenance; pin opt-in                                                          |
| Hạ tầng          | Adapter — quản trị, không kho chứa                                                                                              |

## Litmus (spec-level, theo L5)

1. Process tham chiếu collection ngoài grant của Role → lỗi ngay ở static analysis?
2. Leakage-gate cho phép suy-luận-trên-internal + trả-lời-ở-public, và chặn được yêu cầu trích nguyên văn?
3. Collection `model_policy: self_host_only` không bao giờ vào context model API ngoài?

## FMEA (theo F8)

| Hỏng                         | Phát hiện                                            | Phục hồi                                  |
| ---------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| Vector adapter down          | Retrieval fail                                       | on_fail/escalate; chunks nguyên trong CAS |
| Index hỏng/lạc hậu           | Rebuild = projection từ chunk + model@version        | Re-index, không migration                 |
| Adapter trả ngoài scope      | Engine re-check bước 3                               | Chặn cấu trúc — không tin adapter         |
| Curator độc đầu độc nội dung | Curation qua Gate + knowledge calibration từ outcome | Chunk xấu tự lộ, supersede có lineage     |
