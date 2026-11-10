# Domain Model — Remote Cache

Bounded context `remote-cache`: dịch vụ remote cache multi-tenant. Context sở hữu ngữ nghĩa nghiệp vụ của tenant, project, membership, API key (machine credential), quota, retention, usage metering, audit và lifecycle enforcement ở cấp domain. Data plane phục vụ giao thức cache (Nx-first); control plane quản lý toàn bộ state multi-tenant và không nằm trên hot path của cache traffic.

## 1. Mục đích và ranh giới

`remote-cache` sở hữu **dịch vụ remote cache multi-tenant**: tenant, project, membership, API key machine credential, quota, retention, usage metering và audit. Cache artifact là disposable build state — mất cache thì task chạy lại được, không mất correctness. Cache không phải source of truth, không phải serving dependency của application nào.

| Sở hữu                                                                                                                                                                                                                                            | Không sở hữu                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tenant (kèm owner — `sub` opaque, đúng một, thuộc tính persistence độc lập trên bản ghi tenant), project, membership, API key (machine credential) scoped theo project, quota/retention/usage metering, audit, domain-level lifecycle enforcement | giao thức cache Nx (adapter), HTTP API, streaming, object storage partitioning, bucket/object key, storage adapters, CDN, runtime, deployment, recovery, operations |

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

## 3. Invariant nghiệp vụ

1. Tenant isolation: project, API key, cache artifact đều scoped theo tenant/project.
2. API key hash-only; plaintext hiện một lần lúc tạo; không lưu plaintext persistent.
3. Lifecycle enforcement fail-closed: credential không active phải bị từ chối, kể cả stale cache.
4. Quota/usage authority ở PostgreSQL; không double-count khi retry/upload đồng thời.
5. Cache artifact immutable — một hash chỉ được tạo một lần.
6. Audit append-only cho mọi administrative mutation.

## 4. Open boundary

Không có open boundary nghiệp vụ còn mở trong phạm vi context này.
