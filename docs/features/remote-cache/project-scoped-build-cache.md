# Build cache theo project

> **Product area:** `remote-cache/` · **Mô tả một dòng:** developer và CI chia sẻ artifact build của Nx qua một remote cache tự vận hành, cách ly theo tenant và project.
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

- `GET /v1/cache/:hash` — đọc một entry của project gắn với API key.
- `PUT /v1/cache/:hash` — ghi một entry mới; từ chối khi hash đã tồn tại, khi thiếu scope `write`, khi key không tin cậy, hoặc khi vượt quota.
- Xác thực bằng bearer API key, kèm kiểm tra vòng đời tenant trước khi phục vụ.
- Cách ly object theo cặp `tenant` + `project` ở cả metadata và object storage.
- Đếm usage theo project, ghi audit cho lần ghi cache được cho phép và lần bị từ chối vì quota.
- `POST /projects` — tạo project kèm API key đầu tiên; secret chỉ trả về đúng một lần trong response.
- `GET /projects` — liệt kê project của tenant, phân trang bằng cursor.
- `GET /health` và `GET /ready` cho vận hành.

### Không bao gồm

- **Tương thích Nx CLI end-to-end chưa được verify.** Repository không có system test nào chạy client Nx thật qua remote cache; các biến `NX_SELF_HOSTED_REMOTE_CACHE_*` chỉ xuất hiện trong tài liệu, không có trong code hay CI. Kiểm chứng hiện tại dừng ở mức HTTP.
- **Không có rotation hay revoke API key qua HTTP.** Hàm repository tồn tại nhưng không có route gọi tới; thu hồi key hiện phải làm ở tầng dữ liệu.
- **Không có endpoint cấu hình quota, không có endpoint đọc usage hay audit.** Quota mặc định không giới hạn (`DEFAULT_MAX_STORAGE_BYTES` và `DEFAULT_MAX_ENTRY_COUNT` bằng `0` nghĩa là unlimited).
- **Retention chưa chạy.** Cột `expires_at` và index tồn tại, code đọc nó khi phục vụ. Code chỉ ghi giá trị tương lai khi `DEFAULT_RETENTION_TTL_SECONDS` được cấu hình — biến này chưa có trong `wrangler.jsonc` hay CI, nên trên cấu hình hiện tại cột luôn `NULL`. Không có job xoá row hay object hết hạn.
- **Chưa có provisioning tenant, membership hay project đầu tiên qua UI/API.** `POST /projects` đòi key tin cậy đã có scope `write`, nên lần tạo project đầu tiên của một tenant phải làm trực tiếp trên database.
- **Control plane chưa được test.** `POST /projects` và `GET /projects` không có test nào; `/health`, `/ready`, error handler và adapter `S3ObjectStorage` cũng vậy.
- **Chưa có deploy unit thật.** `wrangler.jsonc` còn Hyperdrive id rỗng và không có route; deployment project ở trạng thái `scaffold`. Đây là giới hạn triển khai, không phải hành vi của Feature.
- **Không có metric hit/miss/latency/storage**, không có structured logging ngoài `requestId` + error code.
- Quản lý tenant, membership và phân vùng storage (`ACTIVE`/`DRAINING`/`FULL`/`DISABLED`) chỉ có trong tài liệu kiến trúc.

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

## 5. Domain & Application Mapping

| Domain / Application             | Vai trò trong Feature                                                                           | Canonical                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `remote-cache` (bounded context) | Sở hữu tenant, project, API key, cache entry, quota, usage và audit; database `db-remote-cache` | [`domains/remote-cache/`](../../domains/remote-cache/README.md)           |
| `apps/remote-cache`              | Deploy unit duy nhất phục vụ cả data plane cache và control plane project                       | [`applications/remote-cache/`](../../applications/remote-cache/README.md) |
| `libs/remote-cache-*`            | Domain, application và infrastructure của context — kiểm tra scope, quota, repository           | [`05-code-architecture.md`](../../architecture/05-code-architecture.md)   |

Object storage là dependency ngoài (S3-compatible), không phải domain; khoá lưu object mang cả tenant và project để cách ly.

## 6. Verification Mapping

Test thật nằm trong `apps/remote-cache/tests/` và chạy qua target `test-integration` (integration app-owned) hoặc `test` (unit colocated). Mọi integration spec dùng PostgreSQL 17 thật qua testcontainers; storage được thay bằng `InMemoryObjectStorage`. **Không có system test** nào cho Feature này.

| Scenario                                                                                             | Test file / suite                                                         | Loại test   | Nx target          |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------- | ------------------ |
| PUT rồi GET trả lại đúng nội dung; GET miss trả 404                                                  | `apps/remote-cache/tests/integrations/cache.spec.ts`                      | integration | `test-integration` |
| PUT trùng hash trả 409 và giữ nguyên bản gốc                                                         | `cache.spec.ts`, `cache-p45.spec.ts`                                      | integration | `test-integration` |
| Cách ly theo tenant/project; project cùng tên ở hai tenant là hai tài nguyên                         | `cache-p45.spec.ts`                                                       | integration | `test-integration` |
| Thiếu scope `read`/`write` trả 403; key thiếu/rỗng/revoked trả 401; key không trusted trả 403        | `cache.spec.ts`, `cache-p45.spec.ts`                                      | integration | `test-integration` |
| Tenant suspended/deleted trả 409 cho cả GET và PUT                                                   | `cache.spec.ts`                                                           | integration | `test-integration` |
| Ghi dưới quota thành công, tăng counter, ghi audit `allowed`; vượt quota trả 429 và không ghi object | `apps/remote-cache/tests/integrations/cache-p43.spec.ts`                  | integration | `test-integration` |
| Entry hết hạn không đọc được                                                                         | `cache-p43.spec.ts`                                                       | integration | `test-integration` |
| `audit_log` từ chối UPDATE/DELETE từ role runtime; grant chính xác của schema                        | `cache-p43.spec.ts`, `apps/remote-cache/tests/integrations/roles.spec.ts` | integration | `test-integration` |
| Migration chạy được, idempotent, giữ đúng CHECK constraint                                           | `apps/remote-cache/tests/databases/migrations.spec.ts`                    | database    | `test-integration` |
| Route cache ở mức unit với repository giả                                                            | `apps/remote-cache/src/cache-routes.spec.ts`, `src/cache-p43.spec.ts`     | unit        | `test`             |

**Giới hạn của verification hiện tại:**

- `POST /projects`, `GET /projects`, `/health`, `/ready`, error handler, `config.ts`, `cursor.ts` và `S3ObjectStorage` **không có test**. Các scenario tạo project ở §4 vì vậy chưa có bằng chứng verification.
- 413 (payload quá lớn), 503 (storage chưa cấu hình), 400 (hash sai, thiếu `Content-Length`, body rỗng) và nhánh `payload_too_large` **không có test**.
- Không có test nào chứng minh Nx client thật dùng được cache; toàn bộ kiểm chứng dừng ở HTTP.
- Sự tồn tại của các spec trên không chứng minh chúng đã chạy và pass. Kết luận `Verified` cần kết quả chạy của `test` và `test-integration`.
