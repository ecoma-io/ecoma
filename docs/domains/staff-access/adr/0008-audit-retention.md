# ADR-0008 — Retention authorization audit: theo retention policy hệ thống cho audit/security event

> 📌 Thư mục này là bounded context **Staff Access** (xem [`../README.md`](../README.md) §4): ADR này chốt quyết định cho nghiệp vụ staff/RBAC khi được tách khỏi `backoffice` (A21–A24). Ngày nay `backoffice` còn sở hữu staff/RBAC.

> **Trạng thái:** Accepted · **Ngày:** 2026-10-21 · **Quyết định từ:** [`domain-model.md`](../domain-model.md) §9 (hàng 8), §3.7 · **Issue:** #87

## Bối cảnh

[`domain-model.md`](../domain-model.md) §3.7 chốt authorization audit là **append-only**, access-restricted, không chứa token/secret/PII (SR-013, SR-014, SR-015), và đã ghi trước hướng: "Retention cho authorization audit đi theo policy retention hệ thống cho audit/security event — quyết định hệ thống, canonical ở [`architecture/01-architecture.md`](../../../architecture/01-architecture.md) §10". Câu hỏi §9 cần chốt là: `backoffice` tự định nghĩa retention riêng hay đi theo policy hệ thống.

Tình trạng của policy hệ thống: retention của audit/security event **chưa chốt** ở [`architecture/01-architecture.md`](../../../architecture/01-architecture.md) §10 (hàng "Retention của audit/security event và của authorization transaction đã hết hạn" — kích hoạt "Trước production"), và việc _có cần giữ_ là câu hỏi pháp lý mở, không phải mặc định giữ; tombstone kỹ thuật tối thiểu là ngoại lệ duy nhất được giữ vĩnh viễn.

## Phương án

| #   | Phương án                                                                           | Đánh giá                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **`backoffice` là consumer của retention policy hệ thống cho audit/security event** | Chấp nhận — một policy một nơi; audit của `backoffice` là một audit/security event class trong đó                                                                                                                        |
| 2   | `backoffice` tự định nghĩa retention riêng                                          | Loại — tạo hai policy cho cùng loại dữ liệu, và một service đơn lẻ không có cơ sở pháp lý để quyết định thời gian giữ audit                                                                                              |
| 3   | Giữ vĩnh viễn mọi audit record                                                      | Loại — mâu thuẫn với hướng của policy hệ thống (việc giữ là câu hỏi pháp lý mở, không phải mặc định giữ); và mâu thuẫn với §3.7 "không giả định xoá vật lý" chỉ áp cho state sống, không phải chính sách lưu trữ dài hạn |
| 4   | Không retention — giữ đến khi đầy                                                   | Loại — không phải chính sách, là mặc định ngẫu nhiên; không tuân thủ được khi policy hệ thống ra đời                                                                                                                     |

## Quyết định

**Retention của authorization audit của `backoffice` đi theo retention policy hệ thống cho audit/security event. `backoffice` là consumer của policy, không phải owner.**

- Owner của policy là **hệ thống** (canonical: [`architecture/01-architecture.md`](../../../architecture/01-architecture.md) §10). Khi policy đó được chốt, giá trị retention của nó áp dụng trực tiếp cho authorization audit của `backoffice` mà không cần ADR riêng của `backoffice`.
- Cho tới khi policy hệ thống chốt: authorization audit **không bị xoá** — append-only giữ nguyên (SR-015); việc xoá theo retention chỉ bắt đầu khi policy hệ thống chốt và cài đặt. Không có job prune nào tự ý xoá audit trước đó.
- **Không giả định xoá vật lý** của record staff/assignment vẫn đúng như §3.7: đó là quy tắc về state sống của domain, tách biệt với chính sách retention của audit record.
- **Điều kiện kích hoạt lại:** chỉ khi policy hệ thống cho audit/security event thay đổi — `backoffice` cập nhật theo, không cần ADR mới trừ khi `backoffice` có ràng buộc riêng (vd. yêu cầu pháp lý riêng) mà policy chung không phủ; khi đó ADR mới ghi ràng buộc đó như một ngoại lệ có lý do.
- Câu hỏi pháp lý về việc có cần giữ (đã ghi ở policy hệ thống) **không** được `backoffice` tự trả lời.

## Hệ quả

- Workstream A (#85) thiết kế bảng audit **không kèm** TTL/prune của riêng mình; mọi cơ chế xoá sau này đi kèm policy hệ thống.
- Nếu policy hệ thống chốt giá trị retention ngắn hơn kỳ vọng điều tra, `backoffice` phải chấp nhận — hoặc đưa ràng buộc riêng vào ADR mới, không tự chặn việc xoá.
- Cần theo dõi: khi [`architecture/01-architecture.md`](../../../architecture/01-architecture.md) §10 chốt retention audit/security event, cập nhật cross-reference tại đây (không cần thay đổi quyết định).
- Dữ liệu audit nằm trong `db-backoffice` (ADR-0001), nên retention thực thi trên PostgreSQL của nó; cơ chế thực thi (job, partition, archive) là việc operations khi policy ra đời.

## Cross-reference

- **SR/T-**: SR-013, SR-014, SR-015 · T-12 ([`applications/staff-access/02-requirements.md`](../../../applications/staff-access/02-requirements.md)).
- **Thiết kế:** [`domain-model.md`](../domain-model.md) §3.7, §8 invariant 7/12 · §9 (hàng "Retention cho authorization audit").
- **System:** [`architecture/01-architecture.md`](../../../architecture/01-architecture.md) §10 (hàng "Retention của audit/security event") — canonical của policy hệ thống.
- **Implementation:** #85 (schema audit, không kèm prune riêng).
