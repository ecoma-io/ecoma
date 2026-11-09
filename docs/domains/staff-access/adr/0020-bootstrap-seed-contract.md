# ADR-0020 — Hợp đồng bootstrap/seed liên service: chạy ngoài serving path, seed thuộc service sở hữu dữ liệu

> 📌 Thư mục này là bounded context **Staff Access** (xem [`../README.md`](../README.md) §4). ADR này chốt **đường chạy** của bootstrap/seed, **danh tính khởi tạo canonical** (tenant `ecoma`, Superadmin đầu tiên) và **ranh giới sở hữu** của từng bước; nó supersede-in-part [ADR-0003](./0003-bootstrap-first-admin-recovery.md) ở đúng ba điểm ghi ở §"Quan hệ với ADR-0003". Nội dung vận hành đầy đủ (thứ tự bước, bảng bước → database, idempotency, verify) nằm ở [`architecture/02-delivery.md`](../../../architecture/02-delivery.md) §3.2 — architecture sở hữu policy delivery; ADR này chỉ giữ **quyết định**.

> **Trạng thái:** Accepted · **Ngày:** 2026-11-09 · **Quyết định từ:** [`architecture/02-delivery.md`](../../../architecture/02-delivery.md) §0, §3.1 · [ADR-0003](./0003-bootstrap-first-admin-recovery.md) · [ADR-0004](./0004-custom-role-administration.md) · [ADR-0010](./0010-permission-naming-and-read-catalog.md) · [ADR-0013](./0013-staff-access-ownership-transfer.md) · [ADR-0015](../../remote-cache/adr/0015-remote-cache-bounded-context.md) · **Issue:** #10

## Bối cảnh

Ba hiện trạng mâu thuẫn nhau trong cùng một cây code:

1. `deploys/remote-cache-deploy/index.ts` và `deploys/staff-access-deploy/index.ts` ghi "deploy unit cấm mọi code path bootstrap", trong khi [`architecture/02-delivery.md`](../../../architecture/02-delivery.md) §0 ghi **provisioning** là một đường thay đổi riêng do Pulumi project trong `deploys/` sở hữu.
2. `deploys/pact-broker-api-deploy/index.ts` và `deploys/auth-deploy/index.ts` **đang** seed dữ liệu trong deploy unit (tenant `local` + machine token; OAuth client `ecoma-backoffice-local`), nên câu "cấm mọi code path" đã bị chính repo phủ định.
3. Hai migration `0003_permission_catalog_seed.sql` insert dữ liệu permission, trong khi `02` §3 mô tả migration chỉ tạo schema.

Cùng lúc, ba tên khác nhau đang chỉ cùng một thứ: `ecoma-internal` (bootstrap script Pact Broker, consumer entitlement), `local` (seed deploy local), `Ecoma` (yêu cầu MVP). Không có ADR nào chốt tên nào là canonical, nên mỗi Issue Delivery sẽ tự chọn một tên.

Hai khoảng trống nữa mà hợp đồng này phải trả lời:

- **Account đầu tiên.** [ADR-0003](./0003-bootstrap-first-admin-recovery.md) quy định procedure first-administrator nhận một `sub` đã tồn tại ở `db-account`, nhưng không có quyết định nào nói Account đầu tiên được tạo ra ở đâu và với trạng thái email nào.
- **Ai điều phối thứ tự bước.** Mỗi bước ghi một database khác nhau, nhưng chưa có chỗ nào nói cái gì chạy các bước theo đúng thứ tự mà không trở thành người ghi database của service khác.

Câu hỏi ADR này trả lời: bootstrap/seed chạy ở đâu, dữ liệu nào thuộc lớp đó, tên tenant nội bộ canonical là gì, Account đầu tiên và quyền quản trị đầu tiên được tạo thế nào, và cái gì điều phối thứ tự bước.

## Phương án

| #   | Phương án cho đường chạy bootstrap                                                                                                                       | Đánh giá                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Bước một-lần trong provisioning lifecycle của deploy unit sở hữu dữ liệu, cộng CLI offline cùng service cho production và cho bước cần `ecoma_owner`** | Chấp nhận — chạy ngoài Worker, dùng credential migrator/owner không bao giờ vào Worker, không route, không flag, không phụ thuộc service đang serving; giữ được "deploy/readiness fail nếu bootstrap fail" bằng thứ tự phụ thuộc resource; cùng một đường dùng được cho local và environment thật |
| 2   | Framework bootstrap trung tâm (service/migration runner ôm mọi service)                                                                                  | Loại — service thứ hai ghi database của service khác, phá A9 và `AGENTS.md`; tạo distributed transaction chỉ để che một nhu cầu mà thứ tự bước đã giải quyết được                                                                                                                                 |
| 3   | Chạy bootstrap trong Worker (cron, route nội bộ, flag "nếu chưa có thì tạo")                                                                             | Loại — đúng hình dạng backdoor mà [ADR-0003](./0003-bootstrap-first-admin-recovery.md) và invariant 36 cấm; Worker không giữ được credential owner/migrator (invariant 1)                                                                                                                         |
| 4   | Chỉ manual SQL, không có entry point nào trong repo                                                                                                      | Loại cho mọi bước trừ first-admin — không kiểm được, không lặp lại được, và biến mỗi environment thành một lần gõ tay không idempotency                                                                                                                                                           |
| 5   | Đưa toàn bộ seed vào migration                                                                                                                           | Loại — dữ liệu biến thiên theo lane/environment (redirect URI, tenant, token) không thể nằm trong file migration; credential trong migration là chỗ credential không được phép xuất hiện                                                                                                          |

## Quyết định

1. **Bootstrap/seed là lớp dữ liệu thứ tư, không phải migration và không phải application release.** Nó chỉ chứa **dữ liệu khởi tạo do hệ thống sở hữu**: bản ghi mà sản phẩm cần để hoạt động và không do người dùng tạo ra — Account đầu tiên, staff/role assignment đầu tiên, tenant nội bộ + membership, machine credential cho CI, provider/offer đầu tiên. Dữ liệu do người dùng tạo lúc chạy (tenant của khách hàng, project, API key của khách) **không** thuộc lớp này và giữ nguyên đường tạo riêng của sản phẩm.
2. **Không có code path bootstrap nào trên serving path của Worker.** Cấm route HTTP, cấm flag runtime, cấm logic "nếu chưa có thì tạo" trong Worker bundle. Đây là nghĩa đúng của câu "deploy unit cấm mọi code path bootstrap" đang ghi trong `deploys/remote-cache-deploy` và `deploys/staff-access-deploy`: cấm **đường serving**, không cấm bước provisioning.
3. **Hai bề mặt thực thi, chọn đúng một cho mỗi bước:** (a) bước một-lần trong provisioning lifecycle của deploy unit sở hữu dữ liệu, chạy sau `migrate` và trước khi container serving khởi động — bề mặt của lane local; (b) CLI offline nằm trong chính app sở hữu dữ liệu, chạy bằng credential migrator/owner — bề mặt cho environment thật và cho bước cần `ecoma_owner`. Không bề mặt nào đọc/ghi database của service khác.
4. **Seed thuộc service sở hữu dữ liệu, ghi đúng một database.** Mỗi bước chỉ ghi database của chính service đó; bước cần nhiều database phải liệt kê tường minh cùng cơ chế hội tụ khi chạy lại. Không FK xuyên database, không transaction nguyên tử xuyên database, không dùng email làm subject của Account — `sub` là tham chiếu duy nhất đi xuyên service.
5. **Idempotent bằng natural key, không bằng state ngoài.** Mỗi bước có khoá tự nhiên trong domain (`sub`, `(product, tenant name)`, `(tenant, sub)`, `client_id`, `sha256(plaintext token)`, permission id); chạy lại là no-op trên bản ghi đã có và hội tụ về đúng trạng thái của một lần chạy sạch. Không file trạng thái, không bảng marker, không đọc log để quyết định bước kế tiếp.
6. **Không có compensating step nào; forward-fix theo invariant 11.** Mọi bước là insert-if-absent hoặc update trường không phải danh tính, nên trạng thái dở dang là một **tiền tố hợp lệ**, không phải trạng thái hỏng: chạy lại toàn bộ hợp đồng từ đầu là cơ chế phục hồi duy nhất. Tenant ở trạng thái `suspended`/`deleted` phải fail-closed, không được hồi sinh.
7. **Lỗi được cô lập theo service.** Bootstrap/verify của một unit thất bại chỉ làm unit đó không ready và không được coi là hoàn tất; các unit khác vẫn retry được. Phụ thuộc duy nhất giữa các unit là giá trị `sub` do bước Account sinh ra — một giá trị đầu ra, không phải một ràng buộc giao dịch.
8. **Mỗi bước có một kiểm tra đọc được, không dựa vào log.** Kiểm tra là một câu truy vấn/probe trả về đúng bản ghi kỳ vọng (hoặc đúng một `sub`), chạy được bằng chính bề mặt đã chạy bước đó. Bảng bước → database → kiểm tra là nội dung canonical của `02` §3.2.
9. **Tên tenant nội bộ canonical là `ecoma`.** Đây là tên lưu trong database, ở mọi sản phẩm có tenant và mọi environment. `local`, `staging`, `production` là nhãn environment/lane và **không** bao giờ là tên tenant; `Ecoma` chỉ là nhãn hiển thị trong prose. Không tồn tại tenant song song `ecoma-internal`; mọi câu `ecoma-internal` còn lại trong tài liệu hay code trước ADR này đọc là `ecoma`. Cấu hình theo environment được đổi **input seed** (endpoint, credential, redirect URI, token plaintext), **không** được đổi danh tính canonical của tenant. Mỗi sản phẩm vẫn sở hữu tenant riêng của nó: cùng chuỗi `ecoma` ở `pact-broker` và `remote-cache` là hai entity khác nhau, có thể ở hai database khác nhau, không FK, không suy quyền ([ADR-0015](../../remote-cache/adr/0015-remote-cache-bounded-context.md)).
10. **Migration được chứa đúng một lớp dữ liệu: catalog sealed.** Reference data có danh tính cố định lúc review, không biến thiên theo environment, không phải credential — permission catalog và mail template catalog — nằm trong migration của service sở hữu, insert idempotent, forward-only. Tenant, membership, staff/role assignment, machine token, OAuth client, và mọi credential **không** được nằm trong migration.
11. **Bootstrap Superadmin — Account đầu tiên, không cần phê duyệt, không tự đánh dấu email `verified`.** Procedure tạo đúng **một** Account với email khởi tạo `superadmin@ecoma.io` và cấp cho nó quyền quản trị hệ thống:
    - **Email khởi tạo là danh tính canonical**, giống tên tenant `ecoma`: `superadmin@ecoma.io` ở mọi environment. Cấu hình environment cung cấp input seed, không được thay bằng một địa chỉ khác.
    - **Email ở trạng thái `pending`.** Bootstrap ghi hàng `account.email_addresses` với `status = 'pending'`, **không** đặt `verified_at`, **không** đặt `is_sign_in`. Verify email là hành vi của Superadmin khi chứng minh kiểm soát hộp thư, không phải hành vi của bootstrap.
    - **Không yêu cầu phê duyệt hai-phím.** Trên một environment mới, chưa tồn tại identity quản trị nào để làm phím thứ hai; một "phím thứ hai" trong tình huống đó chỉ là credential vận hành dùng chung, không phải một phê duyệt độc lập. Neo tin cậy của bootstrap là **chứng minh kiểm soát email** ở lần đăng nhập đầu, cộng audit trail và idempotency của procedure.
    - **Staff identity + role assignment hệ thống** do `staff-access` tạo ở `db-staff-access`: staff entry của `sub` vừa được Account cấp, và một assignment của **system-defined administrator role** (`granted_by` NULL — schema đã dành nghĩa đó cho hàng do bootstrap/migrator tạo). Nội dung permission của role đó thuộc permission catalog, chốt ở #11 (xem Quyết định 14).
    - **Superadmin là Account bình thường.** Không có account type hay cờ riêng; quyền quản trị đến từ role assignment và audit đi qua `staff_access.authorization_audit`. Sau khi email được verify, account đi theo đúng lifecycle và capability bảo mật của Account thường.
    - **Nhiều Superadmin được phép**, nhưng chỉ Superadmin đầu tiên đi qua bootstrap. Superadmin thứ hai được tạo bằng role administration thông thường, không bằng cách chạy lại bootstrap.
    - **Một Superadmin không thể tự thu hồi quyền quản trị của chính mình**; một Superadmin khác phải thực hiện. Đây là áp dụng separation of duties (§6 `../domain-model.md`) cho chính đường bootstrap.
12. **Một entry point bootstrap, nhiều cấu hình environment.** Thứ tự bước được điều phối bởi **một** entry point vận hành duy nhất, chạy bằng cấu hình chọn environment và input seed của environment đó. Entry point đó:
    - là **script vận hành nội bộ**, không phải một application cần đường production: vị trí của nó theo `05-code-architecture.md` §2.1 (`tools/`, cùng nhóm với `tools/account-bridge`), **không** đặt trong `deploys/` và **không** tạo edge giữa hai Pulumi stack;
    - **không giữ credential database nào** và **không ghi trực tiếp database của service nào**;
    - chỉ gọi **thao tác bootstrap do từng service tự sở hữu** (bề mặt (a) hoặc (b) của Quyết định 3), theo đúng thứ tự, và dừng khi một bước fail.

    Logic bootstrap và danh tính canonical (`ecoma`, `superadmin@ecoma.io`) giống nhau ở mọi environment; chỉ input seed đổi. Không có cấu hình nào của environment này được fallback sang environment khác (`02` §4.1 điều 1).

13. **Phân chia sở hữu dữ liệu khởi tạo — mỗi bản ghi có đúng một service ghi:**

    | Dữ liệu khởi tạo                                 | Service ghi    | Database                       |
    | ------------------------------------------------ | -------------- | ------------------------------ |
    | Account Superadmin + hàng email `pending`        | `account`      | `db-account`                   |
    | Staff identity + assignment của administrator    | `staff-access` | `db-staff-access`              |
    | Tenant `ecoma` + owner membership                | từng sản phẩm  | database của chính sản phẩm đó |
    | Machine token, OAuth client, provider/offer, key | service sở hữu | database của chính service đó  |

    Hàng "từng sản phẩm" **không** giả định các sản phẩm chia sẻ một database hay một implementation: `pact-broker`, `remote-cache`, `llm-consumer-tenant` và `llm-seller-tenant` có tenant riêng, database riêng, và bước seed riêng của từng service.

14. **Catalog permission có một nguồn canonical; permission thứ tư và nội dung role chưa chốt ở đây.** Canonical là `staff_access.permissions` ([ADR-0013](./0013-staff-access-ownership-transfer.md)); mọi thay đổi đi qua seed migration mới, không sửa migration đã apply ([ADR-0010](./0010-permission-naming-and-read-catalog.md)). Chênh lệch 3-vs-4 permission giữa `db-staff-access` và `db-backoffice` (`audit.read`, thêm bởi P5.4/issue #478) **không** được giải quyết bằng cách chọn một bên tại đây; quyết định tập permission và nội dung system-defined administrator role thuộc #11. ADR này chỉ chốt rằng bước Staff của bootstrap **không** tự định nghĩa permission nào.

## Quan hệ với ADR-0003

Ba điểm bị supersede, phần còn lại giữ nguyên hiệu lực:

- **Bị supersede:** câu "Không có route/flag/code-path nào thực hiện bootstrap hay recovery" được đọc lại thành **"không có route/flag/code path nào trên serving path của Worker"** theo Quyết định 2 và 3 ở trên. Một bước provisioning hoặc CLI offline không phải code path của application.
- **Bị supersede:** tên database trong ADR-0003 (`db-backoffice`) đọc theo [ADR-0013](./0013-staff-access-ownership-transfer.md) là `db-staff-access` — đây là cách đọc đã được ADR-0013 tuyên bố cho ADR-0002…0012, ghi lại ở đây để ADR-0003 không còn bị trích dẫn như một mâu thuẫn.
- **Bị supersede, chỉ cho đường bootstrap đầu tiên:** **hai-phím rule** không áp dụng cho lần bootstrap Superadmin đầu tiên, theo Quyết định 11. Trust anchor thay thế là chứng minh kiểm soát email ở lần đăng nhập đầu. Câu "Hai-phím rule" và các hệ quả của nó trong ADR-0003 **vẫn nguyên hiệu lực cho emergency recovery**.
- **Giữ nguyên hiệu lực:** audit trail của mọi lần chạy (ai, thời điểm, bản ghi được tạo, khoá idempotency của lần chạy); không có nút bấm UI cho cả hai procedure; `sub` phải tồn tại ở `db-account` trước khi tạo staff; procedure không được tự phát hiện "đã có admin rồi" để rẽ nhánh. Idempotent theo natural key (Quyết định 5) **không** phải logic phát hiện đó: nó hội tụ trên cùng bản ghi, không đọc trạng thái để quyết định có chạy hay không.
- **Giữ nguyên hiệu lực:** emergency recovery dùng lại đúng procedure của ADR-0003, gồm hai-phím và bước xác minh danh tính mạnh hơn. ADR này **không** đổi policy phục hồi và **không** viết runbook phục hồi; phần runbook vẫn chưa có và thuộc vận hành.
- **Bổ sung, không supersede:** ADR-0003 nói procedure first-administrator kiểm `sub` tồn tại trước khi tạo staff. Quyết định 11 thêm bước đứng trước nó — Account đầu tiên — do `account` sở hữu, ở database khác, không nằm trong transaction của `staff-access`.

## Quyết định hoãn — mở lại ở #11

**Cơ chế để Account chưa có email `verified` hoàn tất lần xác minh đầu tiên.** Chủ quyết định: #11, cùng ADR của `account` và `staff-access` mà Issue đó tạo ra. Trigger mở lại: khi #11 chốt đường tạo Account đầu tiên; #17 không được hiện thực bước Account của Quyết định 11 trước khi trigger đó xảy ra.

Quyết định 11 yêu cầu email khởi tạo ở `pending` và Superadmin chứng minh kiểm soát email ở lần đăng nhập đầu. Trong code hiện tại, hai điều kiện đó chưa nối được với nhau:

- chỉ email `status = 'verified'` mới nhận OTP đăng nhập (`apps/account/server/lib/otp.ts`, `lookupVerifiedAddress`), và `docs/domains/account/domain-model.md` FR-002 yêu cầu ≥ 1 email `verified` mới đăng nhập được;
- route verify email (`POST /api/emails/:id/verify`) yêu cầu session đã đăng nhập (`apps/account/server/api/emails/[id]/verify.post.ts`).

Đường hoàn tất lần xác minh đầu tiên vì vậy **chưa được quyết định**; nó phải chọn một cơ chế không phải route bootstrap và không phải flag runtime. ADR này **không** tạo route, flag hay code path nào để lấp khoảng trống đó, và không được trích dẫn như thể khoảng trống đã được giải quyết.

## Hệ quả

- `deploys/pact-broker-api-deploy` và `deploys/auth-deploy` không còn là ngoại lệ chưa được giải thích: chúng là bề mặt (a) của hợp đồng, và phải tuân Quyết định 5 (token plaintext ổn định theo environment, không sinh mới mỗi lần chạy).
- Tenant `local` trong seed Pact Broker bị thay bằng `ecoma`; đây là thay đổi hành vi của lane local, thực hiện ở Issue Delivery #21 — ADR này chỉ chốt tên. Cùng thay đổi áp cho hằng `INTERNAL_TENANT_NAME` trong `apps/pact-broker-api/db/bootstrap-internal-tenant.mts` và cho `ensureTenant('ecoma-internal')` trong `libs/pact-broker-api-application/src/provision-entitlement-membership.ts`: đó là code, nên thuộc #21, không thuộc PR tài liệu này. Đường `ensureTenant(...)` đang chạy trong entitlement queue consumer là **vi phạm Quyết định 2** (tenant được tạo trên đường serving); #21 phải đưa nó về bề mặt bootstrap, không chỉ đổi chuỗi.
- Seed tenant trên bề mặt provisioning phải fail-closed như code đã làm trong `bootstrap-internal-tenant.mts`: `ON CONFLICT` không được `DO UPDATE` trần — một hàng `suspended`/`deleted` không được dùng lại thành `active` (Quyết định 6).
- Cụm `ecoma-internal-v1` / `ecoma-internal-v2` và các header `x-ecoma-internal-*` **không** phải tên tenant — chúng là định danh envelope HMAC của giao thức nội bộ, giữ nguyên.
- Hai migration catalog giữ nguyên vị trí; xem Quyết định 14 cho phần chênh lệch `audit.read`.
- Mọi Issue Delivery có bước bootstrap phải đọc `02` §3.2 thay vì tự chọn thứ tự, bề mặt thực thi hoặc tên tenant.
- Không có framework, service hay abstraction mới: hợp đồng là một bảng bước trong tài liệu delivery, thi hành bằng code có sẵn của từng deploy unit, cộng một entry point vận hành không giữ credential database.

## Cross-reference

- **System:** [`architecture/02-delivery.md`](../../../architecture/02-delivery.md) §0 (bốn đường thay đổi), §3 (migration), §3.2 (hợp đồng bootstrap/seed), §4.1 (hợp đồng environment), §8 (không rollback dữ liệu) · invariant 7, 10, 11, 25, 36.
- **Context:** [ADR-0003](./0003-bootstrap-first-admin-recovery.md) (procedure first-admin + recovery) · [ADR-0004](./0004-custom-role-administration.md) (chỉ system-defined role) · [ADR-0010](./0010-permission-naming-and-read-catalog.md) (catalog permission) · [ADR-0013](./0013-staff-access-ownership-transfer.md) (ownership `db-staff-access`) · [ADR-0015](../../remote-cache/adr/0015-remote-cache-bounded-context.md) (tenant riêng của `remote-cache`).
- **Hiện thực:** #11 (đường Account đầu tiên, ánh xạ email → `sub`, permission thứ tư) · #17 (Account + staff đầu tiên) · #20 (tenant Remote Cache) · #21 (Pact Broker) · #22/#23/#24 (LLM) · #25 (entry point nội bộ).
- **Index:** [`./README.md`](./README.md).
