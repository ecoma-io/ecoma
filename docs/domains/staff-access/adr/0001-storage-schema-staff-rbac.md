# ADR-0001 — Storage/schema staff/RBAC: `db-backoffice`, PostgreSQL, schema `backoffice`

> 📌 Thư mục này là bounded context **Staff Access** (xem [`../README.md`](../README.md) §4): ADR này chốt quyết định cho nghiệp vụ staff/RBAC khi được tách khỏi `backoffice` (A21–A24). Ngày nay `backoffice` còn sở hữu staff/RBAC.

> **Trạng thái:** Accepted (Superseded (in part) by [ADR-0013](./0013-staff-access-ownership-transfer.md) — tên database/schema `db-staff-access`/`staff_access` theo ownership mới; engine, mô hình role và chặn chéo giữ nguyên) · **Ngày:** 2026-10-21 · **Quyết định từ:** [`domain-model.md`](../domain-model.md) §9 (hàng 1) · **Issue:** #87

## Bối cảnh

A21 gán cho `backoffice` quyền sở hữu staff directory, permission catalog, role, staff-role assignment và authorization audit, nhưng tên database, schema và cách lưu **chưa chốt** tại thời điểm viết thiết kế. [`architecture/01-architecture.md`](../../../architecture/01-architecture.md) A20 chốt nguyên tắc chọn engine **theo bounded context** (transactional requirement, relational complexity, portability, operational cost, workload, recovery), không theo mức quan trọng của dữ liệu. Workstream A (#85) cần một quyết định storage trước khi viết migration; `docs/architecture/01-architecture.md` §4 hiện ghi "PostgreSQL — chưa provision".

Domain cần lưu là state **transactional, quan hệ** với ràng buộc đa bảng: staff member ↔ Account ID 1:1 (reference, không FK), role → permissions (nhiều-nhiều), role_assignment kèm scope và hiệu lực thời gian, authorization audit **append-only** với grant bị chặn `UPDATE`/`DELETE` (SR-015). Đây là hình dạng dữ liệu của PostgreSQL, không của D1: constraint nhiều bảng, transaction nhiều bảng, grant semantics ở mức table.

## Phương án

| #   | Phương án                                                                          | Đánh giá                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Database PostgreSQL riêng `db-backoffice`, schema ứng dụng `backoffice`**        | Khớp precedent `db-account`/`db-auth` (A2): mỗi service một database, một bộ role, `REVOKE CONNECT` chéo                                                              |
| 2   | D1                                                                                 | Loại — thiếu constraint quan hệ phức tạp, transaction nhiều bảng và grant semantics mà audit append-only (SR-015) cần; A20 hướng PostgreSQL cho core relational state |
| 3   | Schema `backoffice` đặt **trong** database của một service khác (vd. `db-account`) | Loại — vi phạm A9 "mỗi authoritative storage resource một owner" và đảo ranh giới service: `account` sẽ nắm giữ dữ liệu RBAC nó không sở hữu                          |
| 4   | Database dùng chung một database cho nhiều service, phân biệt bằng row/table       | Loại — chung database = chung write authority; §7 và A2 đã loại hình "chung instance" ngay từ đầu                                                                     |

## Quyết định

- **Engine: PostgreSQL.** Business data của `backoffice` theo đúng quy tắc bounded context (A20).
- **Database: `db-backoffice`** — database riêng, chỉ `backoffice` sở hữu (A9). Nằm cùng PostgreSQL instance tier khởi đầu như `db-account`/`db-auth` (A2, A3).
- **Schema ứng dụng: `backoffice`** — toàn bộ bảng staff/role/permission/assignment/audit nằm trong một schema; schema này là ranh giới grant của runtime role.
- **Mô hình role ba tầng** theo pattern của [`../account/03-operations.md`](../../../applications/account/03-operations.md) §3 — **tham chiếu pattern, không dùng chung credential**:
  - `ecoma_owner` — sở hữu database và object; không chạy trong Worker.
  - `ecoma_backoffice_migrator` — quyền DDL trên schema `backoffice`; chỉ chạy trong CI runner; không bao giờ là Worker secret (SR-010).
  - `ecoma_backoffice_runtime` — chỉ DML tối thiểu trên schema `backoffice`; không DDL, không `CREATE`.
- **Chặn chéo:** `REVOKE CONNECT ON DATABASE db-backoffice FROM ecoma_account_runtime, ecoma_auth_runtime` **và** rút khỏi `PUBLIC` — rút khỏi PUBLIC phải đi kèm, vì PostgreSQL cấp `CONNECT` cho `PUBLIC` theo mặc định (lý do chi tiết ở account §3.1). Ngược lại `ecoma_backoffice_runtime` không được `CONNECT` vào `db-account`/`db-auth` (SR-011, AC-011).
- **Hyperdrive:** một config riêng, query cache OFF (A5, `01` invariant 14).
- **Migration:** SQL thuần idempotent, forward-only, apply từ CI runner bằng migrator role với advisory lock theo tên database — pattern của `apps/account/db/`. Migration history **độc lập** với `db-account`/`db-auth`.
- **Phạm vi quyết định:** ADR này chốt **tên database, engine, tên schema, mô hình role và quy tắc chặn chéo**. Thiết kế bảng/cột cụ thể (staff, role, `role_permissions`, `role_assignment`, authorization audit) thuộc workstream A, migration `0001_backoffice_domain.sql` tại #85 — ADR không nhân bản nội dung schema đó và không sửa nó từ đây.

## Hệ quả

- Provisioning `db-backoffice` theo cùng thứ tự bốn bước ở account §3.2 (infrastructure → expand → binding → compatible rollout); mỗi bước dừng an toàn, kiểm được bằng `has_database_privilege`.
- Việc rút `CONNECT` khỏi `PUBLIC` trên `db-backoffice` là **bắt buộc**, không phải tuỳ chọn — bởi `PUBLIC` có `CONNECT` theo mặc định.
- Thêm một Hyperdrive config và một bộ triple role vào ngân sách vận hành (khác gì một database dùng chung sẽ tiết kiệm máy chủ nhưng vi phạm A9).
- Backup/restore: `db-backoffice` dùng chung cluster với `db-account`/`db-auth`, nên `pg_dumpall` dump toàn cluster; chi tiết restore path độc lập theo database sẽ được định nghĩa trong runbook vận hành theo [`../account/03-operations.md`](../../../applications/account/03-operations.md) §9; `db-backoffice` **chưa được provision** tại thời điểm quyết định này.

## Cross-reference

- **SR/T-**: SR-010, SR-011, SR-015 · T-08 · AC-011, AC-012, AC-015 ([`applications/staff-access/02-requirements.md`](../../../applications/staff-access/02-requirements.md)).
- **Thiết kế:** [`domain-model.md`](../domain-model.md) §3, §7 ("Database trust"), §8 invariant 4/11 · §9 (hàng "Storage/schema").
- **System:** [`architecture/01-architecture.md`](../../../architecture/01-architecture.md) §4 · A2, A5, A9, A20, A21 · invariant 5, 25, 34.
- **Pattern tham chiếu:** [`../account/03-operations.md`](../../../applications/account/03-operations.md) §3.
- **Implementation:** #85 (Workstream A).
