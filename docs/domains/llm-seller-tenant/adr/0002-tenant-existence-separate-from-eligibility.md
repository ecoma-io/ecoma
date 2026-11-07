# ADR-0002 — Sự tồn tại của Seller tenant tách khỏi operational eligibility

**Trạng thái:** Accepted · **Ngày:** 2026-11-06 · **Issue:** #549

## Bối cảnh

Thiết kế cũ dùng một trường `status` (`pending` | `active` | `suspended` | `terminated`) cho Seller tenant và biến onboarding approval thành điều kiện để tenant trở thành `active`. Cách đó gộp bốn câu hỏi khác nhau vào một giá trị:

1. Tenant **có tồn tại** không (dữ liệu, membership, profile đã được ghi).
2. Tenant có **đủ điều kiện vận hành** (bán offer, nhận payout) không.
3. Tenant đã **xác minh** các yêu cầu pháp lý/thuế chưa.
4. Tenant có đang **bị hạn chế** không.

Gộp lại khiến lifecycle state trở thành nguồn sự thật thứ hai cho restriction, và khiến seller mới không thể được tạo trước khi duyệt onboarding — trái với yêu cầu "tạo là operational-active ngay".

## Quyết định

- Seller tenant **không** có trường `status`, `pending`, `archivedAt` hay `deletedAt`.
- Tạo Seller tenant nghĩa là tenant **tồn tại và operational-active ngay**. Onboarding approval **không** phải điều kiện tiên quyết để tạo tenant.
- Bốn trục được đánh giá độc lập và không có giá trị nào được lưu thành `status`:
  - **Tồn tại** — bản ghi tenant + owner.
  - **Restriction** — suy ra từ tập `RestrictionRecord` tại `now` ([ADR-0003](../../llm-seller-governance/adr/0003-restriction-and-appeal-model.md)).
  - **Verification** — trạng thái các verification case ([ADR-0006](../../llm-seller-governance/adr/0006-verification-and-versioned-profiles.md)).
  - **Operational eligibility / onboarding hoàn tất** — **giá trị suy ra** từ restriction + verification + sự hiện diện của legal/tax profile version hiệu lực.
- Consumer (marketplace, financial, payout) nhận kết quả suy ra qua contract/projection; không đọc một cột `status`.

## Hệ quả

- Không có transition `pending → active`; không có "duyệt onboarding" như một bước lifecycle của tenant.
- Bỏ một restriction hoặc approve một verification case làm thay đổi eligibility **ngay ở lần đánh giá kế tiếp**, không cần ghi lại trạng thái tenant.
- Không thể có hai nguồn sự thật mâu thuẫn (`status = active` nhưng đang bị restriction chặn, hoặc ngược lại).
- Consumer phải gọi contract/hàm suy ra thay vì cache một trường `status`; caching là quyết định của application và phải có freshness bound.
- Hệ quả phụ: không có "tenant terminated" như trạng thái domain; vòng đời pháp lý của dữ liệu vẫn chưa chốt ([`domain-model.md`](../domain-model.md) §8.3).

## Cross-reference

- [`domain-model.md`](../domain-model.md) §1, §3, §8.3
- [`llm-seller-governance/domain-model.md`](../../llm-seller-governance/domain-model.md) §3.3 — verification và onboarding
- [`llm-consumer-tenant/domain-model.md`](../../llm-consumer-tenant/domain-model.md) §8.1 — cùng lý do loại legal lifecycle khỏi domain
