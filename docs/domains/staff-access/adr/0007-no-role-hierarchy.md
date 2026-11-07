# ADR-0007 — Không dùng role hierarchy: gán phẳng

> 📌 Thư mục này là bounded context **Staff Access** (xem [`../README.md`](../README.md) §4): ADR này chốt quyết định cho nghiệp vụ staff/RBAC khi được tách khỏi `backoffice` (A21–A24). Ngày nay `backoffice` còn sở hữu staff/RBAC.

> **Trạng thái:** Accepted · **Ngày:** 2026-10-21 · **Quyết định từ:** [`domain-model.md`](../domain-model.md) §9 (hàng 7), §3.4, §3.8 · **Issue:** #87

## Bối cảnh

§3.4 ghi "Role hierarchy (role kế thừa role) là **deferred** và không bật mặc định", §3.8 liệt kê điều kiện kích hoạt: "catalog lớn tới mức kế thừa role là cần thật". §9 giữ quyết định "có bật role hierarchy không" là chưa chốt.

RBAC (NIST) định nghĩa role hierarchy là khả năng một role kế thừa permission của role khác — dùng để tránh gán trùng lặp khi một role là tập con tự nhiên của role khác. Lợi ích chỉ hiện thực khi catalog đủ lớn và có cấu trúc phân cấp thật. Chi phí của hierarchy là không nhỏ: quyết định "role X có permission P không" trở thành traversal trên đồ thị kế thừa thay vì một phép tra cứu trực tiếp, vòng kế thừa (cycle) phải bị chặn, và việc hiểu tại sao một staff member có một permission trở thành truy vết nhiều tầng.

Hiện trạng: catalog permission và system-defined role chưa tồn tại trong implementation; số role dự kiến ở v1 nhỏ (vài system-defined role).

## Phương án

| #   | Phương án                                                   | Đánh giá                                                                                                                       |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Gán phẳng: role = tập permission hữu hạn, không kế thừa** | Chấp nhận — một phép tra cứu trực tiếp trả lời "role nào có permission nào"; không cycle, không truy vết                       |
| 2   | Bật role hierarchy ngay từ v1                               | Loại — với số role nhỏ, chi phí traversal + chống cycle + truy vết lớn hơn lợi ích tránh trùng lặp permission                  |
| 3   | Bật hierarchy có giới hạn (một tầng)                        | Loại — vẫn thêm khái niệm kế thừa vào mô hình, vẫn phải chống cycle, mà lợi ích với một tầng gần như bằng 0 so với gán phẳng   |
| 4   | Hierarchy ẩn qua "role chứa role" trong catalog             | Loại — cùng chi phí của phương án 2 nhưng khó thấy hơn trong review; khái niệm ẩn trong dữ liệu tệ hơn khái niệm được khai báo |

## Quyết định

**Không dùng role hierarchy. Role assignment là gán phẳng: mỗi role là một tập permission hữu hạn được liệt kê trực tiếp, không kế thừa role khác.**

- Mọi system-defined role (ADR-0004) liệt kê permission của nó một cách trực tiếp trong catalog; một role muốn có permission của role khác phải liệt kê lại các permission đó, hoặc được thay đổi nội dung bằng governance action có audit.
- Không có khái niệm "role cha"/"role con" trong domain model, trong catalog hay trong assignment.
- **Điều kiện kích hoạt lại:** catalog lớn tới mức **kế thừa là cần thật** — tức số system-defined role tăng tới điểm mà việc liệt kê trực tiếp tạo trùng lặp đủ nhiều để việc đồng bộ nội dung role qua governance action trở thành gánh nặng thực tế (không phải dự đoán). Khi điều kiện đó xảy ra, một ADR mới chốt mô hình hierarchy (một tầng/nhiều tầng, chống cycle, semantics của truy vết) — quyết định đó **không** được âm thầm hiện thực trong code.
- Việc thấy trùng lặp permission giữa hai role **không** tự động là điều kiện kích hoạt: đường chính tắc là chỉnh nội dung role qua governance action, không phải thêm hierarchy.

## Hệ quả

- Query "role nào có permission P" là một phép tra cứu trên `role_permissions`, không phải traversal — đơn giản để test và để audit (SR-006 phân tích permission của role nghiệp vụ là phép đọc trực tiếp).
- Khi catalog lớn lên, trùng lặp permission giữa các role có thể xuất hiện; chi phí đồng bộ được ghi nhận có chủ ý và được xử lý bằng governance action cho tới khi điều kiện kích hoạt lại thỏa.
- Domain model giữ đúng hình "role = tập permission có tên" của §3.4; không cần thay đổi mô hình nếu sau này bật hierarchy (thêm cạnh kế thừa là mở rộng, không phải đảo mô hình).
- Không có cycle để chống, không có thứ tự ưu tiên giữa role để định nghĩa — hai lớp phức tạp được loại khỏi v1.

## Cross-reference

- **SR/T-**: SR-005, SR-006, SR-016 · T-01 ([`applications/staff-access/02-requirements.md`](../../../applications/staff-access/02-requirements.md)).
- **Thiết kế:** [`domain-model.md`](../domain-model.md) §3.4, §3.8 · §9 (hàng "Có bật role hierarchy không").
- **System:** [`architecture/01-architecture.md`](../../../architecture/01-architecture.md) A21.
- **Tham chiếu:** NIST RBAC (role hierarchies trong reference model) — [`applications/staff-access/02-requirements.md`](../../../applications/staff-access/02-requirements.md) §8.
