# ADR-0034 — Ba permission ghi của bổ nhiệm thường: `role.assign`, `role.revoke`, `staff.create`

> 📌 Thư mục này là bounded context **Staff Access**; ADR này chốt **bộ permission ghi cuối cùng** mà đường bổ nhiệm thường ([ADR-0023](./0023-administrator-lifecycle-paths.md) Quyết định 2) cần, kèm role nắm giữ và seed migration tương ứng — nghĩa vụ ADR-before-seed mà Quyết định 2 và comment trên issue #44 (2026-11-13) đặt ra trước khi catalog canonical nhận bất kỳ literal ghi nào mới.

> **Trạng thái:** Accepted · **Ngày:** 2026-11-15 · **Quyết định từ:** [ADR-0023](./0023-administrator-lifecycle-paths.md) Quyết định 2, 6 · [ADR-0033](./0033-permission-verdict-contract.md) Quyết định 2 · [ADR-0010](./0010-permission-naming-and-read-catalog.md) · [ADR-0021](./0021-first-admin-bootstrap-path.md) Quyết định 8 · [ADR-0024](./0024-trusted-bootstrap-verified-address.md) Quyết định 5 · **Issue:** #44

## Bối cảnh

ADR-0023 Quyết định 2 chốt bổ nhiệm thường là đường duy nhất hợp lệ cho administrator thứ hai, và đặt việc seed permission ghi vào một điều kiện tường minh: literal theo quy ước `domain.action` là `role.assign` và `role.revoke`, nhưng **đây chưa phải quyết định đã chốt** — thêm mục vào catalog là thay đổi catalog canonical, và [ADR-0010](./0010-permission-naming-and-read-catalog.md) cùng ADR-0021 Quyết định 8 xếp việc đó vào một seed migration mới **đúng kèm ADR tương ứng**. Comment trên [#44](https://github.com/ecoma-io/ecoma/issues/44) (2026-11-13) nhắc lại đúng nghĩa vụ này: ADR phải được accept **trước** khi seed migration áp dụng.

Cùng lúc, đường tạo staff identity cho người thứ hai vẫn không có caller: `insertStaff` tồn tại trong `libs/staff-access-infrastructure` nhưng không route nào gọi. Nếu bổ nhiệm thường có hai permission gán/thu hồi mà không có đường tạo staff, hệ thống vẫn không bổ nhiệm được ai — nên đường tạo staff cũng cần một permission ghi riêng nếu nó thuộc catalog.

Hai dữ kiện hẹp phạm vi:

- **[ADR-0033](./0033-permission-verdict-contract.md) Quyết định 2 đã mở cơ chế**: `0010` cấp `invitation.create` cho role canonical và ghi rõ mọi seed grant mới phải thêm literal vào mảng `later_seed_permissions` của `0008` cùng ADR tương ứng; "Issue #44 (`role.assign`, `role.revoke`, `staff.create`) sẽ dùng migration `0011` trở đi và cùng cơ chế này."
- **Role đích chỉ có thể là role canonical.** ADR-0023 Quyết định 2 chốt bổ nhiệm thường = gán **canonical administrator role**; tạo role thứ hai cho permission là thêm một định danh canonical phải quản trị — cùng lý do ADR-0033 Quyết định 2 đã loại.

## Phương án

| #   | Phương án                                                                                              | Đánh giá                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Ba literal: `role.assign`, `role.revoke`, `staff.create`, cấp cho role canonical, seed bằng `0011`** | Chấp nhận — mỗi literal nắm đúng một capability mà đường bổ nhiệm thường cần, tên khớp quy ước `domain.action` của ADR-0010, role đích là role canonical duy nhất đã có, cơ chế seed đúng hình ADR-0033 đã mở.                                   |
| 2   | Hai literal (`role.assign`, `role.revoke`), đường tạo staff không vào catalog                          | Loại — không permission nào authorize được `POST /staff` nếu route đó tồn tại, và không route nghĩa là `insertStaff` mãi không có caller; "đường tạo staff do Issue khác sở hữu" đã được ADR-0023 loại vì chặn tiền đề của chính đường bổ nhiệm. |
| 3   | Một literal bao trùm `role.admin` gộp gán/thu hồi                                                      | Loại — ADR-0010 phương án 4 và SR-016 cấm permission bao trùm/wildcard; gán và thu hồi là hai hành động phân biệt khi điều tra audit, mỗi hành động một literal cho phép audit `denied` phân loại được.                                          |
| 4   | Tạo role mới (ví dụ `role-administrator`) nắm ba literal                                               | Loại — một định danh canonical nữa phải seed, bổ nhiệm và audit; ADR-0023 Quyết định 2 đã chốt "bổ nhiệm thường = gán role canonical cho staff thứ hai", không phải gán một role quản-trị-role khác.                                             |
| 5   | Sửa seed đã apply (`0003`/`0007`/`0010`) thay vì migration mới                                         | Loại — ADR-0010 chốt permission mới đi qua **seed migration mới**; runner không có ledger nên file đã apply vẫn chạy lại, và sửa nó là xoá dấu vết governance của một thay đổi quyền.                                                            |

## Quyết định

### 1. Bộ literal ghi cuối cùng: `role.assign`, `role.revoke`, `staff.create`

Catalog canonical (`staff_access.permissions`) nhận **đúng ba** permission ghi mới, mỗi literal là một cặp `(domain, action)` theo quy ước `domain.action` của [ADR-0010](./0010-permission-naming-and-read-catalog.md) — nửa domain là resource noun, nửa action là verb:

| Literal        | `domain` | `action` | Hành động được authorize                                                             |
| -------------- | -------- | -------- | ------------------------------------------------------------------------------------ |
| `role.assign`  | `role`   | `assign` | `POST /staff/:id/assignments` — gán một role cho một staff member                    |
| `role.revoke`  | `role`   | `revoke` | `POST /assignments/revoke` — thu hồi một assignment còn hiệu lực                     |
| `staff.create` | `staff`  | `create` | `POST /staff` — tạo một staff identity mới trong directory (đường cho `insertStaff`) |

- Tên này **chốt lại** ứng viên "chưa chốt" của ADR-0023 Quyết định 2 (`role.assign`, `role.revoke`); ADR này **supersede-in-part** Quyết định 2 ở đúng vế "⚠️ Đây **chưa phải quyết định đã chốt**" — hai tên đó giờ là literal canonical, cùng một literal thứ ba cho đường tạo staff. Phần còn lại của Quyết định 2 (điều kiện route, guard, `granted_by`, audit) giữ nguyên hiệu lực.
- Không permission bao trùm, không `admin.*`, không wildcard (ADR-0010 phương án 4, §4.4/SR-016). Cấp thêm quyền nào cho role canonical sau này vẫn phải qua seed migration mới + ADR tương ứng (ADR-0033 Quyết định 2).
- Audit action của các route **không đổi**: gán/thu hồi vẫn ghi `role_assignment.create`/`role_assignment.revoke` (action audit mô tả thao tác trên resource, không phải permission đã authorize nó). Hàng `denied` của phép kiểm permission dùng `action = <permission>` với `reason = 'permission_denied'`, đúng hình [ADR-0033](./0033-permission-verdict-contract.md) Quyết định 3.

### 2. Role nắm giữ: canonical `system-administrator`, không role mới

Ba literal được cấp cho **đúng một** role hiện có: `kind = 'system'`, `name = 'system-administrator'`, id cố định `eeb3abcb-31ef-479f-9dd1-198a9d520b1b` theo [ADR-0024](./0024-trusted-bootstrap-verified-address.md) Quyết định 5, cùng role mà [ADR-0033](./0033-permission-verdict-contract.md) đã cấp `invitation.create`. Không tạo role mới — cùng lý do ADR-0033 Quyết định 2.

Hệ quả: nội dung role canonical là bốn permission read cộng **bốn** literal đã seed (`invitation.create`, `role.assign`, `role.revoke`, `staff.create`). Mảng `later_seed_permissions` của `0008` khai báo đủ bốn literal đó; một seed grant mới sau này lại thêm vào mảng này kèm ADR.

### 3. Seed: migration mới `0011`, không sửa file đã apply

Ba literal vào catalog bằng migration **mới** `0011_permission_catalog_write_actions.sql`, đúng hình idempotent/fail-loud của `0010` (ADR-0010: không sửa `0003`/`0007`/`0010` đã apply):

1. Insert ba literal vào `staff_access.permissions` với `status = 'active'` — idempotent qua `WHERE NOT EXISTS ... ON CONFLICT DO NOTHING`, fail-loud khi literal đã tồn tại với `domain`/`action` khác hay đã `retired` (retired là terminal).
2. Cấp ba literal cho role canonical qua `role_permissions`, sau khi kiểm role canonical tồn tại, `active`, và id cố định không bị hàng khác chiếm.
3. Mảng `later_seed_permissions` của `0008` được mở rộng đúng ba literal mới — assertion "sealed set" so với hợp của hai mảng, nên literal thiếu khai báo làm lần apply kế tiếp dừng; đó là điểm review duy nhất của "role được cấp thêm quyền".

Catalog vẫn sealed cho runtime: grant `INSERT`/`UPDATE`/`DELETE` trên ba bảng catalog vẫn chỉ thuộc migrator (migration `0002`, assertion `0008`).

## Hệ quả

- Người giữ role canonical được bổ nhiệm/thu hồi role và tạo staff identity; mọi người khác bị từ chối 403 kèm một hàng audit `denied` truy được bằng `correlation_id` (ADR-0023 Quyết định 6, ADR-0033 Quyết định 3).
- Sau ADR này, cửa sổ một administrator chỉ còn hai tiền đề hiện thực: enforcement trên route (thuộc #44) và đường tạo Account cho người thứ hai (ADR-0030 của `account`, hiện thực thuộc #227).
- Catalog sau seed là: `audit.read`, `invitation.create`, `permission.read`, `role.assign`, `role.read`, `role.revoke`, `staff.create`, `staff.read` — tám literal, đúng tập khai báo của `0008` cộng seed của `0010` và `0011`.
- Không schema mới, không bảng mới, không role mới. Chỉ ba hàng `permissions` và ba hàng `role_permissions`.

## Cross-reference

- **SR/T-**: SR-002, SR-003, SR-005, SR-013, SR-016, SR-018 · invariant 7, 10 ([`../../../architecture/01-architecture.md`](../../../architecture/01-architecture.md) §9).
- **Thiết kế:** [`./0023-administrator-lifecycle-paths.md`](./0023-administrator-lifecycle-paths.md) Quyết định 2, 6 (supersede-in-part ở vế đã nêu) · [`./0033-permission-verdict-contract.md`](./0033-permission-verdict-contract.md) Quyết định 2, 3 · [`./0010-permission-naming-and-read-catalog.md`](./0010-permission-naming-and-read-catalog.md) · [`./0021-first-admin-bootstrap-path.md`](./0021-first-admin-bootstrap-path.md) Quyết định 8.
- **Implementation:** `apps/staff-access/db/migrations/0011_permission_catalog_write_actions.sql` · `apps/staff-access/src/routes.ts` · `libs/staff-access-contracts/src/management-staff-contract.ts` · Issue #44.
- **Index:** [`./README.md`](./README.md).
