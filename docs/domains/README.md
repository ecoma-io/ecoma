# Domains

> **Phạm vi:** view **Domains** — nghiệp vụ của Ecoma được tổ chức thành những bounded context nào, mỗi context sở hữu tri thức gì, chúng quan hệ với nhau ra sao, và ranh giới nghiệp vụ nào còn chưa chốt.
>
> Domains chỉ sở hữu **business knowledge**. Tài liệu này **không** chứa HTTP route, Nuxt/Hono/Worker/Queue, SQL schema/migration, binding, SDK/adapter, retry/lease/concurrency, deployment/monitoring/runbook → [`applications/`](../applications/README.md), [`architecture/`](../architecture/README.md).

## 1. Mục đích và cách đọc

View Domains trả lời bốn câu hỏi, mỗi câu có một tài liệu canonical:

1. **Ngôn ngữ domain dùng chung là gì?** → [`glossary.md`](./glossary.md).
2. **Bounded context nào tồn tại, trách nhiệm nghiệp vụ ra sao?** → catalog ở §2 của tài liệu này.
3. **Các context tương tác với nhau như thế nào?** → [`context-map.md`](./context-map.md).
4. **Ranh giới nghiệp vụ nào thật sự chưa chốt?** → [`open-boundaries.md`](./open-boundaries.md).

Business model, rule và invariant của từng context nằm trong `domains/<context>/domain-model.md`.

### 1.1 Bốn trục không được nhầm lẫn

| Trục                | Nghĩa                                                                     | Ví dụ                                                                        | Nơi canonical                                        |
| ------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Bounded context** | Ranh giới nghiệp vụ — ai sở hữu trách nhiệm và dữ liệu của một capability | `pact-broker`                                                                | Domain view (tài liệu này)                           |
| **Application**     | Thành phần phần mềm thực thi, composition của nó                          | `llm-api`, `transactional-mailer-job`                                        | [`applications/`](../applications/README.md)         |
| **Deploy unit**     | Một Worker/runtime unit chạy request                                      | `account`, `auth`                                                            | [`01`](../architecture/01-architecture.md) §2        |
| **Nx scope**        | Trục sở hữu code (`scope:*`)                                              | `scope:messaging` bao trùm control + delivery plane của `transactional-mail` | [`05`](../architecture/05-code-architecture.md) §6.3 |

Một bounded context có thể được hiện thực bởi **nhiều** Application và nhiều deploy unit (A10) — đó là chủ đích, không phải bất thường. Ngược lại, một Application có thể host nhiều context. Deploy unit, Application hay job **không** tạo bounded context. `account` và `auth` là hai bounded context riêng; `pact-broker` là một context với nhiều Application; `transactional-mail` gồm control plane và delivery plane nhưng vẫn là một context.

### 1.2 Quy tắc về hiện trạng

- **Không** có cột/ký hiệu "đã implement / chưa implement / chưa provision / chưa deploy" trong catalog hay context map. Trạng thái triển khai là thuộc tính của implementation, không phải của domain view.
- "Chưa triển khai nhưng đã kiến trúc hoá" (ví dụ `payment`) **vẫn nằm trong catalog** với đầy đủ trách nhiệm và ranh giới — vì tài liệu kiến trúc đã định nghĩa nó.
- "Chưa chốt quyết định" **không** phải "chưa triển khai" — nó vào [`open-boundaries.md`](./open-boundaries.md), không vào catalog.

---

## 2. Catalog bounded context

Catalog liệt kê **18 bounded context**. Mỗi dòng nêu trách nhiệm nghiệp vụ ngắn gọn và liên kết tới README của context; business model chi tiết nằm trong `domain-model.md` của context đó.

| Bounded Context                       | Trách nhiệm nghiệp vụ                                                                                                                                                      | Tài liệu                                                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `account`                             | Bằng chứng đăng nhập, account identity (`sub`) và lifecycle, credential, authentication eligibility, profile/preference/privacy semantics                                  | [`domains/account`](./account/README.md)                                                                              |
| `auth`                                | OAuth 2.0/OIDC: authorization transaction, consent, grant, authorization code và token lifecycle, revocation policy                                                        | [`domains/auth`](./auth/README.md)                                                                                    |
| `staff-access`                        | Staff member và lifecycle, permission catalog, role, staff-role assignment, product entitlement, authorization audit                                                       | [`domains/staff-access`](./staff-access/README.md), [`adr/`](./staff-access/adr/README.md)                            |
| `pact-broker`                         | Consumer-driven contract testing: pact, verification, matrix, version/environment/deployment record, `can-i-deploy`, tenant/membership/machine credential                  | [`domains/pact-broker`](./pact-broker/README.md)                                                                      |
| `transactional-mail`                  | Email giao dịch: mail template, mail message, message intent, business delivery lifecycle, semantic idempotency, retention/deletion semantics                              | [`domains/transactional-mail`](./transactional-mail/README.md)                                                        |
| `push-notification`                   | Device, push subscription, push provider, push notification, push routing policy, push delivery business lifecycle, invalidation và failure semantics                      | [`domains/push-notification`](./push-notification/README.md)                                                          |
| `llm-consumer-tenant`<br/>_Consumer_  | Consumer tenant (đúng một owner), membership, workspace, permission grant theo scope và suspension record                                                                  | [`domains/llm-consumer-tenant`](./llm-consumer-tenant/README.md), [`adr/`](./llm-consumer-tenant/adr/README.md)       |
| `llm-consumer-routing`<br/>_Consumer_ | Model alias, routing policy, candidate selection và fallback configuration phía Consumer                                                                                   | [`domains/llm-consumer-routing`](./llm-consumer-routing/README.md)                                                    |
| `llm-seller-tenant`<br/>_Seller_      | Seller tenant và ownership, membership, permission grant, authorization ladder trong tenant                                                                                | [`domains/llm-seller-tenant`](./llm-seller-tenant/README.md), [`adr/`](./llm-seller-tenant/adr/README.md)             |
| `llm-seller-governance`<br/>_Seller_  | Restriction và appeal, verification/onboarding, legal/tax profile, evidence reference, operational eligibility verdict, `FirstPartyLegalPrincipal` + principal association | [`domains/llm-seller-governance`](./llm-seller-governance/README.md), [`adr/`](./llm-seller-governance/adr/README.md) |
| `llm-marketplace`<br/>_Seller_        | Model offer, capability, upstream endpoint và endpoint pool — kể cả ý nghĩa nghiệp vụ của `health_status`                                                                  | [`domains/llm-marketplace`](./llm-marketplace/README.md)                                                              |
| `llm-seller-pricing`<br/>_Seller_     | Customer price do seller cấu hình, pricing schedule theo offer, per-request/per-token, peak/off-peak, pricing snapshot                                                     | [`domains/llm-seller-pricing`](./llm-seller-pricing/README.md)                                                        |
| `llm-inference`<br/>_Shared_          | Logical request lifecycle, provider attempt, retry semantics, streaming và execution evidence                                                                              | [`domains/llm-inference`](./llm-inference/README.md)                                                                  |
| `llm-usage`<br/>_Shared_              | Usage normalization, metering, usage record, correction và aggregation                                                                                                     | [`domains/llm-usage`](./llm-usage/README.md)                                                                          |
| `llm-financial`<br/>_Shared_          | Billing account, wallet, credit, sponsor funding, ledger, reservation, budget escrow, customer charge, seller payable, settlement và reconciliation                        | [`domains/llm-financial`](./llm-financial/README.md), [`adr/`](./llm-financial/adr/README.md)                         |
| `payment`                             | Ledger credit và payment transaction (inbound fiat payment); gateway/execution adapter cho fiat disbursement                                                               | [`domains/payment`](./payment/README.md)                                                                              |
| `payout`                              | Payout request, payout quote, beneficiary/destination, fiat disbursement, manual payout MVP, execution evidence, payout reconciliation                                     | [`domains/payout`](./payout/README.md), [`adr/`](./payout/adr/README.md)                                              |
| `remote-cache`                        | Tenant, project, membership, API key và authorization semantics, quota, retention, usage metering, audit, lifecycle enforcement                                            | [`domains/remote-cache`](./remote-cache/README.md), [`adr/`](./remote-cache/adr/README.md)                            |

### 2.1 Nhóm LLM product

Chín context LLM là các bounded context riêng, không phải một umbrella `llm` và không phải một umbrella `llm-seller`. Ba nhóm sở hữu:

| Nhóm         | Context                                                                               |
| ------------ | ------------------------------------------------------------------------------------- |
| **Consumer** | `llm-consumer-tenant`, `llm-consumer-routing`                                         |
| **Seller**   | `llm-seller-tenant`, `llm-seller-governance`, `llm-marketplace`, `llm-seller-pricing` |
| **Shared**   | `llm-inference`, `llm-usage`, `llm-financial`                                         |

Quy tắc ranh giới nghiệp vụ:

- **Consumer tenant ≠ Seller tenant** — hai loại tenant độc lập, không suy quyền lẫn nhau. Seller tenant là organization boundary và **không có Seller Workspace**; workspace chỉ tồn tại trong Consumer tenant.
- **Seller tenant active ngay khi tạo** — không có `status` lifecycle và không có bước duyệt onboarding như điều kiện tồn tại; verification/eligibility là giá trị suy ra thuộc `llm-seller-governance`.
- **Restriction độc lập với tenant lifecycle** — restriction không làm tenant mất tồn tại; `llm-seller-governance` phụ thuộc một chiều vào `llm-seller-tenant`, chiều ngược lại bị cấm.
- **Consumer và Seller không phụ thuộc nhau**; Shared được cả hai tiêu thụ nhưng không phụ thuộc bên nào. Bất biến chiều phụ thuộc → [ADR-0019](./llm-consumer-tenant/adr/0019-llm-scope-ownership-and-dependency-matrix.md); tách Seller → [ADR-0018](./llm-seller-governance/adr/0018-seller-bounded-context-split.md).

**Không có bounded context `Tenant` dùng chung.** Mỗi context có tenant sở hữu tenant domain, membership, authorization, lifecycle và plan của chính mình; thin shared kernel `libs/tenant-kernel-domain` chỉ được chứa primitive có cùng ngữ nghĩa (tham chiếu opaque + tenant-scoping collection, owned-tenant fact, membership incarnation), và ADR-0025 loại role-based membership cùng tenant lifecycle khỏi kernel. Phạm vi và giới hạn → [ADR-0025](./llm-consumer-tenant/adr/0025-thin-shared-tenant-kernel.md).

### 2.2 Quy ước ngôn ngữ

- Bounded context không đổi tên theo Application, deploy unit hay Nx project.
- Tên application không hàm ý sở hữu domain: `llm-api`, `llm-seller`, `llm-console` host và compose nhiều context nhưng **không** sở hữu domain rule hay database chỉ vì tên trùng.
- Thuật ngữ dùng chung → [`glossary.md`](./glossary.md). Quan hệ → [`context-map.md`](./context-map.md).

---

## 3. Thành phần không phải bounded context

Các thành phần sau **không** phải bounded context nghiệp vụ và **không** nằm trong catalog. Chúng thuộc view Applications hoặc Architecture:

| Thành phần                                                 | Bản chất                                                             | Nơi canonical                                                                                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `backoffice`                                               | Composition/UI + BFF vận hành nội bộ; không sở hữu dữ liệu nghiệp vụ | [`applications/backoffice`](../applications/backoffice/README.md)                                                                    |
| `home`, `router`                                           | Deploy unit public / non-production entry                            | [`01`](../architecture/01-architecture.md) §2                                                                                        |
| `janitor`, `auth-nonce-prune-job`                          | Maintenance plane (cron Worker)                                      | [`applications/auth-nonce-prune-job`](../applications/auth-nonce-prune-job/README.md), [`01`](../architecture/01-architecture.md) §2 |
| `llm-api`, `llm-seller`, `llm-console`, `llm-health-check` | Composition / API service / job của các context LLM                  | [`applications/`](../applications/README.md)                                                                                         |
| `local-development`                                        | Hạ tầng Docker local dùng chung, phục vụ mọi component               | [`architecture/local-development/`](../architecture/local-development/README.md)                                                     |
| `deploys/*`                                                | Project Pulumi provision hạ tầng                                     | [`05`](../architecture/05-code-architecture.md) §2.1                                                                                 |
| `platform`/`shared`/`public` scope                         | Vùng ownership chia sẻ trong Nx                                      | [`05`](../architecture/05-code-architecture.md) §6.3                                                                                 |

---

## 4. Quy tắc bảo trì domain view

1. **Mỗi fact có một canonical location.** Ngôn ngữ → `glossary.md`; catalog → tài liệu này; quan hệ → `context-map.md`; ranh giới chưa chốt → `open-boundaries.md`; model của context → `domains/<context>/domain-model.md`. Tài liệu khác **tham chiếu**, không sao chép.
2. Thêm bounded context mới → thêm vào catalog, cập nhật `context-map.md` và `open-boundaries.md` nếu có quan hệ/chưa chốt liên quan.
3. Loại một capability khỏi catalog **chỉ** khi tài liệu kiến trúc không còn định nghĩa nó — không phải vì thiếu implementation.
4. Một mục vào `open-boundaries.md` chỉ khi thật sự chưa có đáp án; đã chốt bằng ADR thì không viết lại như open.
5. Deploy unit, Application hay job mới không tự động tạo bounded context.
6. Shared infra (`local-development`, `janitor`, `deploys/*`) không bao giờ là bounded context. `remote-cache` từng là disposable build state (A18) và trở thành SaaS bounded context theo [ADR-0015](./remote-cache/adr/0015-remote-cache-bounded-context.md).
7. Khi một open boundary được giải quyết, chuyển nội dung sang tài liệu canonical tương ứng và xoá khỏi `open-boundaries.md`, để lại nhiều nhất một pointer `đã chốt → <link>`.

---

## 5. Quy tắc tài liệu theo tệp

- `domains/<context>/README.md`: ngắn gọn — context chịu trách nhiệm gì, sở hữu gì, không sở hữu gì, những context nào cần biết nó, các canonical documents trong thư mục, vị trí ADR index. Không bao giờ restatement nội dung của `domain-model.md`.
- `domains/<context>/domain-model.md`: canonical location của business knowledge. Các phần chuẩn: purpose and scope, ubiquitous language, concepts and relations, aggregates/entities/value objects (nơi áp dụng), business lifecycle và state transitions, policies/rules/invariants, actors/authority/business permissions, domain events và semantic contracts, business exceptions/correction/compensation, undecided business points. Chỉ tạo khi có đủ domain knowledge đáng để viết; số section không bắt buộc đồng nhất giữa các context; không bao giờ là technical architecture document.
- Ràng buộc catalog: không có cột deploy-unit/Nx-project/Pulumi mapping; không có decision register sao chép ADR index. Thành phần không phải bounded context đã thuộc §3 — không lặp.
