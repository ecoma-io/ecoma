# Bounded context `llm-consumer-tenant` — Domain Model

`llm-consumer-tenant` là bounded context sở hữu **tenant, membership, workspace, permission grant và suspension record** của Consumer trong hệ sinh thái LLM. Nó là nguồn sự thật cho ranh giới cách ly tổ chức và quyết định authorization trên tài nguyên LLM.

> Bounded context này là **Consumer tenant**. Seller tenant là bounded context riêng (`llm-seller-tenant`); hai loại tenant **không** dùng thay nhau, và Seller tenant **không có** workspace (ADR-0018). `sub` là tham chiếu opaque, **không FK** sang `db-account`/`db-auth`. Authenticated actor (`sub`) luôn lấy từ verified authentication context. Billing account **≠** tenant. Vòng đời pháp lý của tenant và dữ liệu **chưa chốt**.

## 1. Domain entities

### Tenant

- `id`, `name`, `owner` (`sub`), `createdAt`.
- Invariant: **đúng một owner**, luôn có. Không tồn tại tenant ownerless; không có collection owner.
- Owner là nguồn authority duy nhất của tenant, không phải một grant và không phải membership.
- Tenant **không** mang cột lifecycle `status`, `archivedAt` hay `deletedAt` (vòng đời pháp lý chưa chốt).

### Membership

- `id` (định danh của **lần** membership), `tenantId`, `actor` (`sub`), `status` (`active` | `revoked`), `createdAt`, `revokedAt`.
- `UNIQUE (tenant_id, id)` và partial unique `UNIQUE (tenant_id, actor) WHERE status = 'active'` — một account có tối đa một membership active trong một tenant, nhưng giữ được các bản ghi đã revoke làm lịch sử.
- Membership **không** mang role: quyền của member đến từ grant trực tiếp.
- Provision tường minh, không tự động khi signup/login. Provision lại một actor đã có membership active bị từ chối; re-provision sau revoke tạo membership **mới với `id` mới**, không restore bản ghi cũ.
- Grant trỏ tới `membershipId`, không trỏ `sub`: nhờ đó quyền của một lần membership đã revoke không sống lại khi actor được provision lại.
- Bất biến "đúng một owner là thuộc tính tenant", danh tính membership theo lần cấp quyền, tenant-scoping của collection và tham chiếu opaque là primitive của thin shared kernel (P1–P5: opaque ID guard, epoch-millis guard, owned-tenant fact, tenant member reference, tenant-scoped collection), dùng chung với `llm-seller-tenant` → [ADR-0025](./adr/0025-thin-shared-tenant-kernel.md); consumer tiêu thụ guard P1–P3 qua `@ecoma-io/tenant-kernel-domain`. Role, grant, workspace, suspension, authorization và tenant lifecycle **không** thuộc kernel.

### Workspace

- `id`, `tenantId`, `name`, `createdAt`.
- Mọi workspace thuộc **đúng một** tenant; namespace/storage scope derive từ `(tenant_id, workspace_id)`.
- Tham chiếu workspace của tenant khác bị từ chối; tra cứu workspace luôn kèm tenant đang chọn.
- Workspace không mang `status` cho tới khi vòng đời pháp lý được chốt.

### Permission

- **Permission identifier** theo hình `domain.action` (ADR-0010), ví dụ `workspace.read`, `billing.manage`. Wildcard và superuser bị từ chối.
- `llm-consumer-tenant` giữ identifier như **domain value opaque**. Nội dung catalog và việc publish nó thuộc governance của `staff-access`; boundary này chưa được chốt đầy đủ.
- Không có role entity, không có custom-role administration.

### Permission grant

- `tenantId`, `membershipId`, `permission`, `scope`.
- `scope` là **tenant** hoặc **workspace** (đúng một `workspaceId`).
- Grant chỉ cấp cho membership **active** trong tenant; grant trỏ workspace phải trỏ workspace của **cùng** tenant.
- Cùng `(membershipId, permission, scope)` không được trùng. Tenant scope và workspace scope là hai scope khác nhau. Hai membership khác nhau (dù cùng `sub`) là hai chủ thể quyền độc lập.

### Suspension record

- `id`, `tenantId`, `policy`, `reason`, `scope`, `activatesAt`, `expiresAt` (hoặc không hạn), `liftedAt` (hoặc chưa lift).
- Nhiều record độc lập cho một tenant; mỗi record có vòng đời riêng. Lift/expire record này không đụng record khác.
- `policy` và `reason` là **định danh mở**, không phải enum của domain. Domain không liệt kê lý do billing/compliance/security/administrative; đó là dữ liệu cấu hình có governance.

## 2. Authorization model

### Nguyên tắc

- **Deny by default.** Chỉ hai nguồn allow: owner authority và grant trực tiếp.
- **Owner**: allow mọi operation trong tenant của mình, gồm cả billing, trên mọi workspace của tenant — trừ khi target đang bị suspension chặn. Owner authority **không** đi theo `sub` sang tenant khác — không có global owner role bypass.
- **Member**: chỉ allow đúng permission đã được cấp, ở đúng scope đã cấp, trên **đúng lần membership** đã được cấp.
- **Grant gắn với một lần membership.** Chỉ grant trỏ `membershipId` của membership active hiện tại được tính; grant của membership đã revoke không bao giờ authorize, kể cả khi actor đã được provision lại.
- **Không kế thừa ngầm tenant → workspace.** Grant tenant scope không authorize một thao tác workspace cụ thể.
- **Ngoại lệ tường minh duy nhất**: một permission có thể được khai báo là **quản trị workspace toàn tenant**; khi đó grant tenant scope của chính permission đó authorize mọi workspace của tenant. Ngoại lệ này phải được khai báo theo từng permission, không suy ra từ tên hay từ một wildcard.
- **Owner authority là không giới hạn theo permission — có chủ đích.** Vì owner được xác định bằng quan hệ trên tenant chứ không bằng grant, quyền owner áp cho **mọi** permission, kể cả permission thêm sau này. Đây là lựa chọn đã chốt, không phải hệ quả tình cờ: nó bảo đảm tenant luôn có một chủ thể vận hành được khi grant bị thu hồi hết. Hệ quả cần biết: permission catalog **không** giới hạn được owner; muốn hạn chế owner thì phải dùng suspension, không phải grant.

### Thứ tự kiểm và fail closed

Mọi request authorization đi qua cùng một thứ tự:

1. Ngữ cảnh đọc được không (actor, tenant, permission, target, membership set, grant set, khai báo semantics).
2. Tenant của membership/grant/workspace khớp tenant đang chọn; lệch ⇒ từ chối, không lọc rồi allow.
3. Target workspace thuộc tenant đang chọn.
4. Target đang bị suspension chặn, hoặc không đánh giá được suspension ⇒ deny, **kể cả owner**.
5. Owner ⇒ allow.
6. Đúng một membership active cho actor; thiếu ⇒ deny, revoked ⇒ deny, nhiều hơn một bản ghi active ⇒ deny (`membership_ambiguous`).
7. Target tenant: cần grant tenant scope của membership active đó. Target workspace: cần grant đúng workspace của membership active đó, hoặc grant tenant scope khi permission được khai báo tenant-wide.
8. Không thỏa ⇒ deny.

Bất kỳ bước nào không đánh giá được đều **deny**, kèm lý do cụ thể để audit — không bao giờ "không biết ⇒ cho qua". Suspension đứng **trước** owner authority: một tenant bị hạn chế không cho phép owner bypass bằng quyền owner.

### Billing

- Billing management (khởi tạo, top up) là một permission riêng, không cấp quyền nào khác và không bao giờ được khai báo là quản trị workspace toàn tenant.
- Owner có billing authority mà không cần grant; member cần grant tenant scope của permission đó.
- Domain **chỉ authorize**. Thực thi giao dịch thanh toán, số dư, ledger, reconciliation, funding thuộc `payment`/`llm-financial`; domain không giữ số dư và không gọi ra ngoài.

## 3. Suspension model

- **Không có nguồn sự thật thứ hai.** "Đang bị hạn chế" là giá trị **suy ra** từ tập record tại một thời điểm `now`; không có cột `status = suspended`.
- **Cửa sổ hiệu lực nửa mở** `[activatesAt, expiresAt)`: hiệu lực tại đúng `activatesAt`, hết tại đúng `expiresAt`. `liftedAt` có hiệu lực khi `liftedAt <= now`; một lần lift đặt lịch tương lai chưa có tác dụng.
- **Scope**: record scope tenant chặn toàn tenant (và do đó mọi workspace bên trong); record scope workspace chỉ chặn đúng workspace đó, không chặn tenant hay workspace khác.
- **Đánh giá deterministic**: target bị chặn khi tồn tại ít nhất một record hiệu lực, áp dụng cho target, với policy restrictive. Không có record như vậy ⇒ không bị hạn chế bởi suspension.
- **Suspension được compose vào authorization, không phải bước tuỳ chọn.** `authorizeTenantAction` nhận kết quả `evaluateSuspensions` của cùng target; `blocked` ⇒ `target_suspended`, `unevaluable` ⇒ `suspension_unevaluable`, cả hai đều deny trước khi xét owner. Lib không có hàm gộp sẵn hai bước, nên bỏ quên suspension là quyết định tường minh của caller chứ không phải mặc định im lặng.
- **Fail closed**: policy không có trong cấu hình ⇒ coi là restrictive và đánh dấu evaluation là **unevaluable**; record sai hình dạng, tập record lẫn tenant, hay target workspace không thuộc tenant ⇒ từ chối đánh giá thay vì trả "không chặn". Evaluation `blocked` hoặc `unevaluable` đều dẫn tới deny.
- **Suspension không huỷ request đã qua admission.** Hành vi của request đang chạy (hoàn tất, cancel) thuộc application/domain tương ứng.
- **Audit append-only** cho mọi mutation đặc quyền (tạo/lift record, grant, membership, workspace); persistence thuộc application/infrastructure của `llm-api`.

## 4. Workspace isolation

- Mỗi workspace thuộc đúng một tenant; mọi thao tác phải xác nhận workspace thuộc tenant đang chọn trước khi authorize.
- Grant workspace scope chỉ áp dụng đúng workspace đó; không leak sang workspace anh em cùng tenant.
- Không có cơ chế chia sẻ dữ liệu LLM xuyên tenant.

## 5. Auth boundary

- `llm-consumer-tenant` **không** xác minh danh tính; nhận `sub` từ access token đã verify bởi `auth`.
- Tenant resolution dùng tenant/resource đã được xác minh ownership; tenant selector từ client không phải proof of authorization.
- Product authorization do backend LLM enforce trên mọi protected request (deny-by-default). Entitlement từ `staff-access` là product availability, không phải verdict per-request (ADR-0009).

## 6. Data ownership

- `llm-consumer-tenant` là chủ sở hữu duy nhất dữ liệu tenant, membership, workspace, permission grant và suspension record. Không context nào khác đọc/ghi trực tiếp dữ liệu này; mọi truy cập đi qua contract của composition sở hữu storage.
- `llm-seller-tenant` là ownership boundary độc lập; dữ liệu của hai context không dùng thay nhau.
- Bố cục storage, engine, role và migration → [`docs/architecture/01-architecture.md`](../../architecture/01-architecture.md) §2 và [`docs/applications/llm-api/README.md`](../../applications/llm-api/README.md).

## 7. Inbound / outbound contracts và open boundary

- **Inbound**: provision tenant/workspace/membership, issue/revoke grant, tạo/lift suspension record, authorize qua API nội bộ của `llm-api`.
- **Outbound**: phát event tenant/membership/grant change qua transactional outbox (A8) cho consumer projection; idempotent consumer.
- **Billing account ≠ tenant.** Quan hệ crediting/reconciliation/settlement giữa `payment` và `llm` là open boundary; không giả định cơ chế.

## 8. Quyết định chưa chốt

Các mục dưới đây **không** phải planned state; chúng chưa có đáp án và không được implement hay suy diễn.

### 8.1 Vòng đời pháp lý của tenant và dữ liệu

Archive, termination, deletion, retention, legal hold, export, anonymization và physical deletion **chưa được chốt**. Domain giữ tách biệt ba trục: (a) quyền truy cập/operational lifecycle của tenant, (b) data lifecycle, (c) legal retention/deletion policy. Domain **không** sở hữu retention hay physical deletion. Transition `deleted`/`archived` trong thiết kế cũ không còn là quyết định đã duyệt.

### 8.2 Chuyển ownership tenant

Chính sách chuyển owner (transfer) **chưa chốt**: điều kiện, approval, hiệu lực và xử lý khi owner account không còn khả dụng. Domain hiện chỉ đảm bảo invariant "đúng một owner"; không có workflow transfer.

### 8.3 Ranh giới permission catalog

Permission identifier theo ADR-0010, nhưng ai sở hữu nội dung catalog, ai publish và cách đồng bộ chưa được chốt đầy đủ. Quyết định hiện hành: domain giữ identifier như giá trị opaque, **không** phụ thuộc Nx project khác và **không** tạo catalog trùng.

### 8.4 Catalog reason/policy của suspension

Domain không liệt kê hay giới hạn reason/policy. Tập reason/policy hợp lệ, ngữ nghĩa từng policy và cơ chế governance là quyết định của policy owner, chưa chốt.

## 9. Failure / correction

- Không đánh giá được authorization hay suspension ⇒ fail closed, không leak dữ liệu.
- Membership revoke: hiệu lực theo revocation latency target (ADR-0002/ADR-0014) — không hứa tức thời khi chưa có cơ chế.
- Migration: forward-fix only, expand → compatible rollout → contract.
- Correction: prefer forward-fix over data rollback (A16).

## 10. Ranh giới với các context khác

| Context                | Ranh giới với `llm-consumer-tenant`                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account`              | `sub` là tham chiếu opaque; tenant không tự tạo membership khi account signup/login.                                                                                  |
| `auth`                 | `sub` lấy từ authenticated principal (access token) đã verify; `llm-consumer-tenant` không tự xác minh danh tính.                                                     |
| `payment`              | Billing account và tenant là hai khái niệm khác nhau; không suy tenant từ billing account và ngược lại.                                                               |
| `llm-api`              | Tenant/workspace id truyền qua contract; `llm-api` là storage owner duy nhất của `db-llm-tenant`, không có deploy unit riêng cho `llm-consumer-tenant`.               |
| `llm-marketplace`      | Workspace/tenant là scope cho offer/catalog; marketplace không sở hữu membership/grant.                                                                               |
| `llm-consumer-routing` | Tiêu thụ tenant/workspace scope khi resolve routing; không sở hữu membership/grant.                                                                                   |
| `llm-seller-tenant`    | Seller tenant **độc lập**: không dùng `llm-consumer-tenant` thay cho Seller tenant và ngược lại; không có Seller Workspace (ADR-0018).                                |
| `staff-access`         | Product entitlement cấp khả năng dùng sản phẩm LLM; không thay thế authorization bên trong `llm-consumer-tenant`, và không trả lời allow/deny per-request (ADR-0009). |

## 11. Quy tắc cốt lõi

- **Đúng một owner mỗi tenant.** Owner có toàn quyền trong tenant của mình, kể cả billing. Không có global owner role: cùng một `sub` có thể owner tenant A, member tenant B, và không có quyền gì ở tenant C.
- **`sub` là opaque và đa membership.** Một `sub` có thể owner nhiều tenant và member nhiều tenant khác. Consumer tenant và Seller tenant độc lập hoàn toàn (ADR-0018); không có ngầm chọn tenant đầu tiên/default/UI state.
- **Membership tường minh và có danh tính.** Provision vào tenant (kể cả internal) là thao tác riêng; signup/login không tạo membership. Revoke không tự restore — re-provision tạo membership **mới với `id` mới**, nên grant của lần cũ không sống lại.
- **Grant trực tiếp theo scope, gắn với một lần membership.** Member chỉ có đúng permission được cấp, tại tenant scope hoặc đúng một workspace scope. **Không kế thừa ngầm tenant → workspace**: grant tenant scope không authorize thao tác trên một workspace cụ thể, trừ khi permission đó được khai báo tường minh là quản trị workspace toàn tenant.
- **Billing là permission riêng.** Một permission `billing.manage` (khởi tạo/top up) không cấp bất kỳ quyền nào khác. Domain chỉ authorize; thực thi giao dịch, số dư, ledger, reconciliation, funding nằm ngoài.
- **Suspension là suy ra và chặn authorization.** Nhiều record độc lập theo reason/scope/policy; lift hoặc expire record này không làm yếu record khác. Không có cột `status = suspended` thứ hai. Policy không đánh giá được ⇒ restrictive (fail closed), và evaluation `blocked`/`unevaluable` ⇒ deny **kể cả owner**. Suspension không huỷ request đã được admission.
- **Billing account ≠ tenant.** Một tenant có thể có nhiều billing account hoặc một billing account phục vụ nhiều tenant; quan hệ crediting/reconciliation giữa `payment` và `llm` là open boundary — không giả định.
- **`sub` opaque.** Không FK xuyên database; toàn vẹn là responsibility của contract + reconciliation.
- **Xác minh lại ở write boundary.** Tenant selector từ client chỉ là gợi ý chọn scope: backend xác minh lại ownership, membership và quyền tại chính write boundary để tránh TOCTOU, và fail closed nếu không xác minh được.
- **Vòng đời pháp lý chưa chốt.** Archive/termination/deletion/retention/legal hold/export/anonymization/physical deletion không được implement hay suy diễn trong domain này. Không có transition `deleted`/`archived` nào là quyết định đã duyệt.

## 12. Tài liệu

| Document                               | Nội dung                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`domain-model.md`](./domain-model.md) | Business model, authorization, suspension, workspace isolation, auth boundary, data ownership, contract, quyết định chưa chốt, failure/correction |
| [`README.md`](./README.md)             | Tóm tắt trách nhiệm, không sở hữu, ranh giới, quy tắc cốt lõi                                                                                     |
| [`adr/README.md`](./adr/README.md)     | ADR index (0019, 0025) của bounded context                                                                                                        |
