# Truy cập tài nguyên nội bộ được bảo vệ

> **Product area:** `internal-access/` · **Mô tả một dòng:** staff đăng nhập vào backoffice qua OIDC, và mỗi lần đọc dữ liệu nội bộ đều được kiểm tra permission trên server trước khi trả kết quả.
>
> Đặc tả domain → [`domains/staff-access/`](../../domains/staff-access/README.md) · quy tắc viết → [`../README.md`](../README.md).

## 1. Problem

Dữ liệu nội bộ — danh bạ staff, role, permission, audit — không được để lộ cho người ngoài tổ chức, và không phải staff nào cũng được xem mọi thứ. Nếu quyền được kiểm tra ở trình duyệt hoặc chỉ ở menu điều hướng, bất kỳ ai gọi thẳng API cũng đọc được dữ liệu; nếu token truy cập được giữ trong trình duyệt, một lỗ XSS là đủ để lấy nó.

Người vận hành cũng cần một bản ghi khi một lần truy cập bị từ chối, và không chấp nhận trường hợp hệ thống "tạm cho qua" khi không kiểm tra được quyền.

## 2. Outcome

Staff đăng nhập được vào backoffice và chỉ đọc được những tài nguyên mà role của họ cho phép; mọi lần bị từ chối đều để lại dấu vết.

- Đăng nhập đi qua authorization server bằng Authorization Code Flow + PKCE; **token không bao giờ tới trình duyệt** — trình duyệt chỉ giữ một session cookie và một CSRF cookie.
- Quyền được quyết định **trên server** cho từng request `/api/**`, mặc định từ chối.
- Từ chối trả 403 và ghi audit **trước khi** trả lời.
- Không kiểm tra được quyền (không đọc được nguồn danh tính) thì trả 503, không trả dữ liệu rỗng và không cho qua.
- Thu hồi assignment có hiệu lực từ request kế tiếp, không cần đăng nhập lại.
- Đăng xuất xoá cả hai cookie; request tiếp theo bằng cookie cũ nhận 401.
- Lời gọi giữa backoffice và Staff Access dùng envelope HMAC nội bộ, không dựa vào transport.

## 3. Scope

### Bao gồm

- Khởi động login: đặt cookie luồng dùng một lần rồi chuyển hướng tới authorization server với PKCE S256.
- Callback: đổi code, xác thực access token và ID token, tạo session server-side, đặt session cookie và CSRF cookie.
- Logout: trả 403 khi CSRF cookie có mặt nhưng header không khớp; thiếu hẳn CSRF cookie thì vẫn thu hồi session (204). Thu hồi best-effort ở authorization server, đánh dấu session đã thu hồi.
- Năm bề mặt đọc được bảo vệ theo permission: danh bạ staff, role, permission, audit và entitlement.
- Hai bề mặt chỉ cần session: thông tin người dùng hiện tại và trạng thái onboarding.
- Chuyển hướng sang `/onboarding` khi profile chưa có tên hiển thị.
- Gộp tên hiển thị từ `account` vào danh bạ staff, có đường suy giảm có kiểm soát khi `account` không đọc được.
- Audit cho lần bị từ chối, ghi append-only trong database của backoffice.

### Không bao gồm

- **Không có giao diện quản trị staff, role hay permission.** Không có trang hay route BFF nào tạo, sửa, xoá assignment. Hai hàm client ghi vào Staff Access tồn tại nhưng **không có call site** nào gọi chúng.
- **Không có UI đăng nhập và không có UI đăng xuất.** Không thành phần giao diện nào link tới `/api/auth/login` hay post tới `/api/auth/logout`. Trang load không đăng nhập vẫn render bình thường, rồi fetch client hiện trạng thái lỗi.
- **Không có luồng refresh token.** Token được lưu và bị thu hồi, nhưng không route nào dùng nó để gia hạn access token; hàm thay access token tồn tại nhưng không được gọi ở đâu. Access token sống 300 giây. Sau khoảng 5 phút, session còn sống vẫn nhận 401 cho mọi `/api/**`, và người dùng không có cách nào đăng nhập lại từ giao diện. Đây là giới hạn hiện tại, không phải hành vi mong muốn.
- **Không có trang từ chối quyền (403) riêng**; UI chỉ hiện trạng thái lỗi chung.
- **Không có 2FA.** Khối 2FA trên `/onboarding` là placeholder "chưa cài đặt".
- **Bốn trang dữ liệu đang ở chế độ prototype** với dữ liệu mẫu và banner: `/`, `/staff`, `/roles`, `/permissions`. Hai trang đọc dữ liệu thật: `/audit` và `/onboarding`. Chế độ mặc định là `disabled`, và mọi giá trị không nhận diện được đều fail-closed về trạng thái không dùng được.
- **Trang `/roles` không hiển thị permission của role** ở chế độ thật: adapter đặt `permissionIds: []`, nên số permission luôn là 0. Ở chế độ realtime, cột entitlement của `/staff` luôn trống vì `mapStaff` đặt `entitlements: []` và không trang nào gọi `listEntitlements`.
- **Staff Access Worker không tự kiểm tra permission.** Nó chỉ xác thực envelope và kiểm tra actor là staff `active`; kiểm tra permission là việc của BFF.
- **Projection authorization của Staff Access chưa thể trở thành nguồn sự thật.** Cổng cutover được đọc nhưng không được đặt ở đâu, nên `db-backoffice` legacy vẫn là nguồn quyết định.
- **Catalog permission ở hai database lệch nhau**: `db-backoffice` có `audit.read`, `db-staff-access` không có. Việc đưa `audit.read` vào catalog canonical đã được chấp nhận ([`staff-access` ADR-0021](../../domains/staff-access/adr/0021-first-admin-bootstrap-path.md) Quyết định 8); migration seed tương ứng chưa tồn tại.
- Playwright suite app-owned trong `apps/backoffice/e2e/` **không chạy được**: không có target `e2e`, không có CI job. Bằng chứng browser chỉ đến từ system test.

## 4. Acceptance Scenarios

```text
Cho  một request không có session cookie
Khi  gọi /api/staff, /api/roles, /api/permissions, /api/me hoặc /api/onboarding-status
Thì  nhận 401
```

```text
Cho  một staff bắt đầu đăng nhập
Khi  GET /api/auth/login được gọi
Thì  nhận 302 tới /authorize với PKCE S256, scope `openid offline_access`,
     và một cookie luồng đăng nhập dùng một lần
```

```text
Cho  callback đổi code thành công
Khi  trình duyệt nhận phản hồi
Thì  trình duyệt giữ cookie session Secure/HttpOnly/SameSite=Lax và cookie CSRF,
     và không giữ access token hay ID token nào
```

```text
Cho  session hợp lệ nhưng role không có permission của route
Khi  gọi route đó
Thì  nhận 403 và có một audit row được ghi trước khi phản hồi
```

```text
Cho  assignment cấp `staff.read` đang hiệu lực
Khi  gọi /api/staff
Thì  nhận 200 kèm danh sách staff
```

```text
Cho  cùng session đó, assignment vừa bị thu hồi
Khi  gọi lại /api/staff mà không đăng nhập lại
Thì  nhận 403
```

```text
Cho  nguồn danh tính không đọc được
Khi  gọi bất kỳ route đọc được bảo vệ nào
Thì  nhận 503 — không phải 200 với danh sách rỗng
```

```text
Cho  profile hoàn tất login nhưng chưa có tên hiển thị
Khi  callback hoàn tất
Thì  trình duyệt được đưa tới /onboarding, nơi có link tới profile
     và một khối 2FA không tương tác
```

```text
Cho  session hợp lệ và có CSRF cookie
Khi  post logout không kèm CSRF header khớp
Thì  nhận 403 và session vẫn dùng được
```

```text
Cho  session hợp lệ
Khi  post logout với cặp CSRF đúng
Thì  nhận 204, cả hai cookie bị xoá, và request bằng cookie cũ nhận 401
```

```text
Cho  chế độ dữ liệu là prototype
Khi  mở /, /staff, /roles hoặc /permissions
Thì  thấy banner dữ liệu mẫu, không có điều khiển ghi,
     và không có request nào tới /api/**
```

```text
Cho  chế độ dữ liệu không phải `prototype` hay `realtime`
Khi  mở một trang dữ liệu
Thì  thấy trạng thái lỗi thay vì dữ liệu mẫu
```

## 5. Domain & Application Mapping

| Domain / Application                      | Vai trò trong Feature                                                           | Canonical                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `staff-access` (bounded context)          | Sở hữu staff, role, permission catalog, assignment và audit                     | [`domains/staff-access/`](../../domains/staff-access/README.md)                                      |
| `auth` (bounded context)                  | Cấp token qua Authorization Code + PKCE, công bố JWKS                           | [`applications/auth/01-architecture.md`](../../applications/auth/01-architecture.md)                 |
| `account` (bounded context)               | Cung cấp tên hiển thị cho danh bạ staff                                         | [`applications/account/01-architecture.md`](../../applications/account/01-architecture.md)           |
| `apps/backoffice`                         | Deploy unit phục vụ UI và BFF; nơi duy nhất thực thi kiểm tra permission        | [`applications/backoffice/README.md`](../../applications/backoffice/README.md)                       |
| `apps/staff-access`                       | Worker nội bộ phục vụ dữ liệu staff/role/permission/audit qua envelope HMAC     | [`applications/staff-access/01-architecture.md`](../../applications/staff-access/01-architecture.md) |
| `libs/backoffice-{domain,infrastructure}` | Policy quyết định quyền, session store, token verification, client Staff Access | [`architecture/05-code-architecture.md`](../../architecture/05-code-architecture.md)                 |

`apps/staff-access-relay` **không** tham gia: nó chỉ có entrypoint `scheduled` và không phục vụ login.

## 6. Verification Mapping

Bằng chứng gồm ba tầng: integration app-owned (PostgreSQL thật), unit/component, và system E2E trên stack local thật.

| Scenario                                                                                                           | Test file / suite                                                                                    | Loại test      | Nx target          |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------------- | ------------------ |
| Năm route trả 401 khi không có cookie                                                                              | `system-tests/e2e/backoffice-access-control-e2e/e2e/unauthenticated-denial.spec.ts`                  | system E2E     | `system-test`      |
| Kickoff sinh PKCE S256, scope, cookie dùng một lần, state/challenge khác nhau giữa hai lần                         | `system-tests/e2e/backoffice-access-control-e2e/e2e/login-kickoff.spec.ts`                           | system E2E     | `system-test`      |
| Callback tạo session cookie, `/api/me` 200 với `no-store`, trang overview render                                   | `system-tests/e2e/backoffice-access-control-e2e/e2e/authenticated-access.spec.ts`                    | system E2E     | `system-test`      |
| 403 khi chưa cấp quyền; 200 sau khi cấp; 403 sau khi thu hồi mà không đăng nhập lại                                | `system-tests/e2e/backoffice-access-control-e2e/e2e/permission-enforcement.spec.ts`                  | system E2E     | `system-test`      |
| CSRF sai trả 403; CSRF đúng trả 204 và xoá cookie; cookie cũ trả 401; logout không cookie idempotent               | `system-tests/e2e/backoffice-access-control-e2e/e2e/logout.spec.ts`                                  | system E2E     | `system-test`      |
| Middleware: pass-through cho non-`/api`, canary với JWKS thật, 503 thiếu config/binding, 401 cho cookie lạ/hết hạn | `apps/backoffice/tests/integrations/authn-middleware.spec.ts`                                        | integration    | `test-integration` |
| Route đọc: 200; 403 kèm audit row ghi trước phản hồi; 401 không principal; 503 khi DB hoặc binding không dùng được | `apps/backoffice/tests/integrations/read-routes.spec.ts`                                             | integration    | `test-integration` |
| Audit từ chối: trường, từ chối khoá bí mật, không UPDATE/DELETE, lỗi insert lan truyền                             | `apps/backoffice/tests/integrations/authorization-audit.spec.ts`                                     | integration    | `test-integration` |
| Quyền ở mức database, audit append-only, từ chối tự cấp quyền, catalog bất biến                                    | `apps/backoffice/tests/integrations/{grants,self-elevation-guard,migrations-and-races}.spec.ts`      | integration    | `test-integration` |
| Mỗi permission literal được thực thi đều resolve được trong catalog `active`                                       | `apps/backoffice/tests/integrations/permission-catalog-contract.spec.ts`                             | integration    | `test-integration` |
| Gộp `displayName` và suy giảm khi `account` không đọc được                                                         | `apps/backoffice/tests/integrations/staff-display-name.spec.ts`                                      | integration    | `test-integration` |
| Migration áp dụng được, đặt tên đúng, catalog seed đúng                                                            | `apps/backoffice/tests/databases/{migrations,migration-file-naming,permission-catalog-seed}.spec.ts` | database       | `test-integration` |
| Seam chọn adapter fail-closed theo data mode                                                                       | `apps/backoffice/app/backoffice-data/data-gate.spec.ts`                                              | unit/component | `test`             |

**Giới hạn của verification hiện tại:**

- **Sự tồn tại của các spec trên không chứng minh chúng đã chạy và pass.** Kết luận `Verified` cần kết quả chạy của `test-integration` và `system-test`; `system-test` chỉ chạy được sau `local-up` của sáu deploy unit.
- Revocation được chứng minh ở tầng system **trên nguồn legacy `db-backoffice`**. Đường projection của Staff Access không có test chứng minh nó được dùng, vì cổng cutover chưa thể bật.
- Scenario prototype/fail-closed chỉ có bằng chứng ở tầng unit (`data-gate.spec.ts`, `data-mode.spec.ts`); browser suite `apps/backoffice/e2e/` không chạy được nên không tạo bằng chứng.
- Không có test nào kiểm chứng trải nghiệm sau khi access token hết hạn 300 giây.
- Không có test nào kiểm chứng một đường ghi từ UI, vì đường đó không tồn tại.
- Scenario "trình duyệt không giữ access token hay ID token" chỉ được kiểm chứng gián tiếp: các spec kiểm tra thuộc tính cookie và việc `/api/me` trả dữ liệu, không assert rằng không có token nào nằm trong storage hay body.
- Chuyển hướng sang `/onboarding` khi profile chưa có tên hiển thị không có test nào assert; không spec system hay integration nào chạm nhánh đó.
