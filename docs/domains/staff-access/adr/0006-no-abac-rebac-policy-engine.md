# ADR-0006 — Không bật ABAC/ReBAC/policy engine ngoài: RBAC + typed scope + controlled conditions

> 📌 Thư mục này là bounded context **Staff Access** (xem [`../README.md`](../README.md) §4): ADR này chốt quyết định cho nghiệp vụ staff/RBAC khi được tách khỏi `backoffice` (A21–A24). Ngày nay `backoffice` còn sở hữu staff/RBAC.

> **Trạng thái:** Accepted · **Ngày:** 2026-10-21 · **Quyết định từ:** [`domain-model.md`](../domain-model.md) §9 (hàng 6), §3.8 · **Issue:** #87

## Bối cảnh

§3.8 liệt kê **ABAC / ReBAC / policy engine ngoài** là deferred, mặc định v1 chỉ RBAC. §9 giữ quyết định "có cần ABAC/ReBAC/policy engine ngoài không" là chưa chốt, và điều kiện kích hoạt đã được viết sẵn: "một yêu cầu resource/context cụ thể được chứng minh là RBAC không đáp ứng".

Bối cảnh kiến trúc: A23 chốt authorization deny-by-default, enforce server-side tại resource-owning backend trên mọi protected request, và đã **loại** phương án "gọi đồng bộ một authorization service trung tâm cho mỗi request" — vì nó biến authorization thành serving-path dependency. ABAC với policy engine ngoài (OPA, Cedar, Casbin…) là hình thái gần nhất của phương án đó: một bộ quy tắc policy bên ngoài, được đánh giá ở nơi khác, mà enforcement path phải phụ thuộc vào.

Mặt khác, RBAC thuần **không** biểu đạt được: quyền theo thuộc tính của object (chỉ được đụng record của tenant mình), theo context (chỉ trong giờ trực), theo quan hệ (resource thuộc đội mình). Ba khả năng này chính là ABAC/ReBAC sinh ra để giải quyết.

## Phương án

| #   | Phương án                                                      | Đánh giá                                                                                                                                                               |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **RBAC + typed scope + controlled conditions** (v1)            | Chấp nhận — đáp ứng nhu cầu đã biết (role theo nhóm, phạm vi object được định nghĩa có kiểu, điều kiện được liệt kê kiểm soát) mà không thêm engine bên ngoài          |
| 2   | ABAC với policy engine ngoài (OPA/Cedar)                       | Loại ở v1 — thêm runtime policy, thêm dependency serving-path, thêm bề mặt quyết định khó kiểm chứng bằng contract test, trong khi chưa có nhu cầu nào được chứng minh |
| 3   | ReBAC (quan hệ user↔resource)                                  | Loại ở v1 — cần mô hình quan hệ và graph traversal; đắt hơn nhiều so với RBAC + scope đã có                                                                            |
| 4   | Đánh giá policy tại chỗ trong `backoffice` (không qua network) | Loại ở v1 — vẫn là policy engine về mặt ý nghĩa, và tạo ra hai nơi cùng ra quyết định authorization (catalog ở `backoffice`, policy ở runtime), làm mờ ranh giới A23   |
| 5   | Bật ABAC "sẵn sàng" nhưng không dùng                           | Loại — giữ một abstraction ABAC chưa dùng là chi phí không có giá trị; §3.8 đã chốt việc bật lại phải qua điều kiện kích hoạt                                          |

## Quyết định

**Không dùng ABAC, ReBAC hay policy engine ngoài. Authorization của `backoffice` = RBAC + typed scope + controlled conditions.**

- **RBAC**: role là tập permission; permission là action + resource domain; catalog là nguồn sự thật duy nhất (SR-020).
- **Typed scope**: assignment mang phạm vi có kiểu rõ ràng (resource/organization đã định nghĩa trong domain). "Có permission" **không** đồng nghĩa "truy cập mọi object thuộc loại đó" — object-level + scope-level check bắt buộc (SR-004, AC-017).
- **Controlled conditions**: mọi điều kiện gắn vào permission phải là điều kiện đã được liệt kê trong domain, có tập giá trị đóng; **không** phải arbitrary predicate do admin viết. Điều kiện không thuộc danh sách thì không dùng được.
- **Không có policy engine bên ngoài, không có bước đánh giá policy ngoài process của resource-owning backend.**
- **Điều kiện kích hoạt lại:** một yêu cầu resource/context cụ thể được **chứng minh** là RBAC + typed scope + controlled conditions không đáp ứng — tức có use case thật mà scope hiện tại không biểu đạt được, và người đề xuất đưa ra ví dụ cụ thể, không phải "có thể sau này cần". Khi điều kiện đó xảy ra, một ADR mới chọn: mở rộng typed scope, thêm controlled condition, hay đưa ABAC/policy engine vào; quyết định đó **không** được âm thầm hiện thực trong code.
- **Không đánh tráo:** việc thêm một scope hay một controlled condition mới **không** tự động là điều kiện kích hoạt ABAC — đó là việc mở rộng trong khung RBAC, và nó được làm bằng governance action có audit.

## Hệ quả

- Workstream B không cần tích hợp policy engine, không cần thêm contract với bên thứ ba; enforcement path của resource-owning backend tự evaluate bằng dữ liệu nó có.
- Nhu cầu thực tế được biết hiện tại (role theo nhóm, giới hạn phạm vi object) được đáp ứng bằng typed scope + controlled conditions.
- Đánh đổi: nếu sau này có yêu cầu attribute-based (vd. quyền phụ thuộc trạng thái của chính object), mô hình hiện tại **không** biểu đạt được và phải mở lại điều kiện kích hoạt. Đây là chi phí được chấp nhận có chủ ý, không phải sự lãng quên.
- Việc kiểm chứng authorization vẫn là contract test theo permission/role/scope (AC-001…AC-007, AC-017) — độ khó kiểm chứng giữ được ở mức bảng quyết định, không phải ở mức rule engine.

## Cross-reference

- **SR/T-**: SR-002, SR-003, SR-004, SR-016, SR-020 · T-02, T-04, T-15 ([`applications/staff-access/02-requirements.md`](../../../applications/staff-access/02-requirements.md)).
- **Thiết kế:** [`domain-model.md`](../domain-model.md) §3.3, §3.5, §3.8, §4, §8 invariant 1/2/10 · §9 (hàng "Có cần ABAC/ReBAC/policy engine ngoài không").
- **System:** [`architecture/01-architecture.md`](../../../architecture/01-architecture.md) A21, A23 · invariant 33.
- **Tham chiếu:** NIST SP 800-162 (định nghĩa ABAC) — [`applications/staff-access/02-requirements.md`](../../../applications/staff-access/02-requirements.md) §8.
