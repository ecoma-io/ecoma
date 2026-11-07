# Remote Cache Service — Requirements

> Invariant kiến trúc: [`01-architecture.md`](./01-architecture.md) §13. Ranh giới hệ thống: [`docs/architecture/01-architecture.md`](../../architecture/01-architecture.md) A18, invariant 22. Ngữ nghĩa business của tenant, project, membership, API key, quota, retention, usage, audit và lifecycle enforcement → [`docs/domains/remote-cache/domain-model.md`](../../domains/remote-cache/domain-model.md) (canonical).
> File này chỉ chứa requirements (what/constraint + non-goals). `MUST` / `MUST NOT` / `SHOULD` giữ nguyên nghĩa. Mỗi requirement bắt buộc đều có một dòng verify trong §6.

---

## 1. Purpose

`cache` là self-hosted remote cache cho Nx, cung cấp cache artifact qua `cache.ecoma.io`, nhằm giảm thời gian CI và local development.

Mục tiêu:

- tương thích Nx Self-hosted Remote Cache;
- cô lập cache giữa các project;
- giữ cache **disposable**, không trở thành source of truth;
- vận hành được với chi phí và operational complexity thấp.

**Cache không được trở thành dependency bắt buộc để hệ thống build đúng.**

---

## 2. Users

| User              | Dùng cache để                                                                           |
| ----------------- | --------------------------------------------------------------------------------------- |
| **Developer**     | Đọc/ghi artifact; chỉ truy cập project được cấp quyền                                   |
| **CI**            | Đọc/ghi bằng credential riêng theo project/repository                                   |
| **Administrator** | Quản lý projects, API keys, storage backends/partitions, capacity, health, usage, audit |

---

## 3. Functional requirements

| #   | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Service MUST nói đúng Nx remote cache protocol: `GET /v1/cache/{hash}` và `PUT /v1/cache/{hash}`. Nx phải upload được, download được, nhận `404` khi miss và build tiếp bình thường sau miss                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| R2  | Mọi cache request MUST yêu cầu Bearer API key. Key MUST có entropy đủ cao, revoke được, expire được, **project-scoped**, có phân quyền read/write, và **không** lưu plaintext — secret chỉ hiển thị một lần lúc tạo                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R3  | Một credential của project này MUST NOT đọc hoặc ghi cache của project khác. Read-only credential MUST NOT ghi                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| R4  | Một cache hash đã tồn tại MUST NOT bị overwrite                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| R5  | Upload và download MUST stream end-to-end. Service MUST validate `Content-Length` tồn tại, > 0, không vượt maximum, và khớp số byte thực tế                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R6  | Service MUST lưu artifact trên object storage (MVP: Backblaze B2 qua S3-compatible API), và coi storage là **disposable**: artifact có thể expire, mất cache không mất source of truth, không cần backup, không cần migration khi đổi partition                                                                                                                                                                                                                                                                                                                                                                                                          |
| R7  | Cache MUST được logical-isolate theo project/namespace. Storage partition MUST **không** thay đổi authorization boundary. Thêm storage backend MUST NOT yêu cầu migrate cache hiện có                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| R8  | Cache MUST có retention hữu hạn; storage lifecycle MUST tự cleanup obsolete versions, incomplete uploads và artifact hết retention. MVP **không** yêu cầu application-level GC trên request path                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| R9  | Administrative operations MUST tách khỏi data path. Control plane MUST quản lý tenants, projects, memberships, API keys, storage backends, storage partitions, quota/usage, capacity state, lifecycle configuration. Data plane MUST **không** dùng database làm nơi lưu artifact, cấu hình routing hay administrative state. Data plane **có** đọc `db-remote-cache` mỗi request để xác thực API key, resolve project, kiểm lifecycle state tenant (fail-closed, [ADR-0017](../../domains/remote-cache/adr/0017-lifecycle-enforcement.md)) và kiểm quota/usage khi ghi; target "không phụ thuộc DB trong hot path" bị thu hẹp có chủ đích theo ADR-0017 |
| R10 | Admin API MUST là private control plane; public Internet chỉ cần expose `cache.ecoma.io`. Admin UI/BFF truy cập qua private service binding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R11 | Service MUST cung cấp `/health` và `/ready` để phân biệt _process đang sống_ với _service nhận được traffic_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| R12 | Service MUST cung cấp structured logs, request correlation ID, hit/miss, latency (request và storage), storage usage và auth failure. Secrets MUST **không** xuất hiện trong logs                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| R13 | Control plane MUST model tenant, project (mỗi project thuộc đúng một tenant), membership/role của người dùng trong tenant, và lifecycle state của tenant/project. Multi-tenancy là yêu cầu MVP, không phải mở rộng sau MVP                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R14 | Service MUST định nghĩa quota/usage semantics ở mức MVP: attribution theo project, không double-count khi retry hoặc upload đồng thời. Hành vi khi write vượt quota không được phá vỡ build correctness của caller: write vượt quota trả `429` non-fatal và caller coi như cache miss — hiện thực ở `apps/remote-cache/src/cache-routes.ts`                                                                                                                                                                                                                                                                                                              |
| R15 | Mọi administrative mutation (tenant/project/membership/API key/quota/retention) MUST tạo audit entry với actor, action, target, time, outcome; audit MUST query được qua control plane                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

---

## 4. Non-functional requirements

**Security:** HTTPS; Bearer auth; hash API key; enforce project-level authorization và explicit read/write permission; least-privilege storage credentials; audit administrative mutations; chống abuse ở auth/admin endpoint. CI credentials MUST project-scoped; **không** global write credential cho toàn ecosystem.

**Performance:** ưu tiên low request latency, direct streaming, low Worker memory, low dependency footprint, bursty CI traffic. Rate limiting MUST **không** đặt global RPS limit thấp một cách không cần thiết trên cache traffic bình thường; ưu tiên bảo vệ trước `authentication failures` → `admin operations` → `suspicious clients`. Per-project/per-key limits thêm khi workload thực tế yêu cầu.

**Reliability:** cache miss là hành vi bình thường (`GET → 404 → execute task`). Khi storage tạm thời unavailable, service MUST fail request rõ ràng, MUST **không** corrupt entry hiện có, MUST **không** retry mù one-shot request body, và dữ liệu cache hợp lệ phải giữ immutable.

---

## 5. Initial scope và non-goals

MVP là **multi-tenant**: tenant/project/membership/API key là control-plane state từ ngày đầu (R13); một storage backend (bucket) và một storage partition cho tới khi protocol và streaming được validate. Deployment shape mở rộng theo thứ tự multiple partitions → multiple backends sau đó; tenancy không nằm trong chuỗi mở rộng đó — nó là yêu cầu MVP.

`ecoma-cache` **không** phải: Nx Cloud · Nx Agents · distributed task execution · artifact registry · general-purpose object storage · backup · long-term artifact retention · Object Lock · arbitrary backend management · automatic cache migration · multi-region replication. Tương thích protocol cache khác không phải yêu cầu MVP.

---

## 6. Acceptance criteria

Mỗi dòng là một hành vi quan sát được.

### Nx contract

| #   | Kịch bản                                  | Kết quả mong đợi                    |
| --- | ----------------------------------------- | ----------------------------------- |
| A1  | local → remote cache → CI, cùng task hash | CI báo **cache hit**                |
| A2  | Nx `PUT` artifact rồi `GET` lại           | Nội dung khớp byte-for-byte         |
| A3  | `GET` hash chưa tồn tại                   | `404`, Nx thực thi task bình thường |

### Authentication và authorization

| #   | Kịch bản                                      | Kết quả mong đợi                 |
| --- | --------------------------------------------- | -------------------------------- |
| A4  | Bearer token hợp lệ                           | `2xx`                            |
| A5  | Token sai hoặc thiếu                          | `401`                            |
| A6  | Token đã revoke                               | Bị từ chối                       |
| A7  | Read-only key gọi `PUT`                       | `403`                            |
| A8  | Credential project A truy cập cache project B | Bị từ chối                       |
| A9  | Key lưu trong state                           | Chỉ cryptographic representation |

### Immutability và streaming

| #   | Kịch bản                                             | Kết quả mong đợi                   |
| --- | ---------------------------------------------------- | ---------------------------------- |
| A10 | `PUT` hash đã tồn tại                                | `409`, artifact cũ **không** đổi   |
| A11 | Upload artifact lớn                                  | Thành công, không buffer toàn bộ   |
| A12 | Download artifact lớn                                | Stream về Nx, không buffer toàn bộ |
| A13 | `Content-Length` thiếu / 0 / vượt maximum / sai khớp | Bị từ chối                         |

### Storage và resilience

| #   | Kịch bản                                 | Kết quả mong đợi                                     |
| --- | ---------------------------------------- | ---------------------------------------------------- |
| A14 | Single B2 backend                        | Toàn bộ chức năng cache hoạt động                    |
| A15 | Storage lifecycle cleanup                | Object hết retention bị xoá, không cần scan thủ công |
| A16 | B2 unavailable                           | Request fail rõ ràng; **entry cũ không bị corrupt**  |
| A17 | Cache unavailable (disable remote cache) | Task chạy lại được, **không** mất correctness        |
| A18 | Đổi/thêm storage partition               | Không migrate cache cũ; routing ổn định              |

### Operations

| #   | Kịch bản                                       | Kết quả mong đợi                              |
| --- | ---------------------------------------------- | --------------------------------------------- |
| A19 | `/health`, `/ready`                            | Phân biệt được alive vs sẵn sàng nhận traffic |
| A20 | Structured logs + request ID + hit/miss metric | Truy vết được một request                     |
| A21 | Secrets xuất hiện trong logs                   | Không có                                      |

### Multi-tenancy và control plane

| #   | Kịch bản                                                                            | Kết quả mong đợi                                                                  |
| --- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| A22 | Tenant A và tenant B cùng hash                                                      | Artifact của A không đọc/ghi được bằng credential của B                           |
| A23 | Credential scoped project A (tenant A) với ID project B (tenant B) do client tự gửi | Bị từ chối — scope resolve từ principal, không từ body/URL                        |
| A24 | Tenant/project không ở trạng thái `active` (suspended/deleted)                      | Write/read bị từ chối (fail-closed) — kể cả khi cached configuration chưa refresh |
| A25 | Administrative mutation (key/membership/project/quota)                              | Có audit entry với actor/action/target/time/outcome                               |
| A26 | Upload retry sau khi request đầu đã ghi đủ artifact                                 | Usage không bị double-count                                                       |

---

## 7. Success criteria

MVP thành công khi hai tenant trở lên dùng đồng thời service ([`03-operations.md`](./03-operations.md) §4) và đạt đồng thời: cache hit hoạt động · cache miss hoạt động · CI publish cache an toàn · project không đọc được cache của nhau (kể cả cross-tenant) · artifact lớn stream đúng · storage disposable · cache failure không ảnh hưởng build correctness · quota/usage/audit hoạt động ở mức MVP · service deploy/observe/operate được mà không thêm hạ tầng không cần thiết.
