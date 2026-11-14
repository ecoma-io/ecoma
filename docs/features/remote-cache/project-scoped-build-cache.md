# Build cache theo project

> **Feature area:** `remote-cache/` · **Mô tả một dòng:** developer và CI chia sẻ artifact build của Nx qua một remote cache tự vận hành, cách ly theo tenant và project.
>
> Đặc tả domain → [`domains/remote-cache/`](../../domains/remote-cache/README.md) · thiết kế deploy unit → [`applications/remote-cache/`](../../applications/remote-cache/README.md) · quy tắc viết → [`../README.md`](../README.md).

## 1. Problem

Một Nx workspace tính lại cùng một target trên nhiều máy và nhiều lần chạy CI, dù input không đổi. Developer chờ build lặp lại, CI tốn thời gian cho công việc đã có kết quả, và không có chỗ chia sẻ artifact giữa máy cá nhân với pipeline.

Dịch vụ cache công khai không phù hợp: mã nguồn và artifact build của tổ chức không được gửi ra ngoài, và nhiều project trong cùng một tổ chức phải không đọc được cache của nhau.

## 2. Outcome

Hệ thống lưu và trả lại cache entry theo nội dung, để một lần chạy sau lấy lại kết quả của lần chạy trước thay vì tính lại.

- Mỗi entry được định danh bằng hash do Nx tính từ input của target; cùng hash nghĩa là cùng artifact.
- Dữ liệu cách ly theo **tenant** rồi theo **project**: một project không đọc được entry của project khác, kể cả khi hash trùng và kể cả khi hai project cùng tenant.
- Entry là **immutable**: hash đã tồn tại thì không ghi đè; lần ghi thứ hai bị từ chối và bản gốc vẫn đọc được.
- Truy cập cần API key có scope tương ứng với thao tác; ghi còn cần key được đánh dấu tin cậy cho CI.
- Entry có kích thước lớn được truyền theo stream, không cần đọc trọn vào bộ nhớ.
- Tenant bị treo hoặc đã xoá không đọc và không ghi được cache.
- Khi vượt quota, lần ghi bị từ chối với 429 và không object nào được ghi. Repo không có test nào chứng minh phía client Nx coi 429 là cache miss rồi tiếp tục build.

## 3. Scope

### Bao gồm

**Data plane — cache protocol (đã hiện thực):**

- `GET /v1/cache/:hash` — đọc một entry của project gắn với API key.
- `PUT /v1/cache/:hash` — ghi một entry mới; từ chối khi hash đã tồn tại, khi thiếu scope `write`, khi key không tin cậy, hoặc khi vượt quota.
- Xác thực bằng bearer API key, kèm kiểm tra vòng đời tenant trước khi phục vụ.
- Cách ly object theo cặp `tenant` + `project` ở cả metadata và object storage.
- Đếm usage theo project, ghi audit cho lần ghi cache được cho phép và lần bị từ chối vì quota.
- `GET /health` và `GET /ready` cho vận hành.

**Control plane — developer portal (mục tiêu M1; quyết định phạm vi tại [#177](https://github.com/ecoma-io/ecoma/issues/177)):**

`remote-cache-app` là **Internal Developer Portal** — developer Ecoma tự phụ trách onboarding: lấy credential và cấu hình client Nx của mình cho Remote Cache, không cần vận hành can thiệp. Yêu cầu chức năng:

- Đăng nhập developer bằng Ecoma Account; quyền resolve từ membership của tenant sản phẩm (`ecoma` là tenant đầu tiên). Không có self-registration của khách hàng.
- Liệt kê project, tạo project, xem chi tiết project.
- Tạo thêm API key cho project, liệt kê metadata key (không lộ secret), revoke key; secret của key mới chỉ hiển thị đúng một lần.
- Phân biệt rõ ràng developer credential và trusted CI credential; trusted CI semantics không bị nới vì developer credential.
- Hướng dẫn cấu hình Nx copy được (endpoint + credential) kèm first-use workflow thực dụng.
- Portal truy cập control plane riêng tư qua BFF + private service binding (R10); Admin API không bao giờ public chỉ để phục vụ UI.

Trạng thái hiện thực từng yêu cầu portal — bảng dưới là nguồn thật; **control plane API đã hiện thực và có integration test** ([#202](https://github.com/ecoma-io/ecoma/issues/202), đã merge); **portal app (`remote-cache-app`) vẫn là scaffold** — composition UI thuộc [#180](https://github.com/ecoma-io/ecoma/issues/180):

| Yêu cầu                 | Hiện trạng (đã verify trên code)                                                                                                                                                                                                                         | Hành vi bắt buộc                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Đăng nhập + quyền       | Control plane xác thực qua envelope HMAC nội bộ mang actor đã xác thực; membership resolve từ database ([ADR-0034](../../domains/remote-cache/adr/0034-human-principal-control-plane-authorization.md)) — portal chưa có đường xác thực người (scaffold) | Người đã xác thực có membership thao tác được; người ngoài membership bị từ chối mọi thao tác control plane       |
| Bootstrap tenant nội bộ | Tenant `ecoma` + membership owner + host project + first trusted CI key được provision qua `apps/remote-cache-api/db/bootstrap-tenant.mts` (bề mặt provisioning ADR-0020)                                                                                | Onboarding developer không đòi thao tác database, bootstrap credential, hay key máy có trước                      |
| Tạo project + key đầu   | Đã hiện thực: developer có membership tạo được project + key đầu tiên **không cần key tin cậy có trước** (`portal-routes.ts`, integration `portal-control-plane.spec.ts` R18)                                                                            | Người đã xác thực có membership tạo được project và key đầu tiên của mình qua portal                              |
| List/create/revoke key  | Đã hiện thực: list metadata không lộ secret, tạo key show-once, revoke key; revoke có hiệu lực ở data plane từ request đầu tiên (R19, R20)                                                                                                               | Tạo thêm key (show-once), list metadata không lộ secret, revoke; key đã revoke bị data plane từ chối              |
| Developer vs trusted CI | `trusted_ci` tồn tại ở schema và route; developer credential không trusted — PUT cache bằng developer credential trả 403 (R20); class immutability enforce qua column-level grants + không có code path đổi class                                        | Developer credential không trusted, phân biệt tường minh với trusted CI trong UI và API; write vẫn đòi trusted    |
| Nx onboarding           | Chưa có — biến `NX_SELF_HOSTED_REMOTE_CACHE_*` chỉ xuất hiện trong tài liệu, không có trong code hay CI (A33, thuộc #180)                                                                                                                                | Nội dung copy được kèm first-use workflow trên portal                                                             |
| BFF + private binding   | Control plane là route của cùng deploy unit `remote-cache-api`; portal app vẫn là scaffold shell, chưa có authentication hay BFF; deploy unit app `scaffold`                                                                                             | BFF giữ token server-side, session store thuộc `account`; control plane chỉ reachable qua private service binding |

### Không bao gồm

- **Tương thích Nx CLI end-to-end chưa được verify.** Repository không có system test nào chạy client Nx thật qua remote cache; các biến `NX_SELF_HOSTED_REMOTE_CACHE_*` chỉ xuất hiện trong tài liệu, không có trong code hay CI. Kiểm chứng hiện tại dừng ở mức HTTP.
- **Chưa có route list/revoke API key.** Trước đây mục này được ghi là exclusion; từ quyết định [#177](https://github.com/ecoma-io/ecoma/issues/177) list/create thêm key/revoke là **yêu cầu M1 của portal** (bảng trạng thái ở trên). **Đã hiện thực ở tầng control plane API** (#202 — route + integration test `portal-control-plane.spec.ts`); phần còn thiếu là portal UI (#180) gọi các route đó.
- **Không có endpoint cấu hình quota, không có endpoint đọc usage hay audit.** Đây là gap hiện trạng (chưa có route), không phải non-goal nghiệp vụ: audit vẫn thuộc mục tiêu control plane (R15) và quota vẫn là semantics MVP của data plane. Quota mặc định không giới hạn (`DEFAULT_MAX_STORAGE_BYTES` và `DEFAULT_MAX_ENTRY_COUNT` bằng `0` nghĩa là unlimited).
- **Retention chưa chạy.** Cột `expires_at` và index tồn tại, code đọc nó khi phục vụ. Code chỉ ghi giá trị tương lai khi `DEFAULT_RETENTION_TTL_SECONDS` được cấu hình — biến này chưa có trong `wrangler.jsonc` hay CI, nên trên cấu hình hiện tại cột luôn `NULL`. Không có job xoá row hay object hết hạn.
- **Provisioning tenant/membership vẫn chỉ qua đường bootstrap.** Tạo project và key đầu tiên qua portal là yêu cầu M1 (bảng trạng thái ở trên); việc tạo tenant, thêm/xoá membership và host project của key CI vẫn thuộc bề mặt provisioning ADR-0020, không có UI/API nào trong M1. Hiện trạng: `POST /projects` đòi key tin cậy scope `write`, nên không có đường người dùng nào hôm nay.
- **Vùng control plane portal đã được test đủ ở tầng API.** Suite `apps/remote-cache-api/tests/integrations/portal-control-plane.spec.ts` (14 test) phủ: project+key đầu tiên không cần key tin cậy có trước (R18), show-once không bao giờ lặp lại, cách ly tenant, non-member bị từ chối (R17), tenant suspended 409, revoke hiệu lực ở data plane (R20), replay/bad-signature 401, fail-closed 503 thiếu secret nội bộ. Route cache máy (trusted key) có integration test riêng (`control-plane-routes.spec.ts`) và route surface có unit test (`src/main.spec.ts`); error handler và adapter `S3ObjectStorage` vẫn không có test.
- **Chưa có deploy unit thật cho portal app.** `wrangler.jsonc` của `remote-cache-api` còn Hyperdrive id rỗng; deployment project của `remote-cache-app` ở trạng thái `scaffold`. Đây là giới hạn triển khai, không phải hành vi của Feature. Smoke của data plane tồn tại: `remote-cache-api-deploy:local-smoke` chạy E2E thật qua HTTP worker (bootstrap tenant → POST /projects show-once → PUT → GET byte-equal).
- **Không có metric hit/miss/latency/storage**, không có structured logging ngoài `requestId` + error code.
- Quản lý tenant, membership và phân vùng storage (`ACTIVE`/`DRAINING`/`FULL`/`DISABLED`) chỉ có trong tài liệu kiến trúc.

**Portal không bao gồm** (quyết định [#177](https://github.com/ecoma-io/ecoma/issues/177)):

- Customer self-registration; admin multi-tenant dùng chung cho khách hàng.
- Tạo tenant, admin membership, RBAC phức tạp hay tổ chức.
- Billing, subscription, payment.
- Admin storage backend; UI cấu hình quota/retention.
- Advanced analytics và reporting.

## 4. Acceptance Scenarios

```text
Cho  một project có API key scope `read write`, đánh dấu trusted CI
Khi  PUT một hash chưa tồn tại kèm nội dung
Thì  nhận 201 kèm `{ hash, size }`, và GET cùng hash sau đó trả lại đúng nội dung
```

```text
Cho  hash đã được ghi trước đó cho project này
Khi  PUT lại cùng hash
Thì  nhận 409, và nội dung gốc vẫn đọc được nguyên vẹn
```

```text
Cho  hai project ở hai tenant khác nhau cùng ghi một hash
Khi  project của tenant kia GET hash đó
Thì  nhận 404 — không có dữ liệu của tenant khác
```

```text
Cho  API key chỉ có scope `read`
Khi  PUT một entry
Thì  nhận 403 và không có entry nào được tạo
```

```text
Cho  API key thiếu, rỗng, sai, hoặc đã bị revoke
Khi  GET hoặc PUT
Thì  nhận 401
```

```text
Cho  API key hợp lệ nhưng không được đánh dấu trusted CI
Khi  PUT một entry
Thì  nhận 403
```

```text
Cho  project chưa đạt quota
Khi  PUT một entry
Thì  nhận 201, usage counter tăng, và audit ghi nhận `cache_put` / `allowed`
```

```text
Cho  project đã đạt quota dung lượng hoặc số entry
Khi  PUT một entry
Thì  nhận 429, counter không đổi, không object nào được ghi, audit ghi nhận `quota_exceeded` / `denied`
```

```text
Cho  tenant ở trạng thái suspended hoặc deleted
Khi  GET hoặc PUT cache
Thì  nhận 409 và không thao tác nào được thực hiện
```

```text
Cho  một tenant đã có API key tin cậy
Khi  tạo project mới
Thì  nhận 201 kèm project và token của API key đầu tiên, và token đó không xuất hiện lại ở bất kỳ response nào khác
```

Các scenario portal dưới đây là mục tiêu M1 (quyết định [#177](https://github.com/ecoma-io/ecoma/issues/177)). **Các scenario control-plane đã có implementation và integration test ở tầng API** (#202); **các scenario bề mặt portal (đăng nhập, UI, Nx onboarding) chưa có implementation** — thuộc [#180](https://github.com/ecoma-io/ecoma/issues/180):

```text
Cho  một developer là member của tenant `ecoma`, chưa có API key Remote Cache nào
Khi  đăng nhập portal bằng Ecoma Account và tạo project
Thì  nhận project kèm secret key chỉ hiện đúng một lần — không cần thao tác database, bootstrap credential hay key máy có trước
```

```text
Cho  một người đã xác thực bằng Ecoma Account nhưng không có membership trong tenant
Khi  gọi bất kỳ thao tác control plane qua portal
Thì  bị từ chối — quyền resolve từ membership của tenant sản phẩm, không từ trạng thái đăng nhập
```

```text
Cho  một project có nhiều API key
Khi  list key metadata trên portal
Thì  thấy scopes, cờ trusted CI và thời điểm tạo của từng key, nhưng không thấy secret của key nào
```

```text
Cho  một key vừa bị revoke qua portal
Khi  data plane GET hoặc PUT bằng key đó
Thì  nhận 401 ở lần request đầu tiên sau revoke
```

```text
Cho  một developer credential do portal tạo (không trusted)
Khi  PUT cache bằng credential đó
Thì  nhận 403 — trusted CI semantics giữ nguyên, không nới vì developer credential
```

```text
Cho  một developer vừa tạo project
Khi  mở trang onboarding Nx của portal
Thì  có hướng dẫn copy được endpoint + credential và một first-use workflow chạy được
```

```text
Cho  một project đã có ít nhất một key
Khi  tạo thêm key mới từ portal
Thì  secret của key mới chỉ hiện đúng một lần, và không response nào khác trả lại nó
```

```text
Cho  portal đang chạy trên lane
Khi  quan sát đường mạng của nó tới control plane
Thì  chỉ có private service binding — Admin API không có endpoint public nào
```

## 5. Domain & Application Mapping

| Domain / Application             | Vai trò trong Feature                                                                                                                                  | Canonical                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `remote-cache` (bounded context) | Sở hữu tenant, project, membership, API key, cache entry, quota, usage và audit; database `db-remote-cache`                                            | [`domains/remote-cache/`](../../domains/remote-cache/README.md)           |
| `apps/remote-cache-api`          | Deploy unit duy nhất phục vụ cả data plane cache và control plane project                                                                              | [`applications/remote-cache/`](../../applications/remote-cache/README.md) |
| `apps/remote-cache-app`          | Internal Developer Portal — onboarding developer (đăng nhập, project, API key, hướng dẫn Nx); truy cập control plane qua BFF + private service binding | [`applications/remote-cache/`](../../applications/remote-cache/README.md) |
| `libs/remote-cache-*`            | Domain, application và infrastructure của context — kiểm tra scope, quota, repository                                                                  | [`05-code-architecture.md`](../../architecture/05-code-architecture.md)   |

Object storage là dependency ngoài (S3-compatible), không phải domain; khoá lưu object mang cả tenant và project để cách ly.

## 6. Verification Mapping

Test thật nằm trong `apps/remote-cache-api/tests/` và chạy qua target `test-integration` (integration app-owned) hoặc `test` (unit colocated). Mọi integration spec dùng PostgreSQL 17 thật qua testcontainers; storage được thay bằng `InMemoryObjectStorage`. **Không có system test** nào cho Feature này.

| Scenario                                                                                                                               | Test file / suite                                                             | Loại test      | Nx target                             |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------- | ------------------------------------- |
| PUT rồi GET trả lại đúng nội dung; GET miss trả 404                                                                                    | `apps/remote-cache-api/tests/integrations/cache.spec.ts`                      | integration    | `test-integration`                    |
| PUT trùng hash trả 409 và giữ nguyên bản gốc                                                                                           | `cache.spec.ts`, `cache-p45.spec.ts`                                          | integration    | `test-integration`                    |
| Cách ly theo tenant/project; project cùng tên ở hai tenant là hai tài nguyên                                                           | `cache-p45.spec.ts`                                                           | integration    | `test-integration`                    |
| Thiếu scope `read`/`write` trả 403; key thiếu/rỗng/revoked trả 401; key không trusted trả 403                                          | `cache.spec.ts`, `cache-p45.spec.ts`                                          | integration    | `test-integration`                    |
| Tenant suspended/deleted trả 409 cho cả GET và PUT                                                                                     | `cache.spec.ts`                                                               | integration    | `test-integration`                    |
| Ghi dưới quota thành công, tăng counter, ghi audit `allowed`; vượt quota trả 429 và không ghi object                                   | `apps/remote-cache-api/tests/integrations/cache-p43.spec.ts`                  | integration    | `test-integration`                    |
| Entry hết hạn không đọc được                                                                                                           | `cache-p43.spec.ts`                                                           | integration    | `test-integration`                    |
| `audit_log` từ chối UPDATE/DELETE từ role runtime; grant chính xác của schema                                                          | `cache-p43.spec.ts`, `apps/remote-cache-api/tests/integrations/roles.spec.ts` | integration    | `test-integration`                    |
| Migration chạy được, idempotent, giữ đúng CHECK constraint                                                                             | `apps/remote-cache-api/tests/databases/migrations.spec.ts`                    | database       | `test-integration`                    |
| Route cache ở mức unit với repository giả                                                                                              | `apps/remote-cache-api/src/cache-routes.spec.ts`, `src/cache-p43.spec.ts`     | unit           | `test`                                |
| Tạo project bằng trusted key (show-once), 409 trùng tên, 403 không trusted, 401 key revoked, 409 tenant suspended, GET listing         | `apps/remote-cache-api/tests/integrations/control-plane-routes.spec.ts`       | integration    | `test-integration`                    |
| Project + key đầu tiên bằng developer membership (không cần key tin cậy, R18); show-once không lặp; non-member bị từ chối (R17)        | `apps/remote-cache-api/tests/integrations/portal-control-plane.spec.ts`       | integration    | `test-integration`                    |
| List metadata key không lộ secret (R19); revoke key hiệu lực ở data plane từ request đầu (R20); developer credential PUT cache bị chặn | cùng file trên                                                                | integration    | `test-integration`                    |
| Envelope nội bộ: replay/bad-signature/no-actor 401; fail-closed 503 thiếu secret                                                       | cùng file trên                                                                | integration    | `test-integration`                    |
| Smoke data plane trên deploy thật: bootstrap tenant → tạo project show-once → PUT → GET byte-equal                                     | `deploys/remote-cache-api-deploy/smoke.ts`                                    | system (smoke) | `remote-cache-api-deploy:local-smoke` |

**Giới hạn của verification hiện tại:**

- `POST /projects`, `GET /projects` đã có integration test (`control-plane-routes.spec.ts`); `/health`, `/ready` và route surface có unit test (`main.spec.ts`). Error handler, `config.ts`, `cursor.ts` và `S3ObjectStorage` **không có test riêng**. Scenario tạo project bằng key tin cậy ở §4 có bằng chứng verification qua suite integration đó.
- 413 (payload quá lớn), 503 (storage chưa cấu hình), 400 (hash sai, thiếu `Content-Length`, body rỗng) và nhánh `payload_too_large` **không có test**.
- Không có test nào chứng minh Nx client thật dùng được cache; toàn bộ kiểm chứng dừng ở HTTP.
- **Các scenario control-plane portal đã có bằng chứng integration** (`portal-control-plane.spec.ts` — project/key lifecycle, membership authorization, show-once, revoke hiệu lực ở data plane, cách ly tenant). **Các scenario bề mặt portal** (đăng nhập Ecoma Account, UI project/key, Nx onboarding, private binding qua BFF) **chưa có implementation lẫn test** — thuộc [#180](https://github.com/ecoma-io/ecoma/issues/180), tầng browser regression của `apps/remote-cache-app`, gắn `test-integration`.
- Sự tồn tại của các spec trên không chứng minh chúng đã chạy và pass. Kết luận `Verified` cần kết quả chạy của `test` và `test-integration`.
