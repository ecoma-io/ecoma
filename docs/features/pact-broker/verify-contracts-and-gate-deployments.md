# Verify contract và gate deployment

> **Feature area:** `pact-broker/` · **Mô tả một dòng:** provider ghi kết quả verification lên broker, và pipeline hỏi broker một câu trả lời duy nhất trước khi deploy: version này có được phép đi tiếp không.
>
> Đặc tả domain → [`domains/pact-broker/`](../../domains/pact-broker/README.md) · quy tắc viết → [`../README.md`](../README.md).

## 1. Problem

Provider chạy verification trong CI của mình, nhưng kết quả đó chỉ có giá trị nếu consumer và pipeline deploy đọc được nó. Nếu kết quả nằm trong log CI, không ai trả lời được câu hỏi "version provider này đã được kiểm chứng với mọi consumer đang chạy chưa?" — và câu trả lời sai theo hướng lạc quan sẽ đưa một version chưa kiểm chứng lên production.

Ngược lại, câu trả lời phải phân biệt được ba trạng thái: đã kiểm chứng và đạt, đã kiểm chứng và hỏng, và **chưa từng được kiểm chứng**. Gộp trạng thái thứ ba vào "đạt" biến gate thành hình thức.

## 2. Outcome

Kết quả verification trở thành dữ liệu broker lưu và pipeline đọc được, kèm một phán quyết ba trạng thái không bao giờ lạc quan khi thiếu bằng chứng.

- Kết quả verification được ghi kèm version provider và chỉ ghi được vào pact thuộc tenant của caller.
- Kết quả là append-only: ghi thêm không sửa bản ghi cũ.
- Matrix trả lời cho một cặp consumer/provider, có thể nhắm theo environment, tag hoặc branch, và chọn kết quả verification tốt nhất theo thời điểm.
- `can-i-deploy` trả `true` khi mọi phụ thuộc đã đạt, `false` khi có ít nhất một cái hỏng, và `null` khi còn ít nhất một cái chưa rõ.
- Khi selector mang một version mà matrix rỗng, phán quyết **không** được rơi về "không có phụ thuộc thiếu". Broker trả `null` kèm lý do phân biệt: chưa từng có pact nào cho version đó, hay version đó không tồn tại.
- Deployment được ghi nhận theo environment, và mỗi cặp version + environment chỉ có một deployment đang hiệu lực.
- Truy vấn deployment và matrix bị giới hạn theo tenant.

## 3. Scope

### Bao gồm

- Ghi một verification result cho một pact SHA, cần credential đủ quyền ghi; yêu cầu phải nêu kết quả đạt/hỏng và version provider.
- Đọc lại một verification result.
- Hỏi matrix cho một pacticipant, nhắm theo environment, tag hoặc branch, với kết quả verification tốt nhất theo thời điểm được chọn.
- Hỏi `can-i-deploy` cho một cặp pacticipant + version, có thể nhắm tới một environment hoặc tag đích.
- Quản lý environment: liệt kê, tạo, đọc theo uuid hoặc tên, cập nhật, xoá.
- Ghi deployment vào một environment (idempotent, tự tạo environment nếu chưa có), đọc deployment, và undeploy.
- Broker quảng cáo link ghi deployment theo từng environment trên version resource.

Đường dẫn, mã trạng thái và tên tham số chính xác thuộc contract của broker — xem [`applications/pact-broker/01-architecture.md`](../../applications/pact-broker/01-architecture.md).

### Không bao gồm

- **Dashboard hiển thị matrix ở trang `/pacts`** — BFF hợp thành `/pacticipants` + `/matrix` và trang render được hàng matrix thật kèm trạng thái verification (#225). Cập nhật 2026-11-15 sau #208 (PR #293): có thêm trang verification riêng (`/verifications`), trang matrix chuyên dụng (`/matrix`, truy vấn verdict `can-i-deploy` qua `POST /api/broker/can-i-deploy`) và trang environments (`/environments`) — các route BFF `can-i-deploy.post.ts`/`verifications.get.ts`/`matrix.get.ts` đã được trang gọi. Vẫn không có điều khiển ghi nào từ dashboard: việc chạy verification và `can-i-deploy` trong CI thuộc CLI/CI; `can-i-deploy` trên portal là truy vấn đọc, không ghi.
- **Kiểm chứng end to end bằng Pact CLI có ở tầng system E2E** (cập nhật 2026-11-18 sau #27): suite `system-tests/e2e/cross-product-journey-e2e` chạy `pact-broker publish`, `pact-verifier` và `can-i-deploy` thật (`@pact-foundation/pact-cli@18.10.9`) trên lane local, đã xanh trên CI main (schedule run 44297959838, 2026-11-18). Tầng integration gọi route trong process vẫn là bằng chứng cấp app-owned của feature này.
- **Không có xoá kết quả verification.** Kết quả append-only, không có route sửa hay xoá.
- Xoá environment **có ghi audit** (`environment.delete`, kèm tên environment bị xoá), và có test assert hàng audit tương ứng; thay đổi tag hay deployment không ghi audit. `environment.create`, `environment.update` và `environment.delete` đều được ghi.
- **RBAC theo vai trò người dùng đã hiện thực trên đường đọc.** Đường user qua portal enforce theo permission matrix ([ADR-0032](../../domains/pact-broker/adr/0032-developer-authorization-matrix-and-credential-policy.md) §1 — `viewer` trở lên đọc được verification/matrix), hiện thực qua #206; đường machine token (CI/CLI) giữ scope-based.
- **Đọc một verification result đòi scope `read`.** Quyết định đã chấp nhận và đã hiện thực: đổi từ scope `write` sang `read` ([ADR-0032](../../domains/pact-broker/adr/0032-developer-authorization-matrix-and-credential-policy.md) §6, hiện thực qua #206).
- Không bao gồm publish pact và đọc contract — thuộc [Publish và truy xuất contract](./publish-and-retrieve-contracts.md). Không bao gồm credential — thuộc [Quản lý machine credential](./manage-pact-broker-machine-credentials.md).

## 4. Acceptance Scenarios

```text
Cho  pact SHA thuộc tenant T và credential có scope write
Khi  post một verification result
Thì  nhận 201 và kết quả đọc lại được
```

```text
Cho  SHA thuộc tenant khác
Khi  post verification result
Thì  nhận 404 và không có hàng nào được ghi
```

```text
Cho  một consumer version có pact chưa từng được verify
Khi  hỏi /can-i-deploy cho version provider đó
Thì  nhận `deployable: null` kèm lý do "chưa được kiểm chứng" — không phải `true`
```

```text
Cho  version provider tồn tại nhưng chưa có pact nào
Khi  hỏi /can-i-deploy
Thì  nhận `deployable: null` kèm lý do "chưa có pact nào được publish"
```

```text
Cho  version provider không tồn tại
Khi  hỏi /can-i-deploy
Thì  nhận `deployable: null` kèm lý do riêng "không có version đó"
```

```text
Cho  một consumer version verify hỏng
Khi  hỏi /can-i-deploy
Thì  nhận `deployable: false`
```

```text
Cho  một version được ghi đã deploy vào một environment
Khi  hỏi /matrix với target là environment đó
Thì  matrix báo deployment đó
```

```text
Cho  version đã được undeploy khỏi environment
Khi  hỏi lại /matrix
Thì  lịch sử deployment còn nhưng không còn deployment nào hiệu lực
```

```text
Cho  request không kèm credential, hoặc credential đã thu hồi
Khi  hỏi /matrix hay /can-i-deploy
Thì  nhận 401 với cùng một hình dạng phản hồi
```

```text
Cho  /matrix được gọi không kèm tham số `pacticipant`
Khi  request tới
Thì  nhận 400
```

## 5. Domain & Application Mapping

| Domain / Application                                       | Vai trò trong Feature                                                                           | Canonical                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pact-broker` (bounded context)                            | Sở hữu verification result, matrix, environment, deployment và quy tắc phán quyết ba trạng thái | [`domains/pact-broker/`](../../domains/pact-broker/README.md)                                      |
| `apps/pact-broker-api`                                     | Deploy unit phục vụ toàn bộ HTTP API của broker                                                 | [`applications/pact-broker/01-architecture.md`](../../applications/pact-broker/01-architecture.md) |
| `libs/pact-broker-api-{domain,application,infrastructure}` | Rule phán quyết, chọn kết quả tốt nhất, repository matrix/deployment                            | [`architecture/05-code-architecture.md`](../../architecture/05-code-architecture.md)               |

`apps/pact-broker-app` tham gia ở vai trò **hiển thị**: trang `/pacts` render được hàng matrix thật (gồm trạng thái verification) qua BFF; các trang khác của portal không có trang verification hay matrix chuyên dụng và không gọi được route gate từ UI.

## 6. Verification Mapping

Bằng chứng ở tầng integration app-owned (Hono `app.request()` trong process, PostgreSQL 17 thật qua testcontainers) và unit. System E2E chạy Pact CLI thật có tại `system-tests/e2e/cross-product-journey-e2e` (#27, cập nhật 2026-11-18), đã xanh trên CI main (schedule run 44297959838).

| Scenario                                                                                | Test file / suite                                           | Loại test          | Nx target          |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------ | ------------------ |
| Ghi verification chỉ vào pact cùng tenant                                               | `apps/pact-broker-api/tests/integrations/api.spec.ts`       | integration        | `test-integration` |
| Ba nhánh fail-closed của `can-i-deploy` (chưa verify, chưa có pact, không có version)   | cùng file trên                                              | integration        | `test-integration` |
| Ghi deployment vào environment, undeploy, và `/can-i-deploy` nhắm theo environment đích | cùng file trên                                              | integration        | `test-integration` |
| `/matrix` báo version đang deploy và lý do kèm target environment                       | cùng file trên                                              | integration        | `test-integration` |
| `/matrix` sau undeploy: lịch sử còn trong DB, matrix không còn deployment hiệu lực      | cùng file trên                                              | integration        | `test-integration` |
| Ưu tiên target environment → tag → branch; verification tốt nhất theo `verified_at`     | cùng file trên                                              | integration        | `test-integration` |
| 400 khi `/matrix` thiếu `pacticipant`                                                   | cùng file trên                                              | integration        | `test-integration` |
| CRUD environment end-to-end: create, list, read by name, update, delete                 | cùng file trên                                              | integration        | `test-integration` |
| 401 đồng nhất cho missing/unknown/revoked, kể cả `/matrix` và `/can-i-deploy`           | cùng file trên                                              | integration        | `test-integration` |
| Đường user: viewer trở lên đọc được verification/matrix theo permission matrix          | `apps/pact-broker-api/tests/integrations/user-auth.spec.ts` | integration        | `test-integration` |
| Trang `/pacts` của portal render hàng matrix thật qua BFF                               | `apps/pact-broker-app/tests/browser/read-pages.spec.ts`     | browser regression | `test-integration` |
| Phán quyết ba trạng thái và lý do tương ứng                                             | `libs/pact-broker-api-application/src/can-i-deploy.spec.ts` | unit               | `test`             |
| Tổng hợp matrix: `failed > 0 → false`, `unknown > 0 → null`, còn lại `true`             | `libs/pact-broker-api-domain/src/matrix-summary.spec.ts`    | unit               | `test`             |
| Ràng buộc một deployment hiệu lực cho mỗi version + environment; composite-FK tenant    | `apps/pact-broker-api/tests/databases/migrations.spec.ts`   | database           | `test-integration` |

**Giới hạn của verification hiện tại:**

- **Sự tồn tại của các spec trên không chứng minh chúng đã chạy và pass.** Kết luận `Verified` cần kết quả chạy của `test` và `test-integration`.
- Pact CLI được chạy thật trong system E2E (#27): `pact-verifier` và `can-i-deploy` qua npm `@pact-foundation/pact-cli@18.10.9` trên lane local, xanh trên CI main (schedule run 44297959838, 2026-11-18) — đóng khoảng trống "tương thích chỉ suy từ hình dạng route" của ghi chú trước.
- Không có test nào chứng minh thay đổi tag hay deployment là hành vi không ghi audit mong muốn; đó là khoảng trống đã biết. Xoá environment thì ngược lại: hàng audit `environment.delete` được assert trong test (`apps/pact-broker-api/tests/integrations/user-auth.spec.ts:493`).
