# Publish và truy xuất contract

> **Feature area:** `pact-broker/` · **Mô tả một dòng:** consumer publish pact của mình lên broker, provider và CI đọc lại đúng phiên bản contract cần kiểm chứng.
>
> Đặc tả domain → [`domains/pact-broker/`](../../domains/pact-broker/README.md) · quy tắc viết → [`../README.md`](../README.md).

## 1. Problem

Hai service khác team cùng cam kết một contract HTTP. Nếu contract chỉ nằm trong repo của consumer, provider không biết mình phải đáp ứng hình dạng nào, CI không có bản contract cố định để chạy verification, và khi một bên đổi contract thì bên kia chỉ phát hiện lúc integration hỏng.

Consumer cũng cần publish contract từ pipeline, nơi không có người ngồi trước màn hình: không thể dùng mật khẩu, không thể bấm nút, và pipeline của tenant này không được đụng dữ liệu của tenant khác.

## 2. Outcome

Contract của consumer trở thành một artifact có địa chỉ ổn định trên broker, publish được từ CI và đọc lại được theo nhiều cách chọn.

- Publish là idempotent: cùng nội dung publish lại không tạo bản ghi thứ hai.
- Publish lại nội dung **khác** cho cùng một version thì bản ghi được cập nhật tại chỗ, và các verification result đã ghi trước đó **vẫn gắn** với pact đó.
- Nội dung pact quá lớn bị từ chối theo số byte thật của body, không theo header khai báo.
- Publish hàng loạt (nhiều contract trong một request) kiểm tra **toàn bộ trước khi ghi**: một contract sai cấu trúc thì không contract nào được ghi.
- Đọc lại được theo version chính xác, theo content SHA, theo `latest` có hoặc không kèm tag, và theo danh sách selector dùng cho verification.
- Mọi truy vấn bị giới hạn theo tenant của credential gọi nó; tenant khác không thấy gì.
- Phản hồi mang HAL link để client đi tiếp được (publish verification result, publish contract, danh sách pact cần verify).

## 3. Scope

### Bao gồm

- Publish một contract cho một consumer version, kèm branch của version đó.
- Publish hàng loạt nhiều contract trong một lượt, kèm branch, tag và build URL; lượt publish hàng loạt có trần về kích thước, số interaction và số contract, và **validate toàn bộ trước khi ghi**.
- Publish bị từ chối khi body vượt trần kích thước, đo trên body thật chứ không tin header khai báo.
- Đọc lại contract theo version chính xác, theo content SHA, theo bản `latest` có hoặc không kèm tag, và theo danh sách lựa chọn dùng cho verification (có trần số lựa chọn mỗi lượt).
- Đọc qua HAL index của broker, gồm compatibility version và link publish.
- Yêu cầu credential có scope đủ để đọc hoặc ghi (xem [Quản lý machine credential](./manage-pact-broker-machine-credentials.md)).

Đường dẫn, mã trạng thái và các con số trần chính xác thuộc contract của broker — xem [`applications/pact-broker/01-architecture.md`](../../applications/pact-broker/01-architecture.md).

### Không bao gồm

- **Không có đường publish từ trình duyệt hay UI.** Broker chỉ nhận contract qua HTTP với machine credential; không có trang upload.
- **Không có versioning hay xoá pact.** Publish lại chỉ cập nhật nội dung tại chỗ; không có route xoá pact, consumer version hay tag.
- **Không có xác thực nội dung pact theo schema Pact Specification.** Kiểm tra cấu trúc ở mức hình dạng tối thiểu; broker không từ chối một pact vì interaction không khớp spec.
- **Không có webhook phát ra khi publish.** Bề mặt webhook trả lời được nhưng outbound bị tắt cứng ở cấu hình: bật nó làm config ném lỗi nên mọi request trừ `/health` trả 503, và một lượt execute trả thành công giả (`fired: false`) mà không gọi mạng. Đây là bề mặt đã tắt, không phải capability.
- **Pact CLI chưa được kiểm chứng end to end.** Không có system test nào chạy `pact-broker publish` thật hay gọi broker từ ngoài Worker; bằng chứng chỉ ở tầng integration gọi route trong process.
- Không bao gồm verification result và `can-i-deploy` — thuộc [Verify contract và gate deployment](./verify-contracts-and-gate-deployments.md).
- Không bao gồm cấp phát credential — thuộc [Quản lý machine credential](./manage-pact-broker-machine-credentials.md).

## 4. Acceptance Scenarios

```text
Cho  credential có scope write của tenant T
Khi  publish pact cho một consumer version mới
Thì  nhận 201, phản hồi có `contentSha` và link publish verification result
```

```text
Cho  pact đã tồn tại với cùng nội dung
Khi  publish lại
Thì  nhận 200 và không có bản ghi thứ hai
```

```text
Cho  pact đã có verification result
Khi  publish nội dung khác cho cùng consumer version
Thì  nhận 200, nội dung được cập nhật, và verification result cũ vẫn gắn với pact
```

```text
Cho  body lớn hơn 1 MiB, kể cả khi `Content-Length` thiếu hoặc khai báo sai
Khi  publish
Thì  nhận 413 và không có gì được ghi
```

```text
Cho  batch publish có một contract sai cấu trúc
Khi  gửi request
Thì  nhận lỗi và không contract nào trong batch được ghi
```

```text
Cho  batch publish hợp lệ kèm branch, tag và build URL
Khi  gửi request
Thì  nhận 200 kèm `notices`, và contract đọc lại được theo tag đó
```

```text
Cho  credential của tenant B
Khi  đọc pact của tenant A theo version, SHA hoặc latest
Thì  không thấy dữ liệu của tenant A
```

```text
Cho  danh sách selector cho verification dài hơn 50 mục
Khi  gửi request
Thì  nhận 400
```

```text
Cho  request không kèm credential, hoặc credential đã thu hồi
Khi  đọc hoặc publish
Thì  nhận 401 với cùng một hình dạng phản hồi
```

## 5. Domain & Application Mapping

| Domain / Application                                       | Vai trò trong Feature                                                                         | Canonical                                                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pact-broker` (bounded context)                            | Sở hữu pacticipant, pact, consumer version, tag, branch, tenant và quy tắc idempotent publish | [`domains/pact-broker/`](../../domains/pact-broker/README.md)                                      |
| `apps/pact-broker-api`                                     | Deploy unit phục vụ toàn bộ HTTP API của broker                                               | [`applications/pact-broker/01-architecture.md`](../../applications/pact-broker/01-architecture.md) |
| `libs/pact-broker-api-{domain,application,infrastructure}` | Rule publish/idempotent, HAL, validation, repository trên `db-pact-broker`                    | [`architecture/05-code-architecture.md`](../../architecture/05-code-architecture.md)               |

`apps/pact-broker-app` (dashboard) **không** tham gia: màn hình Pacts của nó gọi `/matrix` không kèm tham số và đọc sai hình dạng phản hồi, nên không hiển thị được danh sách pact. Không mô tả nó như bề mặt đọc contract.

## 6. Verification Mapping

Toàn bộ bằng chứng nằm ở tầng integration app-owned: Hono `app.request()` trong process, PostgreSQL 17 thật qua testcontainers. **Không có system E2E** nào chạy Pact CLI hay gọi broker từ ngoài.

| Scenario                                                                                                | Test file / suite                                           | Loại test   | Nx target          |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------- | ------------------ |
| `/health` không cần credential; CORS chỉ cho origin cấu hình; 401 đồng nhất cho missing/unknown/revoked | `apps/pact-broker-api/tests/integrations/api.spec.ts`       | integration | `test-integration` |
| HAL index có link publish contract (không assert giá trị compatibility `version`)                       | cùng file trên                                              | integration | `test-integration` |
| Publish 201 rồi publish lại 200; trần selector 50                                                       | cùng file trên                                              | integration | `test-integration` |
| Trần body 1 MiB đo trên stream trả 413, request nhỏ trả 201                                             | cùng file trên                                              | integration | `test-integration` |
| Cách ly tenant trên mọi đường đọc                                                                       | cùng file trên                                              | integration | `test-integration` |
| Batch publish kèm branch và tag                                                                         | cùng file trên                                              | integration | `test-integration` |
| Rule publish/idempotent ở tầng application                                                              | `libs/pact-broker-api-application/src/publish-pact.spec.ts` | unit        | `test`             |
| Hình dạng HAL và link                                                                                   | `libs/pact-broker-api-domain/src/hal.spec.ts`               | unit        | `test`             |
| Validation tên, version, branch, tag, SHA                                                               | `libs/pact-broker-api-domain/src/validation.spec.ts`        | unit        | `test`             |
| Bảng, ràng buộc composite-FK tenant, role runtime chỉ DML, runner idempotent                            | `apps/pact-broker-api/tests/databases/migrations.spec.ts`   | database    | `test-integration` |

**Giới hạn của verification hiện tại:**

- Không có test nào chạy Pact CLI thật; tương thích với CLI chỉ được suy ra từ hình dạng route và `compatibility version 2.107.0` trong HAL index.
- Publish lại nội dung khác giữ verification result: rule được mô tả trong repository và có unit test cho use case, nhưng **không có scenario integration** assert trực tiếp rằng verification row vẫn còn sau khi publish đè.
- Không có test cho `GET /pacts/latest` hay `GET .../latest/:tag` ở tầng integration; chỉ có unit test của phần domain.
- **Hình dạng phản hồi publish chỉ được assert một phần.** Scenario "201 kèm `contentSha`" dựa trên unit test của use case; integration test assert mã trạng thái và bản ghi, không assert `contentSha` trong body.
- **Tính all-or-nothing của batch publish không được assert trực tiếp.** Không spec nào gửi một batch có contract hỏng rồi kiểm tra rằng không contract nào trong batch được ghi.
- Trường `notices` trong phản hồi batch không được test nào assert.
- Sự tồn tại của các spec trên không chứng minh chúng đã chạy và pass. Kết luận `Verified` cần kết quả chạy của `test` và `test-integration`.
