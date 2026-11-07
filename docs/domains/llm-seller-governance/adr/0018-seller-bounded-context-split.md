# ADR-0018 — Tách `llm-seller` thành `llm-seller-tenant` và `llm-seller-governance`

**Trạng thái:** Accepted · **Ngày:** 2026-11-06 · **Issue:** #559

## Bối cảnh

`llm-seller-domain` trộn hai trục ownership có vòng đời và actor khác nhau trong một library:

- **Tenant**: Seller tenant, owner, membership, permission grant, authorization ladder. Thay đổi khi Seller tự vận hành.
- **Governance**: restriction, appeal, verification/onboarding, legal/tax profile, evidence reference, derived operational eligibility. Thay đổi khi platform reviewer quyết định.

Hệ quả hiện tại:

- Một thay đổi ở governance buộc rebuild và re-review toàn bộ tenant model.
- Marketplace và Financial — hai consumer của **kết luận** governance — có đường import trực tiếp vào implementation của restriction và evidence, nên có thể tự diễn giải legal evidence thay vì tiêu thụ verdict.

Ba phương án đã cân nhắc:

1. **Giữ một library, tách module nội bộ** — loại: module trong cùng Nx project không tạo dependency edge, nên không constraint nào enforce được ranh giới; đây đúng là lỗi hiện tại.
2. **Tách ba library: tenant, governance, entitlement dùng chung** — loại: "entitlement chung" chỉ là tập con của governance (verification + restriction); tách thêm tạo bounded context thứ ba không có invariant riêng.
3. **Tách hai library: `llm-seller-tenant-domain` và `llm-seller-governance-domain`** — **chấp nhận.**

## Quyết định

### 1. Ranh giới sở hữu

| Context                 | Sở hữu                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `llm-seller-tenant`     | Seller tenant, owner, membership, permission grant, authorization ladder trong tenant                                                      |
| `llm-seller-governance` | Restriction record và evaluation, appeal lifecycle, verification/onboarding, legal profile, tax profile, evidence, operational eligibility |

- `llm-seller-governance` **được phép** phụ thuộc `llm-seller-tenant` (cùng owner, một chiều, để tham chiếu tenant/membership). Chiều ngược lại **bị cấm**.
- Authorization ladder trong `llm-seller-tenant` nhận restriction evaluation như **giá trị khai báo tại boundary** của chính nó, không import `llm-seller-governance`. Cùng hình thức `llm-consumer-routing-domain` dùng cho `ExecutionEvidence`: khai báo lại shape tại biên và ghim bằng spec.
- Không có boolean `verified` duy nhất. Tồn tại, operational eligibility, verification và restriction là bốn trục độc lập.
- Tenant tồn tại là active ngay khi tạo. Restriction **không** làm tenant mất tồn tại, và không chặn nó ở tầng lifecycle.

### 2. Consumer tenant ≠ Seller tenant

- Consumer Tenant và Seller Tenant là hai ownership boundary độc lập. Membership/grant ở tenant này không ngụ ý quyền ở tenant kia.
- Không tồn tại "Seller Workspace": Seller tenant là organization boundary.

### 3. Governance là owner duy nhất của eligibility verdict

- Marketplace, Financial và Routing tiêu thụ eligibility/restriction verdict như **giá trị hợp đồng**.
- Chúng không đọc evidence pháp lý, không tự diễn giải restriction record, và không tự suy ra eligibility từ verification case.

## Hệ quả

- Tên package đổi thành `@ecoma-io/llm-seller-tenant-domain` và `@ecoma-io/llm-seller-governance-domain`; đây là refactor trong repo chưa phát hành nên không cần lớp tương thích.
- ADR Seller hiện có được phân về đúng context mà **không** đổi nội dung quyết định: `0001`, `0002`, `0005`, `0007` thuộc `llm-seller-tenant`; `0003`, `0004`, `0006`, `0008` thuộc `llm-seller-governance`.
- Provider cost **không** được gán ownership bởi ADR này; xem [`docs/domains/open-boundaries.md`](../../open-boundaries.md) OB-7.

## Phạm vi supersede

Không supersede ADR nào. ADR này chỉ thu hẹp cách đọc các ADR Seller hiện có về mặt context sở hữu.
