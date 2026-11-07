# Staff Access — Domain Model

`staff-access` là bounded context sở hữu **quyền truy cập nội bộ của nhân sự**: nhân sự nội bộ và trạng thái truy cập, catalog vai trò/permission dành cho nhân sự, việc gán vai trò/quyền, entitlement cho phép nhân sự sử dụng các sản phẩm nội bộ, và audit mọi thay đổi quyền/entitlement.

> Tài liệu này chứa **thuần business knowledge** của context: khái niệm, quy tắc nghiệp vụ, invariant, sự kiện domain và ngữ nghĩa quyền. Nó không mô tả schema, HTTP endpoint, Worker hay chạy triển khai — những nội dung đó thuộc application layer (`docs/applications/`). ADR của context nằm ở [`adr/`](./adr/README.md) và không thay đổi bởi tài liệu này.

## 1. Trách nhiệm

1. **Staff directory và lifecycle** — nhân sự nội bộ, trạng thái truy cập nội bộ (active/suspended/terminated).
2. **Permission catalog và role** — catalog permission `domain.action`, role built-in + custom (custom role v1 tắt — ADR-0004), staff-role assignment.
3. **Product entitlement** — quyền sử dụng sản phẩm nội bộ (backoffice, pact-broker, remote-cache…) của từng nhân sự; sự khác biệt giữa entitlement (product-level availability) và authorization (per-resource/per-operation) là ranh giới bắt buộc — ADR-0009.
4. **Audit** — mọi thay đổi quyền/entitlement để lại audit record (actor, target, action, thời điểm, kết quả, lý do, correlation ID).

Staff Access **không** phải IdP thứ hai và **không** phải credential store: authentication đi qua `account`/`auth` như mọi application khác; nó chỉ tiêu thụ **Account ID** (`sub`) như tham chiếu opaque.

## 2. Ranh giới với các context khác

| Context                 | Sở hữu (rút gọn)                                                                                         | Không sở hữu (rút gọn)                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `account`               | Dữ liệu danh tính: hồ sơ, email đã xác thực, credential, MFA/passkey, browser session, authn audit       | Staff membership, staff role, permission assignment — trạng thái staff ≠ trạng thái account (invariant 31) |
| `auth`                  | Giao thức OAuth 2.0 / OIDC: flows, clients, token issuance/revocation                                    | Business role/permission — **OAuth scope ≠ application-level permission** (A22)                            |
| `staff-access`          | Staff directory/lifecycle, permission/role catalog, assignment, product entitlement, authorization audit | Không phải IdP, không phải credential store; không tự enforce trên resource của context khác               |
| Resource-owning backend | Enforce permission trên operation + tài nguyên của chính nó, trên **mọi** protected request (A23)        | Không tự phát minh permission ngoài catalog                                                                |

Enforcement chia đôi: **catalog govern ở Staff Access; backend enforce ở resource-owning backend.** Token hợp lệ không phải bằng chứng privilege còn hiện hành (A24).

## 3. Domain model (khái niệm)

### 3.1 Staff member ↔ Account ID

- **staff member** (thành viên staff) là một người trong **staff directory** của context, liên kết tới đúng **một** Account ID.
- Thuật ngữ là **`staff`** — không dùng `user`, `employee` hay `admin` để chỉ khái niệm này, tránh nhầm với account `users` của `account`.
- Account ID (`sub`) là **reference** ổn định, không tái phát hành/không tái sử dụng; **email không phải khoá danh tính chính**.
- Một Account ID có thể không có staff entry; khi có, mapping là 1:1. Không suy ra staff membership từ việc một Account tồn tại.
- Không tạo staff entry bằng dữ liệu do client gửi; linkage do server-side decision tạo và audit.

### 3.2 Staff status — trục khác hẳn account status

- **staff status** là trạng thái **membership** của một staff member trong staff directory; đề xuất gồm `active` | `suspended` | `terminated`. Tập nhãn này **chưa chốt**; điều đã chốt là nó là **trục riêng**, không suy ra từ account status.
- Account status (`active` | `suspended` | `deleted`) do `account` sở hữu. Hai trục **khác nhau, không suy ra nhau**.
- Thay đổi account status (suspend/delete ở `account`) **không** tự động viết lại staff status; ngược lại, `terminated` ở `backoffice` **không** tự suspend account.
- Hai bên biết về nhau qua event/contract với semantics riêng, nhưng không có đường ghi ngầm: `account` không ghi dữ liệu staff, `staff-access` không ghi dữ liệu account.
- `terminated` là trạng thái cuối cho membership; khôi phục membership là thao tác mới có audit, không phải "chuyển lại về active" im lặng.

### 3.3 Permission và permission catalog

- **permission** là định danh một hành động trên một resource domain (action + resource domain). Nội dung của từng permission cụ thể là quyết định của service/resource-owning backend đặt tên và dành chỗ; tài liệu này **không phát minh** permission cụ thể nào.
- Permission **không phải scope**: OAuth scope do `auth` cấp theo giao thức không map thẳng thành application-level permission (A22).
- **permission catalog** — danh mục các permission được phép gán — thuộc sở hữu của `staff-access`. Thêm/đổi/bỏ một permission là governance action có audit.
- **Enforcement thuộc resource-owning backend**: catalog định nghĩa permission; resource-owning backend enforce permission đó trên operation của chính nó. Permission ngoài catalog không được backend tự phát minh (A21, ADR-0009).
- Permission không hàm ý theo thời gian hay theo object — đó là hai trục của assignment (§3.5) và của enforcement (§4).

### 3.4 Role

- **role** là một tập permission có tên; role là cách gán quyền theo nhóm thay vì gán từng permission.
- **Không có unrestricted `isAdmin` bypass role**: mọi role đều là tập permission hữu hạn, và mọi đường đều đi qua enforcement như nhau.
- **system-defined role** vs **custom role** được phân biệt; custom role administration **không bật** giai đoạn này, chỉ system-defined role (ADR-0004).
- Role hierarchy (role kế thừa role) **không dùng**; gán phẳng (ADR-0007).
- Nội dung của từng system-defined role chưa chốt ở đây — nó phải xuất phát từ permission catalog thực tế, không phải từ tài liệu này.

### 3.5 Staff-role assignment

- **role assignment** gán một role cho một staff member; một staff member có thể có **nhiều** role.
- Assignment có thể kèm **phạm vi (scope)** và **hạn theo thời gian** — hai thuộc tính này quyết định assignment sống ở đâu, tới khi nào.
- **Job title confers no permissions**: chức danh/hồ sơ không tạo ra quyền; chỉ assignment tạo quyền.
- Không tự-assignment, không tự-nâng quyền, không gán quyền vượt quá quyền của mình (§4); mọi assignment là privileged operation có audit.
- Khi staff status chuyển sang `terminated`, assignment không còn hiệu lực — nhưng việc này **không** suy ra từ account status (§3.2).

### 3.6 Product entitlement

- **Entitlement trả lời đúng một câu hỏi:** "nhân sự X có được dùng sản phẩm P không" — **product availability**, nhị phân theo cặp (staff, product). Nó **không** mang per-resource, **không** mang per-operation, **không** evaluate điều kiện nào.
- **Authorization trả lời câu hỏi per-resource/per-operation** và được **resource-owning backend enforce** bằng dữ liệu của chính nó + permission catalog — **catalog govern, backend enforce** (§4). Entitlement **không bao giờ** tham gia đường quyết định per-operation.
- **Read model và event của entitlement chỉ mang tính khả dụng sản phẩm** — **không** mang verdict allow/deny, **không** mang permission list, **không** mang nội dung role, **không** mang per-resource scope. Ràng buộc này được enforce cơ học ở lớp contract.
- **Chiều ngược:** thu hồi entitlement xóa bỏ tính khả dụng sản phẩm; nó **không** tự tính hay truyền bất kỳ verdict authorization nào về resource cụ thể — điều đó vẫn thuộc enforcement của sản phẩm.
- **Non-goal:** entitlement **không** phải input policy engine cho quyết định kiểu ABAC — ABAC/policy engine vẫn **deferred** (ADR-0006, §3.7).

### 3.7 Authorization audit

- **authorization audit** là bản ghi của một thao tác nhạy cảm quyền: actor, target, action, thời gian, kết quả, lý do, request/correlation ID.
- **Append-only** và access-restricted; **không** chứa access token, auth secret hay PII.
- Audit ghi _đã xảy ra gì_, không phải _được phép làm gì_ — nó không thay thế enforcement.
- **Không giả định xoá vật lý**: `terminated` là trạng thái của record staff, không phải xoá record; lịch sử assignment được giữ để audit còn truy vấn được.
- Retention cho authorization audit đi theo policy retention hệ thống cho audit/security event — quyết định hệ thống, canonical ở `architecture/01-architecture.md` §10; `staff-access` là consumer, không phải owner của policy (ADR-0008).

### 3.8 Deferred — chỉ bật khi có điều kiện kích hoạt

| Khái niệm                              | Trạng thái   | Điều kiện kích hoạt xem xét lại                                                      |
| -------------------------------------- | ------------ | ------------------------------------------------------------------------------------ |
| **role hierarchy**                     | **deferred** | Catalog lớn tới mức kế thừa role là cần thật (ADR-0007)                              |
| **ABAC / ReBAC / policy engine ngoài** | **deferred** | Một yêu cầu resource/context cụ thể được chứng minh là RBAC không đáp ứng (ADR-0006) |
| **departments / groups**               | **deferred** | Có nhu cầu assignment theo tổ chức được lặp lại thay vì gán role từng người          |

ABAC được định nghĩa là logical access control mà kết quả authorize được quyết định bằng cách evaluate **attributes** của subject, object, operation và đôi khi environment conditions (nguồn: NIST SP 800-162). **v1 chỉ RBAC** — không dùng ABAC/ReBAC/policy engine ngoài (ADR-0006).

## 4. Authorization model và nơi enforce

- **Deny-by-default.** Mọi protected request bị từ chối trừ khi được authorize rõ ràng; không có đường allow mặc định khi thiếu dữ liệu (A23).
- **Server-side enforcement tại resource-owning backend, trên mọi protected request.** "Permission should be validated correctly on every request"; validate ở phần lớn request là **không đủ**.
- **Decision inputs:** principal (Account ID + staff context) + action (permission) + resource (object + scope) + context. Thiếu, sai, mơ hồ hay không đọc được authorization state → **fail closed**, **không** có degraded allow path.
- **Object-level + scope-level checks bắt buộc (A23).** Có quyền với _loại_ object không đồng nghĩa truy cập mọi object của loại đó (IDOR/BOLA — CWE-639); role assignment **không** phải quyền không giới hạn trên mọi object. Ownership/data filtering theo từng resource.
- **Enforcement chia đôi, không hợp nhất:** một permission được định nghĩa và có lifecycle trong **catalog của `staff-access`**, nhưng việc _enforce_ permission đó trên operation/resources thuộc về **resource-owning backend** của chính resource đó. `staff-access` không thay resource-owning backend quyết định trên từng request; resource-owning backend **không tự phát minh permission ngoài catalog**.
- **UI visibility ≠ authorization (A23).** Ẩn nút, ẩn route hay ẩn menu là trải nghiệm, không phải chốt chặn; gọi trực tiếp API phải vẫn bị từ chối.
- **Workload/service identity ≠ end-user identity.** Internal call mang danh tính service nào thì không được phép giả danh end-user, và ngược lại; hai trục principal không trộn.
- **Trusted mapping** từ token subject (`sub`) sang Account ID và sang staff context diễn ra server-side từ token đã xác thực; client không supply được principal, role, permission hay scope.
- **Internal contracts** không dựa vào vị trí mạng: dùng envelope HMAC (signature + timestamp + nonce, chống replay) theo giao thức canonical ở `docs/applications/auth/01-architecture.md` §8; **vị trí mạng nội bộ không phải trust**.
- **`staff-access` không mặc định trở thành lời gọi đồng bộ trên mỗi request.** Resource-owning backend tự enforce với dữ liệu nó có (token + assignment đã đồng bộ); **không có** contract nhận kết quả authorization từ `staff-access` (ADR-0009) — chỉ batch/event-based sync.
- **Quyết định deny cũng phải quan sát được** như quyết định allow — một request bị từ chối mà không để lại dấu vết là mất tín hiệu điều tra; nội dung audit vẫn theo §3.7, không ghi secret.

## 5. Token validation và freshness của authorization

- **Resource server validate token theo token profile của nó:** chữ ký, issuer, audience, expiry. RFC 9700 (BCP 240): access tokens **SHOULD** audience-restricted tới một resource server cụ thể; khi token không hợp lệ "the resource server MUST refuse to serve the respective request"; "The privileges associated with an access token SHOULD be restricted to the minimum required".
- **ID Token không phải API access token.** OIDC Core 1.0 định nghĩa ID Token là JWT "that contains Claims about the Authentication event", và validation của nó gồm `iss` "MUST exactly match", `aud`, chữ ký JWS, và `exp` — đó là bằng chứng của **một authentication event giữa OP và Client**, không phải permission để gọi resource server.
- **Token validity ≠ privilege currency (A24).** Một token còn hạn **không** phải bằng chứng privilege còn hiện hành: staff có thể đã `terminated`, assignment có thể đã hết hạn, account có thể đã `suspended`, authorization cache có thể cũ.
- **Bốn cơ chế tách biệt, không suy cái này ra cái khi:**

| Cơ chế                               | Ai sở hữu                                | Nó làm được gì                                            | Nó **không** làm được gì                          |
| ------------------------------------ | ---------------------------------------- | --------------------------------------------------------- | ------------------------------------------------- |
| **Staff termination**                | `staff-access`                           | Chấm dứt membership và assignment của staff member        | Không thu hồi token đã cấp; không suspend account |
| **Account suspension**               | `account`                                | Chặn xác thực mới, thu hồi browser session theo `account` | Không tự xoá staff status hay assignment          |
| **Token / session revocation**       | `auth` (+ `account`)                     | Làm token/session hết hiệu lực theo mô hình revocation    | Không sửa staff status; không đổi catalog         |
| **Authorization cache invalidation** | resource-owning backend + `staff-access` | Làm cache permission/role cũ hết hiệu lực                 | Không thu hồi token, không đổi account status     |

- **Stale-authorization risk khi role/status được embed vào JWT.** Các lựa chọn và đánh đổi:

| Lựa chọn                                       | Đổi lấy gì                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| **Short-lived token**                          | Cửa sổ stale nhỏ; phải có đường gia hạn an toàn — không nêu con số ở đây |
| **Online check với trạng thái `staff-access`** | Luôn thấy trạng thái hiện hành; trả giá một lần tra cứu mỗi request      |
| **Versioned authorization state**              | Token mang version, backend từ chối version đã bị thu hồi                |
| **Cache invalidation**                         | Giảm tải; độ trễ invalidation là rủi ro phải đo và giới hạn              |

- **Ngưỡng revocation latency tối đa theo risk class (ADR-0002):** `normal` ≤ 60 giây, `high` ≤ 5 giây (target) — và cơ chế đáp ứng ngưỡng đã chốt (ADR-0014): event-driven invalidation với deadline delivery theo event class (`high` ≤ 5s, `normal` ≤ 60s), freshness bound + fail-closed, re-check-at-write-time cho write path. Không tuyên bố Cloudflare Queues (hay bất kỳ hàng đợi nào) đơn thuần bảo đảm ngưỡng ≤ 5 giây, và không hứa thu hồi tức thời — hai điều này giữ nguyên hiệu lực trong ADR-0014.
- **Privilege change → cân nhắc regenerate session/token.** OWASP Session Management Cheat Sheet: session phải invalidate **server-side**, và "The session ID must be renewed or regenerated… after any privilege level change"; xoá cookie một mình **không** invalidate bản sao session bị đánh cắp.

## 6. Step-up authentication, privileged operations và governance

- **Permission ≠ authentication assurance.** Một staff member có permission vẫn có thể bị đòi bước xác thực mạnh hơn cho hành động rủi ro cao; `staff-access` dựa vào **bằng chứng từ flow `auth` đáng tin cậy**, và **không bao giờ tin cờ MFA do client supply** (claim/header do client gửi bị bỏ qua và bị coi là không đáng tin). Cơ chế step-up và freshness window đã chốt → ADR-0005.
- **Cấm:** tự gán role (self-assignment), tự nâng quyền (self-elevation), cấp quyền vượt quá quyền của chính mình (granting above one's own authority).
- **Separation of duties.** Role administration tách khỏi thao tác nghiệp vụ thường ngày; thao tác rủi ro cao cần phê duyệt độc lập (independent approval).
- **Mass-affecting role edits phải được gated** — sửa nhiều assignment cùng lúc có blast radius lớn nên phải qua nút kiểm soát riêng.
- **Concurrency khi đổi quyền phải không mở rộng quyền âm thầm:** re-check authorization **at write time**, không dùng kết quả đã cache từ trước khi quyền bị thay đổi (chống TOCTOU).
- **Bootstrap first-administrator và emergency recovery phải được document hoá và audit.** Chúng **không** được là cờ bypass/backdoor chưa document hay một đường tắt `isAdmin`; đường đã chốt là IaC/manual SQL có audit trail + hai-phím rule, không có backdoor code path (ADR-0003).

## 7. Data và service trust

- **Quyền ghi không đi kèm vị trí mạng.** `account`/`auth` **không bao giờ** mutate role assignment, staff hay catalog của `staff-access`, kể cả khi chung hạ tầng lưu trữ. Ranh giới này là ownership, không phải cấu hình: mỗi service chỉ có quyền tối thiểu trên dữ liệu của chính nó.
- **Vị trí mạng không phải bằng chứng danh tính.** Một lời gọi nội bộ không được coi là đáng tin vì nó đến từ trong hệ thống; lời gọi nội bộ phải mang bằng chứng xác thực riêng. Giao thức canonical → `docs/applications/auth/01-architecture.md` §8; `staff-access` **không** tự định nghĩa envelope thứ hai.
- **Confused deputy ở privileged BFF.** `staff-access` (UI + BFF) không được hành động thay cho một identity chưa được xác minh: principal luôn lấy từ server-side verified token, không từ request body/param.
- **Tách end-user identity với workload identity** khi các privileged operation được thực hiện thay (on behalf of) — cần ghi rõ principal nào đang thực thi và audit theo principal đó.

Cơ chế runtime của bốn ranh giới trên (credential role, kết nối, envelope HMAC) → [`docs/applications/staff-access/01-architecture.md`](../../applications/staff-access/01-architecture.md) và [`docs/architecture/01-architecture.md`](../../architecture/01-architecture.md) §6. Quyết định "Service Binding không phải cơ chế xác thực" nằm ở đó, không ở tài liệu domain.

## 8. Architectural Invariants

| #   | Invariant                                                                                                                                      | Enforcement                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | Authorization **deny-by-default**, enforced **server-side** tại resource-owning backend trên **mọi** protected request                         | Contract test: request thiếu permission → `403`, kể cả gọi thẳng API                       |
| 2   | **UI visibility ≠ authorization** — ẩn UI không thay thế server-side check                                                                     | Contract test: thao tác bị ẩn UI, gọi API trực tiếp → vẫn `403`                            |
| 3   | Không tin bất kỳ identity/role/permission/scope/MFA flag nào do client supply                                                                  | Contract test: request với claim/header giả bị bỏ qua hoặc bị từ chối                      |
| 4   | `account`/`auth` **không ghi** vào dữ liệu staff/role/permission của `staff-access`                                                            | DB grant review (REVOKE theo role) + module-boundary lint                                  |
| 5   | **Token validity ≠ privilege currency** — privilege check đọc trạng thái hiện hành, không suy từ token còn hạn                                 | Contract test: token còn hạn + staff `suspended` → từ chối                                 |
| 6   | **Không** có bypass `isAdmin`/cờ chưa document nào đi qua enforcement                                                                          | Manual review đường request path + audit-log check: mọi privileged op có audit             |
| 7   | Mọi privileged operation ghi **authorization audit** (actor, target, action, time, result, reason, correlation ID), **không** secret/token/PII | Audit-log check: truy vấn audit không chứa token/secret/PII                                |
| 8   | `staff status` và **account status** là hai trục độc lập, không suy ra nhau                                                                    | Contract test: account bị suspend không tự đổi staff status (và ngược lại)                 |
| 9   | Bootstrap/recovery first-administrator chỉ qua đường **đocumented + audited**                                                                  | Manual review đường bootstrap + audit-log check: mọi lần thử có audit                      |
| 10  | Catalog là nguồn sự thật duy nhất của permission; resource-owning backend **không** tự phát minh permission ngoài catalog                      | Contract test + catalog review: permission dùng bởi backend phải có trong catalog          |
| 11  | Least-privilege DB credential; runtime privilege ≠ migrator privilege                                                                          | DB grant review: `has_table_privilege` sweep không còn quyền thừa                          |
| 12  | Authorization audit **append-only**, access-restricted                                                                                         | SQL check: UPDATE/DELETE trên audit bị từ chối; grant read có giới hạn                     |
| 13  | UI **không giả lập backend**: không mở rộng trạng thái backend chưa xác nhận; ngoài prototype chỉ backend; lỗi → lỗi thật, không fallback mẫu  | Browser test readonly boundary + unit `app/backoffice-data/data-gate.spec.ts`: fail-closed |

## 9. Đã chốt qua ADR

Mười bốn quyết định từng "chưa chốt" dưới đây đã được chốt bằng architectural decision record ([ADR](./adr/README.md)) — mỗi quyết định có **một** canonical location là ADR tương ứng; bảng này chỉ giữ **con trỏ** tới đó, không nhân bản quyết định. Thay đổi nội dung một quyết định được chốt phải qua ADR tương ứng (hay một ADR mới thay thế nó), không sửa ô bảng ở đây; điều kiện kích hoạt xem xét lại từng quyết định được ghi trong ADR đó. Danh sách trạng thái tổng của bộ ADR → [`adr/README.md`](./adr/README.md).

| Quyết định (đã chốt)                                                                                                                               | ADR                                                                                                                                                                                                                          | Kích hoạt                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Storage/schema cho staff/RBAC** — engine theo quy tắc bounded context (`architecture/01-architecture.md` A20)                                    | [ADR-0001](./adr/0001-storage-schema-staff-rbac.md) — PostgreSQL; tên database/schema `db-staff-access`/`staff_access` theo [ADR-0013](./adr/0013-staff-access-ownership-transfer.md)                                        | Trước khi implement persistence đầu tiên cho staff/RBAC                      |
| **Ngưỡng revocation latency tối đa theo risk class** (A24)                                                                                         | [ADR-0002](./adr/0002-revocation-latency-risk-class.md) — `normal` ≤ 60s, `high` ≤ 5s (target)                                                                                                                               | Trước khi bật role assignment thật                                           |
| **Cơ chế bootstrap first-administrator + emergency recovery** — đường nào, ai approve, audit ra sao                                                | [ADR-0003](./adr/0003-bootstrap-first-admin-recovery.md) — IaC/manual SQL + hai-phím rule, không có backdoor path                                                                                                            | Trước khi cấp quyền đầu tiên                                                 |
| **Có bật custom role administration không** (system-defined vs custom)                                                                             | [ADR-0004](./adr/0004-custom-role-administration.md) — không bật; chỉ system-defined role                                                                                                                                    | Trước khi cho phép tạo role ngoài system-defined                             |
| **Step-up mechanism + freshness window** cho hành động rủi ro cao                                                                                  | [ADR-0005](./adr/0005-step-up-fresh-session.md) — fresh session ≤ 5 phút (target) trước privileged operation                                                                                                                 | Trước privileged-operation workflow đầu tiên                                 |
| **Có cần ABAC/ReBAC/policy engine ngoài không**                                                                                                    | [ADR-0006](./adr/0006-no-abac-rebac-policy-engine.md) — không dùng; RBAC + typed scope + controlled conditions                                                                                                               | Khi có yêu cầu resource/context cụ thể được chứng minh là RBAC không đáp ứng |
| **Có bật role hierarchy không**                                                                                                                    | [ADR-0007](./adr/0007-no-role-hierarchy.md) — không dùng; gán phẳng                                                                                                                                                          | Khi catalog cần kế thừa role thay vì gán phẳng                               |
| **Retention cho authorization audit** — theo retention policy hệ thống cho audit/security event (canonical: `architecture/01-architecture.md` §10) | [ADR-0008](./adr/0008-audit-retention.md) — `staff-access` là consumer, không phải owner của policy                                                                                                                          | Trước production                                                             |
| **Internal contract** nhận kết quả authorization giữa `staff-access` và resource-owning backend                                                    | [ADR-0009](./adr/0009-no-internal-authorization-result-contract.md) — không có; backend tự enforce, chỉ batch/event-based sync                                                                                               | Trước tích hợp enforcement đầu tiên                                          |
| **Cách đặt tên permission read và seed catalog**                                                                                                   | [ADR-0010](./adr/0010-permission-naming-and-read-catalog.md) — `domain.action` dot-style; 3 permission read `staff.read`/`role.read`/`permission.read`                                                                       | Trước route read                                                             |
| **Authn boundary của `staff-access` server routes** — 401 cho credential vắng/hỏng, 503 cho credential không verify được lúc này                   | [ADR-0011](./adr/0011-authn-boundary-and-unauthenticated-response.md) — 401 credential vắng/hỏng, 503 credential không verify được lúc này                                                                                   | Khi tầng authn thật được wire vào `staff-access` server routes               |
| **Credential contract của `staff-access`** — cơ chế mang credential, token được verify, ánh xạ `sub` → staff                                       | [ADR-0012](./adr/0012-credential-contract-and-staff-subject-mapping.md) — Authorization Code + PKCE, BFF đổi code → token, verify access token offline JWKS, phiên BFF riêng, ánh xạ qua `loadPrincipalAuthorization`        | Trước khi implement tầng authn của `staff-access`                            |
| **Ownership transfer** — `staff-access` tiếp quản staff/RBAC từ `backoffice`; database `db-staff-access`, schema `staff_access`                    | [ADR-0013](./adr/0013-staff-access-ownership-transfer.md)                                                                                                                                                                    | Trước khi provision `db-staff-access`                                        |
| **Cơ chế đáp ứng revocation SLA** — tổ hợp nào đạt `normal` ≤ 60s / `high` ≤ 5s (ADR-0002)                                                         | [ADR-0014](./adr/0014-revocation-sla-mechanism.md) — event-driven invalidation với deadline delivery theo event class, freshness bound + fail-closed, re-check-at-write-time cho write path; TTL 300s giữ làm trần bên ngoài | Trước khi bật role assignment thật                                           |
| **Cơ chế relay outbox** — Worker relay đọc bảng outbox, Queue hay NATS                                                                             | [ADR-0016](./adr/0016-outbox-relay-mechanism.md) — cron Worker claim outbox `db-staff-access` + Cloudflare Queues, idempotency key = `event_id`, không NATS                                                                  | Trước tích hợp Saga                                                          |

Quyết định nền tảng của hệ thống (A21–A24) nằm ở hệ thống, không nhân bản tại đây → `architecture/01-architecture.md` §8.
