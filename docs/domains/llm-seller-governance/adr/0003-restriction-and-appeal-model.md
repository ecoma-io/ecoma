# ADR-0003 — Restriction model: record độc lập, suy ra, public/internal tách biệt

**Trạng thái:** Accepted · **Ngày:** 2026-11-06 · **Issue:** #549

## Bối cảnh

Seller có thể bị hạn chế vì nhiều lý do (compliance, fraud, vi phạm chính sách, yêu cầu pháp lý). Thiết kế cũ dùng `status = suspended` trên tenant: một giá trị duy nhất, không phân biệt lý do, không có thời hạn, và không nói gì về việc lý do nào được phép công bố cho Seller.

Ba vấn đề phải giải quyết cùng lúc:

1. Nhiều hạn chế **đồng thời và độc lập** — lift cái này không được mở khoá cái kia.
2. Seller phải biết **đủ** để phản hồi, nhưng lý do nội bộ (điều tra, nghi vấn) không được lộ.
3. Hạn chế phải chặn được **cả owner**, và không bị bypass qua billing/payout authorization.

## Quyết định

- **Không có `status = restricted`.** Trạng thái "đang bị hạn chế" là **giá trị suy ra** từ tập `RestrictionRecord` tại `now`; tenant không có cột trạng thái thứ hai.
- Mỗi record có: `id`, `tenantId`, `policy`, `publicReason`, `internalReason`, `scope`, `activatesAt`, `expiresAt` (hoặc không hạn), `liftedAt` (hoặc chưa lift), `appealDeadline` (hoặc không có).
- **Nhiều record độc lập.** Lift/expire một record không thay đổi record khác; đánh giá trả `blockingRecordIds` để audit.
- **Hai loại lý do, tách tuyệt đối.** `publicReason` được phép xuất hiện trong public projection/contract/event. `internalReason` chỉ nằm trong domain state và audit nội bộ; không xuất hiện trong bất kỳ object mà Seller đọc được, kể cả error.
- **Cửa sổ nửa mở** `[activatesAt, expiresAt)`. `liftedAt` có hiệu lực khi `liftedAt <= now`; lift đặt lịch tương lai chưa có tác dụng.
- **Scope** là tenant hoặc một capability. Record tenant-scope chặn mọi capability; record capability chỉ chặn capability đó.
- **Fail closed với policy chưa biết.** `policy` là định danh mở (không phải enum của domain). Policy không có trong cấu hình ⇒ coi là restrictive **và** đánh dấu evaluation `unevaluable`.
- **Authorization deny khi `blocked` hoặc `unevaluable`, kể cả owner** — restriction được đánh giá trước owner authority.
- **Financial settlement hold không phải restriction.** Hold của `llm-financial`/`payout` có vòng đời riêng, không tạo restriction và không chặn login/publishing ([`llm-financial/adr/0007`](../../llm-financial/adr/0007-seller-settlement-holds.md)).

## Phương án bị loại

| Phương án                               | Lý do loại                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `status = suspended` trên tenant        | Một giá trị cho nhiều lý do; lift một lý do phải ghi đè lý do khác; không audit được. |
| Một record duy nhất với danh sách lý do | Không có vòng đời riêng cho từng hạn chế; expire/lift không biểu diễn được.           |
| Chỉ `internalReason`, lọc ở UI          | Lọc ở UI không phải bảo đảm; lý do nội bộ vẫn vào contract/event/log.                 |
| Chỉ `publicReason`                      | Mất ngữ cảnh điều tra nội bộ và audit.                                                |

## Hệ quả

- Bảng persistence cần `public_reason` và `internal_reason` là hai cột tách biệt, và projection public chỉ chọn cột public ([`domain-model.md`](../domain-model.md) §8).
- Evaluation là hàm thuần của `(records, policies, target, now)`; caller truyền `now`, domain không đọc clock.
- Appeal trỏ tới một restriction record cụ thể ([ADR-0004](./0004-appeal-lifecycle-and-decision-authority.md)); lift vẫn là thao tác riêng.
- Có thể có record hiệu lực nhưng không restrictive (ghi nhận để theo dõi) — cấu hình policy quyết định, không phải domain.

## Vẫn mở

Tập policy restrictive, ngữ nghĩa từng policy và thời hạn appeal mặc định chưa chốt ([`domain-model.md`](../domain-model.md) §8.4). Domain giữ `policy` như định danh mở và không hardcode.

## Cross-reference

- [`domain-model.md`](../domain-model.md) §3.1, §3.6, §3.7 · §8.4
- [`llm-consumer-tenant/domain-model.md`](../../llm-consumer-tenant/domain-model.md) §3 — pattern suspension suy ra
