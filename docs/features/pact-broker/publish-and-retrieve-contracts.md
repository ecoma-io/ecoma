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
- Phản hồi mang HAL link để client đi tiếp được (publish verification result, publish contract). HAL index phát link `pb:latest-provider-pacts` mà verifier mặc định của Pact CLI cần để khám phá pact (cập nhật 2026-11-18 sau #294/#315; hiện thực tại `libs/pact-broker-api-domain/src/hal.ts:45`). Các HAL link khác (`pb:latest-pact-versions`, `pb:latest-pact-version`, …) đã phát trước đó.

## 3. Scope

### Bao gồm

- Publish một contract cho một consumer version, kèm branch của version đó.
- Publish hàng loạt nhiều contract trong một lượt, kèm branch, tag và build URL; lượt publish hàng loạt có trần về kích thước, số interaction và số contract, và **validate toàn bộ trước khi ghi**.
- Publish bị từ chối khi body vượt trần kích thước, đo trên body thật chứ không tin header khai báo.
- Đọc lại contract theo version chính xác, theo content SHA, theo bản `latest` có hoặc không kèm tag, và theo danh sách lựa chọn dùng cho verification (có trần số lựa chọn mỗi lượt).
- Đọc qua HAL index của broker, gồm compatibility version và link publish.
- Yêu cầu credential có scope đủ để đọc hoặc ghi (xem [Quản lý machine credential](./manage-pact-broker-machine-credentials.md)).
- Yêu cầu tiền đề truy cập của con người: developer đăng nhập portal bằng Ecoma Account, portal forward access token tới broker — broker xác thực JWT và resolve membership/role của tenant; đường publish từ portal vẫn đòi quyền ghi theo permission matrix ([ADR-0031](../../domains/pact-broker/adr/0031-developer-portal-authentication-and-identity-propagation.md), [ADR-0032](../../domains/pact-broker/adr/0032-developer-authorization-matrix-and-credential-policy.md) §1, hiện thực #206). CI dùng machine credential trực tiếp.

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

`apps/pact-broker-app` tham gia ở vai trò **bề mặt đọc**: developer đã đăng nhập thấy danh sách pact qua trang `/pacts`, nhờ BFF hợp thành `/pacticipants` + `/matrix` theo đúng contract ([ADR-0031](../../domains/pact-broker/adr/0031-developer-portal-authentication-and-identity-propagation.md), hiện thực #254/#225). Nó **không** là bề mặt publish: không có trang upload nào; publish đi qua machine credential (CI/CLI).

## 6. Verification Mapping

Toàn bộ bằng chứng nằm ở tầng integration app-owned: Hono `app.request()` trong process, PostgreSQL 17 thật qua testcontainers; cộng thêm browser regression cho trang đọc của portal. System E2E chạy Pact CLI thật (`@pact-foundation/pact-cli@18.10.9`) tồn tại tại `system-tests/e2e/cross-product-journey-e2e` (#27): suite publish/verify/can-i-deploy qua CLI thật trên lane local, và đã chạy xanh trên CI main (schedule run 44297959838, 2026-11-18).

| Scenario                                                                                                | Test file / suite                                           | Loại test          | Nx target          |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------ | ------------------ |
| `/health` không cần credential; CORS chỉ cho origin cấu hình; 401 đồng nhất cho missing/unknown/revoked | `apps/pact-broker-api/tests/integrations/api.spec.ts`       | integration        | `test-integration` |
| HAL index có link publish contract (không assert giá trị compatibility `version`)                       | cùng file trên                                              | integration        | `test-integration` |
| Publish 201 rồi publish lại 200, `contentSha` ổn định kèm link verification; trần selector 50           | cùng file trên                                              | integration        | `test-integration` |
| Trần body 1 MiB đo trên stream trả 413, request nhỏ trả 201                                             | cùng file trên                                              | integration        | `test-integration` |
| Cách ly tenant trên mọi đường đọc                                                                       | cùng file trên                                              | integration        | `test-integration` |
| Batch publish kèm branch, tag và `notices`                                                              | cùng file trên                                              | integration        | `test-integration` |
| Batch all-or-nothing: một contract hỏng thì không contract nào được ghi                                 | cùng file trên                                              | integration        | `test-integration` |
| `latest` và `latest/:tag`, kèm 404 cho tag không tồn tại                                                | cùng file trên                                              | integration        | `test-integration` |
| Republish nội dung khác giữ verification result đã ghi                                                  | cùng file trên                                              | integration        | `test-integration` |
| Đường user: viewer/member/admin đọc theo permission matrix; user token bị chặn khỏi đường ghi/admin     | `apps/pact-broker-api/tests/integrations/user-auth.spec.ts` | integration        | `test-integration` |
| Trang `/pacts` của portal render đúng hàng matrix thật qua BFF                                          | `apps/pact-broker-app/tests/browser/read-pages.spec.ts`     | browser regression | `test-integration` |
| Rule publish/idempotent ở tầng application                                                              | `libs/pact-broker-api-application/src/publish-pact.spec.ts` | unit               | `test`             |
| Hình dạng HAL và link                                                                                   | `libs/pact-broker-api-domain/src/hal.spec.ts`               | unit               | `test`             |
| Validation tên, version, branch, tag, SHA                                                               | `libs/pact-broker-api-domain/src/validation.spec.ts`        | unit               | `test`             |
| Bảng, ràng buộc composite-FK tenant, role runtime chỉ DML, runner idempotent                            | `apps/pact-broker-api/tests/databases/migrations.spec.ts`   | database           | `test-integration` |

**Giới hạn của verification hiện tại:**

- Pact CLI thật được chạy trong system E2E (#27): `pact-broker publish`, `pact-verifier` và `can-i-deploy` qua npm `@pact-foundation/pact-cli@18.10.9` trên lane local (`system-tests/e2e/cross-product-journey-e2e/e2e/cross-product-chain.spec.ts`). Tương thích CLI không còn chỉ là suy từ hình dạng route.
- Sự tồn tại của các spec trên không chứng minh chúng đã chạy và pass. Kết luận `Verified` cần kết quả chạy của `test` và `test-integration`.
