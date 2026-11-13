# Remote Cache

`remote-cache` là bounded context sở hữu **dịch vụ remote cache multi-tenant**: tenant, project, membership, API key machine credential, quota, retention, usage metering và audit. Data plane phục vụ giao thức cache (Nx-first); control plane quản lý toàn bộ state multi-tenant và không nằm trên hot path của cache traffic.

> Thư mục này giữ **ranh giới nghiệp vụ và quyết định ownership** của bounded context: ranh giới và storage ([ADR-0015](./adr/0015-remote-cache-bounded-context.md)), lifecycle enforcement ([ADR-0017](./adr/0017-lifecycle-enforcement.md)). Spec kỹ thuật đầy đủ của deploy unit nằm ở [`docs/applications/remote-cache/`](../../applications/remote-cache/README.md) — thư mục này không nhân bản thiết kế service.

## 1. Trách nhiệm

1. **Tenant** — ranh giới cách ly của tổ chức/customer; lifecycle state riêng (`active`/`suspended`/`deleted`) với enforcement fail-closed.
2. **Project** — đơn vị isolation của cache; mỗi project thuộc đúng một tenant; namespace và storage scope derive từ project, không từ input client.
3. **Membership** — quan hệ người dùng ↔ tenant kèm role; vòng đời độc lập với API key machine credential.
4. **API key** — machine credential scoped theo project, read/write scope, revoke/expiry; hai phân lớp tường minh trusted CI / developer credential (§2.4 của [`domain-model.md`](./domain-model.md)); hash-only ở storage, show-once lúc tạo; không `last_used_at` (observability không vào serving path).
5. **Quota/usage** — attribution theo project, PostgreSQL là authority.
6. **Audit** — mọi administrative mutation có entry actor/action/target/time/outcome.

## 2. Ranh giới với các context khác

| Context        | Sở hữu (rút gọn)                                     | Ranh giới với `remote-cache`                                                                                                                                                                                                                                          |
| -------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pact-broker`  | Tenant/membership/role **của broker**, machine token | **Tenant của `remote-cache` ≠ tenant của `pact-broker`** — không dùng chung, không suy ra membership từ bên kia, không FK chéo database (glossary [`domains/glossary.md`](../glossary.md))                                                                            |
| `staff-access` | Entitlement product-level availability của nhân sự   | **Deferred cho MVP**: `remote-cache` dùng API key riêng; khi tích hợp thì chỉ qua entitlement event (ADR-0009) — không sync-call, không authorization-result contract                                                                                                 |
| `backoffice`   | Composition/UI + BFF                                 | Không tiêu thụ control-plane API của `remote-cache` — consumer duy nhất là portal `remote-cache-app` qua BFF + private service binding (quyết định [#177](https://github.com/ecoma-io/ecoma/issues/177), thay tham chiếu "#556" đã hết giá trị) — không chạm database |

Enforcement authorization bên trong `remote-cache` resolve từ principal — API key ở data plane và portal; principal của con người trên control plane là quyết định còn mở (§4 của [`domain-model.md`](./domain-model.md)) — và dữ liệu của chính nó: **catalog govern / backend enforce** giữ nguyên hình dạng chung của hệ thống.

## 3. Ownership và storage

- Database `db-remote-cache`, PostgreSQL, schema `remote_cache` — [ADR-0015](./adr/0015-remote-cache-bounded-context.md) (canonical).
- Ba-role pattern `ecoma_owner` / `ecoma_remote_cache_migrator` / `ecoma_remote_cache_runtime`, chặn chéo `REVOKE CONNECT`, Hyperdrive riêng với query cache OFF (pattern ADR-0001/ADR-0013).
- Data plane đọc `db-remote-cache` mỗi request để xác thực API key, resolve project, kiểm lifecycle state và quota khi ghi ([ADR-0017](./adr/0017-lifecycle-enforcement.md)); routing configuration lấy từ config của Worker, không từ database. Cache artifact nằm trên object storage (B2) và là disposable data, không phải authoritative state.

## 4. Tài liệu

| Document                                                                                 | Nội dung                                                                                                       |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [`domain-model.md`](./domain-model.md)                                                   | Mô hình nghiệp vụ: tenant, project, membership, API key, quota, retention, usage, audit, lifecycle enforcement |
| [`adr/0015-remote-cache-bounded-context.md`](./adr/0015-remote-cache-bounded-context.md) | Xác lập bounded context, storage `db-remote-cache`, ranh giới tenant/entitlement                               |
| [`adr/0017-lifecycle-enforcement.md`](./adr/0017-lifecycle-enforcement.md)               | Cơ chế lifecycle enforcement ở data plane; thu hẹp một phần ADR-0015                                           |
| [`docs/applications/remote-cache/`](../../applications/remote-cache/README.md)           | Thiết kế deploy unit: boundary, request flow, storage partitioning, requirements, runbook                      |

Số `0015` và `0017` nối tiếp dải dùng chung với [`staff-access/adr/`](../staff-access/adr/README.md) (`0001…0014`, `0016`); `llm-financial/adr/` giữ dải riêng `0001…0010`, nên trích dẫn ADR phải nêu cả context. Quyết định nền tảng của hệ thống (A5, A9, A18, A20, invariant 6/14/22) nằm ở hệ thống, không nhân bản tại đây → [`../../architecture/01-architecture.md`](../../architecture/01-architecture.md) §8–§9. Thiết kế kỹ thuật của deploy unit → [`docs/applications/remote-cache/`](../../applications/remote-cache/README.md).
