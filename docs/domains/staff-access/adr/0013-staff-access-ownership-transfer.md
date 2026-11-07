# ADR-0013 — Ownership transfer: `staff-access` tiếp quản staff/RBAC từ `backoffice`; storage `db-staff-access`, schema `staff_access`

> 📌 Thư mục này là bounded context **Staff Access** (xem [`../README.md`](../README.md) §4): ADR này thi hành việc chuyển ownership của staff/RBAC từ `backoffice` sang `staff-access`. Khác ADR-0001…0012 — vốn được viết dưới framing A21 (`backoffice` còn sở hữu staff/RBAC) — ADR này supersede phạm vi tương ứng của A21.

> **Trạng thái:** Accepted · **Ngày:** 2026-10-30 · **Quyết định từ:** [`architecture/01-architecture.md`](../../../architecture/01-architecture.md) §2.2 · **Issue:** #426

## Bối cảnh

A21 ([`architecture/01-architecture.md`](../../../architecture/01-architecture.md) §8) gán cho `backoffice` quyền sở hữu staff directory, permission catalog, role, staff-role assignment và authorization audit; [ADR-0001](./0001-storage-schema-staff-rbac.md) chốt storage `db-backoffice`, schema `backoffice` dưới framing đó. Roadmap Phase 1 xác lập bounded context `staff-access` làm owner đích của nghiệp vụ staff/RBAC/entitlement/audit với deploy unit riêng (P1.4); P1.1 yêu cầu chốt domain model và schema ownership với target `db-staff-access`; ghi chú framing ở §2.2 của hệ thống yêu cầu một ADR supersede khi implement. Câu hỏi ADR này phải trả lời: tên database/schema cho ownership mới là gì, và cách ghi nhận việc chuyển mà không âm thầm sửa bất kỳ quyết định đã Accepted nào.

Hiện trạng chuyển tiếp (không phải chủ đề quyết định): `apps/backoffice` hôm nay sở hữu migrations `0001–0006`, binding `DB_BACKOFFICE` và database `db-backoffice` thật. Docs giữ nguyên tắc target-only — cơ chế migrate/rollout dữ liệu giữa hai tên là việc implementation của Phase 1, không được quyết lại ở đây.

## Phương án

| #   | Phương án                                                                                                                                                          | Đánh giá                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **ADR mới**: supersede phạm vi sở hữu của A21; đặt tên storage theo bounded context mới (`db-staff-access`, schema `staff_access`); giữ nguyên mọi quyết định khác | Chấp nhận — đúng quy tắc "đảo một quyết định phải qua ADR mới, không sửa ADR đã Accepted" của [`adr/README.md`](./README.md); P1.1 được chốt trước khi P1.4 dựng deploy unit                |
| 2   | Sửa ADR-0001 tại chỗ (đổi tên database/schema trong body)                                                                                                          | Loại — sửa ADR Accepted để đổi ý là đổi ý âm thầm, vi phạm quy tắc index ADR                                                                                                                |
| 3   | Giữ tên `db-backoffice`/schema `backoffice` cho bounded context `staff-access`                                                                                     | Loại — tên storage phải theo owner của nó (A9): sau transfer `backoffice` chỉ còn composition/UI + BFF và không còn sở hữu nghiệp vụ staff/RBAC, giữ tên cũ là owner-name lệch storage-name |
| 4   | Chưa đặt tên, chờ chốt cùng lúc deploy unit được dựng                                                                                                              | Loại — P1.1 chốt schema ownership **trước** implement; provisioning và migration cần tên chốt trước khi viết DDL                                                                            |

## Quyết định

- **Supersede phạm vi sở hữu của A21.** Trách nhiệm staff directory, permission catalog, role, staff-role assignment, product entitlement và authorization audit — cùng database staff/RBAC/audit và mọi API quản trị nhân sự/quyền — chuyển từ `backoffice` sang bounded context `staff-access`. A21 giữ nguyên trong bảng §8 của hệ thống với con trỏ supersede trỏ về ADR này; sau khi P1.4 dựng xong deploy unit, `backoffice` chỉ còn composition/UI + BFF.
- **Database: `db-staff-access`, PostgreSQL.** Đây là đổi tên quyết định của [ADR-0001](./0001-storage-schema-staff-rbac.md) (`db-backoffice`) cho ownership mới — rationale của ADR-0001 giữ nguyên: engine theo quy tắc bounded context (A20), một database một owner (A9), nằm cùng PostgreSQL instance tier khởi đầu như `db-account`/`db-auth` (A2, A3).
- **Schema ứng dụng: `staff_access`** — mirror tên database để ranh giới grant của runtime role đọc được ngay từ tên, và để không mượn tên `backoffice` mà context này không còn sở hữu.
- **Mô hình role ba tầng** giữ pattern của ADR-0001: `ecoma_owner` / `ecoma_staff_access_migrator` / `ecoma_staff_access_runtime` — tham chiếu pattern, không dùng chung credential; chặn chéo `REVOKE CONNECT` (kể cả rút khỏi `PUBLIC`) và Hyperdrive riêng với query cache OFF theo đúng ADR-0001 (A5, invariant 14).
- **Không đổi:**
  - Domain model khái niệm staff/role/permission/assignment/entitlement/audit — [`../domain-model.md`](../domain-model.md) §3.
  - Các quyết định ADR-0002…0012 — kể cả khi body của chúng gọi tên `db-backoffice`: chỗ gọi tên đó đọc theo ownership mới là `db-staff-access`, nội dung quyết định không đổi.
  - System invariants 31–36 ([`architecture/01-architecture.md`](../../../architecture/01-architecture.md) §9).
  - Splits catalog-govern/backend-enforce (A23, [ADR-0009](./0009-no-internal-authorization-result-contract.md)) và token validity ≠ privilege currency (A24, [ADR-0002](./0002-revocation-latency-risk-class.md)).
- **Vẫn mở (không chốt ở đây):** tập nhãn `staff status` ([`../domain-model.md`](../domain-model.md) §3.2); nội dung từng system-defined role (§3.4); cơ chế bảo đảm revocation `high` ≤ 5s (Phase 2, P2.5).

## Hệ quả

- Mọi tham chiếu target-framing tới storage staff/RBAC dùng `db-staff-access`/`staff_access`; tài liệu đích giữ con trỏ về ADR này thay vì nhân bản quyết định.
- Provisioning `db-staff-access` đi theo pattern bốn bước của ADR-0001 (infrastructure → expand → binding → compatible rollout) khi deploy unit staff-access được dựng; trước đó `db-backoffice` + migrations `0001–0006` của `apps/backoffice` vẫn tồn tại nguyên trạng — docs không mô tả bước chuyển.
- Ngân sách vận hành giữ như ADR-0001 đã tính: một database, một bộ ba role, một Hyperdrive config.
- Catalog bounded context và deployment map chỉ thêm `staff-access` khi deploy unit thật sự được dựng — ADR này không tạo deploy unit.

## Cross-reference

- **Supersedes:** phạm vi sở hữu staff/RBAC của A21 ([`architecture/01-architecture.md`](../../../architecture/01-architecture.md) §8); phần tên database/schema của [ADR-0001](./0001-storage-schema-staff-rbac.md).
- **System:** A2, A3, A9, A10, A20, A21–A24 · invariant 5, 25, 31–36.
- **Context:** [`../domain-model.md`](../domain-model.md) §7 ("Database trust"), §3, §9 · [`../README.md`](../README.md) §4 · SR-010, SR-011, SR-015 · T-08 · AC-011, AC-012, AC-015 ([`../../../applications/staff-access/02-requirements.md`](../../../applications/staff-access/02-requirements.md)).
- **Kế thừa roadmap cũ:** Phase 1 (P1.1 schema ownership, P1.4 deploy unit, P1.5 ADR này) · Phase 2 (P2.5 cơ chế revocation ≤ 5s → [ADR-0014](./0014-revocation-sla-mechanism.md)).
