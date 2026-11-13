# ADR-0029 — Hằng `display_name` cho staff bootstrap và repair một lần hàng legacy

> 📌 Thư mục này là bounded context **Staff Access** (xem [`../README.md`](../README.md) §4), vì quyết định đi thẳng vào procedure bootstrap administrator. ADR này chốt **giá trị `display_name` mà S1 ghi** và **đường repair cho hàng đã tồn tại**; nó không đụng guard (ADR-0022), ba đường vòng lifecycle administrator (ADR-0023), hay đường verify trusted (ADR-0024).
> **Trạng thái:** Accepted · **Ngày:** 2026-11-13 · **Quyết định từ:** [ADR-0021](./0021-first-admin-bootstrap-path.md) Quyết định 4 · [ADR-0020](./0020-bootstrap-seed-contract.md) Quyết định 10 · [ADR-0023](./0023-administrator-lifecycle-paths.md) Quyết định 6 · **Issue:** #170

## Bối cảnh

S1 của bootstrap (ADR-0021 Quyết định 4) chèn hàng `staff_access.staff` với `display_name` rỗng. Điều tra #170 đã xác nhận: contract staff (`management-staff-contract`) yêu cầu `display_name` 1..200 ký tự, validator phía consumer từ chối **cả trang** listing khi một entry rỗng, nên mọi `GET /api/staff` trên môi trường có hàng đó trả 503 — khi `llm-inference-e2e` bootstrap trước suite backoffice trong cùng job system-test, suite backoffice fail deterministic.

Vế "`display_name` rỗng" của ADR-0021 dựa trên lý do "hồ sơ canonical ở `account`". Nhưng bootstrap **không có** tên nào của người để dùng: input surface của procedure chỉ có `sub`, `operator_ref` (tự khai báo để audit, không chứng minh danh tính) và `correlation_id`; bước Account (A1) chỉ tạo `account.users` + email, không tạo profile; staff-access không được đọc `db-account` (invariant 7/25) và CLI bootstrap là bề mặt offline không có đường HTTP. Contract staff cũng chốt ngược lại ADR-0021: `display_name` là nhãn riêng của sổ staff, **không** đồng bộ từ account. Quyết định cũ không thể giữ được — nó sinh ra hàng vi phạm chính contract mà consumer dùng để đọc sổ.

## Quyết định

1. **S1 ghi hằng `BOOTSTRAP_STAFF_DISPLAY_NAME = 'Bootstrap Superadmin'`** (hằng trong code, đúng quy ước seed identity của ADR-0020 — không phải cấu hình tự do). Nhãn mô tả nguồn gốc row; khi đường ghi staff của Milestone B tồn tại, người có quyền sẽ đặt tên thật. `display_name` vẫn không phải dữ liệu đồng bộ từ account.
2. **Hàng legacy được repair một lần bởi migration `0009_bootstrap_staff_display_name.sql`, không phải bởi bootstrap.** Căn cứ: bootstrap không thể với tới môi trường đã bootstrap — resolve path (`--resolve-if-bootstrapped`) chỉ đọc, lần chạy guarded đầy đủ bị guard từ chối `mode_mismatch` khi `admins_ever > 0`, và nhánh converged của S1 không ghi gì vào staff row (chỉ audit noop). Migration repair là đường duy nhất chạm được mọi môi trường persistent, chạy lại trong mỗi lần `staff-access-deploy` up. Predicate `trim(display_name) = ''` tự-idempotent trên runner không ledger: sau lần sửa đầu không còn hàng khớp.
3. **Phạm vi repair:** chỉ hàng rỗng hoặc chỉ-toàn-whitespace. Tên hợp lệ không bao giờ khớp predicate nên không thể bị ghi đè; `id`, `sub`, `status`, assignment và audit giữ nguyên; `updated_at` bumped đúng bằng lần sửa. Hàng whitespace-only được đưa vào phạm vi dù validator hôm nay chỉ kiểm độ dài (không trim): nhãn chỉ-toàn-whitespace là rỗng về ngữ nghĩa, không có writer production nào tạo ra nó, và sửa nó không mở đường ghi đè tên thật. Mọi status được sửa (active/suspended/terminated) vì contract validate cả entry không-active; trigger terminal không chặn UPDATE chỉ đụng `display_name`.

## Quan hệ supersede

Supersede-in-part **ADR-0021 Quyết định 4** — đúng một câu "tạo **một** hàng `staff_access.staff` … `display_name` rỗng (hồ sơ canonical ở `account`)". Phần còn lại của Quyết định 4 (ánh xạ `sub`, kiểm hai lớp, không cột email) và toàn bộ phần còn lại của ADR-0021 giữ nguyên hiệu lực. Không supersede ADR-0022/0023/0024.

## Hậu quả

- Môi trường fresh: S1 luôn sinh hàng hợp lệ theo contract; 503 của #170 không thể tái phát từ bootstrap.
- Môi trường đã bootstrap (kể cả local lane stack): được repair ở lần `staff-access-deploy` up kế tiếp, trước khi bootstrap chạy trong cùng chuỗi; không cần thao tác thủ công, không xoá dữ liệu.
- Repair không ghi audit row (migration là DML vận hành, không phải authorization action — khác với denial audit của ADR-0023); bằng chứng sửa chữa nằm ở git history của migration.
- ⚠️ `0009` không tự hết hạn trên runner không ledger: khi đường ghi staff của Milestone B xuất hiện (ADR-0023), biên ghi phải từ chối hoặc trim tên chỉ-toàn-whitespace (validator hợp đồng hiện không trim), hoặc rút bỏ `0009` sau khi mọi môi trường đã được sửa — nếu không, lần `staff-access-deploy` up kế tiếp sẽ ghi đè tên whitespace-only mới-ghi bằng hằng bootstrap.
- Trách nhiệm chứng minh hành vi: integration test của migration 0009 và S1 pin đúng hằng, trong `apps/staff-access`.
