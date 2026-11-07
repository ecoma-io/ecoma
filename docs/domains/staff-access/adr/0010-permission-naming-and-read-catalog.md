# ADR-0010 — Cách đặt tên permission read và seed catalog backoffice

> 📌 Thư mục này là bounded context **Staff Access** (xem [`../README.md`](../README.md) §4): ADR này chốt quyết định cho nghiệp vụ staff/RBAC khi được tách khỏi `backoffice` (A21–A24). Ngày nay `backoffice` còn sở hữu staff/RBAC.

> **Trạng thái:** Accepted · **Ngày:** 2026-10-22 · **Quyết định từ:** [`domain-model.md`](../domain-model.md) §3.3, §9 · **Issue:** #100

## Bối cảnh

Catalog permission của `backoffice` được tạo **rỗng có chủ ý** ở migration `0001`
(`backoffice.permissions`), vì §3.3 cấm "phát minh permission từ tài liệu". Issue #99
(read-through routes) cần ba permission đọc để đi qua `requirePermission`, nhưng việc
**đặt tên permission là governance action có audit** (§3.3, invariant 10) — không thể
phát minh từ tài liệu hay từ route. Cần chốt một quy ước đặt tên và một tập permission
read tối thiểu, có audit từ git, để #99 resume.

Phạm vi issue này **chỉ seed permission**, không seed role, không seed assignment, không
seed staff. System-defined role là quyết định riêng (ADR-0004, #87/#85).

## Phương án đặt tên

| #   | Phương án                                                    | Đánh giá                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **`<domain>.<action>` (dot-style)**                          | Chấp nhận — khớp định nghĩa §3.3 ("định danh một hành động trên một resource domain"), khớp fixture prototype `staff.read`, và khớp convention đã dùng ở ví dụ `delivery.redrive`                        |
| 2   | `<domain>:<action>` (colon-style, shorthand trong issue #99) | Loại — chỉ là cách viết tắt trong prose; catalog lưu `domain` và `action` là **hai cột tách**, và `id` phải là một định danh không mơ hồ; colon không xuất hiện ở fixture hay ở ví dụ `delivery.redrive` |
| 3   | `<domain>_<action>` hoặc `<action>_<domain>`                 | Loại — trộn hai nửa định danh thành một label, làm mất ràng buộc `UNIQUE (domain, action)` và khó truy vấn theo domain                                                                                   |
| 4   | Permission bao trùm (`*`, `admin.all`, wildcard)             | Loại — §3.4 cấm bypass role unrestricted; một permission bao trùm trong catalog là đường tắt đúng thứ đó                                                                                                 |

## Quyết định

**Tên permission theo định dạng `domain.action` (dot-style).** `id` của một permission
trong `backoffice.permissions` bằng đúng chuỗi `<domain>.<action>`, và hai nửa được lưu
riêng ở cột `domain` và `action` (ràng buộc `UNIQUE (domain, action)` giữ định danh).

**Ba permission read được seed ở migration `0003_permission_catalog_seed.sql`, status
`active`:**

| id                | domain       | action |
| ----------------- | ------------ | ------ |
| `staff.read`      | `staff`      | `read` |
| `role.read`       | `role`       | `read` |
| `permission.read` | `permission` | `read` |

- **Chỉ permission, không role:** không seed `roles`, `role_permissions`,
  `role_assignments`, `staff`. System-defined role là quyết định riêng (ADR-0004) và
  phải xuất phát từ catalog thực tế — chưa có ở đây.
- **Không surplus:** ba permission trên là đúng những gì route read của #99 cần
  (`GET /api/staff`, `GET /api/roles`, `GET /api/permissions`). Không thêm permission
  "cho chắc", không thêm permission chưa được route nào dùng.
- **Retired là terminal:** một permission đã retire không được quay lại `active` bằng
  UPDATE im lặng (trigger `permissions_retired_immutable` trong `0001`); đưa lại phải
  là một seed migration mới được review.
- **Idempotent:** seed dùng `INSERT … ON CONFLICT (id) DO NOTHING`, nên apply lại là
  no-op — đúng quy ước migration của `db-backoffice` (forward-only, không down-migration).

**Quyết định phụ về route unavailable (ghi để route-owner unit dùng, không mở rộng ở
đây):** trong giai đoạn này, principal không verify được được xử lý theo đường **503**
(unavailable) thay vì 401; 401 không được dùng cho đường này. Việc chi tiết enforcement
thuộc route-owner unit (#99), ADR này chỉ ghi nhận quyết định để tránh hai route đi
hai hướng khác nhau.

## Hệ quả

- Issue #99 có thể resume trên ba tên permission `staff.read`, `role.read`,
  `permission.read` — không phát minh permission mới, không đổi contract enforcement.
- Catalog vẫn sealed: runtime role chỉ `SELECT` trên `permissions`; INSERT/UPDATE thuộc
  migrator (migration `0003`). Invariant 10 giữ nguyên.
- Nếu sau này cần permission read mới (ví dụ `audit.read` cho route audit), đó là một
  seed migration mới + ADR/cross-reference tương ứng — không thêm vào `0003` đã apply.
- Prototype fixture (`apps/backoffice/app/backoffice-data/prototype-fixture.ts`) dùng
  `staff.read` — khớp catalog thật sau ADR này; các id prototype khác (`delivery.redrive`,
  `mail.read`, …) là minh hoạ, không phải catalog, và **không** được seed ở đây.

## Cross-reference

- **SR/T-**: SR-010, SR-020 · invariant 10 ([`applications/staff-access/02-requirements.md`](../../../applications/staff-access/02-requirements.md), [`domain-model.md`](../domain-model.md) §8).
- **Thiết kế:** [`domain-model.md`](../domain-model.md) §3.3, §8 invariant 10, §9.
- **Implementation:** migration `apps/backoffice/db/migrations/0003_permission_catalog_seed.sql` · Issue #100 (unblocks #99).
- **Prototype fixture (minh hoạ, không authoritative):** `apps/backoffice/app/backoffice-data/prototype-fixture.ts`.
