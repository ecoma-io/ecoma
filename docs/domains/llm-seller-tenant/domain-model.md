# LLM Seller Tenant — Domain Model

Bounded context `llm-seller-tenant`: Seller tenant, ownership, membership, permission grant và authorization ladder trong Seller tenant. Tách từ bounded context `llm-seller` theo [ADR-0018](../llm-seller-governance/adr/0018-seller-bounded-context-split.md).

## 1. Phạm vi và ranh giới

`llm-seller-tenant` sở hữu **Seller tenant, ownership của tenant, membership, permission grant và authorization ladder** trong hệ sinh thái LLM. Nó là nguồn sự thật cho Seller identity và Seller-side authorization.

| Sở hữu                                                                                         | Không sở hữu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seller tenant · ownership (owner `sub`) · membership · permission grant · authorization ladder | Danh tính account/credential/MFA (`account`) · giao thức OAuth (`auth`) · Consumer tenant/workspace/membership/grant (`llm-consumer-tenant`) · restriction/appeal/verification/legal/tax/evidence/operational eligibility (`llm-seller-governance`) · offer/capability/endpoint/pool/provider credential (`llm-marketplace`) · customer pricing (`llm-seller-pricing`) · ledger/charge/payable/settlement (`llm-financial`) · payout (`payout`) · fiat payment transaction (`payment`) · nội dung permission catalog và entitlement (`staff-access`) |

- `sub` là tham chiếu opaque, **không FK** sang `db-account`/`db-auth`.
- Seller tenant ID và Consumer tenant ID là hai ownership boundary độc lập, **không bao giờ** dùng thay nhau ([ADR-0018](../llm-seller-governance/adr/0018-seller-bounded-context-split.md)).
- Seller tenant là **organization boundary**; không tồn tại "Seller Workspace".
- Seller tenant **không** có cột lifecycle `status`, `archivedAt` hay `deletedAt` ([ADR-0002](./adr/0002-tenant-existence-separate-from-eligibility.md)).
- `llm-seller` (composition UI + BFF) không sở hữu domain rules hay database.

## 2. Ngôn ngữ dùng chung

| Thuật ngữ                                 | Ý nghĩa                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seller tenant                             | Ranh giới cách ly dữ liệu của một tổ chức seller; mỗi tenant có đúng một owner.                                                                                                                                                                                                                                                  |
| Owner                                     | `sub` sở hữu tenant, là thuộc tính ownership (không phải role hay permission grant).                                                                                                                                                                                                                                             |
| Seller membership                         | Quan hệ giữa một account (`sub`) và một Seller tenant, có danh tính theo từng lần membership.                                                                                                                                                                                                                                    |
| Permission grant                          | Cấp trực tiếp một permission cho một lần membership, có lịch sử cấp/thu hồi.                                                                                                                                                                                                                                                     |
| Authorization ladder                      | Quyết định allow/deny trên tài nguyên Seller: owner toàn quyền trong tenant của mình trừ khi target bị restriction chặn; member chỉ có đúng permission được cấp.                                                                                                                                                                 |
| Classification (`first_party`/`customer`) | Quan hệ tổ chức của tenant — của Ecoma hay của khách hàng ([ADR-0026](../llm-consumer-tenant/adr/0026-first-party-dogfooding-and-commercial-policy-boundaries.md)); không phải commercial plan, không phải trục eligibility; chỉ thiết lập qua bootstrap/seed ([ADR-0020](../staff-access/adr/0020-bootstrap-seed-contract.md)). |
| First-party provider identity             | Danh tính công khai của một provider first-party, chính là tên tenant first-party của nó (`dronie` đầu tiên) — không phải upstream API provider, không phải pháp nhân → [ADR-0027](./adr/0027-first-party-seller-provider-identity-and-legal-principal.md).                                                                      |

## 3. Business concepts

### 3.1 SellerTenant

- `id`, `name`, `owner` (`sub`), `createdAt`.
- Invariant: **đúng một owner**, luôn có. Không tồn tại Seller tenant ownerless; không có collection owner.
- Owner là một **thuộc tính ownership của tenant**, không phải membership role hay permission grant ([ADR-0001](./adr/0001-seller-tenant-ownership-and-transfer.md)).
- Tạo tenant là **operational-active ngay**: không có trạng thái `pending`; onboarding approval không phải điều kiện tiên quyết ([ADR-0002](./adr/0002-tenant-existence-separate-from-eligibility.md)).
- Tenant không mang `status`; operational eligibility, verification và restriction là các trục độc lập, đánh giá bởi `llm-seller-governance`.
- Classification `first_party` | `customer` là **quan hệ tổ chức**, không phải commercial plan và không phải trục eligibility thứ năm: `first_party` **không** thiết lập operational eligibility — verification, restriction và appeal của `llm-seller-governance` giữ nguyên hiệu lực ([ADR-0002](./adr/0002-tenant-existence-separate-from-eligibility.md), [ADR-0026](../llm-consumer-tenant/adr/0026-first-party-dogfooding-and-commercial-policy-boundaries.md)). Chỉ thiết lập qua bootstrap/seed ([ADR-0020](../staff-access/adr/0020-bootstrap-seed-contract.md)); đường tạo customer-facing không tự gán `first_party`; classification bất biến sau khi thiết lập — không có thao tác đổi nào sau provisioning (ADR-0026 §1); Seller tenant không có commercial plan và không có Free slot bất kể classification; không suy ra từ owner, role hay tên tenant.
- **Mỗi provider first-party do Ecoma-io vận hành có đúng một Seller tenant riêng**, classification `first_party`; `Dronie` là provider đầu tiên. Tên tenant first-party là **tên riêng theo provider** (không phải `ecoma` — supersede-in-part [ADR-0020](../staff-access/adr/0020-bootstrap-seed-contract.md) Quyết định 9 theo [ADR-0027](./adr/0027-first-party-seller-provider-identity-and-legal-principal.md)): duy nhất trong database (natural key bootstrap), bất biến sau khi tạo, dạng khoá định danh (chữ thường, bắt đầu bằng chữ cái, `a-z0-9` và `-`, ≤ 64 ký tự), không bao giờ là nhãn environment/lane. Tên này đồng thời là **danh tính provider công khai** của provider đó (§7 của ADR-0027). Owner của tenant first-party là `sub` của Superadmin bootstrap ([ADR-0020](../staff-access/adr/0020-bootstrap-seed-contract.md) Quyết định 11), truyền vào bước seed như giá trị đầu output (Quyết định 12). Principal pháp lý chịu trách nhiệm cho mọi provider first-party là Ecoma-io — quan hệ được ghi trong `llm-seller-governance`, không phải ở context này → [ADR-0027](./adr/0027-first-party-seller-provider-identity-and-legal-principal.md) §3.

### 3.2 SellerMembership

- `id` (định danh của **lần** membership), `tenantId`, `actor` (`sub`), `status` (`active` | `revoked`), `createdAt`, `revokedAt`.
- `UNIQUE (tenant_id, id)` và **partial unique** `UNIQUE (tenant_id, actor) WHERE status = 'active'` — một account có tối đa một membership active trong một tenant, nhưng giữ bản ghi đã revoke làm lịch sử.
- Membership **không** mang role: quyền của member đến từ grant trực tiếp.
- Provision tường minh, không tự động khi signup/login. Re-provision sau revoke tạo membership **mới với `id` mới**, không restore bản ghi cũ.
- Owner có thể đồng thời là member (khi được provision). Membership của owner không phải nguồn authority — owner authority đến từ thuộc tính ownership của tenant.
- Danh tính membership theo lần cấp quyền, owned-tenant fact, tenant-scoping của collection và tham chiếu opaque là primitive của thin shared kernel (P1–P5: opaque ID guard, epoch-millis guard, owned-tenant fact, tenant member reference, tenant-scoped collection), dùng chung với `llm-consumer-tenant` → [ADR-0025](../llm-consumer-tenant/adr/0025-thin-shared-tenant-kernel.md); seller tiêu thụ guard P1–P2 qua `@ecoma-io/tenant-kernel-domain`, bất invariant owner được giữ ở kiểu domain (owner là field bắt buộc của aggregate). Grant, restriction verdict, authorization ladder và ownership transfer **không** thuộc kernel.

### 3.3 Permission

- **Permission identifier** theo hình `domain.action`, ví dụ `offer.manage`, `payout.manage`. Wildcard và superuser bị từ chối.
- `llm-seller-tenant` giữ identifier như **domain value opaque**. Nội dung catalog và publish thuộc governance của `staff-access`; ranh giới đầy đủ chưa chốt ([ADR-0007](./adr/0007-permission-identifier-boundary.md)).
- Không có role entity, không có role administration.

### 3.4 PermissionGrant

- `tenantId`, `membershipId`, `permission`, `scope`.
- `scope` là **tenant** — Seller tenant không có workspace, nên scope duy nhất là tenant.
- Grant chỉ cấp cho membership **active** trong tenant; grant trỏ `membershipId` chứ không trỏ `sub` — nhờ đó grant của một lần membership đã revoke không sống lại khi actor được provision lại.
- Cùng `(membershipId, permission)` không được trùng.
- **Cấp và thu hồi đều append-only**: grant bị thu hồi không bị xoá, chỉ có `revokedAt`; lịch sử là nguồn audit (§5).

### 3.5 Authorization

- **Deny by default.** Hai nguồn allow duy nhất: owner authority và grant trực tiếp.
- **Owner**: allow mọi operation trong tenant của mình, gồm billing và payout, **trừ khi target đang bị restriction chặn**. Owner authority không đi theo `sub` sang tenant khác.
- **Member**: chỉ allow đúng permission đã cấp, trên **đúng lần membership** đã cấp.
- **Grant gắn với một lần membership.** Grant của membership đã revoke không bao giờ authorize, kể cả khi actor đã được provision lại.
- **Permission chỉ là identifier opaque**; domain không tự thêm quyền nào từ tên permission, tiền tố hay wildcard.
- **Owner authority là không giới hạn theo permission — có chủ đích.** Permission catalog không giới hạn được owner; muốn hạn chế owner phải dùng restriction.
- **Restriction đứng trước owner authority.** `blocked`/`unevaluable` deny kể cả owner và kể cả billing/payout.

## 4. Business operations

Domain operations là pure function: không I/O, không clock hệ thống, không DB/filesystem/network/environment. Mọi thời gian là epoch millis **do caller truyền**; mọi định danh **do caller cấp**. Kết quả là `LlmSellerTenantResult` (`ok` / `error`); dữ liệu hỏng trả domain error, không ném exception. Chỉ `create*Id` ném `TypeError` khi lập trình sai. Mọi giá trị trả về được `Object.freeze`; input không bị mutate.

| Operation                 | Mục đích                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createSellerTenant`      | Tạo Seller tenant với đúng một owner (`sub`) và name; tenant ownerless bị từ chối.                                                                                                                           |
| `transferSellerOwnership` | Chuyển ownership tường minh: actor phải là owner hiện tại; owner mới phải khác và phải có membership active; giữ đúng một owner; owner cũ trở thành member.                                                  |
| `provisionMembership`     | Provision membership tường minh cho account (`sub`) vào Seller tenant; không tự động khi signup/login; provision trùng membership active bị từ chối.                                                         |
| `revokeMembership`        | Thu hồi membership; membership revoked không tự restore — re-provision tạo membership **mới với `id` mới**, và grant của lần cũ không áp cho lần mới.                                                        |
| `createGrant`             | Cấp permission trực tiếp cho một membership active tại tenant scope; trùng `(membershipId, permission)` bị từ chối; grant chỉ áp cho đúng lần membership được cấp.                                           |
| `revokeGrant`             | Thu hồi grant; grant revoked không bị xoá khỏi lịch sử và không authorize cho bất kỳ request nào sau thời điểm revoke.                                                                                       |
| `authorizeSellerAction`   | Quyết định allow/deny trên tài nguyên Seller theo ladder: restriction trước, sau đó owner authority, sau đó grant trực tiếp.                                                                                 |
| `authorizeSellerPayout`   | Gọi cùng ladder với permission `payout.manage` và target capability `payout` được ghim bên trong; kết quả mang `tenantScope: 'seller_tenant'` để consumer không thể diễn giải thành quyền ở Consumer tenant. |

### 4.1 Thứ tự kiểm authorization (fail closed)

Mọi authorization request đi qua cùng một thứ tự, mỗi bước không suy ra bước sau:

1. `actor`, `tenant`, `permission`, `target` đọc được; ngược lại `invalid_context`. Nếu chính `permission` không đọc được, quyết định deny mang `permission: null` — domain không bịa một identifier thay thế.
2. Mọi membership/grant thuộc `tenant.id`; lệch hoặc sai shape ⇒ `inconsistent_context`.
3. `restrictions === undefined`, không qua `isRestrictionEvaluation` (thiếu `blocked`/`unevaluable` boolean), mang `tenantId` khác, mang `target` khác `request.target`, hoặc `unevaluable` ⇒ `restriction_unevaluable`; `blocked` ⇒ `restricted` — **kể cả owner**. Evaluation của tenant/target khác không phải bằng chứng "không bị chặn".
4. `actor === tenant.owner` ⇒ allow, basis `owner`.
5. Đúng một membership active của actor: 0 ⇒ `membership_missing`, chỉ có bản revoked ⇒ `membership_revoked`, > 1 ⇒ `membership_ambiguous`. Nhánh `membership_ambiguous` là **phòng thủ**: adapter đúng với partial unique index không bao giờ tạo ra nó, nhưng dữ liệu đọc từ storage/contract có thể hỏng nên authorization vẫn phải deny thay vì chọn một bản ghi.
6. Grant `active` của đúng `membershipId` đó cho đúng `permission` ⇒ allow, basis `tenant_grant`.
7. `permission_not_granted`.

`authorizeSellerPayout(request)` gọi cùng ladder với permission `payout.manage` và target capability `payout` được ghim bên trong — evaluation caller truyền vào phải được tính cho đúng target đó, nếu không ladder từ chối. `payout.manage` là permission Seller-side mà [`llm-financial/adr/0005`](../llm-financial/adr/0005-ec-to-uc-conversion.md) yêu cầu cho EC→UC conversion. Kết quả mang `tenantScope: 'seller_tenant'` để consumer không thể diễn giải thành quyền ở Consumer tenant. Danh tính của identifier này và ranh giới catalog với `staff-access` ở [ADR-0007](./adr/0007-permission-identifier-boundary.md).

Restriction evaluation là **giá trị khai báo tại biên** của context này (`RestrictionEvaluation`), không import từ `llm-seller-governance-domain` ([ADR-0018](../llm-seller-governance/adr/0018-seller-bounded-context-split.md)).

## 5. Invariants

1. **Đúng một owner.** `SellerTenant.owner` luôn có giá trị; transfer không để lại trạng thái ownerless hay hai owner trong output.
2. **Owner không phải grant.** `authorizeSellerAction` allow theo basis `owner` trước khi xét membership; thu hồi hết grant không làm owner mất quyền.
3. **Restriction trước owner.** `blocked`/`unevaluable` deny kể cả owner và kể cả billing/payout.
4. **Membership incarnation.** Grant chỉ hiệu lực khi `grant.membershipId` là membership `active` hiện tại; re-provision tạo id mới nên grant cũ vô hiệu vĩnh viễn.
5. **Không role.** Không có bảng role, không suy quyền từ tên permission, không wildcard.
6. **Tenant isolation.** Mọi collection lệch tenant bị từ chối nguyên khối, không lọc rồi allow.
7. **Determinism.** Không hàm nào đọc clock/random; cùng input ⇒ cùng output.
8. **`first_party` không bypass ladder.** Classification là quan hệ tổ chức ([ADR-0026](../llm-consumer-tenant/adr/0026-first-party-dogfooding-and-commercial-policy-boundaries.md)), không phải plan hay eligibility; restriction vẫn đứng trước owner authority, và membership + authorization giữ nguyên cho tenant `first_party`.

## 6. State transition

Membership: `∅ → active` (provision, id mới) · `active → revoked` (terminal).
Grant: `∅ → active` (grant, id mới) · `active → revoked` (terminal).

Không transition nào khác được phép.

## 7. Error taxonomy

Một error chỉ mang `code` + `message` (tiếng Anh), không mang identifier, reason nội bộ hay payload. `LLM_SELLER_TENANT_DOMAIN_ERROR_MESSAGES` và cả hai nhánh `LlmSellerTenantResult` đều frozen; factory ném `TypeError` với code ngoài taxonomy; guard dùng `Object.hasOwn` **và** đòi `message` khớp nguyên văn bảng chuẩn, nên một object tự đặt message không qua guard.

Nhóm mã:

- **Định danh/validate:** `invalid_seller_tenant_id`, `invalid_seller_tenant`, `invalid_actor`, `invalid_seller_tenant_name`, `invalid_timestamp`, `invalid_membership_id`, `invalid_membership`, `invalid_grant_id`, `invalid_grant`, `invalid_permission_id`.
- **Ngữ cảnh:** `ambiguous_context`, `inconsistent_context`.
- **Ownership/membership/grant:** `actor_not_owner`, `owner_already_owner`, `new_owner_not_active_member`, `missing_former_owner_membership`, `duplicate_membership_id`, `membership_already_active`, `membership_already_revoked`, `membership_not_found`, `duplicate_grant_id`, `duplicate_grant`, `grant_already_revoked`.
- **Authorization:** `invalid_context`, `restricted`, `restriction_unevaluable`, `membership_missing`, `membership_revoked`, `membership_ambiguous`, `permission_not_granted`.

## 8. Quyết định chưa chốt

### 8.1 Chính sách ownership transfer nâng cao

Điều kiện phụ (approval, cooling-off, xử lý khi owner account không còn khả dụng, transfer do platform khởi tạo) **chưa chốt**. Domain chỉ đảm bảo invariant đúng-một-owner và các guard ở §4.

### 8.2 Ranh giới permission catalog

Ai sở hữu nội dung catalog, ai publish, cách đồng bộ với `staff-access` **chưa chốt đầy đủ**. Quyết định hiện hành: domain giữ identifier opaque, không phụ thuộc Nx project khác, không tạo catalog trùng.

### 8.3 Vòng đời pháp lý của dữ liệu

Archive, termination, deletion, retention, legal hold, export, anonymization và physical deletion **chưa chốt**; canonical tại [`llm-seller-governance/adr/0008`](../llm-seller-governance/adr/0008-data-lifecycle-deferred.md). Domain không có transition `deleted`/`archived`.

## 9. Failure / correction

- Không đánh giá được authorization hay restriction evaluation ⇒ fail closed, không leak dữ liệu.
- Membership/grant revoke: hiệu lực theo revocation latency target của platform — không hứa tức thời khi chưa có cơ chế.
- Migration: forward-fix only; correction ưu tiên forward-fix hơn rollback dữ liệu.
- Transfer phải nguyên tử ở persistence boundary; failure giữa chừng không được để lại tenant ownerless hay hai owner.

## 10. Tài liệu

| Document          | Nội dung                                                               |
| ----------------- | ---------------------------------------------------------------------- |
| `domain-model.md` | Business model, rules, invariants, business operations, error taxonomy |
| `adr/`            | ADR index của bounded context                                          |

ADR `0001`, `0002`, `0005`, `0007` thuộc context này theo phân chia của [ADR-0018](../llm-seller-governance/adr/0018-seller-bounded-context-split.md); nội dung quyết định không đổi khi chuyển context.
