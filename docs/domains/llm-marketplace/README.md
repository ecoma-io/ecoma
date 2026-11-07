# LLM Marketplace

Bounded context `llm-marketplace`: model offer, capability, upstream endpoint, endpoint pool, provider credential, provider model name, normalized model identity và offer activation trong hệ sinh thái LLM. Seller tenant, ownership và membership thuộc `llm-seller-tenant`; restriction, verification và legal/tax profile thuộc `llm-seller-governance`; marketplace giữ `sellerTenantId` như tham chiếu và consume operational eligibility qua contract/projection.

> **Cross-reference:** catalog → [`docs/domains/README.md`](../README.md) §2 (`llm-*`) · system-level → [`docs/architecture/01-architecture.md`](../../architecture/01-architecture.md) §2, §4 · llm-consumer-tenant (consumer workspace/tenant scope) → [`docs/domains/llm-consumer-tenant/README.md`](../llm-consumer-tenant/README.md) · payment (fiat payment transaction) → [`docs/domains/payment/README.md`](../payment/README.md); payout (seller payout workflow/execution) → [`docs/domains/payout/README.md`](../payout/README.md) · staff-access entitlement → [`docs/domains/staff-access/README.md`](../staff-access/README.md).

## 1. Trách nhiệm

1. **Seller-offer association** — liên kết `sellerTenantId` (do `llm-seller-tenant` sở hữu) với model offer. Eligibility của **offer** (draft/active/inactive/retired, endpoint pool healthy) thuộc marketplace; operational eligibility của **Seller** thuộc `llm-seller-governance`. Không tái tạo Seller lifecycle hay restriction.
2. **Model offer** — seller cung cấp model cho marketplace, lifecycle offer.
3. **Capability** — capability của model/offer (text, vision, function calling, ...).
4. **Upstream endpoint** — endpoint upstream phục vụ model (URL, protocol, health).
5. **Endpoint pool** — nhóm endpoint cho một offer (load balancing, failover).
6. **Provider credential** — credential truy cập provider/upstream (hash-only, show-once).
7. **Provider model name** — tên model theo provider (raw identity).
8. **Normalized model identity** — identity chuẩn hoá xuyên provider (alias/canonical).
9. **Public seller prefix** (nếu chốt) — prefix công khai cho seller/offer.
10. **Offer activation** — bật/tắt offer phục vụ customer.

## 2. Phân biệt khái niệm (bắt buộc)

| Khái niệm                     | Nghĩa                                                                       |
| ----------------------------- | --------------------------------------------------------------------------- |
| **Seller offer**              | Một seller cung cấp một model cho marketplace (lifecycle offer).            |
| **Model alias**               | Tên public/customer-visible của model (có thể map tới normalized identity). |
| **Provider endpoint**         | Endpoint upstream phục vụ model (URL/protocol/health).                      |
| **Provider model**            | Tên model theo provider (raw identity).                                     |
| **Customer-visible model**    | Model mà customer thấy và gọi (thường là alias/normalized identity).        |
| **Normalized model identity** | Identity chuẩn hoá xuyên provider, dùng để dedup/group.                     |

## 3. Không sở hữu

- Tenant/membership/workspace/permission grant → `llm-consumer-tenant`.
- Seller tenant, ownership, membership, grant → `llm-seller-tenant`.
- Restriction, appeal, verification/onboarding, legal/tax profile, evidence → `llm-seller-governance`.
- Quota/usage/reservation/settlement → `llm-api` (A7).
- Ledger/charges/settlement → `llm-financial`; payment transaction/payout execution → `payment` (gateway/adapter).
- Danh tính account → `account`.
- Entitlement cross-context → `staff-access`.

## 4. Ranh giới với các context khác

| Context               | Ranh giới                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `llm-consumer-tenant` | Workspace/tenant là scope cho offer/catalog; marketplace không sở hữu membership/role.                                                |
| `llm-api`             | Storage owner duy nhất của `db-llm-marketplace`; offer/normalized identity là input cho routing/quota.                                |
| `payment`             | Gateway/execution adapter cho payment & payout; seller payable/settlement do `llm-financial` sở hữu; marketplace không sở hữu ledger. |
| `account`/`auth`      | `sub` opaque cho actor; marketplace không xác minh danh tính.                                                                         |

## 5. Tài liệu

| Document                               | Nội dung                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`domain-model.md`](./domain-model.md) | Business model, rules, invariants, business operations, error taxonomy, quyết định chưa chốt |
