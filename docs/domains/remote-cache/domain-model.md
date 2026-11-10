# Domain Model — Remote Cache

Bounded context `remote-cache`: dịch vụ remote cache multi-tenant. Context sở hữu ngữ nghĩa nghiệp vụ của tenant, project, membership, API key (machine credential), quota, retention, usage metering, audit và lifecycle enforcement ở cấp domain. Data plane phục vụ giao thức cache (Nx-first); control plane quản lý toàn bộ state multi-tenant và không nằm trên hot path của cache traffic.

## 1. Mục đích và ranh giới

`remote-cache` sở hữu **dịch vụ remote cache multi-tenant**: tenant, project, membership, API key machine credential, quota, retention, usage metering và audit. Cache artifact là disposable build state — mất cache thì task chạy lại được, không mất correctness. Cache không phải source of truth, không phải serving dependency của application nào.

| Sở hữu                                                                                                                                                                                                                                                                                                 | Không sở hữu                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tenant (kèm owner — `sub` opaque, đúng một, thuộc tính persistence độc lập trên bản ghi tenant), classification, plan và chính sách Free slot (§2.9), project, membership, API key (machine credential) scoped theo project, quota/retention/usage metering, audit, domain-level lifecycle enforcement | giao thức cache Nx (adapter), HTTP API, streaming, object storage partitioning, bucket/object key, storage adapters, CDN, runtime, deployment, recovery, operations, subscription/billing (chỉ tiêu thụ tín hiệu subscription, không sở hữu nó) |

- Tenant của `remote-cache` ≠ tenant của `pact-broker` — không dùng chung, không suy ra membership từ bên kia, không FK chéo database. Không có bounded context `Tenant` dùng chung; `remote-cache` áp bất invariant owner §3 của [ADR-0025](../llm-consumer-tenant/adr/0025-thin-shared-tenant-kernel.md) tại persistence boundary (`owner_sub` NOT NULL + CHECK — chưa có đường runtime xử lý owner nên chưa import guard kernel nào) và không áp dụng model membership incarnation (membership incarnation là của từng sản phẩm).
- Entitlement Staff Access deferred cho MVP: `remote-cache` dùng API key riêng; khi tích hợp thì chỉ qua entitlement event (không sync-call, không authorization-result contract).
- Enforcement authorization bên trong `remote-cache` resolve từ principal (API key) và dữ liệu của chính nó — catalog govern / backend enforce giữ nguyên hình dạng chung của hệ thống.

## 2. Ngữ nghĩa nghiệp vụ

### 2.1 Tenant

Tenant là ranh giới cách ly của tổ chức/customer. Mỗi project thuộc đúng một tenant. Tenant có lifecycle state riêng (`active`/`suspended`/`deleted`) với enforcement fail-closed.

Mỗi tenant có đúng một **owner** là tham chiếu `sub` opaque, lưu độc lập trên bản ghi tenant — không phải role hay grant trên membership, không ràng buộc bằng membership, và không tồn tại tenant ownerless. Owner có thể hoặc không có là membership của chính tenant đó; thu hồi membership không ngầm loại bỏ quyền sở hữu.

### 2.2 Project

Project là đơn vị isolation của cache. Mỗi project thuộc đúng một tenant. Namespace và storage scope derive từ project, không từ input client.

### 2.3 Membership

Membership là quan hệ người dùng ↔ tenant kèm role. Vòng đời độc lập với API key machine credential.

Role của membership là dữ liệu sản phẩm, dùng cho phân quyền nội bộ remote-cache — **không** là nguồn quyền sở hữu tenant. Owner là thuộc tính persistence của tenant (§2.1), và role `owner` đã bị loại khỏi từ điển role của membership; role còn lại là `member`. Việc thu hồi membership không làm tenant mất chủ thể vận hành.

### 2.4 API key

API key là machine credential scoped theo project, có read/write scope, có revoke/expiry. Hash-only ở storage, show-once lúc tạo. Vòng đời độc lập với membership. Không có `last_used_at` (observability không vào serving path).

### 2.5 Quota / usage

Quota là giới hạn tài nguyên attributed theo project. PostgreSQL là authority cho quota/usage. Semantics chống double-count khi retry hoặc upload đồng thời.

### 2.6 Retention

Cache artifact có retention hữu hạn. Storage lifecycle tự cleanup obsolete versions, incomplete uploads và artifact hết retention. MVP không yêu cầu application-level garbage collection trên request path.

### 2.7 Audit

Mọi administrative mutation (tenant/project/membership/API key/quota/retention) tạo audit entry với actor, action, target, time, outcome. Audit query được qua control plane.

### 2.8 Lifecycle enforcement (domain-level)

Lifecycle enforcement là domain rule: data plane **re-check trạng thái từ `db-remote-cache` mỗi request**, fail-closed ở mọi nhánh, không cache trạng thái tenant. Credential của tenant/project không ở trạng thái `active` MUST bị từ chối — kể cả khi cached configuration chưa phản ánh trạng thái mới (stale cache không được biến suspend/delete thành allow).

Hệ quả: data plane phụ thuộc database; target "không phụ thuộc database trong hot path" bị thu hẹp có chủ đích. Database không lưu artifact và không giữ cấu hình routing — exception chỉ áp dụng cho lifecycle state của tenant, đọc trực tiếp mỗi request để giữ fail-closed.

### 2.9 Classification, plan và chính sách Free

**Classification tenant.** Mỗi tenant có đúng một **classification** là `first_party` hoặc `customer`, thuộc tính NOT NULL của bản ghi tenant trong `remote-cache`. Classification là **quan hệ tổ chức** (tenant của Ecoma hay của khách hàng), không phải commercial plan — [ADR-0026](../llm-consumer-tenant/adr/0026-first-party-dogfooding-and-commercial-policy-boundaries.md). Nó chỉ được thiết lập qua đường provisioning sản phẩm kiểm soát (bootstrap/seed theo bề mặt của [ADR-0020](../staff-access/adr/0020-bootstrap-seed-contract.md)); mặc định khi tạo qua đường customer là `customer`; không suy ra được từ owner là Superadmin, email domain, tên tenant, environment, plan hay membership role, và không có đường customer-facing nào tự gán `first_party`. Đổi classification sau khi tạo chỉ qua thao tác tường minh, có thẩm quyền, auditable trên bề mặt offline sản phẩm kiểm soát; tại thời điểm commit tenant phải thoả mọi invariant của trạng thái đích (slot Free, subscription khi đích là `paid`, unique `name`; lifecycle `status` không đổi) — chi tiết cross-product → [ADR-0026](../llm-consumer-tenant/adr/0026-first-party-dogfooding-and-commercial-policy-boundaries.md) §1.

**Tenant `first_party` trong `remote-cache`.** Tenant nội bộ canonical là `ecoma`, owner là subject Superadmin canonical, provisioned duy nhất qua internal bootstrap ([ADR-0020](../staff-access/adr/0020-bootstrap-seed-contract.md) Quyết định 9, 13). Miễn trừ thương mại của nó chỉ gồm: không tiêu slot Free và không có ràng buộc plan/subscription. Không miễn: usage metering (§2.5), audit (§2.7), quota/retention/lifecycle enforcement (§2.6, §2.8) hay tenant isolation — miễn trừ classification không tự tạo hay tự bỏ một hạn mức nào (§2.5). Tenant `first_party` đi theo đúng lifecycle của sản phẩm; seed lại sau xoá/suspend chịu rule fail-closed "không hồi sinh" của ADR-0020.

**Plan.** Tenant `customer` có đúng một **plan** là `free` hoặc `paid`; tenant `first_party` **không có plan** (plan không áp dụng — không có giá trị, không phải một giá trị thứ ba của enum). Plan có giá trị nếu và chỉ nếu classification là `customer`. Plan không đổi ngữ nghĩa của quota (§2.5) và retention (§2.6); classification cũng vậy.

**Slot Free theo owner.** Chủ thể của slot là `owner_sub` trên bản ghi tenant (§2.1) — không phải membership. Mỗi owner sở hữu tối đa **một** tenant `free` concurrent trong `remote-cache`. Slot là bất invariant của từng sản phẩm: một user có thể cùng lúc sở hữu một tenant Free `remote-cache` và một tenant Free `pact-broker`, vì tenant của hai context không dùng chung (§1). Membership ở tenant khác — bất kể role — không tiêu slot. Chỉ tenant có plan `free` tiêu slot: tenant `paid` và tenant `first_party` (không có plan) đều không tiêu slot Free — hạn mức một-free-của-mỗi-owner chỉ tính tenant `free` chưa `deleted`.

**Trạng thái và slot.** Tenant Free bị `suspended` vẫn tiêu slot. Chờ xoá không phải trạng thái lifecycle: bộ trạng thái giữ nguyên `active`/`suspended`/`deleted` (§2.1), không có giá trị thứ tư. Tình trạng chờ xoá — yêu cầu xoá đã nhận nhưng logical deletion chưa commit — được biểu diễn bằng state xoá do `remote-cache` sở hữu: một deletion request/metadata tách khỏi `status` (lưu ở cột hay bảng riêng là chi tiết delivery; đường record này chưa hiện diện trong migration hiện có). Trong cửa sổ chờ xoá đó tenant Free vẫn tiêu slot. Slot chỉ được giải phóng khi logical deletion commit thành công và `status` thành `deleted`; retention/purge physical data sau đó không giữ slot.

**Xoá và thay thế.** Xoá tenant Free cho phép tạo tenant thay thế không giới hạn lần. Mỗi tenant thay thế có tenant ID mới và tên chưa từng dùng — tenant đã xoá không bao giờ được resurrect hay reuse, và tên của nó tiếp tục bị giữ vĩnh viễn dưới semantics unique của `name` hiện có.

**Subscription và tenant trả phí.** Mỗi owner có tối đa một tenant `free` đang tồn tại — chưa `deleted` — trong `remote-cache` (**Slot Free theo owner** ở trên). Quy tắc này áp cho tenant `customer`: sở hữu tenant `first_party` không chiếm slot Free và không chặn owner tạo tenant `free` customer. Khi tenant `free` đó còn tồn tại, tenant thêm của cùng owner phải được tạo là tenant `paid` và đòi subscription hợp lệ; khi tenant `free` đã bị logical deletion, việc tạo tenant Free thay thế không bị giới hạn số lần (**Xoá và thay thế** ở trên). Subscription không phải là plan: subscription hết hạn không tự đổi plan của tenant — không có silent downgrade từ `paid` về `free`; quyền truy cập tenant khi subscription hết hạn do chính `remote-cache` enforce, không thuộc kernel hay bounded context dùng chung.

**Owner transfer.** Transfer ownership kiểm tra slot Free của owner mới trong cùng transaction với việc đổi owner: transfer khiến owner mới vượt quá một tenant Free concurrent bị từ chối, trừ khi tenant được convert sang `paid` với subscription hợp lệ. Slot của owner cũ chỉ được giải phóng sau khi transfer commit thành công.

**Enforcement schema.** Các bất invariant classification/plan/slot Free được enforce ở database, không chỉ qua application check. Yêu cầu schema, phát biểu dưới dạng kiểm được — chưa hiện diện trong migration hiện có, triển khai thuộc delivery: cột classification NOT NULL trên tenant với tập giá trị `first_party`/`customer`, và một composite requirement `(classification = 'customer' AND plan IN ('free','paid')) OR (classification = 'first_party' AND plan không có giá trị)` — plan chỉ có giá trị khi tenant là customer; cộng một partial unique index tên `tenants_one_free_per_owner_key` trên cột (`owner_sub`) của bảng tenant với điều kiện `plan = 'free'` AND `status <> 'deleted'` — `UNIQUE(owner_sub) WHERE plan = 'free' AND status <> 'deleted'` (tenant `first_party` không có plan nên không bao giờ khớp điều kiện); tên index theo quy ước `<table>_<descriptor>_key` của các unique index hiện có. Hai request tạo tenant Free concurrent cùng owner: đúng một commit thành công, request kia bị constraint từ chối — application check đơn thuần không đủ.

_Ghi chú delta:_ các đoạn classification và tenant `first_party` ở §2.9 là delta lên quyết định đã accept của #12 (đóng), theo [ADR-0026](../llm-consumer-tenant/adr/0026-first-party-dogfooding-and-commercial-policy-boundaries.md) §7 — phần còn lại của §2.9 giữ nguyên hiệu lực.

## 3. Invariant nghiệp vụ

1. Tenant isolation: project, API key, cache artifact đều scoped theo tenant/project.
2. API key hash-only; plaintext hiện một lần lúc tạo; không lưu plaintext persistent.
3. Lifecycle enforcement fail-closed: credential không active phải bị từ chối, kể cả stale cache.
4. Quota/usage authority ở PostgreSQL; không double-count khi retry/upload đồng thời.
5. Cache artifact immutable — một hash chỉ được tạo một lần.
6. Audit append-only cho mọi administrative mutation.
7. Mỗi owner tối đa một tenant `free` concurrent, enforce ở database bằng partial unique trên `owner_sub` với điều kiện plan và lifecycle (§2.9; tenant `first_party` không có plan nên không bao giờ khớp điều kiện); suspended và pending-deletion vẫn tiêu slot; slot chỉ giải phóng khi logical deletion commit.
8. Tenant đã xoá không được resurrect hay reuse: replacement có tenant ID mới và tên mới, tên đã xoá vẫn reserved (§2.9).
9. Plan không tự đổi theo subscription — không silent downgrade; subscription hết hạn do chính `remote-cache` enforce (§2.9).
10. Classification `first_party`/`customer` là quan hệ tổ chức, không suy ra từ owner/email/tên/environment/plan/role: chỉ thiết lập qua đường provisioning sản phẩm kiểm soát, chỉ đổi qua thao tác có thẩm quyền, auditable, trên bề mặt offline; plan có giá trị khi và chỉ khi classification là `customer` (§2.9).

## 4. Open boundary

Không có open boundary nghiệp vụ còn mở trong phạm vi context này.
