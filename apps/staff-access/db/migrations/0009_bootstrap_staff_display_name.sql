BEGIN;

-- #170 remediation (ADR-0029): bootstrap S1 trước ADR-0029 chèn hàng staff với
-- `display_name` rỗng; validator contract phía consumer từ chối cả trang listing khi
-- một entry rỗng, làm `GET /api/staff` trả 503 trên mọi môi trường đã bootstrap.
--
-- Sửa một lần bằng predicate tự-idempotent: sau lần chạy đầu không còn hàng nào khớp
-- WHERE, nên các lần re-apply sau (runner không có ledger — mọi file chạy lại mỗi lần)
-- là no-op. Predicate `trim(display_name) = ''` chỉ khớp hàng vi phạm rỗng/toàn
-- whitespace; tên hiển thị hợp lệ của người thật không bao giờ khớp nên được giữ
-- nguyên. Mọi status đều được sửa (listing contract validate cả suspended/terminated
-- entries). Trigger `staff_identity_and_terminal_guard` chỉ chặn đổi `sub` và hồi sinh
-- `terminated` — UPDATE chỉ `display_name` đi qua tự do. Assignment và audit không bị
-- đụng tới. Giá trị khớp hằng `BOOTSTRAP_STAFF_DISPLAY_NAME` trong `db/bootstrap.mts`.
UPDATE staff_access.staff
   SET display_name = 'Bootstrap Superadmin',
       updated_at = now()
 WHERE trim(display_name) = '';

COMMIT;
