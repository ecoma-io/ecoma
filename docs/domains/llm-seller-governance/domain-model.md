# LLM Seller Governance — Domain Model

Bounded context `llm-seller-governance`: restriction và evaluation, appeal lifecycle, verification/onboarding, legal profile, tax profile, evidence reference và operational eligibility của Seller. Tách từ bounded context `llm-seller` theo [ADR-0018](./adr/0018-seller-bounded-context-split.md).

## 1. Phạm vi và ranh giới

`llm-seller-governance` sở hữu **restriction, appeal, verification case, legal profile, tax profile, evidence reference và operational eligibility** của Seller trong hệ sinh thái LLM. Nó là nguồn sự thật cho trạng thái vận hành và các quyết định platform reviewer về Seller.

| Sở hữu                                                                                                                                                | Không sở hữu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restriction record · restriction evaluation · appeal · verification case · legal profile · tax profile · evidence reference · operational eligibility | Danh tính account/credential/MFA (`account`) · giao thức OAuth (`auth`) · Seller tenant/ownership/membership/grant/authorization ladder (`llm-seller-tenant`) · Consumer tenant/workspace (`llm-consumer-tenant`) · offer/capability/endpoint/pool/provider credential (`llm-marketplace`) · customer pricing (`llm-seller-pricing`) · ledger/charge/payable/settlement/withholding/accounting (`llm-financial`) · payout (`payout`) · fiat payment transaction (`payment`) · nội dung permission catalog và entitlement (`staff-access`) |

- `sub` là tham chiếu opaque, **không FK** sang `db-account`/`db-auth`.
- Governance **được phép** phụ thuộc một chiều vào `llm-seller-tenant` để tham chiếu tenant/membership; chiều ngược lại bị cấm ([ADR-0018](./adr/0018-seller-bounded-context-split.md)). Context này **không** import implementation của tenant trong domain library; nó nhận tenant/membership như dữ liệu đầu vào.
- Seller tenant **không** có cột lifecycle `status`, `archivedAt` hay `deletedAt`; restriction không tạo ra lifecycle state.

## 2. Ngôn ngữ dùng chung

| Thuật ngữ                   | Ý nghĩa                                                                                                                                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restriction                 | Bản ghi hạn chế độc lập, mỗi record có vòng đời riêng; "đang bị hạn chế" là giá trị suy ra tại thời điểm đánh giá, không phải trạng thái được lưu.                                                                                             |
| Appeal                      | Khiếu nại của Seller đối với một restriction, có vòng đời và deadline tường minh, do platform reviewer có thẩm quyền quyết định.                                                                                                               |
| Verification case           | Verification case cho từng loại yêu cầu, giữ lịch sử submission/rejection/resubmission.                                                                                                                                                        |
| Legal profile / tax profile | Hồ sơ pháp lý/thuế của Seller, versioned, append-only, kỳ hiệu lực suy ra từ thứ tự version.                                                                                                                                                   |
| Evidence reference          | Metadata và tham chiếu bất biến tới tài liệu evidence. Domain không giữ nội dung tài liệu.                                                                                                                                                     |
| Operational eligibility     | Verdict duy nhất về việc Seller có đủ điều kiện vận hành hay không, suy ra từ restriction + verification + profile version hiệu lực.                                                                                                           |
| Legal principal             | Tổ chức chịu trách nhiệm pháp lý/thuế cho provider first-party — Ecoma-io; không phải pháp nhân của tenant hay một aggregate riêng → [ADR-0027](../llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md) §3. |

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

- `id`, `tenantId`, `type` (định danh mở, ví dụ `legal-identity`, `tax`), `status` (`draft` | `submitted` | `under_review` | `approved` | `rejected` | `expired`), `createdAt`, `submittedAt`, `reviewedAt`, `reviewedBy`, `decidedAt`, `decidedBy`, `expiresAt`, `publicDecisionReason`, `verifiedProfileVersions` (version profile mà approval đã xác minh, theo trục profile tương ứng của `type` — ví dụ `legal-identity` → legal profile version, `tax` → tax profile version; ghi tại thời điểm `approved`, type không gắn trục profile nào thì không có và không thuộc coverage rule — §3.6).
- Mỗi lần submit tạo một **submission record** bất biến kèm evidence reference; resubmit sau reject tạo submission mới trên cùng case, giữ nguyên lịch sử.
- Verification **không** thay đổi sự tồn tại của Seller tenant; nó chỉ thay đổi kết quả đánh giá operational eligibility.
- **Tenant first-party** đạt eligibility bằng cùng thang này, không exemption: `requiredTypes` tối thiểu là `legal-identity` và `tax` (cấu hình của đường provisioning, không phải state domain); evidence là hồ sơ pháp lý/thuế thật của principal Ecoma-io (nguồn authoritative); mọi `approved` là quyết định review thật qua `decideVerification` kèm attribution reviewer — classification **không bao giờ** tự động `approved` một case nào. Approval ghi lại đúng version profile đã được review; case không còn phủ version hiệu lực thì không còn tính (§3.6, §5.9) → [ADR-0027](../llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md) §4.

### 3.4 SellerLegalProfile và SellerTaxProfile

- **Legal profile**: `legalName`, `legalType` (định danh mở), `jurisdiction`, `registrationReference`, `effectiveFrom`, `recordedAt`, `recordedBy`.
- **Tax profile**: `taxResidency`, `taxIdentifier`, `declarationReference`, `effectiveFrom`, `recordedAt`, `recordedBy`.
- Versioned **append-only**: mỗi thay đổi tạo version mới. Không có thao tác update/delete trên version đã ghi.
- Kỳ hiệu lực của một version là `[effectiveFrom, effectiveFrom của version kế tiếp)`; version cuối cùng mở. Domain không cho phép tạo version có `effectiveFrom` không tăng nghiêm ngặt.
- Danh mục `legalType`, `taxResidency` là **định danh mở**: domain không hardcode danh mục pháp lý/thuế và không suy diễn rate.
- **Provenance của tenant first-party:** profile của một tenant first-party ghi hồ sơ pháp lý/thuế của principal pháp lý Ecoma-io, kèm evidence reference trỏ tới bản authoritative; các tenant first-party khác nhau ghi bản ghi riêng trỏ về cùng nguồn authoritative — không có tham chiếu cross-tenant. Khi hồ sơ principal thay đổi hoặc mất hiệu lực, **mọi** tenant first-party tham chiếu principal đó cần version mới **và re-verification** trên trục tương ứng: version mới được ghi ⇒ case `approved` cũ không còn khớp version hiệu lực ⇒ tự rời khỏi tính onboarding/eligibility (fail-closed, §3.6) cho tới khi có case mới được approved trên version mới. Thiếu version hiệu lực tại `now` ⇒ blocker `legal_profile`/`tax_profile` như thường lệ → [ADR-0027](../llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md) §3, §5.

### 3.5 EvidenceReference

- `evidenceId`, `tenantId`, `kind` (định danh mở), `storageRef` (opaque, bất biến), `contentHash` (opaque), `recordedAt`, `recordedBy`.
- Domain **không** giữ nội dung tài liệu, không sinh URL, không đọc storage. `storageRef` là tham chiếu do infrastructure provider cấp và không bao giờ bị sửa.
- Evidence reference gắn **đúng một** Seller tenant; tham chiếu evidence của tenant khác bị từ chối.

### 3.6 Operational eligibility và verdict contract

`deriveOperationalEligibility` là hàm thuần của `(tenantId, restrictions, cases, requiredTypes, legalProfileVersions, taxProfileVersions, now)`:

- Eligible khi restriction không chặn (`blocked === false`, `unevaluable === false`, đánh giá đúng tenant và cho target `tenant`), onboarding complete, và có legal + tax profile version hiệu lực tại `now`.
- **Coverage rule:** một case `approved` chỉ được tính cho type bắt buộc khi `verifiedProfileVersions` của nó còn khớp version profile **hiệu lực tại `now`** trên trục tương ứng; case thiếu pin hoặc pin lệch version không được tính (fail-closed) — không có approved case nào "vẫn giàu hiệu lực" trên facts đã đổi. Rule chỉ áp cho type gắn trục profile; type không gắn trục profile nào không có pin và không thuộc rule — approval còn tính theo trạng thái `approved`, đến `expired` mới mất. Version mới của legal profile chỉ ép re-verification trục `legal-identity`; version mới của tax profile chỉ ép trục `tax` — profile không đổi không gây re-verification không cần thiết.
- Kết quả mang danh sách `blockers` (`restriction` | `verification` | `legal_profile` | `tax_profile`) để consumer hiển thị và audit.
- Không lưu kết quả thành status. Consumer (marketplace, financial, payout) nhận verdict qua contract/projection; caching là quyết định của application và phải có freshness bound.
- Marketplace, Financial và Routing tiêu thụ eligibility/restriction verdict như **giá trị hợp đồng**; chúng không đọc evidence pháp lý, không tự diễn giải restriction record, và không tự suy ra eligibility từ verification case (ADR-0018 §3).

Giá trị suy ra (không lưu trạng thái):

| Giá trị suy ra                           | Suy từ                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Restriction đang hiệu lực của một target | tập `RestrictionRecord` + `now` + policy definitions (cửa sổ nửa mở)                                                     |
| Operational eligibility của tenant       | restriction evaluation + verification outcome còn phủ version hiệu lực + presence của legal/tax profile version hiệu lực |
| Onboarding hoàn tất                      | operational eligibility đạt **và** các verification case bắt buộc ở `approved` còn phủ version hiệu lực                  |
| Owner hiện tại                           | thuộc tính `owner` trên `SellerTenant` (không suy từ grant) — sở hữu bởi `llm-seller-tenant`                             |

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

## 4. Business operations

Domain library `libs/llm-seller-governance-domain` là pure TypeScript:

- Không database/ORM, không HTTP/network, không Cloudflare Workers API, không filesystem, không đọc clock (`Date.now()`), không randomness, không global mutable state.
- Mọi thời gian là epoch millis **do caller truyền**; mọi định danh **do caller cấp** (trừ `version` của profile, do domain tăng đơn điệu).
- Không import từ Nx project khác; không tái sử dụng business logic của `llm-consumer-tenant-domain` hay `llm-seller-tenant-domain`. Tenant/membership được nhận như dữ liệu đầu vào, không import type từ tenant library (ADR-0018).
- Kết quả là `LlmSellerGovernanceResult` (`ok` / `error`); dữ liệu hỏng trả domain error, không ném exception. Chỉ `create*Id` ném `TypeError` khi lập trình sai.
- Mọi giá trị trả về được `Object.freeze`; input không bị mutate.

| Operation                      | Mục đích                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `createRestrictionRecord`      | Tạo restriction record frozen.                                                                                                               |
| `isRestrictionEffective`       | Kiểm tra record có hiệu lực tại `now` (cửa sổ nửa mở).                                                                                       |
| `evaluateRestrictions`         | Đánh giá tập record theo target, trả `RestrictionEvaluation`.                                                                                |
| `liftRestriction`              | Đặt `liftedAt` trên record; không xoá record.                                                                                                |
| `submitAppeal`                 | Tạo appeal status `submitted` cho restriction trong đúng tenant.                                                                             |
| `startAppealReview`            | Đặt appeal vào `under_review` bởi reviewer.                                                                                                  |
| `decideAppeal`                 | Quyết định `accepted` hoặc `rejected`; không tự thay đổi restriction.                                                                        |
| `withdrawAppeal`               | Rút appeal trước khi có quyết định.                                                                                                          |
| `createVerificationCase`       | Tạo case `draft` cho tenant với `type` hợp lệ.                                                                                               |
| `submitVerificationCase`       | Tạo submission bất biến kèm evidence reference; case `submitted`.                                                                            |
| `startVerificationReview`      | Đặt case vào `under_review`.                                                                                                                 |
| `decideVerification`           | Quyết định `approved` hoặc `rejected`; khi `approved` ghi `verifiedProfileVersions` (version hiệu lực tại `decidedAt` theo trục của `type`). |
| `expireVerificationCase`       | Đặt case vào `expired` (chỉ từ `approved`).                                                                                                  |
| `deriveOnboardingState`        | suy ra `{ complete, pendingTypes, issues }` từ cases.                                                                                        |
| `deriveOperationalEligibility` | suy ra `{ eligible, blockers }`.                                                                                                             |
| `appendLegalProfileVersion`    | Tạo version mới `version = last + 1`; `effectiveFrom` tăng nghiêm ngặt.                                                                      |
| `legalProfileVersionAt`        | Lấy version hiệu lực tại thời điểm.                                                                                                          |
| `appendTaxProfileVersion`      | tương tự legal.                                                                                                                              |
| `taxProfileVersionAt`          | lấy version hiệu lực tại thời điểm.                                                                                                          |
| `createEvidenceReference`      | Tạo evidence reference frozen, gắn đúng một tenant.                                                                                          |
| `assertEvidenceInTenant`       | Kiểm tra evidence thuộc đúng tenant.                                                                                                         |

`evaluateRestrictions` áp dụng record theo target: target tenant chỉ nhận record tenant-scope; target capability nhận record tenant-scope **và** record capability trùng tên. Policy không có trong `policies` ⇒ restrictive **và** `unevaluable = true`.

`submitAppeal` nhận `tenant` và `memberships` như **dữ liệu đầu vào** để kiểm tra actor là owner hoặc member active; context này không import tenant library.

`deriveOnboardingState`: `complete` khi mọi `type` bắt buộc có **ít nhất một** case `approved` **còn phủ** version profile hiệu lực tại `now` (§3.6 coverage rule); `issues` chỉ báo `type` khi case **mới nhất** (`createdAt` lớn nhất) của type đó đang `rejected` — resubmit sau reject không còn mang issue cũ. `deriveOperationalEligibility`: eligible khi restriction không chặn (`blocked === false`, `unevaluable === false`, đánh giá đúng tenant và cho target `tenant`), onboarding complete, và có legal + tax profile version hiệu lực tại `now`. Không lưu kết quả thành status.

Kỳ hiệu lực suy ra: version `i` hiệu lực trong `[effectiveFrom_i, effectiveFrom_{i+1})`; version cuối không có cận trên. Domain không có thao tác update/delete version.

## 5. Invariants

1. **Restriction độc lập.** Lift/expire một record không thay đổi record khác; `evaluateRestrictions` là hàm thuần của `(records, policies, target, now)`.
2. **Restriction trước owner.** `blocked`/`unevaluable` deny kể cả owner; ladder tiêu thụ evaluation nằm ở `llm-seller-tenant`.
3. **Public/internal tách biệt.** `internalReason` và `decisionReason` không bao giờ xuất hiện trong `PublicRestriction`/`PublicAppeal` hay trong error object.
4. **Profile append-only.** Không mutation version; `effectiveFrom` tăng nghiêm ngặt; kỳ hiệu lực suy ra, không lưu cờ `current`.
5. **Verification không tạo tenant.** Verification chỉ đổi trạng thái case; không có operation nào tạo/xoá Seller tenant từ verification.
6. **Evidence bất biến và cùng tenant.** `storageRef`/`contentHash` không bị sửa; evidence cross tenant bị từ chối.
7. **Eligibility là giá trị suy ra.** Không lưu `eligible`/`onboarding-complete` thành cột trạng thái.
8. **Determinism.** Không hàm nào đọc clock/random; cùng input ⇒ cùng output.
9. **Approval còn tính khi còn phủ version.** Case `approved` chỉ được tính cho onboarding/eligibility khi `verifiedProfileVersions` khớp version profile hiệu lực tại `now` trên trục tương ứng; thiếu pin hoặc pin lệch version ⇒ không tính (fail-closed). Rule không áp cho type không gắn trục profile (không có pin, tính theo trạng thái `approved` đến `expired`). Việc append version không đổi case; nó chỉ đổi việc case có còn được tính hay không.

## 6. Error taxonomy

Một error chỉ mang `code` + `message` (tiếng Anh), không mang identifier, reason nội bộ hay payload. `LLM_SELLER_GOVERNANCE_DOMAIN_ERROR_MESSAGES` và cả hai nhánh `LlmSellerGovernanceResult` đều frozen; factory ném `TypeError` với code ngoài taxonomy; guard dùng `Object.hasOwn` **và** đòi `message` khớp nguyên văn bảng chuẩn, nên một object tự đặt message không qua guard.

Nhóm mã:

- **Định danh/validate:** `invalid_seller_tenant_id`, `invalid_actor`, `invalid_timestamp`, `invalid_restriction_id`, `invalid_restriction_record`, `invalid_restriction_window`, `invalid_appeal_id`, `invalid_appeal_record`, `invalid_verification_case_id`, `invalid_evidence_id`, `invalid_evidence_reference`, `invalid_profile_version`, `invalid_profile_field`, `invalid_effective_from`.
- **Ngữ cảnh:** `ambiguous_context`, `inconsistent_context`.
- **Restriction:** `duplicate_restriction_id`, `restriction_already_lifted`, `restriction_not_effective`, `restriction_not_in_tenant`.
- **Appeal/decision:** `duplicate_appeal_id`, `appeal_deadline_passed`, `appeal_actor_not_eligible`, `invalid_appeal_transition`, `invalid_decision`, `invalid_decision_reason`, `missing_public_decision_reason`.
- **Verification/evidence:** `duplicate_verification_case_id`, `invalid_verification_case`, `invalid_verification_type`, `invalid_submission_id`, `duplicate_submission_id`, `invalid_verification_transition`, `evidence_missing`, `duplicate_evidence`, `evidence_not_in_tenant`, `duplicate_evidence_reference_id`.
- **Profile:** `effective_from_not_increasing`.

## 7. State transition

Restriction: `∅ → scheduled|effective` (tạo; hiệu lực suy ra từ `activatesAt`) · `→ lifted` (đặt `liftedAt`; `lifted` là _giá trị suy ra_, record không có cột status).
Appeal: `∅ → submitted` · `submitted → under_review` · `under_review → accepted|rejected` · `submitted|under_review → withdrawn`; `accepted|rejected|withdrawn` terminal.
Verification case: `∅ → draft` · `draft|rejected → submitted` (resubmission giữ submission cũ) · `submitted → under_review` · `under_review → approved|rejected` · `approved → expired`; `expired` terminal, không case nào quay lại `draft`.

Không transition nào khác được phép; mọi transition sai trả `invalid_appeal_transition` / `invalid_verification_transition` (hoặc mã tương ứng của entity).

## 8. Quyết định chưa chốt

### 8.1 Vòng đời pháp lý của dữ liệu

Archive, termination, deletion, retention, legal hold, export, anonymization và physical deletion **chưa chốt** ([ADR-0008](./adr/0008-data-lifecycle-deferred.md)). Domain không có transition `deleted`/`archived`.

### 8.2 Danh mục legal type, tax residency và tax treatment

Danh mục pháp lý/thuế, withholding rate, taxable basis và revenue recognition **chưa chốt** ([`llm-financial/adr/0008`](../llm-financial/adr/0008-seller-tax-profile.md) ghi OPEN). Domain giữ `legalType`, `taxResidency` như định danh mở và **không** tính tax.

### 8.3 Thẩm quyền reviewer và separation of duties

Catalog reviewer role, yêu cầu bốn-mắt hay escalation **chưa chốt**. Domain chỉ bắt buộc có actor quyết định và giữ audit.

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
