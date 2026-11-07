# ADR-0006 — Verification, legal/tax profile versioned và evidence reference

**Trạng thái:** Accepted · **Ngày:** 2026-11-06 · **Issue:** #549

## Bối cảnh

Seller phải chứng minh tư cách pháp lý và nghĩa vụ thuế trước khi nhận payout. [`llm-financial/adr/0008`](../../llm-financial/adr/0008-seller-tax-profile.md) đã chốt ownership split: `llm-seller-governance` sở hữu seller legal/tax profile, tax identity, declarations và evidence; `llm-financial` sở hữu tính toán thuế, withholding liability và accounting entries. Còn thiếu quyết định về **cách** profile được ghi, **cách** xác minh, và **cách** tham chiếu tài liệu mà không biến domain thành storage.

## Quyết định

### Verification case

- Verification là **entity riêng**, không phải lifecycle của tenant ([ADR-0002](../../llm-seller-tenant/adr/0002-tenant-existence-separate-from-eligibility.md)).
- Case có `type` là **định danh mở** (`legal-identity`, `tax`, ...); domain không hardcode danh mục.
- Vòng đời: `draft → submitted → under_review → approved | rejected`; `rejected → submitted` khi Seller resubmit (không quay về `draft`, nên submission cũ vẫn là một mốc của chuỗi); `approved → expired` chỉ khi policy cấu hình expiry.
- Mỗi lần submit tạo **submission bất biến** kèm danh sách evidence reference của đúng tenant; submission cũ được giữ nguyên khi resubmit.
- Reviewer quyết định approve/reject; reject bắt buộc `publicDecisionReason`.

### Legal/tax profile

- Hai chuỗi version độc lập, **append-only**: `LegalProfileVersion`, `TaxProfileVersion`. Không có thao tác update/delete.
- `version` do domain cấp, tăng đơn điệu; `effectiveFrom` phải **tăng nghiêm ngặt** so với version trước.
- Kỳ hiệu lực suy ra: version `i` hiệu lực trong `[effectiveFrom_i, effectiveFrom_{i+1})`; version cuối mở. Không có cờ `current`.
- Danh mục `legalType`, `taxResidency` là **định danh mở**; domain không hardcode danh mục pháp lý/thuế và **không** tính tax ([ADR-0008](../../llm-financial/adr/0008-seller-tax-profile.md)).

### Evidence reference

- Evidence là **metadata + tham chiếu bất biến**: `evidenceId`, `tenantId`, `kind`, `storageRef`, `contentHash`, `recordedAt`, `recordedBy`.
- Domain **không** giữ nội dung tài liệu, không sinh URL, không đọc storage, không quyết định retention.
- `storageRef`/`contentHash` bất biến sau khi tạo; evidence gắn đúng một tenant, tham chiếu cross-tenant bị từ chối.

## Phương án bị loại

| Phương án                                  | Lý do loại                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| Profile mutable, một bản ghi hiện hành     | Mất lịch sử; withholding/accounting cần profile tại thời điểm giao dịch.          |
| Cờ `is_current` trên profile               | Nguồn sự thật thứ hai; cần cập nhật nhiều bản ghi trong một transaction, dễ lệch. |
| Domain lưu nội dung evidence               | Vi phạm purity, kéo storage/retention (chưa chốt) vào domain.                     |
| Verification là trạng thái tenant          | Trộn hai trục; xem ADR-0002.                                                      |
| Enum legal type/tax residency trong domain | Bịa danh mục pháp lý chưa được duyệt.                                             |

## Hệ quả

- Persistence cần `UNIQUE (tenant_id, version)` cho mỗi chuỗi profile và trigger chặn UPDATE/DELETE.
- `llm-financial` đọc profile **theo thời điểm** qua contract (hàm chọn version tại `at`), không đọc bản ghi hiện hành.
- Onboarding-complete là giá trị suy ra từ case `approved` + profile version hiệu lực + restriction; không lưu.
- Retention, expiry window, storage provider và cơ chế ký URL **chưa chốt** ([`domain-model.md`](../domain-model.md) §8.4, §8.6).

## Cross-reference

- [`domain-model.md`](../domain-model.md) §3.3–§3.5, §7, §8.1, §8.2, §8.6 · §4
- [`llm-financial/adr/0008`](../../llm-financial/adr/0008-seller-tax-profile.md) — ownership split legal/tax
