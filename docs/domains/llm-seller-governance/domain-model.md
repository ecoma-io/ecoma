# LLM Seller Governance — Domain Model

Bounded context `llm-seller-governance`: restriction và evaluation, appeal lifecycle, verification/onboarding, legal profile, tax profile, evidence reference, first-party legal principal và association, và operational eligibility của Seller. Tách từ bounded context `llm-seller` theo [ADR-0018](./adr/0018-seller-bounded-context-split.md).

## 1. Phạm vi và ranh giới

`llm-seller-governance` sở hữu **restriction, appeal, verification case, legal profile, tax profile, evidence reference, first-party legal principal và principal association, và operational eligibility** của Seller trong hệ sinh thái LLM. Nó là nguồn sự thật cho trạng thái vận hành và các quyết định platform reviewer về Seller.

| Sở hữu                                                                                                                                                                                                      | Không sở hữu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restriction record · restriction evaluation · appeal · verification case · legal profile · tax profile · evidence reference · first-party legal principal + principal association · operational eligibility | Danh tính account/credential/MFA (`account`) · giao thức OAuth (`auth`) · Seller tenant/ownership/membership/grant/authorization ladder (`llm-seller-tenant`) · Consumer tenant/workspace (`llm-consumer-tenant`) · offer/capability/endpoint/pool/provider credential (`llm-marketplace`) · customer pricing (`llm-seller-pricing`) · ledger/charge/payable/settlement/withholding/accounting (`llm-financial`) · payout (`payout`) · fiat payment transaction (`payment`) · nội dung permission catalog và entitlement (`staff-access`) |

- `sub` là tham chiếu opaque, **không FK** sang `db-account`/`db-auth`.
- Governance **được phép** phụ thuộc một chiều vào `llm-seller-tenant` để tham chiếu tenant/membership; chiều ngược lại bị cấm ([ADR-0018](./adr/0018-seller-bounded-context-split.md)). Context này **không** import implementation của tenant trong domain library; nó nhận tenant/membership như dữ liệu đầu vào.
- Seller tenant **không** có cột lifecycle `status`, `archivedAt` hay `deletedAt`; restriction không tạo ra lifecycle state.

## 2. Ngôn ngữ dùng chung

| Thuật ngữ                   | Ý nghĩa                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restriction                 | Bản ghi hạn chế độc lập, mỗi record có vòng đời riêng; "đang bị hạn chế" là giá trị suy ra tại thời điểm đánh giá, không phải trạng thái được lưu.                                                                                                                                                                                                                         |
| Appeal                      | Khiếu nại của Seller đối với một restriction, có vòng đời và deadline tường minh, do platform reviewer có thẩm quyền quyết định.                                                                                                                                                                                                                                           |
| Verification case           | Verification case cho từng loại yêu cầu, giữ lịch sử submission/rejection/resubmission.                                                                                                                                                                                                                                                                                    |
| Legal profile / tax profile | Hồ sơ pháp lý/thuế của Seller, versioned, append-only, kỳ hiệu lực suy ra từ thứ tự version.                                                                                                                                                                                                                                                                               |
| Evidence reference          | Metadata và tham chiếu bất biến tới tài liệu evidence. Domain không giữ nội dung tài liệu.                                                                                                                                                                                                                                                                                 |
| Operational eligibility     | Verdict duy nhất về việc Seller có đủ điều kiện vận hành hay không, suy ra từ restriction + verification + profile version hiệu lực.                                                                                                                                                                                                                                       |
| Legal principal             | Tổ chức chịu trách nhiệm pháp lý/thuế cho provider first-party — Ecoma-io; được ghi thành bản ghi authoritative trong chính context này (§3.8), không phải pháp nhân của tenant hay bounded context dùng chung → [ADR-0027](../llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md) §3.                                                 |
| FirstPartyLegalPrincipal    | Bản ghi authoritative của principal pháp lý first-party: legal/tax profile versions + `status` (`active` \| `reverification_required` \| `blocked`) + audit; mỗi Seller tenant first-party liên kết qua đúng một association pin accepted revisions (§3.8) → [ADR-0027](../llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md) §3, §5. |

## 3. Business concepts

### 3.1 RestrictionRecord

- `id`, `tenantId`, `policy`, `publicReason`, `internalReason`, `scope`, `activatesAt`, `expiresAt` (hoặc không hạn), `liftedAt` (hoặc chưa lift), `appealDeadline` (hoặc không có).
- Nhiều record độc lập cho một tenant; mỗi record có vòng đời riêng. Lift/expire record này không đụng record khác.
- `policy` là **định danh mở**, không phải enum của domain; domain không liệt kê lý do billing/compliance/security/administrative.
- **`publicReason` và `internalReason` là hai field tách biệt.** `publicReason` được phép xuất hiện trong public projection/contract cho Seller. `internalReason` chỉ nằm trong domain state và audit nội bộ; không được đưa vào bất kỳ public contract, projection, event hay error.
- `scope` xác định phạm vi chặn: tenant hoặc một capability cụ thể. Capability ở đây là **định danh mở** do caller cấu hình; domain không tự sinh danh sách.
- Financial settlement hold **không phải** restriction: hold thuộc `llm-financial`/`payout` và không được model lại ở đây ([ADR-0007](../llm-financial/adr/0007-seller-settlement-holds.md)).

### 3.2 Appeal

- `id`, `tenantId`, `restrictionId`, `submittedBy` (`sub`), `submittedAt`, `status`, `reviewedAt`, `reviewedBy` (reviewer `sub`), `decidedAt`, `decidedBy` (reviewer `sub`), `decisionReason`, `publicDecisionReason`.
- Mỗi appeal trỏ **đúng một** restriction; một restriction có thể có nhiều appeal theo thời gian (sau một quyết định reject, Seller có thể appeal lại trong hạn mới nếu chính sách cho phép — policy đó chưa chốt).
- Appeal không tự thay đổi restriction. Chỉ một **decision operation** có thẩm quyền mới lift restriction; hai thao tác là hai domain operation riêng.
- `decidedBy` phải là platform reviewer đã được xác thực — domain không tự đánh giá thẩm quyền ngoài việc từ chối khi thiếu actor.

### 3.3 VerificationCase

- `id`, subject (`tenantId` **hoặc** `principalId` — đúng một trong hai; case principal-scoped phục vụ principal pháp lý first-party, §3.8), `type` (định danh mở, ví dụ `legal-identity`, `tax`), `status` (`draft` | `submitted` | `under_review` | `approved` | `rejected` | `expired`), `createdAt`, `submittedAt`, `reviewedAt`, `reviewedBy`, `decidedAt`, `decidedBy`, `expiresAt`, `publicDecisionReason`, `verifiedProfileVersions` (version profile mà approval đã xác minh, theo trục profile tương ứng của `type` — ví dụ `legal-identity` → legal profile version, `tax` → tax profile version; case principal-scoped pin **version profile của principal**, §3.8; ghi tại thời điểm `approved`, type không gắn trục profile nào thì không có và không thuộc coverage rule — §3.6).
- Mỗi lần submit tạo một **submission record** bất biến kèm evidence reference; resubmit sau reject tạo submission mới trên cùng case, giữ nguyên lịch sử.
- Verification **không** thay đổi sự tồn tại của Seller tenant; nó chỉ thay đổi kết quả đánh giá operational eligibility.
- **Tenant first-party** đạt eligibility qua trục principal: hai type bắt buộc tối thiểu `legal-identity` và `tax` được thực thi bằng **case principal-scoped** (subject là principal — hồ sơ pháp lý/thuế thật của Ecoma-io, nguồn authoritative ngoài sản phẩm; §3.8) chứ không phải case per-tenant; `requiredTypes` là cấu hình của đường provisioning, không phải state domain. Mọi `approved` là quyết định review thật qua `decideVerification` kèm attribution reviewer — classification **không bao giờ** tự động `approved` một case nào; review thật **một lần mỗi revision** của principal và được tái sử dụng bởi mọi tenant first-party liên kết qua association. Approval ghi lại đúng version profile (của principal) đã được review; case không còn phủ version hiện hành thì không còn tính (§3.6, §3.8) → [ADR-0027](../llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md) §4.

### 3.4 SellerLegalProfile và SellerTaxProfile

- **Legal profile**: `legalName`, `legalType` (định danh mở), `jurisdiction`, `registrationReference`, `effectiveFrom`, `recordedAt`, `recordedBy`.
- **Tax profile**: `taxResidency`, `taxIdentifier`, `declarationReference`, `effectiveFrom`, `recordedAt`, `recordedBy`.
- Versioned **append-only**: mỗi thay đổi tạo version mới. Không có thao tác update/delete trên version đã ghi.
- Kỳ hiệu lực của một version là `[effectiveFrom, effectiveFrom của version kế tiếp)`; version cuối cùng mở. Domain không cho phép tạo version có `effectiveFrom` không tăng nghiêm ngặt.
- Danh mục `legalType`, `taxResidency` là **định danh mở**: domain không hardcode danh mục pháp lý/thuế và không suy diễn rate.
- **Phân đường theo classification:** hồ sơ tenant-scoped ở trên là đường **customer**. Tenant `first_party` **không** mang legal/tax profile version riêng — danh tính pháp lý/thuế của nó là **profile versions authoritative của `FirstPartyLegalPrincipal`** mà association của tenant trỏ tới (§3.8); evidence reference trên principal trỏ tới bản authoritative ngoài sản phẩm, không có tham chiếu cross-tenant nào được tạo. Trên một tenant `first_party`, dữ liệu profile/case `legal-identity`/`tax` kiểu tenant-scoped là **bất nhất** ⇒ fail-closed (§3.6). Revision mới của principal ⇒ mọi tenant liên kết tự rời khỏi eligibility cho tới khi revision đó được approved và tenant accept (§3.8) → [ADR-0027](../llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md) §3, §5.

### 3.5 EvidenceReference

- `evidenceId`, `tenantId`, `kind` (định danh mở), `storageRef` (opaque, bất biến), `contentHash` (opaque), `recordedAt`, `recordedBy`.
- Domain **không** giữ nội dung tài liệu, không sinh URL, không đọc storage. `storageRef` là tham chiếu do infrastructure provider cấp và không bao giờ bị sửa.
- Evidence reference gắn **đúng một** Seller tenant; tham chiếu evidence của tenant khác bị từ chối.

### 3.6 Operational eligibility và verdict contract

`deriveOperationalEligibility` là hàm thuần của `(tenantId, tenantClassification, restrictions, cases, requiredTypes, legalProfileVersions, taxProfileVersions, principalAssessment, now)` — application layer cung cấp snapshot đánh giá đầy đủ, authoritative; hàm không tự đọc database/network (`principalAssessment` xem §3.8):

- Eligible khi restriction không chặn (`blocked === false`, `unevaluable === false`, đánh giá đúng tenant và cho target `tenant`), onboarding complete, và có legal + tax profile version hiệu lực tại `now` — trên đường customer. Classification chỉ dùng để **chọn đường bắt buộc**: `customer` đi đúng đường trên (`principalAssessment` phải `null` — khác `null` ⇒ ineligible, blocker `verification`, không được bỏ qua); `first_party` đòi **principal-wide rule** (§3.8) — association hợp lệ, principal `active`, approved coverage còn phủ cặp revision hiện hành, accepted revisions của association khớp revision hiện hành — thiếu/lệch/bất nhất/blocked ⇒ ineligible (blocker `verification`), fail-closed. Classification không bao giờ là nguồn exemption; tenant `first_party` mang dữ liệu profile/case `legal-identity`/`tax` tenant-scoped là bất nhất ⇒ ineligible.
- **Coverage rule:** một case `approved` chỉ được tính cho type bắt buộc khi `verifiedProfileVersions` của nó còn khớp version profile **hiệu lực tại `now`** trên trục tương ứng (case tenant-scoped so với profile tenant; case principal-scoped so với **revision hiện hành của principal** — §3.8); case thiếu pin hoặc pin lệch version không được tính (fail-closed) — không có approved case nào "vẫn giàu hiệu lực" trên facts đã đổi. Rule chỉ áp cho type gắn trục profile; type không gắn trục profile nào không có pin và không thuộc rule — approval còn tính theo trạng thái `approved`, đến `expired` mới mất. Version mới của legal profile chỉ ép re-verification trục `legal-identity`; version mới của tax profile chỉ ép trục `tax` — profile không đổi không gây re-verification không cần thiết.
- Kết quả mang danh sách `blockers` (`restriction` | `verification` | `legal_profile` | `tax_profile`) để consumer hiển thị và audit; mọi failure trên trục principal (thiếu association, principal không `active`, coverage không phủ revision hiện hành, accepted lệch revision) ánh vào blocker `verification` — không có blocker mới.
- Không lưu kết quả thành status. Consumer (marketplace, financial, payout) nhận verdict qua contract/projection; caching là quyết định của application và **phải có freshness bound** — mọi quyết định eligibility-gated chỉ dùng verdict còn trong bound; sau khi principal bị invalidate (§3.8, [ADR-0027](../llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md) §5), mọi derive mới cho tenant liên kết trả `eligible: false`, nên bound là thứ giới hạn thời gian một verdict cũ còn authorize được — verdict assess trước publish nhưng còn trong bound vẫn authorize được cho tới khi hết bound.
- Marketplace, Routing và Financial tiêu thụ eligibility/restriction verdict như **giá trị hợp đồng**; chúng không đọc evidence pháp lý, không tự diễn giải restriction record, và không tự suy ra eligibility từ verification case (ADR-0018 §3). Riêng Financial tiêu thụ thêm **trạng thái association/principal** do Application cấp theo freshness bound — giá trị hợp đồng dùng cho điều kiện entitlement payable, không phải serving eligibility (ADR-0028 §7.1); Financial không đọc governance storage.

Giá trị suy ra (không lưu trạng thái):

| Giá trị suy ra                           | Suy từ                                                                                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Restriction đang hiệu lực của một target | tập `RestrictionRecord` + `now` + policy definitions (cửa sổ nửa mở)                                                                                                                                                                       |
| Operational eligibility của tenant       | restriction evaluation + verification outcome còn phủ version hiệu lực + presence của legal/tax profile version hiệu lực (đường **customer**); tenant `first_party`: principal-wide rule (§3.8) **thay** đường profile tenant — không cộng |
| Onboarding hoàn tất                      | operational eligibility đạt **và** các verification case bắt buộc ở `approved` còn phủ version hiệu lực; tenant `first_party`: coverage tính trên revision hiện hành của principal (§3.8)                                                  |
| Owner hiện tại                           | thuộc tính `owner` trên `SellerTenant` (không suy từ grant) — sở hữu bởi `llm-seller-tenant`                                                                                                                                               |

Không được lưu các giá trị này thành cột trạng thái thứ hai.

### 3.7 Restriction và appeal model

- **Không có nguồn sự thật thứ hai.** "Đang bị hạn chế" là giá trị **suy ra** từ tập record tại `now`; không có cột `status = restricted`.
- **Cửa sổ hiệu lực nửa mở** `[activatesAt, expiresAt)`: hiệu lực tại đúng `activatesAt`, hết tại đúng `expiresAt`. `liftedAt` có hiệu lực khi `liftedAt <= now`; một lần lift đặt lịch tương lai chưa có tác dụng.
- **Scope**: record scope tenant chặn toàn tenant; record scope capability chỉ chặn capability đó. Record tenant scope luôn chặn mọi capability.
- **Đánh giá deterministic**: target bị chặn khi tồn tại ít nhất một record hiệu lực, áp dụng cho target, với policy restrictive. Policy không có trong cấu hình ⇒ coi là restrictive và đánh dấu evaluation `unevaluable`; cả `blocked` và `unevaluable` ⇒ deny.
- **Tách public/internal**: error domain, public projection và event chỉ mang `publicReason` và mã restriction ổn định. `internalReason` chỉ được trả cho surface nội bộ có thẩm quyền (application layer quyết định), không bao giờ nằm trong object mà Seller đọc được.
- **Appeal deadline**: record có thể mang `appealDeadline`. Appeal submit sau deadline bị từ chối; nếu record không có deadline thì appeal policy chưa chốt và domain **không** tự áp deadline (§8).
- **Lift**: lift là domain operation riêng, đặt `liftedAt`; không xoá record. Lift record này không làm yếu record khác.
- **Financial hold độc lập**: settlement/account hold của `llm-financial` không tạo restriction và không bị tạo bởi restriction; không chặn login/publishing (ADR-0007 của `llm-financial`).

### 3.8 FirstPartyLegalPrincipal và principal association

Nguồn sự thật authoritative cho danh tính pháp lý/thuế của principal pháp lý first-party (Ecoma-io) — nơi phát biểu chính tắc của cơ chế, [ADR-0027](../llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md) §3, §5:

- **`FirstPartyLegalPrincipal`**: `principalId` (opaque, ổn định), legal/tax profile versions authoritative (cùng cơ chế append-only, `effectiveFrom` tăng nghiêm ngặt, kỳ hiệu lực suy ra như §3.4), `status`, evidence reference trỏ tới hồ sơ authoritative ngoài sản phẩm, và audit actor/time cho mọi thao tác. Không sở hữu tenant lifecycle/membership/owner/account/credential/offer; không phải aggregate tổ chức xuyên sản phẩm (ADR-0026 §5 giữ nguyên).
- **Evidence trên trục principal không gắn một Seller tenant**: evidence của case principal-scoped gắn vào chính `FirstPartyLegalPrincipal` record, trỏ tới hồ sơ authoritative ngoài sản phẩm (§3.4); rule "gắn đúng một tenant" và `assertEvidenceInTenant` của §3.5 áp cho case subject tenant.
- **Principal association**: `tenantId`, `principalId`, `acceptedLegalProfileVersion`, `acceptedTaxProfileVersion`, actor/time ghi thiết lập và lần accept cuối. Đúng một association cho mỗi tenant `first_party`; tenant `customer` không có association. Thiết lập chỉ qua bề mặt provisioning có kiểm soát (dữ liệu đầu vào của domain, ADR-0020 Quyết định 3); không có operation reassignment hay đổi principal trong model MVP; Seller Tenant Owner authority của `llm-seller-tenant` không chạm governance records.
- **`status` và transition**: `active | reverification_required | blocked`. Ghi revision mới vào principal (legal hoặc tax) ⇒ `reverification_required`, **đồng bộ trong cùng thao tác publish revision** — không phải job nền; case principal-scoped mới `approved` còn phủ cặp revision hiện hành ⇒ `active`; block bởi quyết định có thẩm quyền (từ `active`/`reverification_required`) ⇒ `blocked`; unblock ⇒ `reverification_required` (không bao giờ `active` trực tiếp). Case principal-scoped `expired` làm mất coverage ⇒ eligibility fail-closed như mọi loss-of-coverage khác.
- **`principalAssessment` cho derivation (§3.6)**: snapshot do application layer lắp từ durable state — principal (`principalId`, `status`, legal/tax profile versions hiện hành, approved coverage per trục) + association (hoặc `null`). Domain kiểm shape như `RestrictionEvaluation`; lệch shape, thiếu, hoặc không đọc được ⇒ ineligible, blocker `verification`. Hiện diện dữ liệu profile/case `legal-identity`/`tax` tenant-scoped trên tenant `first_party` cũng ⇒ ineligible (bất nhất, single source).
- **Acceptance**: `acceptPrincipalRevision` chỉ được nhận khi principal `active` và approved coverage phủ **đúng** cặp revision được accept; acceptance không đụng restriction hay dữ liệu tenant khác; audit giữ actor/time.

## 4. Business operations

Domain library `libs/llm-seller-governance-domain` là pure TypeScript:

- Không database/ORM, không HTTP/network, không Cloudflare Workers API, không filesystem, không đọc clock (`Date.now()`), không randomness, không global mutable state.
- Mọi thời gian là epoch millis **do caller truyền**; mọi định danh **do caller cấp** (trừ `version` của profile, do domain tăng đơn điệu).
- Không import từ Nx project khác; không tái sử dụng business logic của `llm-consumer-tenant-domain` hay `llm-seller-tenant-domain`. Tenant/membership được nhận như dữ liệu đầu vào, không import type từ tenant library (ADR-0018).
- Kết quả là `LlmSellerGovernanceResult` (`ok` / `error`); dữ liệu hỏng trả domain error, không ném exception. Chỉ `create*Id` ném `TypeError` khi lập trình sai.
- Mọi giá trị trả về được `Object.freeze`; input không bị mutate.

| Operation                                 | Mục đích                                                                                                                                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createRestrictionRecord`                 | Tạo restriction record frozen.                                                                                                                                                                                  |
| `isRestrictionEffective`                  | Kiểm tra record có hiệu lực tại `now` (cửa sổ nửa mở).                                                                                                                                                          |
| `evaluateRestrictions`                    | Đánh giá tập record theo target, trả `RestrictionEvaluation`.                                                                                                                                                   |
| `liftRestriction`                         | Đặt `liftedAt` trên record; không xoá record.                                                                                                                                                                   |
| `submitAppeal`                            | Tạo appeal status `submitted` cho restriction trong đúng tenant.                                                                                                                                                |
| `startAppealReview`                       | Đặt appeal vào `under_review` bởi reviewer.                                                                                                                                                                     |
| `decideAppeal`                            | Quyết định `accepted` hoặc `rejected`; không tự thay đổi restriction.                                                                                                                                           |
| `withdrawAppeal`                          | Rút appeal trước khi có quyết định.                                                                                                                                                                             |
| `createVerificationCase`                  | Tạo case `draft` với subject (`tenantId` **hoặc** `principalId` — đúng một, §3.3) và `type` hợp lệ; case principal-scoped phục vụ principal pháp lý first-party (§3.8).                                         |
| `submitVerificationCase`                  | Tạo submission bất biến kèm evidence reference; case `submitted`.                                                                                                                                               |
| `startVerificationReview`                 | Đặt case vào `under_review`.                                                                                                                                                                                    |
| `decideVerification`                      | Quyết định `approved` hoặc `rejected`; khi `approved` ghi `verifiedProfileVersions` (version hiệu lực tại `decidedAt` theo trục của `type`; case principal-scoped pin revision hiện hành của principal — §3.8). |
| `expireVerificationCase`                  | Đặt case vào `expired` (chỉ từ `approved`).                                                                                                                                                                     |
| `deriveOnboardingState`                   | suy ra `{ complete, pendingTypes, issues }` từ cases.                                                                                                                                                           |
| `deriveOperationalEligibility`            | suy ra `{ eligible, blockers }`.                                                                                                                                                                                |
| `appendLegalProfileVersion`               | Tạo version mới `version = last + 1`; `effectiveFrom` tăng nghiêm ngặt.                                                                                                                                         |
| `legalProfileVersionAt`                   | Lấy version hiệu lực tại thời điểm.                                                                                                                                                                             |
| `appendTaxProfileVersion`                 | tương tự legal.                                                                                                                                                                                                 |
| `taxProfileVersionAt`                     | lấy version hiệu lực tại thời điểm.                                                                                                                                                                             |
| `createFirstPartyLegalPrincipal`          | Tạo principal record kèm revision hồ sơ pháp lý/thuế đầu tiên, status `reverification_required` lúc tạo — chưa có approved coverage nào, `active` chỉ đạt sau (§3.8).                                           |
| `appendPrincipalLegalProfileVersion`      | Ghi revision legal mới của principal ⇒ `reverification_required` đồng bộ trong cùng thao tác (§3.8).                                                                                                            |
| `principalLegalProfileVersionAt`          | Lấy revision legal hiện hành của principal tại thời điểm.                                                                                                                                                       |
| `appendPrincipalTaxProfileVersion`        | tương tự legal trên trục tax (§3.8).                                                                                                                                                                            |
| `principalTaxProfileVersionAt`            | lấy revision tax hiện hành tại thời điểm.                                                                                                                                                                       |
| `establishFirstPartyPrincipalAssociation` | Thiết lập association tenant `first_party` → principal với accepted revisions được approved coverage phủ; đúng một association cho tenant (§3.8).                                                               |
| `acceptPrincipalRevision`                 | Cập nhật accepted revisions của association lên cặp revision hiện hành; đòi principal `active` và coverage phủ đúng cặp đó (§3.8).                                                                              |
| `blockLegalPrincipal`                     | Quyết định có thẩm quyền đặt principal `blocked` ⇒ mọi tenant liên kết ineligible (§3.8).                                                                                                                       |
| `unblockLegalPrincipal`                   | Đặt principal về `reverification_required`; `active` lại chỉ qua approved coverage của revision hiện hành (§3.8).                                                                                               |
| `createEvidenceReference`                 | Tạo evidence reference frozen, gắn đúng một tenant.                                                                                                                                                             |
| `assertEvidenceInTenant`                  | Kiểm tra evidence thuộc đúng tenant.                                                                                                                                                                            |

`evaluateRestrictions` áp dụng record theo target: target tenant chỉ nhận record tenant-scope; target capability nhận record tenant-scope **và** record capability trùng tên. Policy không có trong `policies` ⇒ restrictive **và** `unevaluable = true`.

`submitAppeal` nhận `tenant` và `memberships` như **dữ liệu đầu vào** để kiểm tra actor là owner hoặc member active; context này không import tenant library.

`deriveOnboardingState`: `complete` khi mọi `type` bắt buộc có **ít nhất một** case `approved` **còn phủ** version profile hiệu lực tại `now` (§3.6 coverage rule; tenant `first_party`: coverage tính trên revision hiện hành của principal qua association — §3.8); `issues` chỉ báo `type` khi case **mới nhất** (`createdAt` lớn nhất) của type đó đang `rejected` — resubmit sau reject không còn mang issue cũ. `deriveOperationalEligibility`: eligible khi restriction không chặn (`blocked === false`, `unevaluable === false`, đánh giá đúng tenant và cho target `tenant`), onboarding complete, và có legal + tax profile version hiệu lực tại `now` (đường customer); tenant `first_party` thay đường profile tenant bằng principal-wide rule §3.8, fail-closed. Không lưu kết quả thành status.

Kỳ hiệu lực suy ra: version `i` hiệu lực trong `[effectiveFrom_i, effectiveFrom_{i+1})`; version cuối không có cận trên. Domain không có thao tác update/delete version.

## 5. Invariants

1. **Restriction độc lập.** Lift/expire một record không thay đổi record khác; `evaluateRestrictions` là hàm thuần của `(records, policies, target, now)`.
2. **Restriction trước owner.** `blocked`/`unevaluable` deny kể cả owner; ladder tiêu thụ evaluation nằm ở `llm-seller-tenant`.
3. **Public/internal tách biệt.** `internalReason` và `decisionReason` không bao giờ xuất hiện trong `PublicRestriction`/`PublicAppeal` hay trong error object.
4. **Profile append-only.** Không mutation version; `effectiveFrom` tăng nghiêm ngặt; kỳ hiệu lực suy ra, không lưu cờ `current`.
5. **Verification không tạo tenant.** Verification chỉ đổi trạng thái case; không có operation nào tạo/xoá Seller tenant từ verification.
6. **Evidence bất biến và cùng tenant.** `storageRef`/`contentHash` không bị sửa; evidence cross tenant bị từ chối (rule cùng tenant áp cho evidence gắn tenant; evidence của `FirstPartyLegalPrincipal` record không gắn tenant — §3.8).
7. **Eligibility là giá trị suy ra.** Không lưu `eligible`/`onboarding-complete` thành cột trạng thái.
8. **Determinism.** Không hàm nào đọc clock/random; cùng input ⇒ cùng output.
9. **Approval còn tính khi còn phủ version.** Case `approved` chỉ được tính cho onboarding/eligibility khi `verifiedProfileVersions` khớp version profile hiệu lực tại `now` trên trục tương ứng (case principal-scoped: revision hiện hành của principal); thiếu pin hoặc pin lệch version ⇒ không tính (fail-closed). Rule không áp cho type không gắn trục profile (không có pin, tính theo trạng thái `approved` đến `expired`). Việc append version không đổi case; nó chỉ đổi việc case có còn được tính hay không.
10. **Principal-wide fail-closed.** Eligibility của tenant `first_party` đòi principal-wide rule (§3.8): `principalAssessment` đủ và nhất quán, principal `active`, approved coverage phủ cặp revision hiện hành, accepted revisions của association khớp revision hiện hành. Thiếu, stale, blocked hay bất nhất ⇒ ineligible với blocker `verification`; một case/approval cũ của tenant **không bao giờ** thỏa mãn revision mới của principal; việc ghi revision mới và chuyển `reverification_required` là một thao tác đồng bộ — fan-out per-tenant không phải cơ chế bảo đảm.
11. **Single source trên trục principal.** Tenant `first_party` không mang legal/tax profile version hay case `legal-identity`/`tax` tenant-scoped — dữ liệu kiểu đó ⇒ bất nhất, fail-closed; association đúng một cho tenant, không có operation reassignment trong model MVP, và Seller Tenant Owner authority không chạm governance records.

## 6. Error taxonomy

Một error chỉ mang `code` + `message` (tiếng Anh), không mang identifier, reason nội bộ hay payload. `LLM_SELLER_GOVERNANCE_DOMAIN_ERROR_MESSAGES` và cả hai nhánh `LlmSellerGovernanceResult` đều frozen; factory ném `TypeError` với code ngoài taxonomy; guard dùng `Object.hasOwn` **và** đòi `message` khớp nguyên văn bảng chuẩn, nên một object tự đặt message không qua guard.

Nhóm mã:

- **Định danh/validate:** `invalid_seller_tenant_id`, `invalid_actor`, `invalid_timestamp`, `invalid_restriction_id`, `invalid_restriction_record`, `invalid_restriction_window`, `invalid_appeal_id`, `invalid_appeal_record`, `invalid_verification_case_id`, `invalid_evidence_id`, `invalid_evidence_reference`, `invalid_profile_version`, `invalid_profile_field`, `invalid_effective_from`.
- **Ngữ cảnh:** `ambiguous_context`, `inconsistent_context`.
- **Restriction:** `duplicate_restriction_id`, `restriction_already_lifted`, `restriction_not_effective`, `restriction_not_in_tenant`.
- **Appeal/decision:** `duplicate_appeal_id`, `appeal_deadline_passed`, `appeal_actor_not_eligible`, `invalid_appeal_transition`, `invalid_decision`, `invalid_decision_reason`, `missing_public_decision_reason`.
- **Verification/evidence:** `duplicate_verification_case_id`, `invalid_verification_case`, `invalid_verification_type`, `invalid_submission_id`, `duplicate_submission_id`, `invalid_verification_transition`, `evidence_missing`, `duplicate_evidence`, `evidence_not_in_tenant`, `duplicate_evidence_reference_id`.
- **Profile:** `effective_from_not_increasing`.
- **Principal/association:** `invalid_legal_principal_id`, `duplicate_legal_principal_id`, `invalid_legal_principal`, `invalid_principal_status_transition`, `invalid_principal_association`, `duplicate_principal_association`, `principal_association_not_in_tenant`, `principal_revision_not_verified`, `principal_not_active`.

## 7. State transition

Restriction: `∅ → scheduled|effective` (tạo; hiệu lực suy ra từ `activatesAt`) · `→ lifted` (đặt `liftedAt`; `lifted` là _giá trị suy ra_, record không có cột status).
Appeal: `∅ → submitted` · `submitted → under_review` · `under_review → accepted|rejected` · `submitted|under_review → withdrawn`; `accepted|rejected|withdrawn` terminal.
Verification case: `∅ → draft` · `draft|rejected → submitted` (resubmission giữ submission cũ) · `submitted → under_review` · `under_review → approved|rejected` · `approved → expired`; `expired` terminal, không case nào quay lại `draft`.
FirstPartyLegalPrincipal status: `∅ → reverification_required` (tạo record kèm revision hồ sơ đầu tiên qua bề mặt provisioning — chưa có approved coverage nào, fail-closed) · `active → reverification_required` (append revision mới — đồng bộ với publish) · `reverification_required → active` (approved coverage mới còn phủ revision hiện hành) · `active|reverification_required → blocked` (quyết định có thẩm quyền) · `blocked → reverification_required` (unblock; không bao giờ `blocked → active` trực tiếp).

Không transition nào khác được phép; mọi transition sai trả `invalid_appeal_transition` / `invalid_verification_transition` (hoặc mã tương ứng của entity).

## 8. Quyết định chưa chốt

### 8.1 Vòng đời pháp lý của dữ liệu

Archive, termination, deletion, retention, legal hold, export, anonymization và physical deletion **chưa chốt** ([ADR-0008](./adr/0008-data-lifecycle-deferred.md)). Domain không có transition `deleted`/`archived`.

### 8.2 Danh mục legal type, tax residency và tax treatment

Danh mục pháp lý/thuế, withholding rate, taxable basis và revenue recognition **chưa chốt** ([`llm-financial/adr/0008`](../llm-financial/adr/0008-seller-tax-profile.md) ghi OPEN). Domain giữ `legalType`, `taxResidency` như định danh mở và **không** tính tax.

### 8.3 Thẩm quyền reviewer và separation of duties

Catalog reviewer role, yêu cầu bốn-mắt hay escalation **chưa chốt**. Domain chỉ bắt buộc có actor quyết định và giữ audit. Thẩm quyền actor cho các principal operation (`acceptPrincipalRevision`, `blockLegalPrincipal`, `unblockLegalPrincipal`) và cho thiết lập association: **chưa chốt** — [ADR-0027](../llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md) §4, §5.

### 8.4 Chính sách restriction và appeal

- Tập policy restrictive và ngữ nghĩa từng policy: chưa chốt.
- Thời hạn appeal mặc định khi record không mang `appealDeadline`: chưa chốt.
- Số lần appeal lại sau reject và điều kiện mở appeal mới: chưa chốt.
- Verification expiry window: chưa chốt.

Domain không hardcode các giá trị này; chúng là input cấu hình của caller.

### 8.5 Public seller prefix và định danh công khai

Prefix/định danh công khai của Seller cho **mọi seller** vẫn **chưa chốt**; nếu chốt phải xét unique/immutable. Domain không định nghĩa trường này. Riêng provider first-party, danh tính công khai đã chốt là **tên tenant first-party** của nó (`dronie` đầu tiên), unique và bất biến theo contract tenant name → [ADR-0027](../llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md) §7.

### 8.6 Evidence retention và storage provider

Retention của evidence, storage provider, cơ chế ký/URL tạm thời **chưa chốt**; domain chỉ giữ `storageRef`/`contentHash` bất biến.

## 9. Failure / correction

- Không đánh giá được restriction hay verification ⇒ fail closed, không leak dữ liệu.
- Migration: forward-fix only; correction ưu tiên forward-fix hơn rollback dữ liệu.
- Lift và quyết định appeal phải nguyên tử ở persistence boundary.

## 10. Tài liệu

| Document          | Nội dung                                                               |
| ----------------- | ---------------------------------------------------------------------- |
| `domain-model.md` | Business model, rules, invariants, business operations, error taxonomy |
| `adr/`            | ADR index của bounded context                                          |

ADR `0003`, `0004`, `0006`, `0008` thuộc context này theo phân chia của [ADR-0018](./adr/0018-seller-bounded-context-split.md); nội dung quyết định không đổi khi chuyển context.

Quyết định thuộc context khác, không nhân bản tại đây:

- [`llm-seller-tenant/adr/`](../llm-seller-tenant/adr/README.md) — tenant ownership, tenant existence tách khỏi eligibility, membership grant và permission identifier boundary.
- [`llm-consumer-tenant/adr/0019`](../llm-consumer-tenant/adr/0019-llm-scope-ownership-and-dependency-matrix.md) — ba Nx scope `llm-consumer` / `llm-seller` / `llm-shared` và dependency matrix.
- [`llm-financial/adr/0007`](../llm-financial/adr/0007-seller-settlement-holds.md) — settlement hold ≠ Seller restriction.
- [`llm-financial/adr/0008`](../llm-financial/adr/0008-seller-tax-profile.md) — ownership split seller legal/tax profile vs tax calculation.
