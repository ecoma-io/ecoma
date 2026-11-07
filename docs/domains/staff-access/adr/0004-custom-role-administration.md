# ADR-0004 — Custom role administration: không bật giai đoạn này

> 📌 Thư mục này là bounded context **Staff Access** (xem [`../README.md`](../README.md) §4): ADR này chốt quyết định cho nghiệp vụ staff/RBAC khi được tách khỏi `backoffice` (A21–A24). Ngày nay `backoffice` còn sở hữu staff/RBAC.

> **Trạng thái:** Accepted · **Ngày:** 2026-10-21 · **Quyết định từ:** [`domain-model.md`](../domain-model.md) §9 (hàng 4), §3.4 · **Issue:** #87

## Bối cảnh

Domain model phân biệt **system-defined role** (role do `backoffice` định nghĩa, nội dung permission cố định theo catalog) với **custom role** (role do admin tạo/sửa nội dung). §3.4 ghi "việc bật custom role administration là quyết định **chưa chốt**". Việc cho phép custom role thay đổi bề mặt governance đáng kể: ai được tạo role, nội dung role do ai duyệt, làm sao chống "role custom" trở thành cách né review catalog, và làm sao kiểm soát một role custom được cấp quyền vượt quá quyền người tạo nó.

Hiện trạng: catalog permission và system-defined role chưa tồn tại trong implementation; v1 chưa có nhu cầu catalog tùy biến được chứng minh từ resource-owning backend nào.

## Phương án

| #   | Phương án                                                         | Đánh giá                                                                                                                                                                  |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Chỉ system-defined role; không bật custom role administration** | Chấp nhận — governance surface nhỏ nhất; mọi role là một mục của catalog có lifecycle có audit, không có đường tạo role ngoài catalog                                     |
| 2   | Bật custom role ngay từ v1                                        | Loại — thêm cả một lớp governance (tạo/sửa/xoá role, kiểm soát quyền người tạo, chống self-escalation qua role) mà chưa có nhu cầu được chứng minh; chi phí trước giá trị |
| 3   | Bật custom role có điều kiện (chỉ admin tạo được)                 | Loại — "chỉ admin" không đủ: SR-006 separation of duties vẫn cần một approval gate riêng; phức tạp như phương án 2 nhưng có vẻ an toàn hơn thực tế                        |
| 4   | Bật custom role chỉ đọc/clone từ system-defined                   | Loại — clone vẫn là một role mới ngoài catalog, vẫn cần toàn bộ governance như phương án 2                                                                                |

## Quyết định

**Không bật custom role administration giai đoạn này. Chỉ system-defined role.**

- Mọi role tồn tại là **system-defined**: nội dung permission của role được định nghĩa cùng catalog, thay đổi nội dung role là một governance action có audit, không phải thao tác runtime của admin.
- Không có route/UI/API nào tạo, sửa nội dung hay xoá role ngoài system-defined.
- **Điều kiện kích hoạt lại:** nhu cầu catalog tùy biến được **chứng minh** — tức một resource-owning backend hay use case thực tế cần một tổ hợp permission mà system-defined catalog không phủ, và tổ hợp đó được đánh giá là lặp lại đủ nhiều để đáng trở thành role. Khi điều kiện đó xảy ra, một ADR mới quyết định cơ chế custom role (ai tạo, approval gate, giới hạn quyền người tạo, lifecycle) — quyết định đó **không** được âm thầm hiện thực trong code.
- Việc cần một tổ hợp permission mới **không** tự động là điều kiện kích hoạt: đường chính tắc là **thêm/chỉnh system-defined role qua governance action có audit**, không phải tạo custom role.

## Hệ quả

- Governance surface của v1 chỉ gồm: quản trị assignment (gán/thu hồi role cho staff member) và quản trị nội dung catalog/role qua governance action — không có runtime role creation.
- Không phải thiết kế approval gate cho custom role creation; nếu điều kiện kích hoạt lại xảy ra, chi phí governance sẽ trả đúng lúc đó.
- Workstream B không cần implement route custom role; domain model vẫn giữ phân biệt system-defined vs custom (§3.4) để không phải đảo mô hình khi bật lại.
- Một hệ quả phụ: role "tạm thời cho dự án X" không tồn tại — nhu cầu tạm thời xử lý bằng assignment có hạn theo thời gian (§3.5) trên system-defined role, không phải role riêng.

## Cross-reference

- **SR/T-**: SR-005, SR-006, SR-020 · T-01, T-04 ([`applications/staff-access/02-requirements.md`](../../../applications/staff-access/02-requirements.md)).
- **Thiết kế:** [`domain-model.md`](../domain-model.md) §3.4, §6 · §9 (hàng "Có bật custom role administration không").
- **System:** [`architecture/01-architecture.md`](../../../architecture/01-architecture.md) A21.
