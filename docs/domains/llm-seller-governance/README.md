# LLM Seller Governance

Bounded context `llm-seller-governance`: restriction và evaluation, appeal lifecycle, verification/onboarding, legal profile, tax profile, evidence reference và operational eligibility của Seller. Tách từ bounded context `llm-seller` theo [ADR-0018](./adr/0018-seller-bounded-context-split.md).

> **Phạm vi:** `llm-seller-governance` sở hữu các quyết định **platform reviewer** về một Seller. Seller tenant, ownership, membership và permission grant thuộc [`llm-seller-tenant`](../llm-seller-tenant/README.md). Không nhầm với deploy unit/composition `llm-seller` (UI seller + BFF) — composition không sở hữu domain rules, database hay source of truth chỉ vì tên trùng. Catalog/context map canonical → [`docs/domains/README.md`](../README.md) §2. Account `sub` opaque → [`docs/domains/glossary.md`](../glossary.md). Tách context → [ADR-0018](./adr/0018-seller-bounded-context-split.md); ba scope ownership → [ADR-0019](../llm-consumer-tenant/adr/0019-llm-scope-ownership-and-dependency-matrix.md).

## 1. Trách nhiệm

1. **Restriction** — nhiều record hạn chế độc lập, mỗi record có vòng đời riêng, tách **lý do công khai** khỏi **lý do nội bộ**; "đang bị hạn chế" là **giá trị suy ra** tại thời điểm đánh giá, không phải trạng thái được lưu ([ADR-0003](./adr/0003-restriction-and-appeal-model.md)).
2. **Appeal** — khiếu nại của Seller đối với một restriction, có vòng đời và deadline tường minh, do platform reviewer có thẩm quyền quyết định ([ADR-0004](./adr/0004-appeal-lifecycle-and-decision-authority.md)).
3. **Verification và onboarding** — verification case cho từng loại yêu cầu, giữ lịch sử submission/rejection/resubmission; trạng thái onboarding là **giá trị suy ra** từ verification case + profile, không phải lifecycle của tenant ([ADR-0002](../llm-seller-tenant/adr/0002-tenant-existence-separate-from-eligibility.md), [ADR-0006](./adr/0006-verification-and-versioned-profiles.md)).
4. **Legal profile và tax profile** — hồ sơ pháp lý/thuế của Seller, versioned, append-only, kỳ hiệu lực suy ra từ thứ tự version ([ADR-0006](./adr/0006-verification-and-versioned-profiles.md)).
5. **Evidence reference** — metadata và tham chiếu bất biến tới tài liệu evidence. Domain không giữ nội dung tài liệu.
6. **Operational eligibility** — verdict duy nhất về việc Seller có đủ điều kiện vận hành hay không, suy ra từ restriction + verification + profile version hiệu lực; Marketplace, Financial và Payout tiêu thụ verdict như **giá trị hợp đồng** (ADR-0018 §3).

## 2. Không sở hữu

- Danh tính account và credential/MFA → `account`.
- Giao thức OAuth 2.0/OIDC → `auth`.
- Seller tenant, ownership, membership, permission grant và authorization ladder → `llm-seller-tenant`.
- Consumer tenant, workspace, membership và grant của Consumer → `llm-consumer-tenant`.
- Model offer, capability, normalized model identity, upstream endpoint, endpoint pool, provider credential, offer activation → `llm-marketplace`.
- Customer pricing schedule → `llm-seller-pricing`.
- UC/EC ledger, reservation, customer charge, seller payable, settlement, tax calculation/withholding/accounting entries, EC→UC conversion → `llm-financial`.
- Payout request, quote, beneficiary, fiat disbursement, payout reconciliation → `payout`.
- Fiat payment transaction và gateway/execution adapter → `payment`.
- Nội dung permission catalog cross-context và entitlement sản phẩm → `staff-access`.
- Chính sách retention/deletion/legal hold và vòng đời pháp lý của dữ liệu → **chưa chốt**, không thuộc domain này (xem §4).

## 3. Ranh giới với các context khác

| Context             | Ranh giới với `llm-seller-governance`                                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account`           | `sub` là tham chiếu opaque; reviewer/submitted actor lấy từ verified authentication context.                                                                                            |
| `llm-seller-tenant` | Governance **phụ thuộc một chiều** vào tenant để tham chiếu tenant/membership; tenant không phụ thuộc governance. Authorization ladder của tenant nhận restriction evaluation tại biên. |
| `llm-marketplace`   | Tiêu thụ operational eligibility/verification verdict qua contract/projection; **không** đọc restriction record hay evidence pháp lý (ADR-0018 §3).                                     |
| `llm-financial`     | Tiêu thụ legal/tax profile version hiệu lực và payout verdict; không sở hữu profile hay restriction.                                                                                    |
| `payout`            | Tiêu thụ operational eligibility và payout verdict; không sở hữu Seller tenant hay permission của Seller.                                                                               |
| `staff-access`      | Catalog govern/backend enforce; entitlement cấp sản phẩm không thay thế authorization bên trong Seller.                                                                                 |

## 4. Quy tắc cốt lõi

- **Restriction là trục độc lập.** Nhiều record độc lập theo reason/scope/policy; lift hoặc expire record này không làm yếu record khác. Không có cột `status = restricted` thứ hai.
- **Restriction độc lập với tenant lifecycle.** Restriction không làm tenant mất tồn tại, không chặn tenant ở tầng lifecycle, và không tạo ra trạng thái `pending`/`suspended` cho tenant ([ADR-0002](../llm-seller-tenant/adr/0002-tenant-existence-separate-from-eligibility.md), [ADR-0003](./adr/0003-restriction-and-appeal-model.md)).
- **Restriction chặn trước owner authority.** Restriction `blocked`/`unevaluable` ⇒ deny **kể cả owner**, và không bypass được qua billing/payout authorization; ladder đó nằm ở `llm-seller-tenant` (§4.1 của [`llm-seller-tenant/domain-model.md`](../llm-seller-tenant/domain-model.md)).
- **Hai loại lý do.** `publicReason` được phép ra contract/UI; `internalReason` chỉ lưu nội bộ và không xuất hiện trong bất kỳ public projection hay error nào.
- **Governance là owner duy nhất của eligibility verdict.** Marketplace, Financial và Payout không đọc evidence pháp lý, không tự diễn giải restriction record, và không tự suy ra eligibility từ verification case (ADR-0018 §3).
- **Không boolean `verified` duy nhất.** Tồn tại, operational eligibility, verification và restriction là bốn trục độc lập (ADR-0018).
- **Legal/tax profile versioned, append-only.** Không sửa version đã ghi; kỳ hiệu lực suy ra từ thứ tự `effectiveFrom` (nửa mở, version cuối mở).
- **Financial settlement hold ≠ Seller restriction.** Hold của `llm-financial`/`payout` không làm thay đổi restriction, không chặn login/publishing, và ngược lại ([ADR-0007](../llm-financial/adr/0007-seller-settlement-holds.md)).
- **Vòng đời pháp lý của dữ liệu chưa chốt.** Retention, deletion, legal hold, anonymization và physical deletion không được implement hay suy diễn trong domain này ([ADR-0008](./adr/0008-data-lifecycle-deferred.md)).

## 5. Tài liệu

| Document                               | Nội dung                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`domain-model.md`](./domain-model.md) | Business model, rules, invariants, business operations, error taxonomy, quyết định chưa chốt |
| [`adr/README.md`](./adr/README.md)     | ADR index của bounded context                                                                |
