# ADR-0003 — Bootstrap first-administrator và emergency recovery

> 📌 Thư mục này là bounded context **Staff Access** (xem [`../README.md`](../README.md) §4): ADR này chốt quyết định cho nghiệp vụ staff/RBAC khi được tách khỏi `backoffice` (A21–A24). Ngày nay `backoffice` còn sở hữu staff/RBAC.

> **Trạng thái:** Accepted (Superseded (in part) by [ADR-0020](./0020-bootstrap-seed-contract.md) — phạm vi "không có route/flag/code-path nào" đọc lại thành "không có code path nào trên serving path của Worker"; tên database `db-backoffice` đọc là `db-staff-access` theo [ADR-0013](./0013-staff-access-ownership-transfer.md); **hai-phím rule không áp dụng cho lần bootstrap Superadmin đầu tiên** — trust anchor của lần đó là chứng minh kiểm soát email ở lần đăng nhập đầu, theo ADR-0020 Quyết định 11. Audit trail, kiểm `sub` tồn tại, không nút UI và **hai-phím cho emergency recovery** vẫn giữ nguyên hiệu lực. Superseded (in part) by [ADR-0022](./0022-measured-first-admin-guard.md) — câu "bootstrap nghĩa là không có logic tự động phát hiện 'đã có admin rồi'" và "không có lối 'nếu đã có admin thì báo lỗi' trong procedure" **không còn hiệu lực**: lý do của chúng là procedure chỉ là SQL thủ công, không còn đúng khi procedure là CLI có transaction; procedure ngày nay **đo** số administrator trong critical section ghi và **từ chối** khi `mode` không khớp số đo) · **Ngày:** 2026-10-21 · **Quyết định từ:** [`domain-model.md`](../domain-model.md) §9 (hàng 3), §6 · **Issue:** #87

## Bối cảnh

Thiết kế chốt rằng bootstrap first-administrator và emergency recovery phải documented + audited, không có bypass flag hay đường tắt `isAdmin` (SR-009, invariant 9 của [`domain-model.md`](../domain-model.md), invariant 36 của [`architecture/01-architecture.md`](../../../architecture/01-architecture.md)). T-11 threat là lạm dụng đường bootstrap/recovery để tạo quyền ngoài governance. Câu hỏi §9: **đường nào, ai approve, audit ra sao**.

Tình huống thật mà phải xử lý:

1. **First-administrator** — hệ thống mới deploy, chưa có staff, chưa có role assignment nào; ai đó phải được cấp quyền quản trị **đầu tiên**, bằng một đường không phụ thuộc vào việc mình hãy còn có quyền.
2. **Emergency recovery** — mất toàn bộ admin (tất cả admin bị terminated/suspended, hoặc mất quyền), hoặc trách nhiệm admin bị chiếm; phải có đường khôi phục quyền quản trị không phụ thuộc admin trong hệ thống.

## Phương án

| #   | Phương án                                                                                                 | Đánh giá                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Cờ bypass trong code / env var kiểm tra lúc runtime "nếu không có admin thì cho phép mọi người bootstrap" | Loại — đúng hình dạng backdoor mà SR-009/invariant 36 cấm; tổn thương khi code chạy nhầm ở môi trường sai; không kiểm soát được ai gọi |
| 2   | Đường tắt `isAdmin` chỉ đọc từ biến cấu hình                                                              | Loại — biến cấu hình thành role vô hạn, vi phạm §3.4 "không có unrestricted `isAdmin` bypass role"                                     |
| 3   | Bootstrap bằng **thủ tục خارج hệ thống (IaC/manual SQL)** có **quy trình hai phím**                       | Chấp nhận — đường ngoài đường serving, người thực thi phải xác minh được danh tính hai phím, và mọi bước để lại audit trail            |
| 4   | Cho phép tự đăng ký / tự bootstrap qua UI                                                                 | Loại — tạo lỗ hổng race khi vừa deploy, và không có bằng chứng caller nào đủ tin                                                       |
| 5   | Recovery chỉ qua admin còn lại                                                                            | Không đầy đủ — mọi admin có thể bị terminated đồng thời; phải có đường không phụ thuộc admin tồn tại                                   |

## Quyết định

**Bootstrap và recovery là procedure ngoài application code — IaC/manual SQL với audit trail + hai-phím rule — không phải code path nào của `backoffice`.**

- **Không có route/flag/code-path nào thực hiện bootstrap hay recovery.** Việc cấp quyền đầu tiên hay khôi phục quyền admin được chạy bằng SQL/IaC trên `db-backoffice` bằng credential `ecoma_owner` (ADR-0001) — role không chạy trong Worker, sống ngoài runtime, nên không thể bị một code path gọi nhầm từ request.
- **Hai-phím rule:** hai người phải cùng phê duyệt (mỗi người phải có quyền quản trị danh tính hệ thống — ví dụ owner VPS hoặc admin còn lại), và một trong hai là người thực thi. Không một người đơn lẻ nào tự cấp được quyền; hai phím phải để lại hai identity kèm thời điểm.
- **Audit trail:** mọi lần chạy bootstrap/recovery phải ghi lại được **ai** (bằng chứng hai phím), **thời điểm**, **bản ghi assignment được tạo**, **mã idempotency của lần chạy**. Hình thức lưu cụ thể (bảng audit riêng trong `db-backoffice` hay kênh log) do workstream A (#85) hiện thực; `ecoma_owner` không phải thứ ghi vào bảng audit của ứng dụng — phần ghi audit do procedure đảm nhiệm riêng, không trộn với credential owner.
- **Cấm nút bấm UI** cho cả hai procedure — chúng không phải thao tác điều khiển bằng UI, mà là procedure vận hành có runbook.
- **First-administrator khi chưa có staff entry:** procedure tạo cùng lúc cả staff entry lẫn role assignment trong cùng transaction ở `db-backoffice`. Sub (Account ID) phải là `sub` đã tồn tại ở `db-account` — procedure kiểm sub tồn tại trước khi khởi tạo, không tạo account từ procedure này.
- **Emergency recovery:** đúng cùng procedure, kèm một bước xác minh danh tính mạnh hơn (ví dụ liên hệ trực tiếp hai phím ngoài hệ thống); viết runbook chi tiết cụ thể là việc operations, không chi tiết ở ADR này.
- **Idempotency:** procedure khi chạy lại không tạo được bản role assignment trùng lặp; key idempotency từ transaction của procedure.
- **Điều kiện áp dụng:** procedure chỉ được dùng khi (a) first-admin bootstrap khi chưa có admin, hoặc (b) khôi phục khi không còn/quá ít admin. Khi cả hai điều kiện không thoả thì việc chạy procedure là vi phạm quy trình; workstream A hiện thực cơ sở để báo cáo phát hiện procedure chạy ngoài lúc thoả điều kiện.

## Hệ quả

- Không có đường root mềm / bypass trong code — audit chỉ có thể chứng minh procedure chạy khi record sinh ra tại DB; việc tồn tại đường code bypass sẽ được review (invariant 9: "manual review đường bootstrap").
- `ecoma_owner` là một credential có mức quyền cao nhất của `db-backoffice`; quyền truy cập nó phải được quản lý nghiêm ngặt theo chính sách bảo vệ credential của hệ thống. Chi tiết `ecoma_owner` ở ADR-0001.
- Bootstrap qua SQL thủ công nghĩa là **không có logic tự động phát hiện "đã có admin rồi"** — operator phải tự rà. Không có lối "nếu đã có admin thì báo lỗi" trong procedure.
- Hai phím phải là **hai người khác nhau**: nếu cho phép hai phím của cùng một người có quyền hệ thống thì quy trình chỉ còn hình thức — một identity có quyền hệ thống đủ để tự cấp quyền cho bất kỳ ai.

## Cross-reference

- **SR/T-**: SR-009, SR-016 · T-11, T-17 · AC-016 ([`applications/staff-access/02-requirements.md`](../../../applications/staff-access/02-requirements.md)).
- **Thiết kế:** [`domain-model.md`](../domain-model.md) §6, §8 invariant 6/9 · §9 (hàng "Cơ chế bootstrap first-administrator").
- **System:** [`architecture/01-architecture.md`](../../../architecture/01-architecture.md) invariant 36 · A21.
- **Implementation:** #85 (audit record cho procedure), cùng runbook vận hành để viết sau trong `03-operations.md` của backoffice khi có runtime thật.
