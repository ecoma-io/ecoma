# llm-seller — Application

`llm-seller` là **composition: UI seller + BFF**, deploy unit chạy trên Edge (Cloudflare Worker), không sở hữu database nghiệp vụ — ghi qua contract/API của các context owning (`llm-seller-tenant`, `llm-seller-governance`, `llm-seller-pricing`, `llm-marketplace`, `llm-consumer-tenant`, `llm-financial`, `payout`, `payment`). Chi tiết bounded context, domain rules → canonical ở [`docs/domains/`](../../domains/).

## 1. Component

- **Component type:** composition (Nuxt SPA non-SSR + BFF).
- **Component purpose:** Cổng seller cho việc tham gia marketplace: Seller profile/ownership/membership, restriction và appeal, verification tài liệu, offer, endpoint, provider credential, pricing seller, earnings, settlement và payout views.
- **Responsibility và boundary:** Orchestrate UI seller + gọi API của các bounded context sở hữu. Không sở hữu DB nghiệp vụ, không chứa business rules thay thế bounded context. Không tự cấp permission.
- **Domain contexts tham gia:** `llm-seller-tenant`, `llm-seller-governance`, `llm-seller-pricing`, `llm-marketplace` (composition nội bộ); `llm-consumer-tenant`, `llm-financial`, `payout`, `payment` (tiêu thụ qua contract/API).
- **Tài liệu bên trong:** [`01-architecture.md`](./01-architecture.md), [`02-requirements.md`](./02-requirements.md), [`03-operations.md`](./03-operations.md).

## 2. Ranh giới ownership

`llm-seller` **không sở hữu** bất kỳ bounded context nào — hosting/composition không phải ownership. Nó compose và consume các context sau theo contract:

| Context                 | Vai trò trong composition                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `llm-seller-tenant`     | Seller tenant, ownership, membership/grant                                                       |
| `llm-seller-governance` | Restriction/appeal, verification, legal/tax profile, onboarding, operational eligibility verdict |
| `llm-seller-pricing`    | Seller pricing cho offer                                                                         |
| `llm-marketplace`       | Offer lifecycle, capability, endpoint, provider credential, normalized identity                  |
| `llm-consumer-tenant`   | Console tenant/workspace, membership, grant (qua contract)                                       |
| `llm-financial`         | Seller payable, settlement, refund/adjustment view (qua contract)                                |
| `payout`                | Payout request, quote, beneficiary, disbursement status, payout reconciliation (qua contract)    |
| `payment`               | Payment transaction / gateway execution adapter (qua contract)                                   |

## 3. Tài liệu liên hệ

- System-level boundary/data ownership → [`docs/architecture/01-architecture.md`](../../architecture/01-architecture.md) §2, §4.
- Bounded context domain model → [`docs/domains/llm-seller-tenant/`](../../domains/llm-seller-tenant/README.md), [`docs/domains/llm-seller-governance/`](../../domains/llm-seller-governance/README.md), [`docs/domains/llm-seller-pricing/`](../../domains/llm-seller-pricing/README.md), [`docs/domains/llm-marketplace/`](../../domains/llm-marketplace/README.md).
