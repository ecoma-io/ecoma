# ADR-0005 — Membership grant và ranh giới permission tài chính của Seller

**Trạng thái:** Accepted · **Ngày:** 2026-11-06 · **Issue:** #549

## Bối cảnh

Seller cần nhiều người vận hành: chủ sở hữu, kế toán, nhân viên quản lý offer. Thiết kế cũ dùng `role` trên membership, nhưng `llm-consumer-tenant` (PR #548) đã chốt bỏ role entity để dùng grant trực tiếp, và ranh giới tài chính giữa Seller tenant và Console tenant cần một quyết định rõ: ai authorize payout, và quyền đó có lan sang Console không.

## Quyết định

### Membership và grant

- Membership có **danh tính theo từng lần** (`id`), trạng thái `active` | `revoked`; revoke là terminal cho bản ghi đó.
- Re-provision sau revoke tạo membership **mới với `id` mới**; grant trỏ `membershipId` nên quyền của lần cũ **không** sống lại.
- Quyền của member đến **chỉ** từ grant trực tiếp: `(grantId, membershipId, permission)` tại tenant scope, có trạng thái `active` | `revoked`, giữ lịch sử.
- Không role entity, không role administration, không wildcard, không suy quyền từ tên permission hay tiền tố.
- Grant chỉ cấp cho membership **active**; grant đã revoke không authorize, kể cả khi actor được provision lại.

### Ranh giới permission tài chính

- **Payout permission là permission Seller-side** (`payout.manage`), được authorize bởi `llm-seller-tenant` trên Seller tenant — owner có sẵn, member cần grant.
- **EC→UC conversion** yêu cầu đồng thời hai authorization **độc lập**: payout permission ở Seller tenant (do `llm-seller-tenant` trả lời) **và** payment permission ở Console tenant (do `llm-consumer-tenant` trả lời) ([`llm-financial/adr/0005`](../../llm-financial/adr/0005-ec-to-uc-conversion.md)).
- Kết quả authorization của `llm-seller-tenant` mang phạm vi tường minh `seller_tenant`; **không** cấp và **không** thay thế bất kỳ quyền nào ở Console tenant.
- `llm-seller-tenant` **chỉ authorize**. Ledger, số dư, conversion, settlement, withholding và disbursement thuộc `llm-financial`/`payout`/`payment`.

## Phương án bị loại

| Phương án                                          | Lý do loại                                                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Role entity trên membership                        | Cần quản trị role, xung đột với `llm-consumer-tenant`; quyền trở nên gián tiếp và khó audit.                   |
| Grant theo `sub` thay vì `membershipId`            | Quyền cũ sống lại sau re-provision — đúng lỗ hổng cần chặn.                                                    |
| Một permission "financial" chung cho cả hai tenant | Xoá ranh giới Seller/Console; vi phạm ADR-0001 của `llm-financial`.                                            |
| `llm-seller-tenant` giữ số dư/payout state         | Vi phạm ownership tài chính ([`llm-financial/adr/0003`](../../llm-financial/adr/0003-financial-ownership.md)). |

## Hệ quả

- Bảng grant cần `UNIQUE (tenant_id, membership_id, permission) WHERE status = 'active'` và không xoá bản ghi đã revoke.
- Consumer cần cả hai verdict; không bên nào được suy ra verdict của bên kia.
- Restriction vẫn đứng trước owner/payout: Seller bị hạn chế thì payout authorization deny ([ADR-0003](../../llm-seller-governance/adr/0003-restriction-and-appeal-model.md)).
- Permission identifier là opaque với domain; nội dung catalog thuộc `staff-access`, ranh giới đầy đủ chưa chốt ([`domain-model.md`](../domain-model.md) §8.2).

## Cross-reference

- [`domain-model.md`](../domain-model.md) §2, §3, §4 · [`llm-financial/adr/0001`](../../llm-financial/adr/0001-independent-seller-console-tenant.md), [`0005`](../../llm-financial/adr/0005-ec-to-uc-conversion.md), [`0003`](../../llm-financial/adr/0003-financial-ownership.md)
- [`staff-access/adr/0009`](../../staff-access/adr/0009-no-internal-authorization-result-contract.md), [`0010`](../../staff-access/adr/0010-permission-naming-and-read-catalog.md)
