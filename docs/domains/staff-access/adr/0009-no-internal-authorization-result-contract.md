# ADR-0009 — Internal contract cho kết quả authorization: không có; resource-owning backend tự enforce

> 📌 Thư mục này là bounded context **Staff Access** (xem [`../README.md`](../README.md) §4): ADR này chốt quyết định cho nghiệp vụ staff/RBAC khi được tách khỏi `backoffice` (A21–A24). Ngày nay `backoffice` còn sở hữu staff/RBAC.

> **Trạng thái:** Accepted · **Ngày:** 2026-10-21 · **Quyết định từ:** [`domain-model.md`](../domain-model.md) §9 (hàng 9), §4 · **Issue:** #87

## Bối cảnh

A21 chốt "enforcement chia đôi": `backoffice` **định nghĩa** permission và vòng đời của chúng trong catalog; **resource-owning backend** _enforce_ permission đó trên operation/resources của chính nó, trên mọi protected request (A23). `architecture/01-architecture.md` §2.2 đã loại trước phương án "gọi đồng bộ một authorization service trung tâm cho **mỗi** request" vì nó biến authorization thành serving-path dependency. Câu hỏi §9 còn mở: **có cần một contract nội bộ riêng để nhận kết quả authorization giữa `backoffice` và resource-owning backend không** — với ghi chú "không mặc định một lời gọi đồng bộ mỗi request" (§4).

Cách hoạt động của mô hình hiện tại: resource-owning backend enforce với **dữ liệu nó có** — token đã xác thực (principal, `sub`) + **assignment đã đồng bộ** về phía nó (hoặc query trực tiếp khi cần — cách đồng bộ cụ thể là quyết định của từng backend, không thuộc ADR này). `backoffice` không đứng giữa request và resource.

## Phương án

| #   | Phương án                                                                                                          | Đánh giá                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Không có contract nhận kết quả authorization; không sync call mỗi request; chỉ batch/event-based sync**          | Chấp nhận — bám đúng A23 và loại serving-path dependency của authorization                                                                                                                                                 |
| 2   | Sync call từ resource-owning backend sang `backoffice` cho **mọi** protected request ("check với source of truth") | Loại — đã bị A23 loại trước; authorization thành serving-path dependency, một sự cố `backoffice` làm sập đường serve của backend khác                                                                                      |
| 3   | Sync call **một bản cache/kết quả** per-request chỉ cho thao tác `high` (ADR-0002)                                 | Loại — vẫn cùng hình dạng phương án 2 ở lớp quan trọng nhất; A23 loại gọi đồng bộ trung tâm cho mỗi request, không phân biệt class; backend có cơ chế riêng cho `high` (event-driven invalidation, re-check at write time) |
| 4   | Batch/event-based sync của assignment/cache invalidation                                                           | **Một phần của quyết định** — đây là cách đúng để state authorization lan tới backend, không phải contract "nhận kết quả authorization"                                                                                    |
| 5   | Contract hỏi chiều ngược: backend gửi kết quả authorize về `backoffice` để `backoffice` lưu/audit                  | Loại ở v1 — `backoffice` không cần những quyết định deny/allow của backend để vận hành; audit của backend là của backend (§4: quyết định deny cũng phải quan sát được — ở backend đó)                                      |

## Quyết định

**Không có contract nội bộ nhận kết quả authorization giữa `backoffice` và resource-owning backend. Không có sync call tới `backoffice` trên đường request. Resource-owning backend tự enforce với dữ liệu nó có; state authorization lan tới backend bằng batch/event-based sync.**

- **`backoffice` không tham gia quyết định authorization trên một request cụ thể nào.** Vai trò của nó là: sở hữu catalog, sở hữu assignment, phát sự kiện thay đổi state authorization. Nơi một request được decide không đổi: tại resource-owning backend.
- **Batch/event-based sync là kênh duy nhất lan truyền state.** Hình thức cụ thể (event qua transactional outbox, batch pull, hay projection do backend giữ) là quyết định của từng backend/workstream, nhưng không có đường nào là sync-call-per-request.
- **Bất kỳ contract nội bộ nào giữa `backoffice` và backend khác ra đời sau này** — kể cả contract nhận kết quả authorization — **phải được chốt bằng ADR mới** với bằng chứng nhu cầu cụ thể; nó không được xuất hiện như một endpoint thêm vào trong implementation. Mọi internal contract dùng envelope HMAC canonical [`ecoma-internal-v1`](../../../applications/auth/01-architecture.md) §5.1.8 (SR-012); `backoffice` không tự định nghĩa envelope thứ hai.
- **Enforcement tại backend không phụ thuộc availability của `backoffice`** ở thời điểm request: một sự cố `backoffice` không làm sập đường serve của backend (A23 loại authorization thành serving-path dependency).
- **Quyết định deny của backend vẫn quan sát được tại backend** (SR-018) — không cần gửi về `backoffice` để có tín hiệu.

## Hệ quả

- Workstream B không cần implement contract nhận kết quả authorization; nó cần implement (hoặc xác nhận) kênh batch/event-based sync của assignment/scope và cơ chế cache invalidation theo ADR-0002.
- Resource-owning backend chấp nhận độ trễ sync của ADR-0002 như một trade-off có chủ ý; nếu có backend nào cần quyết định authorization fresher hơn target `high` (≤ 5s), nó dùng re-check at write time hay cơ chế riêng — không phải mở sync call về `backoffice`.
- Tính available của system không phụ thuộc `backoffice` uptime cho các read path nghiệp vụ thông thường; `backoffice` down là mất khả năng quản trị (gán/thu hồi), không phải mất serving.
- Nếu trong tương lai phát hiện nhu cầu thật của một contract nhận kết quả authorization, ADR mới ra đời trước khi implement — như ghi ở Quyết định.

## Cross-reference

- **SR/T-**: SR-002, SR-003, SR-012, SR-018 · T-09, T-14, T-16 ([`applications/staff-access/02-requirements.md`](../../../applications/staff-access/02-requirements.md)).
- **Thiết kế:** [`domain-model.md`](../domain-model.md) §4, §5, §7 · §9 (hàng "Internal contract").
- **System:** [`architecture/01-architecture.md`](../../../architecture/01-architecture.md) §2.2, §5, §6 · A21, A23 · invariant 7, 33.
- **Envelope HMAC canonical:** [`../auth/01-architecture.md`](../../../applications/auth/01-architecture.md) §5.1.8.
- **Implementation:** #86 (Workstream B).
