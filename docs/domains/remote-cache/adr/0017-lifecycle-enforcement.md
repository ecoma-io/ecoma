# ADR-0017 — Cơ chế data plane `remote-cache` biết lifecycle state của tenant mà không cache trạng thái

> 📌 Thư mục này là bounded context **Remote Cache** (xem [`../README.md`](../README.md)). ADR này đóng mục "lifecycle enforcement mechanism" từng là quyết định mở của `architecture/roadmap.md` (file đã bị xoá theo #553) và là điều kiện tiên quyết mà #462 nêu trước khi hiện thực P4.4. Thiết kế kỹ thuật của data plane giữ nguyên tại [`../../../applications/remote-cache/01-architecture.md`](../../../applications/remote-cache/01-architecture.md) §2.1 — ADR này chỉ chốt **cơ chế lan truyền lifecycle state**.

> **Trạng thái:** Accepted · **Ngày:** 2026-11-06 · **Quyết định từ:** [`../../../applications/remote-cache/01-architecture.md`](../../../applications/remote-cache/01-architecture.md) §2.1 (enforcement fail-closed) · [ADR-0015](./0015-remote-cache-bounded-context.md) (bounded context và storage) · [`../../../architecture/01-architecture.md`](../../../architecture/01-architecture.md) §9 invariant 6 · **Issue:** #462, #500

## Bối cảnh

[`applications/remote-cache/01-architecture.md`](../../../applications/remote-cache/01-architecture.md) §2.1 đặt hai yêu cầu cùng lúc:

1. **Fail-closed:** credential của tenant/project không ở trạng thái `active` MUST bị từ chối, kể cả khi cấu hình đã cache chưa phản ánh trạng thái mới — stale cache không được biến `suspend`/`delete` thành `allow`.
2. **Không phụ thuộc database trong request hot path** của data plane.

Hai yêu cầu này căng nhau: một cache có TTL ngắn vẫn có cửa sổ stale, và cửa sổ đó chính là thứ yêu cầu 1 cấm. Roadmap cũ để mở, với hai ứng viên: cached configuration TTL ngắn + fail-closed khi stale/unknown, hoặc re-check-at-write-time cho write path.

Hiện thực hiện tại (`apps/remote-cache/src/lifecycle.ts`, #462 và #500):

- `enforceTenantLifecycle` **luôn** đọc trạng thái từ database, trên cả read và write path. Không có đường cache trạng thái tenant nào đang hoạt động: cache sót hạn có thể biến `suspend` thành `allow`, nên bất kỳ lớp cache nào còn trong source đều không được nối vào đường phục vụ request.
- Trạng thái `suspended`/`deleted`/không tìm thấy được ánh xạ thành domain error, và API trả `409 Conflict` thay vì `500`.
- Lỗi tra cứu database cũng fail-closed (`tenant_lookup_failed`).

Như vậy thực tế đã chọn **re-check từ database mỗi request**, không phải cached configuration.

## Phương án

| #   | Phương án                                                      | Đánh giá                                                                                                                                                                                 |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Re-check lifecycle từ DB ở mọi request** (đã hiện thực)      | Chấp nhận — đáp ứng yêu cầu fail-closed tuyệt đối; đánh đổi là data plane phụ thuộc database, trái yêu cầu 2 ở dạng chặt nhất                                                            |
| 2   | Cached configuration TTL ngắn + fail-closed khi stale/unknown  | Loại — vẫn có cửa sổ stale trong TTL, và với `deleted` cửa sổ đó là vi phạm yêu cầu 1; "fail-closed khi stale" đòi hỏi re-check đúng lúc cần, tức quay về phương án 1 cho trường hợp xấu |
| 3   | Cached configuration + invalidation event đẩy từ control plane | Loại ở phạm vi này — cần thêm kênh event và consumer trong data plane; chưa có bằng chứng độ trễ đáp ứng yêu cầu 1 khi event bị delay, và làm tăng bề mặt vận hành cho MVP               |
| 4   | TTL dài + kiểm tra lại chỉ khi credential gần hết hạn          | Loại — không liên quan tới lifecycle state; `suspend` không đi kèm thay đổi credential                                                                                                   |
| 5   | Không enforce lifecycle ở data plane, chỉ ở control plane      | Loại — vi phạm trực tiếp fail-closed; credential đã phát vẫn ghi được sau khi tenant bị suspend                                                                                          |

## Quyết định

- **Data plane re-check lifecycle state từ `db-remote-cache` mỗi request**, cả read và write. Không cache trạng thái tenant trong isolate.
- **Fail-closed ở mọi nhánh:** trạng thái không phải `active`, không xác định được, hoặc tra cứu lỗi đều bị từ chối. Không nhánh nào cho phép khi chưa chứng minh được trạng thái.
- **`TenantLifecycleCache` không nằm trên đường phục vụ request.** Class vẫn còn trong `apps/remote-cache/src/lifecycle.ts` nhưng không có caller nào; `enforceTenantLifecycle` không đọc và không ghi nó. Không dựng lại đường cache trạng thái tenant: một cache như vậy không có cách dùng an toàn trong ràng buộc fail-closed này. Xoá class là việc dọn dẹp, không phải một phần của quyết định.
- **Đánh đổi được chấp nhận và ghi nhận:** yêu cầu "data plane không phụ thuộc database trong hot path" **không còn đúng** ở dạng tuyệt đối. Data plane phụ thuộc `db-remote-cache` cho mỗi request. Đây là đánh đổi có chủ đích: correctness của fail-closed được ưu tiên hơn mục tiêu độc lập DB.
- **Mở lại khi có bằng chứng khác:** nếu số đo cho thấy chi phí truy vấn lifecycle trên hot path là trở ngại thực, một ADR mới có thể chọn cache + invalidation event, với điều kiện chứng minh được độ trễ invalidation đáp ứng fail-closed.

## Supersedes (in part) ADR-0015

ADR này **thu hẹp có chủ đích** một câu của [ADR-0015](./0015-remote-cache-bounded-context.md), không đảo toàn bộ:

- **Bị thay thế:** bullet ranh giới tenant ("data plane của `remote-cache` không bao giờ đọc database trong hot path (cached configuration)") và bullet "Lên P4.2" cùng ý — data plane đọc cached configuration thay vì database. Data plane re-check lifecycle state từ `db-remote-cache` mỗi request.
- **Còn hiệu lực nguyên vẹn:** bounded context `remote-cache`; storage `db-remote-cache` / `remote_cache`; mô hình role ba tầng; ranh giới tenant với `pact-broker` (không dùng chung tenant, không FK chéo database); entitlement Staff Access deferred; toàn bộ phần còn lại của ADR-0015.

Phần còn hiệu lực giữ nguyên thẩm quyền tại ADR-0015, không nhân bản ở đây.

## Hệ quả

- [`applications/remote-cache/01-architecture.md`](../../../applications/remote-cache/01-architecture.md) §2.1 không còn được mô tả như "open decision"; câu về data plane không phụ thuộc DB phải được nêu là **target đã bị thu hẹp** theo ADR này, không phải hiện trạng.
- [`02-requirements.md`](../../../applications/remote-cache/02-requirements.md) và [`03-operations.md`](../../../applications/remote-cache/03-operations.md) phải phản ánh rằng data plane cần `db-remote-cache` để phục vụ request — ảnh hưởng availability và readiness.
- [`../README.md`](../README.md) §3 và [`../README.md`](../README.md) §3 bỏ câu "cơ chế lan truyền lifecycle state là quyết định mở của roadmap".
- Thay đổi cơ chế sau này cần ADR mới; ADR này giữ nguyên như bản ghi quyết định ban đầu.
- Readiness của data plane phải kiểm được database, vì request không còn phục vụ được khi DB không tới được (#500 thêm `/ready`).

## Cross-reference

- **System:** invariant 6 (KV/Queue không phải business authority) · invariant 8 (consumer idempotent) — [`../../../architecture/01-architecture.md`](../../../architecture/01-architecture.md) §9.
- **Context:** [ADR-0015](./0015-remote-cache-bounded-context.md) (bounded context, storage) · [`../../../applications/remote-cache/01-architecture.md`](../../../applications/remote-cache/01-architecture.md) §2.1, §10.
- **Hiện thực:** #462 (P4.4 security) · #500 (Phase A correctness — xoá tenant lifecycle cache, fail-closed).
- **Index:** [`./README.md`](./README.md).
