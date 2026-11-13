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

Trạng thái hiện thực từng yêu cầu portal — bảng dưới là nguồn thật; **tất cả các hàng portal hiện chưa có bằng chứng hiện thực**, hiện thực thuộc [#180](https://github.com/ecoma-io/ecoma/issues/180) và issue control-plane API kế nhiệm nó:

| Yêu cầu                 | Hiện trạng (đã verify trên code)                                                                                                                                          | Hành vi bắt buộc                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Đăng nhập + quyền       | Không có đường xác thực người; control plane chỉ xác thực API key (`requireApiKey`)                                                                                       | OIDC qua Ecoma Account; membership tenant sản phẩm là nguồn quyền; người ngoài membership bị từ chối mọi thao tác control plane |
| Bootstrap tenant nội bộ | Tenant `ecoma` + membership owner + host project + first trusted CI key được provision qua `apps/remote-cache-api/db/bootstrap-tenant.mts` (bề mặt provisioning ADR-0020) | Onboarding developer không đòi thao tác database, bootstrap credential, hay key máy có trước                                    |
| Tạo project + key đầu   | `POST /projects` hiện thực nhưng đòi key tin cậy scope `write` → circular dependency onboarding (xuất hiện trong hiện trạng, không phải behavior mục tiêu)                | Người đã xác thực có membership tạo được project và key đầu tiên của mình qua portal                                            |
| List/create/revoke key  | Không có route; repository function có sẵn chưa nối route (`revokeApiKey`, `getApiKeyById`); contract chỉ có wire shape project create/list                               | Tạo thêm key (show-once), list metadata không lộ secret, revoke; key đã revoke bị data plane từ chối                            |
| Developer vs trusted CI | `trusted_ci` tồn tại ở schema và route (ghi đòi key tin cậy); domain model chưa ghi phân lớp credential                                                                   | Developer credential không trusted, phân biệt tường minh với trusted CI trong UI và API; write vẫn đòi trusted                  |
| Nx onboarding           | Chưa có — biến `NX_SELF_HOSTED_REMOTE_CACHE_*` chỉ xuất hiện trong tài liệu, không có trong code hay CI                                                                   | Nội dung copy được kèm first-use workflow trên portal                                                                           |
| BFF + private binding   | App là scaffold shell, chưa có authentication hay BFF; deploy unit `scaffold`                                                                                             | BFF giữ token server-side, session store thuộc `account`; control plane chỉ reachable qua private service binding               |

### Không bao gồm

- **Tương thích Nx CLI end-to-end chưa được verify.** Repository không có system test nào chạy client Nx thật qua remote cache; các biến `NX_SELF_HOSTED_REMOTE_CACHE_*` chỉ xuất hiện trong tài liệu, không có trong code hay CI. Kiểm chứng hiện tại dừng ở mức HTTP.
- **Chưa có route list/revoke API key.** Trước đây mục này được ghi là exclusion; từ quyết định [#177](https://github.com/ecoma-io/ecoma/issues/177) list/create thêm key/revoke là **yêu cầu M1 của portal** (bảng trạng thái ở trên) — hiện là gap thuộc [#180](https://github.com/ecoma-io/ecoma/issues/180): hàm repository tồn tại nhưng chưa có route gọi tới, thu hồi key hiện phải làm ở tầng dữ liệu.
- **Không có endpoint cấu hình quota, không có endpoint đọc usage hay audit.** Quota mặc định không giới hạn (`DEFAULT_MAX_STORAGE_BYTES` và `DEFAULT_MAX_ENTRY_COUNT` bằng `0` nghĩa là unlimited).
- **Retention chưa chạy.** Cột `expires_at` và index tồn tại, code đọc nó khi phục vụ. Code chỉ ghi giá trị tương lai khi `DEFAULT_RETENTION_TTL_SECONDS` được cấu hình — biến này chưa có trong `wrangler.jsonc` hay CI, nên trên cấu hình hiện tại cột luôn `NULL`. Không có job xoá row hay object hết hạn.
- **Provisioning tenant/membership vẫn chỉ qua đường bootstrap.** Tạo project và key đầu tiên qua portal là yêu cầu M1 (bảng trạng thái ở trên); việc tạo tenant, thêm/xoá membership và host project của key CI vẫn thuộc bề mặt provisioning ADR-0020, không có UI/API nào trong M1. Hiện trạng: `POST /projects` đòi key tin cậy scope `write`, nên không có đường người dùng nào hôm nay.
- **Control plane chưa được test.** `POST /projects` và `GET /projects` không có test nào; `/health`, `/ready`, error handler và adapter `S3ObjectStorage` cũng vậy.
- **Chưa có deploy unit thật.** `wrangler.jsonc` còn Hyperdrive id rỗng và không có route; deployment project ở trạng thái `scaffold`. Đây là giới hạn triển khai, không phải hành vi của Feature.
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

Các scenario portal dưới đây là mục tiêu M1 (quyết định [#177](https://github.com/ecoma-io/ecoma/issues/177)) — chưa có bằng chứng verification, hiện thực và test thuộc [#180](https://github.com/ecoma-io/ecoma/issues/180):

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

| Scenario                                                                                             | Test file / suite                                                             | Loại test   | Nx target          |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------- | ------------------ |
| PUT rồi GET trả lại đúng nội dung; GET miss trả 404                                                  | `apps/remote-cache-api/tests/integrations/cache.spec.ts`                      | integration | `test-integration` |
| PUT trùng hash trả 409 và giữ nguyên bản gốc                                                         | `cache.spec.ts`, `cache-p45.spec.ts`                                          | integration | `test-integration` |
| Cách ly theo tenant/project; project cùng tên ở hai tenant là hai tài nguyên                         | `cache-p45.spec.ts`                                                           | integration | `test-integration` |
| Thiếu scope `read`/`write` trả 403; key thiếu/rỗng/revoked trả 401; key không trusted trả 403        | `cache.spec.ts`, `cache-p45.spec.ts`                                          | integration | `test-integration` |
| Tenant suspended/deleted trả 409 cho cả GET và PUT                                                   | `cache.spec.ts`                                                               | integration | `test-integration` |
| Ghi dưới quota thành công, tăng counter, ghi audit `allowed`; vượt quota trả 429 và không ghi object | `apps/remote-cache-api/tests/integrations/cache-p43.spec.ts`                  | integration | `test-integration` |
| Entry hết hạn không đọc được                                                                         | `cache-p43.spec.ts`                                                           | integration | `test-integration` |
| `audit_log` từ chối UPDATE/DELETE từ role runtime; grant chính xác của schema                        | `cache-p43.spec.ts`, `apps/remote-cache-api/tests/integrations/roles.spec.ts` | integration | `test-integration` |
| Migration chạy được, idempotent, giữ đúng CHECK constraint                                           | `apps/remote-cache-api/tests/databases/migrations.spec.ts`                    | database    | `test-integration` |
| Route cache ở mức unit với repository giả                                                            | `apps/remote-cache-api/src/cache-routes.spec.ts`, `src/cache-p43.spec.ts`     | unit        | `test`             |

**Giới hạn của verification hiện tại:**

- `POST /projects`, `GET /projects`, `/health`, `/ready`, error handler, `config.ts`, `cursor.ts` và `S3ObjectStorage` **không có test**. Các scenario tạo project ở §4 vì vậy chưa có bằng chứng verification.
- 413 (payload quá lớn), 503 (storage chưa cấu hình), 400 (hash sai, thiếu `Content-Length`, body rỗng) và nhánh `payload_too_large` **không có test**.
- Không có test nào chứng minh Nx client thật dùng được cache; toàn bộ kiểm chứng dừng ở HTTP.
- Các scenario portal (đăng nhập, membership authorization, key lifecycle, revoke hiệu lực ở data plane, Nx onboarding) **chưa có implementation lẫn test** — verification của chúng thuộc [#180](https://github.com/ecoma-io/ecoma/issues/180): integration control plane của `apps/remote-cache-api` và browser regression của `apps/remote-cache-app`, gắn `test-integration`.
- Sự tồn tại của các spec trên không chứng minh chúng đã chạy và pass. Kết luận `Verified` cần kết quả chạy của `test` và `test-integration`.
