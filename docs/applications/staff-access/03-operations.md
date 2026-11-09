# Staff Access — Vận hành

> Phạm vi: vận hành ứng dụng `staff-access` — bề mặt thực thi, credential, seed/migration và runbook **bootstrap first-administrator** + **emergency recovery**.
> Thiết kế → [`01-architecture.md`](./01-architecture.md) · yêu cầu → [`02-requirements.md`](./02-requirements.md) · nghiệp vụ → [`../../domains/staff-access/domain-model.md`](../../domains/staff-access/domain-model.md) · quyết định → [ADR-0021](../../domains/staff-access/adr/0021-first-admin-bootstrap-path.md) · [ADR-0003](../../domains/staff-access/adr/0003-bootstrap-first-admin-recovery.md) · [ADR-0020](../../domains/staff-access/adr/0020-bootstrap-seed-contract.md) · hợp đồng bootstrap/seed liên service → [`../../architecture/02-delivery.md`](../../architecture/02-delivery.md) §3.2.

## 1. Runtime và credential

| Hạng mục        | Giá trị                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database        | `db-staff-access`, schema `staff_access`                                                                                                                                                                      |
| Role migrator   | `ecoma_staff_access_migrator` — DDL, **chỉ** trong CI secret store ([`../../architecture/02-delivery.md`](../../architecture/02-delivery.md) §3.1, §6 rule 11); **không bao giờ** là Worker secret            |
| Role runtime    | `ecoma_staff_access_runtime` — DML trên schema ứng dụng; chỉ `SELECT` trên `permissions`, `roles`, `role_permissions`                                                                                         |
| Role owner      | `ecoma_owner` — **không** tồn tại cho `db-staff-access` (ADR-0020 Quyết định 11); tên này chỉ có nghĩa ở database có provision nó                                                                             |
| Bề mặt thực thi | Bước provisioning một-lần của deploy unit sở hữu dữ liệu (lane local), hoặc CLI offline trong chính app sở hữu dữ liệu trên admin path CI (environment thật) — ADR-0020 Quyết định 3                          |
| Entry point     | Repo script trong `tools/`, **không** có entry trong `DEPLOYMENT_MAP`, không giữ credential database nào; nó gọi CLI bootstrap của từng service như tiến trình con, theo thứ tự ở §2 (ADR-0020 Quyết định 12) |
| Không được dùng | Route HTTP, runtime flag, cron, hay bất kỳ code path nào trong Worker bundle để tạo staff/role/assignment (ADR-0021 Quyết định 9)                                                                             |

`staff-access` **không** có quyền `CONNECT` sang `db-account`, và procedure này không đọc `db-account` ở bất kỳ bước nào. Giá trị duy nhất đi xuyên service là `sub`.

⚠️ **Credential migrator không rời CI secret store.** Bước S1–S3 dùng `ecoma_staff_access_migrator` trên admin path của `../../architecture/02-delivery.md` §3.1. Nếu cần chạy procedure ngoài CI, **policy credential phải đổi trước** — không tự tạo bản sao thứ hai của credential, và không cấp credential riêng cho procedure (ADR-0021 Quyết định 5).

## 2. Bootstrap first-administrator

**Điều kiện áp dụng:** environment chưa có staff nào giữ role system administrator. Procedure **không** tự kiểm tra điều kiện này để rẽ nhánh — việc xác nhận thuộc người vận hành (ADR-0003). ⚠️ Hệ quả: procedure **không phân biệt được** một lần bootstrap với một lần recovery. Vì vậy mỗi lần chạy **phải** ghi `mode` (`bootstrap` | `recovery`) và **số administrator còn hiệu lực trước khi chạy** vào audit (Bước 7), và T-11 được giữ làm yêu cầu phát hiện — bootstrap có audit riêng, recovery có alert ([`02-requirements.md`](./02-requirements.md)).

**Approval:** lần bootstrap đầu tiên **không** cần hai-phím (ADR-0020 Quyết định 11, không phải quyết định của ADR-0021). Hai-phím **không** bị bỏ cho emergency recovery — xem §3.

**Thứ tự bắt buộc:** A1 → A2 → S1 → S2 → S3. Mỗi bước commit độc lập; không có transaction xuyên database.

⚠️ **Cửa sổ một administrator là cửa sổ rủi ro.** Từ bootstrap tới khi có administrator thứ hai, không ai còn quyền để cấp quyền: mất hoặc suspend staff identity duy nhất đưa hệ thống về trạng thái chỉ recovery mới sửa được, và recovery hiện chưa phủ hết các trường hợp (§3, §4). Tạo administrator thứ hai là việc tiếp theo sau khi bootstrap hoàn tất, không phải việc tuỳ chọn.

### Bước 1 — Chọn cấu hình môi trường đích

Đọc cấu hình từ chính môi trường đích, không từ máy cá nhân:

- `bootstrap_email` của environment (giá trị khởi tạo là `superadmin@ecoma.io` theo ADR-0020 Quyết định 11, nhưng đây là **input cấu hình theo environment** — ADR-0021 Quyết định 1).
- Tên database và credential migrator của `db-account` và `db-staff-access` của **đúng** environment đó, cộng **tham chiếu người thực thi** (id change/ticket) cho audit Bước 7.

Entry point là một repo script trong `tools/` (ADR-0020 Quyết định 12): nó không giữ credential nào, không ghi database nào, và gọi CLI bootstrap của từng service như tiến trình con theo thứ tự dưới đây. Không truyền cấu hình production vào lane local hoặc Preview.

- `bootstrap_email` là **PII**: nằm trong cấu hình của environment, đọc được bởi bất kỳ ai đọc cấu hình đó. Hash địa chỉ **trước khi** nó rời trình đọc cấu hình; không truyền địa chỉ trần qua command-line argument (lộ trong lịch sử shell và danh sách tiến trình) và không gõ nó vào phiên `psql` có ghi history.

### Bước 2 — Validate cấu hình và credential

| Kiểm                                        | Đạt khi                                                                                                                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kết nối `db-account` bằng credential A      | `SELECT 1` thành công; role **không** phải runtime role cho bước ghi                                                                                                                         |
| Kết nối `db-staff-access` bằng credential S | `SELECT 1` thành công; dùng `ecoma_staff_access_migrator` trên admin path CI, không phải runtime role                                                                                        |
| Chặn chéo                                   | `SELECT has_database_privilege('ecoma_staff_access_runtime', 'db-account', 'CONNECT')` = `false`                                                                                             |
| `bootstrap_email` hợp lệ                    | `normalizeEmailAddress` chấp nhận; chuỗi không rỗng và không phải placeholder                                                                                                                |
| Hộp thư đã được kiểm soát                   | Người vận hành xác nhận **ngoài hệ thống** rằng `bootstrap_email` đã được cấp phát cho tổ chức và có MFA — đây là điều kiện tiên quyết, không phải kiểm tra tự động (ADR-0020 Quyết định 11) |
| Seed đã chạy                                | `staff_access.permissions` có đủ 4 bản ghi read; role system administrator và `role_permissions` của nó tồn tại                                                                              |

Dừng ở đây nếu bất kỳ kiểm nào sai. Procedure **không** tạo role hay permission: role là dữ liệu sealed từ seed migration (ADR-0021 Quyết định 4, ADR-0020 Quyết định 10).

### Bước 3 — A1: `account` create-or-resolve

Chạy thao tác create-or-resolve của `account` (ADR-0021 Quyết định 2) với `bootstrap_email`. Bề mặt là CLI offline của `apps/account`; không có route HTTP.

- Địa chỉ được chuẩn hoá bằng đúng hàm của luồng OTP, rồi tra theo `address_hash` (SHA-256 hex), **không** theo địa chỉ trần.
- Không có hàng nào → sinh `sub` mới và ghi `account.users` + `account.email_addresses` trong một transaction.
- Có đúng một `sub` còn sống với hàng `pending` → trả lại chính `sub` đó.
- **Fail-closed ở mọi trạng thái khác:** có hàng `verified`; nhiều hơn một `sub`; `sub` đã `suspended`/`deleted`; hoặc Account đó còn địa chỉ `verified`/`is_sign_in` khác. Trường hợp cuối là leo thang quyền thật: `POST /api/emails` chỉ chặn địa chỉ đã có **chủ `verified`**, nên một Account bất kỳ có thể mang chính `bootstrap_email` ở trạng thái `pending`; nhận `sub` đó là cấp administrator cho người đăng nhập bằng địa chỉ của họ, không phải người kiểm soát hộp thư bootstrap.
- Email được ghi `status = 'pending'`, `is_sign_in = false`, `verified_at IS NULL`. **Không** đánh dấu `verified` — xác minh thuộc lần đăng nhập đầu tiên (Bước 10).
- Audit ghi cùng transaction: `account.security_events` với `subject_sub` = `sub`, `outcome = 'success'`, `metadata.address_hash`, `metadata.correlation_id`, `metadata.mode`, `metadata.operator_ref`.

⚠️ Thao tác create-or-resolve **chưa tồn tại** — nó là yêu cầu hiện thực của #17 (ADR-0021 Quyết định 2). Bước này không chạy được ở thời điểm tài liệu này.

Sinh `correlation_id` cho lần chạy **trước** bước này và dùng lại cho mọi bước còn lại.

### Bước 4 — A2: lấy và xác nhận `sub`

Đọc lại trong `db-account` bằng credential A:

```sql
SELECT u.sub, u.status AS account_status, e.status, e.verified_at
FROM account.users u
JOIN account.email_addresses e ON e.user_sub = u.sub
WHERE e.address_hash = <address_hash>;
```

Đạt khi trả đúng **một** row: `sub` khớp định dạng `^sub_[a-z2-7]{32}$`, `account_status = 'active'` (không tombstone), `status = 'pending'`, `verified_at IS NULL`.

⚠️ Đúng một row **chưa đủ**. Kiểm thêm hai câu, vì hàng `pending` không có ràng buộc duy nhất ở schema:

```sql
SELECT count(*) FROM account.email_addresses
WHERE user_sub = <sub> AND status = 'verified';                 -- phải = 0

SELECT count(DISTINCT user_sub) FROM account.email_addresses
WHERE address_hash = <address_hash>;                            -- phải = 1
```

Câu đầu chứng minh Account này chưa có đường đăng nhập nào khác, nên người duy nhất vào được nó là người kiểm soát `bootstrap_email`. Câu sau chứng minh không `sub` nào khác cùng giữ địa chỉ đó.

Đây là lần duy nhất procedure chạm `db-account`. Giá trị `sub` đọc ở bước này là đầu vào duy nhất của các bước sau.

### Bước 5 — S1: tạo staff identity

Ghi một hàng `staff_access.staff` với `sub` từ bước 4, `display_name` rỗng (hồ sơ canonical ở `account`), status `active`. Bảng **không có cột email** và không được thêm.

`sub` được kiểm hai lớp tại Staff Access: `isSubject` ở tầng ứng dụng, CHECK `^sub_[a-z2-7]{32}$` ở tầng bảng. Procedure chỉ dùng `sub` **do bước 4 trả ra trong cùng lần chạy** (create) hoặc đã được bước đó xác nhận còn sống (recovery). `GET /internal/account/status?sub=` là lớp kiểm bổ sung **khi** environment đã có envelope credential; nó không thay thế bước 4.

Audit `authorization_audit` ghi cùng transaction: `target` = `staff.id`, `actor_staff_id`/`actor_sub` NULL, `outcome = 'success'`, `correlation_id` của lần chạy.

### Bước 6 — S2: gán role system administrator

Insert một `staff_access.role_assignments` trỏ staff ở bước 5 và role system administrator đã seed; `granted_by` NULL (bootstrap/migrator-created).

- Procedure **chỉ gán role**, không cấp từng permission: nội dung quyền của role là `role_permissions` sealed, hiện gồm `staff.read`, `role.read`, `permission.read`, `audit.read` (ADR-0021 Quyết định 4, 8).
- Insert-if-absent trong cùng transaction với audit row (`target` = `assignment.id`).
- **Không** tạo assignment trùng: chạy lại phải hội tụ. ⚠️ `role_assignments` hiện chỉ có PK trên `id`; unique index bộ phận `(staff_id, role_id) WHERE revoked_at IS NULL` là yêu cầu schema của #17, chưa có ở thời điểm tài liệu này.
- Nhiều administrator được phép — không có ràng buộc singleton.

### Bước 7 — Audit của lần chạy

Hai bảng, hai chủ sở hữu, không bảng mới (ADR-0021 Quyết định 6):

| Bảng                               | Ghi ở bước | Nội dung bắt buộc                                                                                                                                                           |
| ---------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account.security_events`          | A1         | `subject_sub`, `outcome = 'success'`, `metadata.address_hash`, `metadata.correlation_id`, `metadata.mode`, `metadata.operator_ref` (bảng **không có** cột `correlation_id`) |
| `staff_access.authorization_audit` | S1, S2     | actor NULL, target `staff.id`/`assignment.id`, action, outcome, `correlation_id`, `context.mode`, `context.operator_ref`, `context.admins_before`                           |

- `mode` là `bootstrap` hoặc `recovery`; `admins_before` là số assignment administrator còn hiệu lực trước khi chạy (`SELECT count(*) … WHERE revoked_at IS NULL`).
- `operator_ref` là tham chiếu người thực thi do người vận hành khai báo (id change/ticket). **Actor NULL không phải "đủ để biết ai"**: database không có principal cho procedure, nên phần "ai" của ADR-0003 chỉ được đáp ứng khi có `operator_ref` **và** audit truy cập credential ở CI secret store. Thiếu `operator_ref` là lần chạy không đủ điều kiện hoàn tất (ADR-0021 Quyết định 6).
- Không ghi token, secret hay PII vào `context`/`metadata`. Chỉ `staff_access.authorization_audit` có CHECK chặn khoá bí mật; `account.security_events` không có lớp đó, nên phía `account` phụ thuộc hoàn toàn vào người ghi.
- Audit nằm **trong** transaction của dữ liệu: lần chạy thất bại không tạo event `success`, lần chạy thành công không thể thiếu audit.

### Bước 8 — S3: đọc lại và verify

Chạy bằng credential S, đọc trực tiếp ba câu:

1. `SELECT id, status FROM staff_access.staff WHERE sub = <sub>` → đúng một row, `active`.
2. `SELECT role_id, revoked_at FROM staff_access.role_assignments WHERE staff_id = <staff.id>` → đúng một assignment còn hiệu lực trỏ role administrator; không có bản ghi trùng.
3. `SELECT id FROM staff_access.role_permissions WHERE role_id = <role.id>` → đúng tập permission đã chốt (4 read).
4. Audit: có row `authorization_audit` cho cả S1 và S2 với cùng `correlation_id`.

Unit chỉ được coi là hoàn tất khi **cả bốn** kiểm đạt. Kiểm tra là truy vấn đọc được, không dựa vào log (ADR-0020 Quyết định 8).

### Bước 9 — Retry an toàn sau thất bại

Lỗi ở bước nào cũng để lại một **tiền tố hợp lệ**, không phải trạng thái hỏng: chạy lại **toàn bộ** procedure từ bước 1 là cơ chế phục hồi duy nhất (ADR-0020 Quyết định 6).

| Lỗi ở bước | Trạng thái còn lại                              | Chạy lại                                                                  |
| ---------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| 3 (A1)     | Không có gì, hoặc Account đã commit rồi mới lỗi | Hội tụ theo `address_hash`; trả cùng `sub`                                |
| 4 (A2)     | Account hợp lệ, chưa có staff                   | Đọc lại đúng `sub`, tiếp tục S1                                           |
| 5 (S1)     | Staff đã commit, chưa có assignment             | `staff.sub` UNIQUE → không tạo staff thứ hai                              |
| 6 (S2)     | Assignment chưa commit                          | Insert-if-absent theo `(staff_id, role_id)` khi chưa có hàng còn hiệu lực |
| 8 (S3)     | Dữ liệu đủ, verify sai                          | Không coi là xong; sửa nguyên nhân rồi verify lại                         |

⚠️ **Chạy lại sau khi assignment đã bị thu hồi tái tạo quyền.** Unique index bộ phận `(staff_id, role_id) WHERE revoked_at IS NULL` không chứa hàng đã `revoked_at`, nên một lần chạy lại S2 với cùng `sub` **insert assignment mới đang hiệu lực**. Đây là hệ quả có chủ ý của idempotency theo natural key, và là lý do: (a) bề mặt này không được nối vào pipeline deploy của environment thật; (b) trên hệ thống đang chạy, cấp lại quyền administrator là **recovery**, phải qua hai-phím; (c) thu hồi quyền vì lý do bảo mật phải đi kèm thu hồi credential vận hành hoặc đổi input canonical, nếu không lần chạy lại sẽ khôi phục quyền (ADR-0021 Quyết định 5).

**Không xoá Account đã tạo hợp lệ vì một bước sau thất bại.** Account chưa có staff chỉ là một Account chưa có quyền; xoá nó tạo tombstone `sub` vĩnh viễn và đi ngược forward-fix (`architecture/01-architecture.md` invariant 11). Không có compensating step, không có rollback dữ liệu.

### Bước 10 — Lần đăng nhập đầu tiên và quyền sở hữu Account về sau

Sau procedure, email khởi tạo vẫn `pending` và **chưa đăng nhập được**. Hoàn tất bootstrap chỉ khi người giữ hộp thư thực hiện:

1. Xác minh kiểm soát địa chỉ qua đường verify dành cho người **chưa có session** (purpose OTP `verify_email`, cùng rate limit/anti-enumeration), đưa email sang `verified` kèm `verified_at` **trước khi** phát hành session.
2. Đăng nhập bằng luồng hiện có; principal mang `sub`, và Staff Access ánh xạ `sub` → staff (ADR-0012).

⚠️ Đường verify đó **chưa tồn tại** — nó là yêu cầu hiện thực của #17 (ADR-0021 Quyết định 3). Thiếu nó, procedure tạo ra Account không thể đăng nhập.

Từ đây Account thuộc về người dùng: đổi email, MFA/passkey, session đều đi qua `account` như mọi Account khác. Đổi email **không** đổi `sub` và **không** đổi staff identity — ánh xạ `sub` là bất biến.

## 3. Emergency recovery

Recovery dùng **đúng procedure §2** — cùng bước, cùng thứ tự, cùng idempotency, cùng kiểm tra. Khác biệt **duy nhất** là authorization:

- **Hai-phím của ADR-0003 giữ nguyên hiệu lực:** hai người khác nhau, mỗi người có quyền quản trị danh tính hệ thống, một người là người thực thi, để lại hai identity kèm thời điểm.
- Bước xác minh danh tính mạnh hơn của ADR-0003 cho recovery giữ nguyên.
- Không suy approval-free của bootstrap sang recovery: recovery chạy trên hệ thống **đang** có người thứ hai để đối chiếu (ADR-0021 Quyết định 7).

Nếu không đủ hai người có quyền hệ thống, đó là tình huống chưa được quyết — dừng và báo, không tự hạ cấp kiểm soát (xem §4).

⚠️ **Recovery trên identity đã `verified` chưa chạy được bằng procedure này.** A1 chỉ tạo được hàng `pending`, và A2 đòi `status = 'pending'` — khôi phục một administrator đã verify xong sẽ dừng ở A2. Đây là khoảng trống thuộc câu (2) §4, không phải một biến thể hợp lệ của procedure.

## 4. Câu hỏi còn mở

Bốn câu chưa được quyết, ghi lại thay vì tự chọn (ADR-0021 Quyết định 5, 7):

1. "Quá ít administrator" được định nghĩa thế nào — 0, hay dưới một ngưỡng?
2. Recovery tạo identity **mới** hay khôi phục identity đã có — và nếu tạo mới thì Account mới lấy từ đâu khi không còn ai có quyền xác nhận? Câu này bao gồm trường hợp identity đã `verified`, thứ procedure §2 không phủ.
3. Ai giữ phím thứ hai khi chính những người giữ phím là người mất quyền?
4. **Ai được giữ và ai được dùng credential vận hành?** `architecture/03-operations.md` §3.5 chỉ yêu cầu credential lấy lại được từ bản sao offline ngoài VPS; không tài liệu canonical nào chốt custody (một người hay tách đôi). Cho tới khi có, mọi lập luận "credential đã được kiểm soát nên một người là đủ" là suy diễn, không phải quyết định.

Bốn câu này thuộc policy vận hành/bảo mật; Issue #11 không quyết chúng.

## 5. Operational invariants

1. Không bề mặt serving nào tạo Account, staff, role hay assignment (ADR-0021 Quyết định 9, invariant 36).
2. Procedure chỉ ghi `db-staff-access`; không `CONNECT`, không đọc, không ghi `db-account` ngoài bước do `account` sở hữu.
3. Không transaction xuyên database, không compensating step; chạy lại toàn bộ là phục hồi.
4. Không đánh dấu email `verified` trong bootstrap.
5. Role và permission là dữ liệu sealed từ migration/seed; procedure chỉ gán.
6. Không xoá Account hợp lệ để "rollback" một bước sau thất bại.
7. Không credential migrator/owner nào trở thành Worker secret, và credential migrator không rời CI secret store.
8. Mỗi lần chạy ghi `mode`, `admins_before` và `operator_ref`; actor NULL một mình không phải attribution.
9. Chạy lại sau khi đã thu hồi assignment tái tạo quyền — nên bề mặt này không thuộc pipeline deploy của environment thật.
