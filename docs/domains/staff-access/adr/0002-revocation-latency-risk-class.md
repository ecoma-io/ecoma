# ADR-0002 — Ngưỡng revocation latency tối đa theo risk class

> 📌 Thư mục này là bounded context **Staff Access** (xem [`../README.md`](../README.md) §4): ADR này chốt quyết định cho nghiệp vụ staff/RBAC khi được tách khỏi `backoffice` (A21–A24). Ngày nay `backoffice` còn sở hữu staff/RBAC.

> **Trạng thái:** Accepted · **Ngày:** 2026-10-21 · **Quyết định từ:** [`domain-model.md`](../domain-model.md) §9 (hàng 2), A24 · **Issue:** #87

## Bối cảnh

A24 chốt nguyên tắc **Token validity ≠ privilege currency** và yêu cầu: bounded revocation latency phải được định nghĩa **theo risk class** trước khi bật role assignment thật, và "không hứa thu hồi tức thời khi chưa có cơ chế guarantee". Thiết kế [`domain-model.md`](../domain-model.md) §5 liệt kê bốn cơ chế tách biệt (staff termination, account suspension, token/session revocation, authorization cache invalidation) và bảng các lựa chọn kỹ thuật — nhưng không con số nào được viết ở đó.

Bài toán: một staff member bị `terminated` hoặc assignment bị thu hồi ở `db-backoffice` — token/session mà resource-owning backend còn tin trong bao lâu? Con số này là một SLO bảo mật: nó phải được chọn cùng một lúc với cơ chế bảo đảm nó, nếu không nó chỉ là một con số không có cơ chế sống phía sau.

## Phương án

| #   | Phương án                                               | Đánh giá                                                                                                                                                                                                             |
| --- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Một con số duy nhất cho mọi thao tác**                | Đơn giản nhưng sai: thao tác đọc báo cáo quản trị và thao tác gán quyền/kick người dùng không có cùng mức rủi ro; ngưỡng an toàn cho cái thứ hai là quá chặt cho cái thứ nhất                                        |
| 2   | **Ngưỡng theo risk class, hai lớp: `normal` và `high`** | Chấp nhận — thể hiện sự không đồng đều của rủi ro; mỗi lớp có target latency riêng                                                                                                                                   |
| 3   | "Thu hồi tức thời" cho mọi thao tác                     | Loại — không có cơ chế nào bảo đảm được mà không biến kiểm tra trạng thái giữ liên tục ở serving path của mọi backend (A23 đã loại gọi đồng bộ trung tâm cho mỗi request); lời hứa không thể giữ là lời hứa vô nghĩa |
| 4   | Không chốt ngưỡng nào, để cơ chế quyết định sau         | Loại — vi phạm A24: ngưỡng phải được định nghĩa **trước** khi bật role assignment thật, không phải làm hệ quả ngược lại                                                                                              |

## Quyết định

- **Hai risk class:**
  - **`normal`** — thao tác mà cửa sổ stale authorization nhỏ không làm thiệt hại không thể phục hồi. **Target revocation latency ≤ 60 giây.**
  - **`high`** — thao tác gán/thu hồi quyền và các privileged operation rủi ro cao trên dữ liệu nghiệp vụ. **Target revocation latency ≤ 5 giây.**
- **Đây là nhắm tới (target), không phải cam kết cơ chế đã tồn tại.** Con số mô tả điểm mà cơ chế revocation phải đạt khi được hiện thực; nó **không** tự sinh ra cơ chế. Các cơ chế cụ thể — token ngắn hạn, kiểm online, versioned authorization state, cache invalidation — do workstream B (#86) chọn, nhưng **target này là ngưỡng thiết kế mà cơ chế phải đáp ứng**: nếu một cơ chế không thể đạt target của lớp `high` thì phải chọn lại cơ chế hoặc xem lại target bằng một quyết định ADR mới — không được âm thầm nới rộng cửa sổ trong code.
- **Không hứa "tức thời".** Mọi đường revocation phải đi qua cơ chế có mô tả được về cửa sổ, không có đường "revoke được ngay vì đã sửa trong DB".
- **Read/validation tại write time (re-check at write time)** vẫn là lớp phòng thủ thứ hai bắt buộc cho mọi thao tác ghi (SR-008, chống TOCTOU) — target latency không thay thế re-check at write time; nó giới hạn cửa sổ cho **các thao tác đọc** giữa các lần re-check.
- **Class được gắn theo operation, không theo role hay người dùng.** Một thao tác thuộc `high` do tính chất của tác vụ, không do ai đó đang là admin.
- Phân loại `normal`/`high` cụ thể cho từng thao tác được định nghĩa theo catalog permission khi hiện thực; ADR này chỉ chốt khung hai lớp và target.

## Hệ quả

- Workstream B phải chọn một cơ chế đáp ứng target `high` ≤ 5s. Access token TTL 300 giây của `auth` (đã chốt ở [`architecture/01-architecture.md`](../../../architecture/01-architecture.md) §10) **không đủ** cho lớp `high` một mình — lớp này cần thêm cơ chế event-driven (invalidation push) hay re-check có giới hạn; việc chọn cụ thể thuộc workstream B.
- Bất kỳ cache authorization nào của resource-owning backend phải có TTL ≤ target của class nó phục vụ; cache TTL vô hạn là vi phạm ADR này.
- Việc đo revocation latency thực tế là acceptance criterion khi cơ chế ra đời — con số đi trước, đo bám theo.
- Account bị `suspended` ở `account` vẫn theo mô hình revocation của `account`/`auth` riêng (§5 của thiết kế) — ADR này không hợp nhất hai revocation path vào một.

## Cross-reference

- **SR/T-**: SR-003, SR-008 · T-05, T-06, T-16 ([`applications/staff-access/02-requirements.md`](../../../applications/staff-access/02-requirements.md)).
- **Thiết kế:** [`domain-model.md`](../domain-model.md) §5, §8 invariant 5 · §9 (hàng "Ngưỡng revocation latency").
- **System:** [`architecture/01-architecture.md`](../../../architecture/01-architecture.md) A24 · §10 (hàng "Bounded revocation latency").
- **Implementation:** #86 (Workstream B).
