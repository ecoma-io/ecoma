# Quản lý machine credential của Pact Broker

> **Feature area:** `pact-broker/` · **Mô tả một dòng:** người vận hành tenant cấp, xoay vòng và thu hồi credential cho CI, với quyền hạn giới hạn theo scope và secret chỉ hiện đúng một lần.
>
> Đặc tả domain → [`domains/pact-broker/`](../../domains/pact-broker/README.md) · quy tắc viết → [`../README.md`](../README.md).

## 1. Problem

Pipeline publish pact và ghi verification result chạy không có người ngồi trước màn hình. Nó cần một credential không phải mật khẩu người dùng, không hết hạn giữa hai lần chạy, và không mang quyền nhiều hơn việc nó phải làm.

Credential đó cũng phải thu hồi được ngay khi CI bị lộ hoặc khi một pipeline bị bỏ, và việc xoay vòng không được để lại một secret cũ vẫn dùng được. Đồng thời, secret không được nằm trong danh sách đọc lại: ai xem được danh sách credential không được nhận luôn quyền dùng chúng.

## 2. Outcome

Tenant quản lý được credential máy theo vòng đời tạo → dùng → xoay vòng → thu hồi, với quyền hạn tối thiểu và secret chỉ lộ một lần.

- Ba scope theo thứ tự bao hàm: `read` ⊂ `write` ⊂ `admin`.
- Secret chỉ có trong phản hồi của lần tạo hoặc lần xoay vòng; danh sách chỉ trả metadata.
- Thu hồi có hiệu lực từ request kế tiếp, không cần chờ.
- Xoay vòng làm secret cũ mất hiệu lực **ngay lập tức**; xoay vòng lần hai làm secret của lần một mất hiệu lực.
- Mọi thao tác chỉ chạm credential thuộc tenant của caller; credential tenant khác báo không tìm thấy, không phân biệt với credential không tồn tại.
- Credential thiếu, không tồn tại, đã thu hồi hoặc bị treo đều trả cùng một 401; 403 chỉ dành cho thiếu scope.
- Tạo, xoay vòng và thu hồi đều ghi audit append-only, không sửa hay xoá được.

## 3. Scope

### Bao gồm

- Liệt kê credential của tenant ở dạng metadata (`id`, `name`, `scopes`, `createdAt`, `revokedAt`); cần scope `admin`.
- Tạo credential với một tên và một đến ba scope; secret trả về đúng một lần.
- Xoay vòng credential: secret mới trả về đúng một lần, secret cũ chết ngay; credential đã thu hồi hoặc không tồn tại báo không tìm thấy.
- Thu hồi credential; thu hồi lại báo không tìm thấy.
- Xác thực request bằng bearer token: broker băm token rồi tra database, không lưu plaintext.
- Scope bị ràng buộc thêm ở tầng database, không chỉ ở tầng ứng dụng.
- Audit append-only cho tạo, xoay vòng và thu hồi.

Đường dẫn, mã trạng thái và giới hạn độ dài tên thuộc contract của broker — xem [`applications/pact-broker/01-architecture.md`](../../applications/pact-broker/01-architecture.md).

### Không bao gồm

- **Không có thời hạn (TTL) và không có `last_used_at`.** Credential sống cho tới khi bị thu hồi hoặc xoay vòng; không có cách nào biết lần dùng cuối.
- **Không có scope hẹp hơn ba mức cố định**, không có scope theo route, environment hay action.
- **Không có API đọc audit.** Audit được ghi nhưng không có route trả nó ra.
- **Không có mô tả hay ghi chú cho credential**; chỉ có `name`.
- **Dashboard không tạo, xoay vòng hay thu hồi được credential.** Trang `/tokens` chỉ đọc metadata, hiện trạng thái "forbidden" khi API từ chối vì thiếu quyền, và không bao giờ hiển thị plaintext. BFF dùng **một token tĩnh** cấu hình ở server, không phải danh tính của người xem.
- **Không có xác thực người dùng cho dashboard.** Mọi route `/api/broker/*` của `apps/pact-broker-app` truy cập được công khai; không có session, cookie hay CSRF.
- **Tạo và thu hồi không nguyên tử với audit.** Riêng xoay vòng chạy cùng một transaction; tạo và thu hồi đổi trạng thái trước rồi mới ghi audit ở transaction riêng, nên một lỗi audit để credential đã tạo (và secret một lần đã mất) hoặc đã thu hồi trong khi request trả 500. Đây là giới hạn hiện tại, không phải hành vi mong muốn.
- **Không có RBAC theo vai trò người dùng.** `tenant_members.role` được ghi nhưng không được kiểm tra ở bất kỳ đường request nào; chỉ scope của token quyết định.
- Không bao gồm việc dùng credential để publish hay verify — thuộc [Publish và truy xuất contract](./publish-and-retrieve-contracts.md) và [Verify contract và gate deployment](./verify-contracts-and-gate-deployments.md).

## 4. Acceptance Scenarios

```text
Cho  credential có scope admin
Khi  tạo một credential mới
Thì  nhận 201 kèm `secret`, và lần gọi danh sách sau đó không có `secret`
```

```text
Cho  hai credential có scope khác nhau
Khi  dùng credential `read` để publish pact
Thì  nhận 403
```

```text
Cho  credential có scope `write`
Khi  gọi /admin/machine-tokens
Thì  nhận 403
```

```text
Cho  credential vừa bị thu hồi
Khi  dùng lại nó
Thì  nhận 401; thu hồi lần nữa trả 404
```

```text
Cho  một credential đang dùng được
Khi  xoay vòng nó
Thì  nhận 200 kèm secret mới; secret cũ nhận 401 ngay lập tức
```

```text
Cho  credential vừa được xoay vòng một lần
Khi  xoay vòng lần hai
Thì  secret của lần một mất hiệu lực
```

```text
Cho  credential của tenant khác
Khi  xoay vòng, thu hồi hoặc đọc trong danh sách
Thì  nhận 404 cho thao tác và không thấy nó trong danh sách
```

```text
Cho  request không kèm credential, hoặc credential không tồn tại, hoặc đã thu hồi
Khi  gọi bất kỳ route nào
Thì  nhận 401 với cùng một hình dạng phản hồi
```

```text
Cho  một lần tạo, xoay vòng hoặc thu hồi thành công
Khi  đọc bảng audit
Thì  có một hàng `machine_token.*` mới, không sửa hay xoá được
```

## 5. Domain & Application Mapping

| Domain / Application                                | Vai trò trong Feature                                                                       | Canonical                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pact-broker` (bounded context)                     | Sở hữu `machine_tokens`, scope, tenant binding và audit event                               | [`domains/pact-broker/`](../../domains/pact-broker/README.md)                                      |
| `apps/pact-broker-api`                              | Deploy unit phục vụ route `/admin/machine-tokens` và kiểm tra credential cho mọi route khác | [`applications/pact-broker/01-architecture.md`](../../applications/pact-broker/01-architecture.md) |
| `libs/pact-broker-api-{application,infrastructure}` | Băm secret, kiểm tra scope, repository tenant và audit                                      | [`architecture/05-code-architecture.md`](../../architecture/05-code-architecture.md)               |
| `apps/pact-broker-app`                              | Chỉ đọc metadata credential; không có đường tạo, xoay vòng hay thu hồi                      | [`applications/pact-broker/README.md`](../../applications/pact-broker/README.md)                   |

## 6. Verification Mapping

Bằng chứng ở tầng integration app-owned (Hono `app.request()` trong process, PostgreSQL 17 thật qua testcontainers), database và unit.

| Scenario                                                                  | Test file / suite                                         | Loại test   | Nx target          |
| ------------------------------------------------------------------------- | --------------------------------------------------------- | ----------- | ------------------ |
| Tạo trả secret một lần, danh sách ẩn secret, thu hồi có hiệu lực tức thời | `apps/pact-broker-api/tests/integrations/api.spec.ts`     | integration | `test-integration` |
| Xoay vòng: secret cũ bị chặn, secret mới dùng được                        | cùng file trên                                            | integration | `test-integration` |
| Xoay vòng ghi audit row                                                   | cùng file trên                                            | integration | `test-integration` |
| Xoay vòng credential đã thu hồi trả 404                                   | cùng file trên                                            | integration | `test-integration` |
| Xoay vòng hai lần làm secret lần một mất hiệu lực                         | cùng file trên                                            | integration | `test-integration` |
| Xoay vòng, thu hồi, liệt kê credential tenant khác đều bị chặn            | cùng file trên                                            | integration | `test-integration` |
| Thứ tự bao hàm scope `read` ⊂ `write` ⊂ `admin`                           | cùng file trên                                            | integration | `test-integration` |
| 401 đồng nhất cho missing/unknown/revoked                                 | cùng file trên                                            | integration | `test-integration` |
| Luật scope và hình dạng hash của token                                    | `libs/pact-broker-api-application/src/token-auth.spec.ts` | unit        | `test`             |
| Audit append-only và composite-FK tenant                                  | `apps/pact-broker-api/tests/databases/migrations.spec.ts` | database    | `test-integration` |

**Giới hạn của verification hiện tại:**

- **Sự tồn tại của các spec trên không chứng minh chúng đã chạy và pass.** Kết luận `Verified` cần kết quả chạy của `test` và `test-integration`.
- Không có test nào chứng minh hành vi khi audit lỗi trong lúc tạo hoặc thu hồi; khoảng trống đó là hệ quả của hai transaction tách rời, không phải một hành vi được thiết kế.
- Không có spec riêng cho hàm băm secret; việc không lưu plaintext chỉ được kiểm chứng gián tiếp qua luồng integration (tạo rồi dùng lại được secret).
- Không có test nào cho trang `/tokens` của dashboard; `environments.vue` và `tokens.vue` không có render spec.
- **Ràng buộc CHECK trên cột `scopes` không được assert ở đâu.** Ràng buộc tồn tại trong migration, nhưng spec database không chạm tới nó.
- **Ánh xạ credential sang tenant không có unit test.** Spec unit chỉ phủ luật scope và hình dạng hash; tenant mapping chỉ được kiểm chứng gián tiếp qua các test cách ly tenant ở tầng integration.
