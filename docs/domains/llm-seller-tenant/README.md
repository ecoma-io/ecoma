# LLM Seller Tenant

Bounded context `llm-seller-tenant`: Seller tenant, ownership, membership, permission grant và authorization ladder trong Seller tenant. Tách từ bounded context `llm-seller` theo [ADR-0018](../llm-seller-governance/adr/0018-seller-bounded-context-split.md).

> **Phạm vi:** `llm-seller-tenant` sở hữu Seller business identity và quyền truy cập trong tenant. Không nhầm với deploy unit/composition `llm-seller` (UI seller + BFF) — composition không sở hữu domain rules, database hay source of truth chỉ vì tên trùng. Catalog/context map canonical → [`docs/domains/README.md`](../README.md) §2. System-level → [`docs/architecture/01-architecture.md`](../../architecture/01-architecture.md) §2, §4, §8. Account `sub` opaque → [`docs/domains/glossary.md`](../glossary.md). Tách context → [ADR-0018](../llm-seller-governance/adr/0018-seller-bounded-context-split.md); ba scope ownership → [ADR-0019](../llm-consumer-tenant/adr/0019-llm-scope-ownership-and-dependency-matrix.md).

## 1. Trách nhiệm

1. **Seller tenant và ownership** — ranh giới cách ly dữ liệu của một tổ chức seller; mỗi Seller tenant có **đúng một owner**; owner là **thuộc tính ownership của tenant**, không phải role hay permission. Chuyển owner là domain operation tường minh ([ADR-0001](./adr/0001-seller-tenant-ownership-and-transfer.md)).
2. **Seller membership** — quan hệ giữa một account (`sub`) và một Seller tenant, có danh tính theo từng lần membership. Provision/revoke tường minh; re-provision tạo membership mới. Bất biến incarnation và owned-tenant fact dùng chung với `llm-consumer-tenant` qua thin shared kernel → [ADR-0025](../llm-consumer-tenant/adr/0025-thin-shared-tenant-kernel.md); phần còn lại của Seller tenant vẫn thuộc context này.
3. **Permission grant** — cấp trực tiếp một permission cho một lần membership, có lịch sử cấp/thu hồi. Không có role entity và không có role administration.
4. **Authorization** — quyết định allow/deny trên tài nguyên Seller: owner có toàn quyền trong tenant của mình **trừ khi bị restriction chặn**; member chỉ có đúng permission được cấp. Backend sở hữu tài nguyên tự enforce.
5. **Tenant isolation** — mọi dữ liệu Seller gắn tenant; không request nào đọc/ghi lệch tenant.

## 2. Không sở hữu

- Danh tính account và credential/MFA → `account`.
- Giao thức OAuth 2.0/OIDC → `auth`.
- Consumer tenant, workspace, membership và grant của Consumer → `llm-consumer-tenant`.
- Restriction, appeal, verification/onboarding, legal/tax profile, evidence reference và operational eligibility → `llm-seller-governance` ([ADR-0018](../llm-seller-governance/adr/0018-seller-bounded-context-split.md)).
- Model offer, capability, normalized model identity, upstream endpoint, endpoint pool, provider credential, offer activation → `llm-marketplace`.
- Customer pricing schedule → `llm-seller-pricing`.
- UC/EC ledger, reservation, customer charge, seller payable, settlement, tax calculation/withholding/accounting entries, EC→UC conversion → `llm-financial`.
- Payout request, quote, beneficiary, fiat disbursement, payout reconciliation → `payout`.
- Fiat payment transaction và gateway/execution adapter → `payment`.
- Nội dung permission catalog cross-context và entitlement sản phẩm → `staff-access` (catalog govern / backend enforce). `llm-seller-tenant` chỉ giữ **identifier** permission theo hình `domain.action` và tự enforce.
- Vòng đời pháp lý của dữ liệu Seller → **chưa chốt**, canonical tại `llm-seller-governance` ([ADR-0008](../llm-seller-governance/adr/0008-data-lifecycle-deferred.md)).

## 3. Ranh giới với các context khác

| Context                 | Ranh giới với `llm-seller-tenant`                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account`               | `sub` là tham chiếu opaque; Seller membership không tự động khi account signup/login.                                                                                                                                                             |
| `auth`                  | `sub` lấy từ authenticated principal (access token) đã verify; `llm-seller-tenant` không tự xác minh danh tính.                                                                                                                                   |
| `llm-consumer-tenant`   | Consumer tenant và Seller tenant là hai ownership boundary độc lập; membership/permission ở tenant này không ngụ ý quyền ở tenant kia. Hai tenant **không bao giờ** dùng thay nhau.                                                               |
| `llm-seller-governance` | Governance **được phép** phụ thuộc một chiều vào context này để tham chiếu tenant/membership. Chiều ngược lại bị cấm; authorization ladder nhận restriction evaluation như giá trị khai báo tại biên ([`domain-model.md`](./domain-model.md) §4). |
| `llm-marketplace`       | Marketplace giữ **tham chiếu** `seller_tenant_id` trên offer; không sở hữu Seller identity, ownership hay permission.                                                                                                                             |
| `llm-financial`         | Tiêu thụ Seller tenant reference và payout permission verdict qua contract; monetary state không thuộc context này.                                                                                                                               |
| `payout`                | Tiêu thụ Seller tenant reference và payout permission verdict; không sở hữu Seller tenant hay permission của Seller.                                                                                                                              |
| `payment`               | Fiat payment transaction; không sở hữu Seller tenant.                                                                                                                                                                                             |
| `staff-access`          | Catalog govern/backend enforce; entitlement cấp sản phẩm không thay thế authorization bên trong `llm-seller-tenant` và không trả lời allow/deny per-request (ADR-0007).                                                                           |

## 4. Quy tắc cốt lõi

- **Đúng một owner mỗi Seller tenant.** Owner có toàn quyền trong tenant của mình, kể cả billing và payout, trừ khi target bị restriction chặn. Owner authority **không** đi theo `sub` sang tenant khác.
- **Seller tenant là organization boundary, không có Seller Workspace.** Tenant là đơn vị tổ chức duy nhất của Seller; không tồn tại workspace trong Seller tenant. "Workspace" chỉ tồn tại trong `llm-consumer-tenant`.
- **Seller tenant tồn tại là active ngay khi tạo.** Không có `status = pending`; onboarding approval không phải điều kiện để tạo tenant. Tồn tại, operational eligibility, verification và restriction là bốn trục độc lập — không dùng một status chung.
- **Restriction độc lập với tenant lifecycle.** Restriction không làm tenant mất tồn tại và không chặn tenant ở tầng lifecycle; nó chỉ chặn authorization khi được đánh giá tại biên ([`domain-model.md`](./domain-model.md) §4).
- **Permission là grant trực tiếp trên một lần membership.** Không role entity. Revoke membership không tự restore; re-provision tạo membership **mới với `id` mới**, nên grant của lần cũ không sống lại.
- **Restriction chặn trước owner authority.** Restriction `blocked`/`unevaluable` ⇒ deny **kể cả owner**, và không bypass được qua billing/payout authorization.
- **Payout permission tại Seller tenant.** EC→UC conversion cần payout permission ở Seller tenant **và** payment permission ở Consumer tenant; hai authorization độc lập ([ADR-0005](../llm-financial/adr/0005-ec-to-uc-conversion.md), [ADR-0005 của Seller](./adr/0005-membership-grants-and-financial-permission-boundary.md)).
- **`sub` opaque.** Không FK xuyên database; toàn vẹn là responsibility của contract + reconciliation.

## 5. Tài liệu

| Document                               | Nội dung                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`domain-model.md`](./domain-model.md) | Business model, rules, invariants, business operations, error taxonomy, quyết định chưa chốt |
| [`adr/README.md`](./adr/README.md)     | ADR index của bounded context                                                                |
