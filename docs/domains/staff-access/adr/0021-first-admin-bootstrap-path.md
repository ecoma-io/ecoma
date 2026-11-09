# ADR-0021 — Đường tạo Account đầu tiên và bootstrap administrator của Staff Access

> 📌 Thư mục này là bounded context **Staff Access** (xem [`../README.md`](../README.md) §4). ADR này chốt **đường tạo Account đầu tiên**, **ánh xạ email → `sub`**, **thứ tự thi hành procedure bootstrap** và **catalog permission canonical**; nó supersede-in-part [ADR-0003](./0003-bootstrap-first-admin-recovery.md) ở đúng một điểm ghi ở §"Quan hệ với ADR-0003 / ADR-0020 / ADR-0013". Nội dung vận hành đầy đủ (từng bước, kiểm tra sau bước, retry) nằm ở [`applications/staff-access/03-operations.md`](../../../applications/staff-access/03-operations.md); hợp đồng bootstrap/seed liên service vẫn thuộc [ADR-0020](./0020-bootstrap-seed-contract.md).

> **Trạng thái:** Accepted · **Ngày:** 2026-11-09 · **Quyết định từ:** [ADR-0003](./0003-bootstrap-first-admin-recovery.md) · [ADR-0010](./0010-permission-naming-and-read-catalog.md) · [ADR-0012](./0012-credential-contract-and-staff-subject-mapping.md) · [ADR-0013](./0013-staff-access-ownership-transfer.md) · [ADR-0020](./0020-bootstrap-seed-contract.md) · [`architecture/02-delivery.md`](../../../architecture/02-delivery.md) §3.2 · **Issue:** #11

## Bối cảnh

Chi tiết kỹ thuật của procedure first-admin đã có từ ADR-0003, và đường chạy bootstrap/seed liên service đã có từ ADR-0020. Nhưng bốn câu hỏi vẫn chưa có câu trả lời canonical, nên #17 (hiện thực Account + staff đầu tiên) không thể bắt đầu:

1. **Account đầu tiên được tạo bằng đường nào, và email ánh xạ sang `sub` ra sao.** Không có production code path nào `INSERT INTO account.users`; migration hiện chỉ có schema. `account.users` khoá bằng `sub` opaque, email ở bảng riêng tra cứu bằng `address_hash`, còn `staff_access.staff` không có cột email. Nếu không chốt đường ánh xạ, mỗi Issue Delivery sẽ tự nghĩ một đường — và đường dễ nghĩ nhất là dùng email làm subject, đúng thứ FR-002 và ADR-0012 cấm.
2. **Mâu thuẫn database owner.** ADR-0003 yêu cầu procedure ghi `db-backoffice`; ADR-0013 đã chuyển staff/RBAC sang `db-staff-access` và tuyên bố mọi tên `db-backoffice` trong ADR-0002…0012 đọc là `db-staff-access`. Chưa có chỗ nào chốt procedure này viết vào đâu sau khi chuyển.
3. **Catalog permission lệch nhau.** `apps/staff-access/db/migrations/0003_permission_catalog_seed.sql` seed 3 permission; bản của `backoffice` seed 4, thêm `audit.read`. `audit.read` là permission **có thật và đang được enforce** (`apps/backoffice/server/api/audit.get.ts` gọi `withReadEnforcement(event, 'audit.read', …)`), nhưng nó không có trong catalog canonical. Hai catalog song song là hai nguồn sự thật.
4. **Least-privilege đối chiếu với thực tế.** Domain model cấm unrestricted `isAdmin`, và `deploys/staff-access-deploy` ghi rõ nội dung system-defined role **chưa** được seed. Vì vậy "role administrator" không thể được phát minh từ tài liệu — nó phải xuất phát từ catalog đang có.

Ngoài ra, ADR-0003 giữ **hai-phím** cho cả bootstrap lẫn recovery. Yêu cầu của Issue #11 là bootstrap đầu tiên không cần approval (hệ thống mới deploy, chưa có ai để làm phím thứ hai có quyền hệ thống), trong khi **emergency recovery** vẫn phải giữ hai-phím. Đây là một thay đổi quyết định đã accepted, nên nó phải đi qua ADR mới chứ không được sửa ADR-0003 tại chỗ.

## Phương án

### Ánh xạ email → `sub`

| #   | Phương án                                                                                                    | Đánh giá                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Account sở hữu một thao tác create-or-resolve offline, trả `sub`; tra cứu idempotent theo `address_hash`** | Chấp nhận — đúng owner của dữ liệu account/email (ADR-0013 §"Hệ quả"); `sub` là giá trị duy nhất đi xuyên service (ADR-0020 Quyết định 4, 7); chạy lại trả cùng `sub`, không tạo Account thứ hai; `staff-access` không cần đọc `db-account` |
| 2   | Dùng email làm subject/staff subject                                                                         | Loại — FR-002 và [ADR-0012](./0012-credential-contract-and-staff-subject-mapping.md) cấm; email đổi được, `sub` thì không; `staff_access.staff.sub` có CHECK dạng `sub_` và trigger cấm đổi `sub`                                           |
| 3   | `staff-access` tra cứu `db-account` (hoặc đọc thẳng bảng email) để tự tìm `sub`                              | Loại — vi phạm A9 và `AGENTS.md`: một service không chạm database của service khác; `db-staff-access` không có và không được có quyền `CONNECT` sang `db-account`                                                                           |
| 4   | Tra cứu qua contract nội bộ `GET /internal/account/status?sub=` từ procedure                                 | Không đủ một mình — contract này nhận **`sub`** làm đầu vào nên không trả lời được "email này là `sub` nào"; nó chỉ kiểm được một `sub` **đã biết** còn sống hay không                                                                      |
| 5   | Operator tự sinh `sub` rồi insert bằng SQL tay                                                               | Loại — sinh `sub` là việc của `account` (`createSubject` cần entropy CSPRNG); SQL tay không đảm bảo bất biến tombstone/tái phát hành và không idempotent theo natural key                                                                   |

### Phạm vi phê duyệt của lần bootstrap đầu tiên

| #   | Phương án                                                                           | Đánh giá                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Bootstrap đầu tiên không approval; emergency recovery giữ hai-phím của ADR-0003** | Chấp nhận — bootstrap chạy trong provisioning của một environment chưa có ai có quyền; người chạy procedure đã phải cầm credential offline của owner/migrator và đã được kiểm soát bằng chính sách credential (§3.5 `architecture/03-operations.md`), nên "phím thứ hai có quyền hệ thống" ở bước này chủ yếu là hình thức. Recovery chạy trên hệ thống **đang** có admin, nên phím thứ hai vẫn có người thật để đối chiếu |
| 2   | Giữ hai-phím cho cả hai, không phân biệt                                            | Loại — với bootstrap đầu tiên, quy tắc này không kiểm chứng được: ở thời điểm đó chưa tồn tại identity nào có quyền hệ thống ngoài chính người thực thi, nên "phím thứ hai" chỉ còn là chữ ký thứ hai của cùng một người                                                                                                                                                                                                   |
| 3   | Bỏ approval cho cả bootstrap lẫn recovery                                           | Loại — thu hẹp một kiểm soát đã accepted ngoài phạm vi Issue #11 và không có bằng chứng nào cho thấy nó bị supersede                                                                                                                                                                                                                                                                                                       |
| 4   | Approval qua UI/route của backoffice                                                | Loại — ADR-0003 cấm nút UI; ADR-0020 cấm route/flag trên serving path                                                                                                                                                                                                                                                                                                                                                      |

### Catalog permission

| #   | Phương án                                                                                          | Đánh giá                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Nhận `audit.read` vào catalog canonical `staff_access.permissions` bằng một seed migration mới** | Chấp nhận — đúng đường [ADR-0010](./0010-permission-naming-and-read-catalog.md) yêu cầu cho permission mới; `audit.read` đã được enforce ở route thật nên không phải surplus; `id = domain |     | '.' |     | action` thoả CHECK sẵn có (`audit`, `read`) |
| 2   | Sửa `apps/staff-access/db/migrations/0003_permission_catalog_seed.sql` đã apply                    | Loại — migration đã apply là forward-only; ADR-0010 và ADR-0020 Quyết định 10 cấm sửa tại chỗ                                                                                              |
| 3   | Coi catalog của `db-backoffice` là canonical và bỏ catalog của `staff_access`                      | Loại — ADR-0013 đã chuyển ownership; `db-backoffice` là database chuyển tiếp                                                                                                               |
| 4   | Giữ hai catalog, mỗi bên tự enforce                                                                | Loại — invariant 10 của domain model: catalog là nguồn sự thật **duy nhất**; hai catalog là hai câu trả lời cho cùng một câu hỏi                                                           |
| 5   | Không đưa `audit.read` vào catalog, đổi route audit sang permission khác                           | Loại — route đang enforce đúng permission mà trang audit cần; đổi tên chỉ để né một lần seed migration                                                                                     |

## Quyết định

### 1. Account đầu tiên và quyền sở hữu email

Account đầu tiên là một **Account bình thường**, không phải loại Account đặc biệt: cùng bảng `account.users`, cùng tombstone rule, cùng vòng đời suspend/delete. Không có cột, cờ hay bảng nào đánh dấu "account bootstrap".

- **`account` sở hữu** Account, địa chỉ email và audit của mình; **`staff-access` sở hữu** staff identity, role, assignment và authorization audit của mình. Ranh giới này là ADR-0013, không đổi.
- Email khởi tạo là **input cấu hình theo environment** (giá trị đầu tiên là `superadmin@ecoma.io`), không phải hằng số trong code và không phải identity. Đổi email khởi tạo ở environment khác là đổi cấu hình, không đổi schema.
- Email **không bao giờ** là subject: không phải `sub` của Account, không phải khoá của `staff_access.staff`, không đi vào token.

### 2. Ánh xạ email → `sub`, và idempotency

`account` sở hữu một **thao tác create-or-resolve** trên bề mặt offline của chính nó (ADR-0020 Quyết định 3(b): CLI trong app sở hữu dữ liệu, chạy bằng credential migrator/owner). Thao tác này:

- chuẩn hoá địa chỉ bằng **đúng một hàm** mà luồng OTP dùng (`normalizeEmailAddress`), tính `address_hash` = SHA-256 hex, rồi tra `account.email_addresses` theo `address_hash`;
- nếu tìm thấy một `sub` còn sống, **trả lại chính `sub` đó** — không tạo Account mới, không tạo email row mới;
- nếu không tìm thấy, sinh `sub` bằng `createSubject` (entropy CSPRNG) rồi ghi `account.users` + `account.email_addresses` trong **một transaction** của `db-account`;
- trả `sub` ra ngoài (stdout/giá trị truyền cho bước kế) — đây là **đầu ra duy nhất** mà bước Staff Access tiêu thụ (ADR-0020 Quyết định 7).

Idempotency của bước này là **natural key `address_hash`**, không phải file trạng thái hay bảng marker. Vì vậy chạy lại toàn bộ procedure sau một lần thất bại không sinh Account thứ hai và không sinh `sub` mới.

⚠️ **Tra cứu theo `address_hash`, không theo địa chỉ trần.** Đây là cùng lý do `0005_email_addresses.sql` chọn hash làm khoá tra cứu: index và log không lộ địa chỉ.

⚠️ **Chưa có đường nào khác tạo Account.** Hiện tại không có production code path nào `INSERT INTO account.users`; thao tác create-or-resolve của ADR này là đường **duy nhất** được phép, và nó là **yêu cầu hiện thực cho #17**. Không thêm route HTTP cho nó.

### 3. Email khởi tạo ở trạng thái `pending`

Procedure bootstrap ghi email khởi tạo với `status = 'pending'`, `is_sign_in = false`, `verified_at IS NULL`. **Procedure không được đánh dấu `verified`.**

Lý do: `verified` là kết luận "người này đã chứng minh kiểm soát địa chỉ". Một procedure ghi thẳng `verified` biến việc cấu hình một chuỗi ký tự thành bằng chứng kiểm soát — đúng thứ FR-002 dùng để chống chiếm account. Chứng minh kiểm soát phải xảy ra ở **lần đăng nhập đầu tiên**, qua chính địa chỉ đó.

⚠️ **Hệ quả: cần một đường verify mới, và nó là yêu cầu hiện thực cho #17.** Trạng thái hiện tại không có đường nào đưa một email `pending` sang `verified` mà không có session:

- `POST /api/emails/:id/verify` gọi `requireAuthedSession(event)` — người chưa đăng nhập được không gọi được;
- luồng OTP đăng nhập chỉ phục vụ địa chỉ `verified` (`lookupVerifiedAddress` lọc `status = 'verified'`), nên email `pending` không nhận được mã đăng nhập;
- vì vậy, nếu không có đường verify mới, procedure này tạo ra một Account **không thể đăng nhập** — bootstrap sẽ "thành công" mà hệ quả là không ai vào được.

Yêu cầu đặt lên đường verify mới (không chốt hình dạng route ở ADR này): nó phải phục vụ được người **chưa có session**, chỉ cho địa chỉ `pending` thuộc Account còn `active`, dùng purpose OTP riêng (domain separation đã có sẵn với `verify_email`, migration `0009`), chịu cùng rate limit/anti-enumeration như luồng hiện có, và chuyển email sang `verified` kèm `verified_at` **trước khi** phát hành session. Sau khi verified, đăng nhập đi qua luồng hiện có, không cần nhánh mới.

### 4. Staff identity, subject validation và system administrator role

- Procedure tạo **một** hàng `staff_access.staff` với `sub` lấy từ bước Account, `display_name` rỗng (hồ sơ canonical ở `account`), status `active`. `staff_access.staff` **không có cột email** và không được thêm.
- **Kiểm `sub` tồn tại trước khi tạo staff** dùng cơ chế do `account` sở hữu, không đọc `db-account` từ Staff Access: giá trị `sub` mà procedure dùng phải là giá trị **do bước Account trả ra trong cùng lần chạy** (create mode), hoặc đã được bước Account xác nhận còn sống trong cùng lần chạy (recovery mode). Kiểm định dạng tại Staff Access là `isSubject` + CHECK `^sub_[a-z2-7]{32}$` của bảng — hai lớp, không phải một. `GET /internal/account/status?sub=` là cơ chế hợp lệ **khi** environment đã có envelope credential; ADR này không tạo credential mới cho nó.
- **System administrator là một system-defined role** (ADR-0004: chỉ system-defined role), được gán cho staff identity bằng procedure. Role **không** phải loại Account, không phải cột `is_admin`, không phải singleton và không phải role vô hạn: nội dung của nó là một tập permission hữu hạn qua `staff_access.role_permissions`, đúng invariant "không có unrestricted `isAdmin`".
- **Nhiều Superadmin được phép.** Không có ràng buộc "đúng một", không có unique index nào trên assignment của role đó; bỏ ràng buộc singleton là điều kiện để một Superadmin nghỉ việc mà không cần recovery.
- **Nội dung tối thiểu của role là bốn quyền read đang có trong catalog**: `staff.read`, `role.read`, `permission.read`, `audit.read`. Đây là toàn bộ những gì catalog canonical chứa sau Quyết định 5, và không có permission nào khác để cấp. Role row + `role_permissions` của nó là **dữ liệu sealed** (danh tính cố định lúc review, không biến thiên theo environment, không phải credential) nên đi vào **seed migration mới** của `db-staff-access`, cùng lớp với catalog theo ADR-0020 Quyết định 10; thay đổi nội dung role sau đó là governance action có audit từ git (ADR-0004). Procedure bootstrap **chỉ gán** role đã tồn tại, không tạo role.
- ⚠️ **Seed role cần một natural key, và bảng hiện chưa có.** `staff_access.roles` không có UNIQUE trên `name` (chỉ có PK trên `id`), nên seed migration phải tự bảo đảm idempotency — hoặc dùng `id` cố định viết trong migration với `ON CONFLICT (id) DO NOTHING`, hoặc thêm UNIQUE `(kind, name)` làm **yêu cầu schema cho #17**. Không được để seed role phụ thuộc vào việc "chạy đúng một lần".
- ⚠️ **Catalog hiện chưa có permission nào cho việc gán/thu hồi assignment.** Route `POST /staff/:id/assignments` và `/assignments/revoke` là privileged operation, nhưng `role.assign` chỉ tồn tại trong prototype fixture và bị chính fixture ghi rõ là **không** thuộc catalog. Vì vậy ADR này **không** cấp quyền ghi đó cho role administrator: thêm một permission như vậy là một lần đổi catalog qua seed migration mới + ADR/cross-reference tương ứng (ADR-0010), và là quyết định riêng. Hệ quả được ghi nhận trung thực: cho tới khi quyết định đó có, Superadmin quản trị được các bề mặt read đã có, còn gán/thu hồi role đi qua privileged operation phía sau enforcement hiện hành — không phải qua một permission được phát minh ở đây.
- **Không tự thu hồi quyền administrator của chính mình.** Một Superadmin không được thu hồi assignment đang là quyền administrator cuối cùng của chính họ; việc đó phải do một Superadmin khác thực hiện, hoặc đi qua emergency recovery. Đây là invariant ở tầng application (route gán/thu hồi phải so principal với assignment target và đếm số administrator còn hiệu lực **tại write time**); database hiện chỉ chặn `granted_by = staff_id` trên row đang ghi (trigger `role_assignment_no_self_elevation`, BEFORE INSERT OR UPDATE) — nó không đếm được administrator còn lại, nên đây là **yêu cầu hiện thực cho #17/#433**, không phải hành vi đã có.
- **System administrator không cấp quyền trong tenant của sản phẩm.** Role này chỉ nói về staff directory, catalog và audit của Staff Access. Membership/ownership/entitlement trong `pact-broker`, `remote-cache` hay tenant LLM là dữ liệu của product context tương ứng (ADR-0015, glossary §Tenant/Membership): không FK, không suy quyền, và không được auto-grant khi login (glossary: membership không bao giờ được cấp tự động, kể cả tenant `ecoma-internal`).

### 5. Database, credential và thứ tự thi hành

Procedure chạy trên **hai bề mặt do hai service sở hữu**, không có transaction xuyên database:

| Bước | Việc                               | Owner ghi      | Database          | Credential                             |
| ---- | ---------------------------------- | -------------- | ----------------- | -------------------------------------- |
| A1   | Create-or-resolve Account + email  | `account`      | `db-account`      | offline của `account` (owner/migrator) |
| A2   | Đọc lại `sub` + `account.users`    | `account`      | `db-account`      | như A1                                 |
| S1   | Tạo staff identity (`sub`)         | `staff-access` | `db-staff-access` | offline của `staff-access`             |
| S2   | Gán system administrator role      | `staff-access` | `db-staff-access` | như S1                                 |
| S3   | Đọc lại staff + assignment + audit | `staff-access` | `db-staff-access` | như S1                                 |

- **Không ghi chéo database.** `staff-access` không nhận quyền `CONNECT` sang `db-account` và ngược lại; `db-backoffice` không xuất hiện trong procedure này ở bất kỳ bước nào (ADR-0013).
- **Không transaction phân tán, không compensating step.** Mỗi bước commit độc lập; trạng thái sau một lỗi là **tiền tố hợp lệ** (ADR-0020 Quyết định 6). Chạy lại từ đầu là cơ chế phục hồi duy nhất.
- **Không xoá Account hợp lệ vì một bước sau thất bại.** Account đã tạo nhưng chưa có staff chỉ là một Account chưa có quyền; nó không phải trạng thái hỏng. Xoá nó như "rollback" sẽ tạo một tombstone `sub` vĩnh viễn cho một người chưa từng dùng hệ thống, và đi ngược rule "prefer forward-fix" (`architecture/01-architecture.md` invariant 11). Nếu cần dọn, đường duy nhất là vòng đời xoá account bình thường, có audit riêng.
- **Idempotency theo natural key:** `address_hash` (bước A1), `staff.sub` UNIQUE (S1), và `(staff_id, role_id)` cho assignment (S2). ⚠️ Ràng buộc cuối **hiện chưa có ở tầng database**: `staff_access.role_assignments` chỉ có PK trên `id`. Vì vậy S2 phải là insert-if-absent trong cùng transaction, **và** một unique index bộ phận `(staff_id, role_id) WHERE revoked_at IS NULL` là **yêu cầu schema cho #17** để bảo đảm không nhân bản khi chạy lại (không viết migration ở PR này).
- **Không permanent bypass.** Sau procedure không còn route, flag, credential hay nhánh code nào cho phép "tạo admin nếu chưa có"; procedure chạy lại chỉ khi thoả điều kiện sử dụng (bootstrap lần đầu, hoặc recovery).
- **Audit nằm trong cùng transaction với dữ liệu của service ghi**, xem Quyết định 6.

### 6. Audit: hai chủ sở hữu, hai bảng, một correlation id

- **Phía `account`:** bản ghi trong `account.security_events` (`subject_sub` = `sub`, `outcome = 'success'`, `type` là một giá trị mới thêm cho bootstrap — giá trị cụ thể chốt ở #17), ghi **trong cùng transaction** với `account.users` + `account.email_addresses`. `metadata` chứa `address_hash` (không phải địa chỉ trần) và `correlation_id` của lần chạy — bảng này **không có** cột `correlation_id` riêng, nên nó nằm trong `metadata`. Đây là nơi trả lời "email nào đã ánh xạ sang `sub` nào, lúc nào".
- **Phía `staff-access`:** bản ghi trong `staff_access.authorization_audit`, ghi **cùng transaction** với staff row và với assignment row (SR-013: grant không tồn tại không audit). `actor_staff_id` và `actor_sub` để **NULL** — principal của procedure không phải staff member, đúng comment của cột `granted_by` ("NULL for bootstrap/migrator-created rows"); `granted_by` của assignment cũng NULL. `target` là `staff.id` (bước S1) hoặc `assignment.id` (bước S2); `action` là giá trị mô tả thao tác bootstrap; `outcome = 'success'`; `correlation_id` = **cùng** mã idempotency của lần chạy, để hai bảng audit nối được với nhau mà không có FK xuyên database.
- **Không có bảng audit mới.** Cả hai bảng đã tồn tại, append-only, và không có cột nào dành riêng cho bootstrap. Không ghi token/secret/PII vào `context`/`metadata` (CHECK sẵn có ở hai bảng là lớp thứ hai).
- Audit ghi **sau khi** dữ liệu ghi thành công trong cùng transaction: một lần chạy thất bại không tạo event `success` giả, và một lần chạy thành công không thể thiếu audit.

### 7. Bootstrap lần đầu và emergency recovery

- **Bootstrap lần đầu:** chạy khi environment chưa có staff nào có quyền administrator. **Không cần approval hai-phím.** Kiểm soát còn lại: chạy ngoài serving path, bằng credential offline của owner/migrator, có audit đầy đủ, có kiểm tra đọc được sau mỗi bước, và không có nút UI.
- **Emergency recovery:** dùng **đúng procedure đó** — cùng bước, cùng thứ tự, cùng idempotency. Khác biệt duy nhất là **authorization**: hai-phím của ADR-0003 cùng bước xác minh danh tính mạnh hơn vẫn giữ nguyên hiệu lực cho recovery, vì recovery chạy trên một hệ thống **đang** có người để đối chiếu.
- **Không suy approval-free của bootstrap sang recovery.** Hai tình huống khác nhau ở chỗ có hay không có người thứ hai có quyền hệ thống; gộp chúng là bỏ một kiểm soát mà không có bằng chứng.
- **Câu hỏi recovery còn mở, ghi lại chứ không tự quyết:** (a) "quá ít admin" được định nghĩa thế nào (0, hay dưới một ngưỡng); (b) recovery tạo identity **mới** hay khôi phục một identity đã có — và nếu tạo mới thì Account mới lấy từ đâu khi không còn ai có quyền xác nhận; (c) ai giữ phím thứ hai khi chính những người giữ phím là người mất quyền. Ba câu này thuộc policy vận hành/bảo mật, không bị Issue #11 quyết, và được ghi ở [`applications/staff-access/03-operations.md`](../../../applications/staff-access/03-operations.md) như mục mở.

### 8. Catalog permission canonical và `audit.read`

- Catalog canonical là **`staff_access.permissions`**. Catalog trong `backoffice.permissions` là **di sản chuyển tiếp** cho tới khi cutover projection hoàn tất; nó không phải nguồn thứ hai, và không được dùng để trả lời "permission nào tồn tại".
- **`audit.read` được chấp nhận** vào catalog canonical. Nó là permission của một route có thật (`GET /api/audit/entries` của backoffice), không phải surplus, và `id = domain || '.' || action` thoả CHECK hiện có.
- Đường đưa vào là **một seed migration mới** của `db-staff-access` (theo ADR-0010 và ADR-0020 Quyết định 10), **không** sửa `0003_permission_catalog_seed.sql`. Hiện thực thuộc #17; PR này không viết migration.
- **Resource owner:** dữ liệu audit thuộc `staff-access` (`staff_access.authorization_audit`). Route audit của backoffice hiện còn hợp nhất thêm các bản ghi audit **cục bộ** của `db-backoffice`; phần đó là dữ liệu di sản của composition, không phải một thẩm quyền audit thứ hai, và không được cấp thêm quyền cho nó.
- Sau khi seed migration mới chạy, **hai catalog không còn lệch**: `db-staff-access` có 4 permission read, và `db-backoffice` giữ 4 như cũ trong vai trò di sản. Không bên nào được thêm permission thứ năm mà không qua ADR/seed mới.

### 9. Cấm bootstrap trên serving path

Không route HTTP, không runtime flag, không logic "nếu chưa có admin thì tạo" trong bundle của Worker nào (ADR-0020 Quyết định 2, invariant 36). Procedure chỉ tồn tại ở hai bề mặt của ADR-0020 Quyết định 3: bước provisioning một lần của deploy unit sở hữu dữ liệu, và CLI offline trong chính app sở hữu dữ liệu. Không có đường nào để một request trigger procedure này, kể cả khi hệ thống không còn administrator nào.

## Quan hệ với ADR-0003 / ADR-0020 / ADR-0013

**ADR-0003 — bị supersede đúng một điểm:**

- **Bị supersede:** **quy trình hai-phím cho lần bootstrap first-administrator đầu tiên.** Bốn câu còn lại của cùng điều khoản (hai người khác nhau, mỗi người có quyền quản trị danh tính hệ thống, một người là người thực thi, để lại hai identity kèm thời điểm) **vẫn giữ nguyên hiệu lực cho emergency recovery**, và yêu cầu xác minh danh tính mạnh hơn của ADR-0003 cho recovery cũng giữ nguyên.
- **Giữ nguyên hiệu lực:** audit trail (ai, thời điểm, bản ghi assignment, mã idempotency) — nay được hiện thực cụ thể hoá theo Quyết định 6; cấm nút UI; `sub` phải tồn tại ở `db-account` trước khi tạo staff; procedure không tự phát hiện "đã có admin" để rẽ nhánh; emergency recovery dùng lại đúng procedure; điều kiện áp dụng (chỉ khi chưa có admin, hoặc khi recovery).
- **Điều chỉnh cách đọc, không đổi quyết định:** tên database `db-backoffice` trong ADR-0003 đọc là `db-staff-access` theo ADR-0013, và "không code path nào" đọc là "không code path nào trên serving path" theo ADR-0020. ADR này không mở lại hai điểm đó.

**ADR-0020:** giữ nguyên toàn bộ. ADR này điền đúng hai chỗ ADR-0020 để mở — permission thứ tư của catalog, và thứ tự bước bên trong procedure first-admin. Bề mặt thực thi, idempotency theo natural key, tiền tố hợp lệ, failure isolation và cấm serving-path bootstrap của ADR-0020 **không** bị thay đổi.

**ADR-0013:** giữ nguyên. Staff/RBAC thuộc `db-staff-access`; procedure ghi staff/role/assignment/audit ở đó, không ghi `db-backoffice`.

## Hệ quả

- #17 có đủ hợp đồng để hiện thực: thao tác create-or-resolve của `account`, đường verify lần đầu, procedure staff + assignment, seed migration permission thứ tư và seed migration role, unique index cho assignment, và guard chống tự thu hồi quyền administrator.
- **Trạng thái hiện tại sau khi ADR này được accept: chưa có gì trong số đó tồn tại.** Đặc biệt: email `pending` hiện **không** có đường verify, và `#17` là Issue đầu tiên phải tạo đường đó trước khi bootstrap có thể dùng được. Đây là giới hạn được ghi nhận, không phải một phần đã xong.
- Bảng bước trong [`architecture/02-delivery.md`](../../../architecture/02-delivery.md) §3.2 đổi ở hai ô: kiểm tra sau bước 3 đọc email `pending` (trước đây `verified`), và bước 4 không còn đi qua hai-phím.
- Tài liệu vận hành chi tiết nằm ở [`applications/staff-access/03-operations.md`](../../../applications/staff-access/03-operations.md); tài liệu này và ADR không nhân bản nội dung của nhau.
- Catalog vẫn sealed: sau seed migration mới, runtime role vẫn chỉ `SELECT` trên `permissions` và `roles`; không có đường runtime tạo role hay permission.
- Hai catalog không còn lệch về **số permission**, nhưng vẫn là hai bảng vật lý cho tới khi cutover projection — đó là gap của quá trình chuyển ownership, không phải hệ quả của quyết định này.

## Cross-reference

- **SR/T-**: SR-009, SR-013, SR-014, SR-016, SR-020 · T-11 · AC-016 ([`applications/staff-access/02-requirements.md`](../../../applications/staff-access/02-requirements.md)).
- **Thiết kế:** [`domain-model.md`](../domain-model.md) §3.1, §3.3, §3.4, §6, §8 invariant 6/7/9/10, §9 · [`domains/account/domain-model.md`](../../account/domain-model.md) §2, §9.1.
- **System:** [`architecture/01-architecture.md`](../../../architecture/01-architecture.md) invariant 10/11/35/36 · [`architecture/02-delivery.md`](../../../architecture/02-delivery.md) §0, §3.2 · [`architecture/03-operations.md`](../../../architecture/03-operations.md) §3.5.
- **Hiện thực:** #17 (Account đầu tiên + staff đầu tiên) · #433 (đường ghi staff, wire verified principal) · #25 (entry point nội bộ).
- **Index:** [`./README.md`](./README.md).
