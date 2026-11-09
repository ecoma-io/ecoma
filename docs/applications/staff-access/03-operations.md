# Staff Access — Vận hành

> Phạm vi: vận hành ứng dụng `staff-access` — bề mặt thực thi, credential, seed/migration và runbook **bootstrap first-administrator**, **bổ nhiệm administrator thường** và **emergency recovery**.
> Thiết kế → [`01-architecture.md`](./01-architecture.md) · yêu cầu → [`02-requirements.md`](./02-requirements.md) · nghiệp vụ → [`../../domains/staff-access/domain-model.md`](../../domains/staff-access/domain-model.md) · quyết định → [ADR-0023](../../domains/staff-access/adr/0023-administrator-lifecycle-paths.md) · [ADR-0021](../../domains/staff-access/adr/0021-first-admin-bootstrap-path.md) · [ADR-0022](../../domains/staff-access/adr/0022-measured-first-admin-guard.md) · [ADR-0003](../../domains/staff-access/adr/0003-bootstrap-first-admin-recovery.md) · [ADR-0020](../../domains/staff-access/adr/0020-bootstrap-seed-contract.md) · hợp đồng bootstrap/seed liên service → [`../../architecture/02-delivery.md`](../../architecture/02-delivery.md) §3.2.

## 1. Runtime và credential

| Hạng mục        | Giá trị                                                                                                                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database        | `db-staff-access`, schema `staff_access`                                                                                                                                                                                                              |
| Role migrator   | `ecoma_staff_access_migrator` — DDL, **chỉ** trong CI secret store ([`../../architecture/02-delivery.md`](../../architecture/02-delivery.md) §3.1, §6 rule 11); **không bao giờ** là Worker secret                                                    |
| Role runtime    | `ecoma_staff_access_runtime` — DML trên schema ứng dụng; chỉ `SELECT` trên `permissions`, `roles`, `role_permissions`                                                                                                                                 |
| Role owner      | `ecoma_owner` — **không** tồn tại cho `db-staff-access` (ADR-0020 Quyết định 11); tên này chỉ có nghĩa ở database có provision nó                                                                                                                     |
| Bề mặt thực thi | Bước provisioning một-lần của deploy unit sở hữu dữ liệu (lane local), hoặc CLI offline trong chính app sở hữu dữ liệu trên admin path CI (environment thật) — ADR-0020 Quyết định 3                                                                  |
| Entry point     | Repo script trong `tools/`, **không** có entry trong `DEPLOYMENT_MAP`, không giữ credential database nào; nó gọi CLI bootstrap của từng service như tiến trình con, theo thứ tự ở §2 (ADR-0020 Quyết định 12)                                         |
| Không được dùng | Route HTTP, runtime flag, cron, hay bất kỳ code path nào trong Worker bundle để **bootstrap** — tạo Account, staff identity, seed role, hay gán role lần đầu (ADR-0021 Quyết định 9). Route gán/thu hồi định kỳ có tồn tại nhưng không phải bootstrap |

`staff-access` **không** có quyền `CONNECT` sang `db-account`. Procedure chỉ chạm `db-account` ở bước do `account` sở hữu và thực thi (bước 3–4, surface A1/A2), bằng credential của `account`; không bước nào chạy `SELECT`/`INSERT` trên `db-account` từ một credential của `staff-access`. Giá trị duy nhất đi xuyên service là `sub`.

⚠️ **Credential migrator không rời CI secret store.** Bước S1–S3 dùng `ecoma_staff_access_migrator` trên admin path của `../../architecture/02-delivery.md` §3.1. Nếu cần chạy procedure ngoài CI, **policy credential phải đổi trước** — không tự tạo bản sao thứ hai của credential, và không cấp credential riêng cho procedure (ADR-0021 Quyết định 5).

## 2. Bootstrap first-administrator

**Điều kiện áp dụng:** `admins_before = 0` **và** `admins_ever = 0` cho **bootstrap** (`mode = 'bootstrap'`); nếu một trong hai khác 0 thì chỉ **recovery**, và chỉ với authorization hai-phím của §3.2–§3.3. Procedure **tự đo** cả hai con số trong critical section ghi của `staff-access`, dưới advisory lock, rồi **từ chối** khi `mode` không khớp số đo — exit khác 0, không ghi dữ liệu nghiệp vụ, một audit row `outcome = 'denied'` với lý do `mode_mismatch` trong `staff_access.authorization_audit` (ADR-0022). Entry point giữ một lớp kiểm trước để fail nhanh, nhưng nó **không** phải lớp bảo vệ chính và không thay lớp trong procedure.

⚠️ `admins_before` và `admins_ever` là **số đo do procedure tính**, không phải giá trị người chạy truyền vào: chúng đi vào audit dưới dạng kết quả đo, và không được dùng cho bất kỳ quyết định nào khi là input. Hai truy vấn canonical (đếm **administrator**, không đếm assignment) ở Bước 7.

**Approval:** lần bootstrap đầu tiên **không** cần hai-phím (ADR-0020 Quyết định 11, không phải quyết định của ADR-0021). Hai-phím **không** bị bỏ cho emergency recovery — xem §3.2–§3.3.

**Thứ tự bắt buộc:** A1 → A2 → S1 → S2 → S3. Mỗi bước commit độc lập; không có transaction xuyên database.

⚠️ **Cửa sổ một administrator là cửa sổ rủi ro, và hôm nay nó là trạng thái thực tế.** Mất hoặc suspend staff identity duy nhất đưa hệ thống về trạng thái chỉ recovery mới sửa được, và recovery chưa chạy được (§3.2, §3.3). Administrator thứ hai chỉ tạo được qua bổ nhiệm thường, mà đường đó chưa tồn tại — thiếu permission ghi trong catalog, thiếu enforcement, thiếu đường tạo staff, thiếu đường tạo Account (§3.1, #44, #48). Không được báo cáo "nhiều Superadmin được phép" mà bỏ vế "nhưng chưa có đường tạo" (ADR-0023 Quyết định 8).

### Bước 1 — Chọn cấu hình môi trường đích

Xác nhận đang nhắm đúng môi trường đích, không phải máy cá nhân:

- `bootstrap_email` và tenant `ecoma` là **hằng trong code** của bước bootstrap, không phải giá trị cấu hình tự do: cấu hình environment chỉ **assert** lại đúng giá trị đó, và procedure **từ chối chạy** khi input khác hằng — kể cả khi input hợp lệ về cú pháp (ADR-0021 Quyết định 1). Không có nhánh "dùng địa chỉ của environment này".
- Tên database và credential migrator của `db-account` và `db-staff-access` của **đúng** environment đó, cộng **tham chiếu người thực thi** (id change/ticket) cho audit Bước 7.

Entry point là một repo script trong `tools/` (ADR-0020 Quyết định 12): nó không giữ credential nào, không ghi database nào, và gọi CLI bootstrap của từng service như tiến trình con theo thứ tự dưới đây. Không truyền cấu hình production vào lane local hoặc Preview.

- `bootstrap_email` là **PII**: nằm trong cấu hình của environment, đọc được bởi bất kỳ ai đọc cấu hình đó. Hash địa chỉ **trước khi** nó rời trình đọc cấu hình; không truyền địa chỉ trần qua command-line argument (lộ trong lịch sử shell và danh sách tiến trình) và không gõ nó vào phiên `psql` có ghi history.

### Bước 2 — Validate cấu hình và credential

| Kiểm                                        | Đạt khi                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Kết nối `db-account` bằng credential A      | `SELECT 1` thành công; role **không** phải runtime role cho bước ghi                                                                                                                                                                                                                                                                 |
| Kết nối `db-staff-access` bằng credential S | `SELECT 1` thành công; dùng `ecoma_staff_access_migrator` trên admin path CI, không phải runtime role                                                                                                                                                                                                                                |
| Chặn chéo                                   | `SELECT has_database_privilege('ecoma_staff_access_runtime', 'db-account', 'CONNECT')` = `false`. Chạy **sau** khi `db-account` tồn tại: hàm này lỗi khi database chưa có, nên `false` chỉ có nghĩa khi kiểm được cả hai trạng thái                                                                                                  |
| `bootstrap_email` hợp lệ                    | Khớp kiểm cú pháp của `account` (`/^[^\s@]{1,64}@[^\s@]{1,255}$/u`, `apps/account/server/api/emails/index.post.ts`) — **không** dùng `normalizeEmailAddress` làm kiểm tra: hàm đó chỉ `trim()` + `toLowerCase()` và chấp nhận cả `'not an email'`                                                                                    |
| Hộp thư đã được kiểm soát                   | Người vận hành xác nhận **ngoài hệ thống** rằng `bootstrap_email` đã được cấp phát cho tổ chức và có MFA — đây là điều kiện tiên quyết, không phải kiểm tra tự động (ADR-0020 Quyết định 11)                                                                                                                                         |
| Seed đã chạy                                | ⚠️ **Chưa đạt được ở hiện tại:** `staff_access.permissions` hiện có **3** bản ghi read (`audit.read` chưa có), và **không** có hàng `roles`/`role_permissions` nào. Đạt khi: 4 permission read, role system administrator, và `role_permissions` của nó tồn tại — cả hai seed mới là yêu cầu của #17 (ADR-0021 Quyết định 4, 8)      |
| Địa chỉ bootstrap không bị giữ chỗ          | Chạy truy vấn A2 (Bước 4) **trước** khi bắt đầu: phải trả 0 hàng, hoặc đúng một hàng `pending` của một Account `active` không có đường đăng nhập khác. Có hàng `pending` thuộc Account khác, hoặc có hàng `revoked`, nghĩa là bootstrap sẽ fail-closed ở giữa procedure — dừng ở đây và xử lý theo §2 Bước 9 (ADR-0021 Quyết định 2) |

Dừng ở đây nếu bất kỳ kiểm nào sai. Procedure **không** tạo role hay permission: role là dữ liệu sealed từ seed migration (ADR-0021 Quyết định 4, ADR-0020 Quyết định 10).

### Bước 3 — A1: `account` create-or-resolve

Chạy thao tác create-or-resolve của `account` (ADR-0021 Quyết định 2) với `bootstrap_email`. Bề mặt là CLI offline của `apps/account`; không có route HTTP.

- Địa chỉ được chuẩn hoá bằng đúng hàm của luồng OTP, rồi tra theo `address_hash` (SHA-256 hex), **không** theo địa chỉ trần.
- **Đọc và ghi trong một transaction dưới `pg_advisory_xact_lock` khoá theo `address_hash`.** Hai lần chạy đồng thời phải tuần tự hoá: lần thứ hai chờ, rồi đọc thấy hàng đã commit của lần thứ nhất và đi nhánh idempotent. Không có lock này, cả hai cùng đọc "chưa có hàng" và cùng ghi — hai `sub`, hai hàng `pending`, và A2 fail-closed không hội tụ được.
- Không có hàng nào **còn sống** → sinh `sub` mới (entropy CSPRNG; `createSubject` chỉ nhận entropy, không tự sinh) và ghi `account.users` + `account.email_addresses` trong cùng transaction.
- Có đúng một `sub` còn sống với hàng `pending` → trả lại chính `sub` đó, không ghi hàng mới.
- **Fail-closed ở mọi trạng thái khác:** có hàng `verified`; nhiều hơn một `sub`; `sub` đã `suspended`/`deleted`; Account đó còn địa chỉ `verified`/`is_sign_in` khác; hoặc cùng `sub` có nhiều hơn một hàng `pending` cho `address_hash` đó (schema cho phép — UNIQUE chỉ áp cho `verified`). Trường hợp cuối là leo thang quyền thật: `POST /api/emails` chỉ chặn địa chỉ đã có **chủ `verified`**, nên một Account bất kỳ có thể mang chính `bootstrap_email` ở trạng thái `pending`; nhận `sub` đó là cấp administrator cho người đăng nhập bằng địa chỉ của họ, không phải người kiểm soát hộp thư bootstrap.
- ⚠️ **Hàng `revoked` không tính là "đã có hàng" và không tính là "đã có chủ".** Khoá tự nhiên và mọi kiểm fail-closed chỉ đọc `status IN ('pending','verified')`. Nhưng một hàng `revoked` cho `bootstrap_email` là dấu hiệu đã có người từng chạm địa chỉ đó (`POST /api/emails` cho họ thêm `pending`, rồi revoke) — **dừng và báo**, không chạy tiếp, vì lần chạy này sẽ tạo Account mới cho cùng địa chỉ. Procedure **không** xoá hay revoke hàng email nào.
- Email được ghi `status = 'pending'`, `is_sign_in = false`, `verified_at IS NULL`. **Không** đánh dấu `verified` — xác minh thuộc lần đăng nhập đầu tiên (Bước 10).
- Audit ghi cùng transaction: `account.security_events` với `subject_sub` = `sub`, `outcome = 'success'`, `metadata.address_hash`, `metadata.correlation_id`, `metadata.mode`, `metadata.operator_ref`. Bảng **không có** cột `correlation_id`, nên các trường này nằm trong `metadata`. **Không** ghi `admins_before`/`admins_ever` ở bước này: hai số đó chỉ được đo trong critical section ghi của `staff-access` (Bước 7), và ghi một giá trị chưa đo được là ghi một con số bịa.

⚠️ Thao tác create-or-resolve **chưa tồn tại** — nó là yêu cầu hiện thực của #17 (ADR-0021 Quyết định 2). Bước này không chạy được ở thời điểm tài liệu này.

Sinh `correlation_id` cho lần chạy **trước** bước này và dùng lại cho mọi bước còn lại.

### Bước 4 — A2: lấy và xác nhận `sub`

Đọc lại trong `db-account` bằng credential A:

```sql
SELECT u.sub, u.status AS account_status, e.status, e.verified_at
FROM account.users u
JOIN account.email_addresses e ON e.user_sub = u.sub
WHERE e.address_hash = <address_hash>
  AND e.status IN ('pending', 'verified');
```

Đạt khi trả đúng **một** row: `sub` khớp định dạng `^sub_[a-z2-7]{32}$`, `account_status = 'active'` (không tombstone), `status = 'pending'`, `verified_at IS NULL`.

⚠️ Đúng một row **chưa đủ**. Kiểm thêm hai câu, vì hàng `pending` không có ràng buộc duy nhất ở schema:

```sql
SELECT count(*) FROM account.email_addresses
WHERE user_sub = <sub> AND status = 'verified';                 -- phải = 0

SELECT count(DISTINCT user_sub) FROM account.email_addresses
WHERE address_hash = <address_hash>
  AND status IN ('pending', 'verified');                        -- phải = 1
```

Câu đầu chứng minh Account này chưa có đường đăng nhập nào khác, nên người duy nhất vào được nó là người kiểm soát `bootstrap_email`. Câu sau chứng minh không `sub` nào khác cùng giữ địa chỉ đó. Cả hai lọc `status IN ('pending','verified')`: hàng `revoked` không chứng minh quyền sở hữu và không giữ địa chỉ (ADR-0021 Quyết định 2).

Đây là lần duy nhất procedure chạm `db-account`. Giá trị `sub` đọc ở bước này là đầu vào duy nhất của các bước sau.

### Bước 5 — S1: tạo staff identity

Ghi một hàng `staff_access.staff` với `sub` từ bước 4, `display_name` rỗng (hồ sơ canonical ở `account`), status `active`. Bảng **không có cột email** và không được thêm.

- `staff.sub` UNIQUE nghĩa là chạy lại **tìm thấy** hàng cũ. Quy tắc fail-closed: không có → tạo; có và `active` → hội tụ; có và khác `active` (`suspended`/`terminated`) → **dừng**, báo là trạng thái cần can thiệp, **không** tự sửa `status`. `staff_identity_and_terminal_guard` chặn hồi sinh nhưng **không** chặn việc gán role cho một staff không hoạt động.
- Bước này chạy **bên trong** critical section ghi của ADR-0022: cùng transaction đã lấy advisory lock và đã đo `admins_before`/`admins_ever`; guard quyết định bước này có được chạy hay không.

`sub` được kiểm hai lớp tại Staff Access: `isStaffSubFormat` (`libs/staff-access-contracts`) ở tầng ứng dụng, CHECK `^sub_[a-z2-7]{32}$` ở tầng bảng — không dùng `isSubject` của `libs/account-domain`, vì nó mang tag `scope:account` và nằm ngoài phạm vi phụ thuộc của `staff-access`. Procedure chỉ dùng `sub` **do bước 4 trả ra trong cùng lần chạy** (create) hoặc đã được bước đó xác nhận còn sống (recovery). `GET /internal/account/status?sub=` là lớp kiểm bổ sung **khi** environment đã có envelope credential; nó không thay thế bước 4.

Audit `authorization_audit` ghi cùng transaction: `target` = `staff.id`, `actor_staff_id`/`actor_sub` NULL, `outcome = 'success'`, `correlation_id` của lần chạy.

### Bước 6 — S2: gán role system administrator

Insert một `staff_access.role_assignments` trỏ staff ở bước 5 và role system administrator đã seed; `granted_by` NULL (bootstrap/migrator-created).

- Procedure **chỉ gán role**, không cấp từng permission: nội dung quyền của role là `role_permissions` sealed, **sau seed migration của #17** gồm `staff.read`, `role.read`, `permission.read`, `audit.read` (ADR-0021 Quyết định 4, 8). Hiện tại role chưa tồn tại và catalog mới có ba permission.
- Insert-if-absent trong cùng transaction với audit row (`target` = `assignment.id`).
- **Không** tạo assignment trùng: chạy lại phải hội tụ. ⚠️ `role_assignments` hiện chỉ có PK trên `id`; unique index bộ phận `(staff_id, role_id) WHERE revoked_at IS NULL` là yêu cầu schema của #17, chưa có ở thời điểm tài liệu này. ⚠️ Index đó **không** đủ để biểu đạt "còn hiệu lực": `effective_until` là read-time filter, và PostgreSQL không cho `now()` trong predicate của index (`functions in index predicate must be marked IMMUTABLE`). Vì vậy một assignment đã **hết hạn nhưng chưa `revoked_at`** sẽ làm lần chạy lại **lỗi duplicate key** thay vì hội tụ. Procedure phải coi trạng thái đó là fail-closed cần can thiệp, không phải no-op.
- Nhiều administrator được phép — không có ràng buộc singleton.
- ⚠️ **Định danh role phải phân giải đúng một hàng.** `staff_access.roles` không có UNIQUE trên `name`, nên hai hàng cùng `(kind = 'system', name = <định danh canonical>)` là hợp lệ ở mức database và mỗi hàng có assignment riêng sẽ tạo ra hai "administrator role" khác nhau. Trước khi gán, đọc role theo định danh canonical: khác đúng một hàng → **dừng**, không đoán hàng nào là canonical. Ràng buộc UNIQUE `(kind, name)` là yêu cầu schema của #17 (ADR-0021 Quyết định 4, ADR-0022 Quyết định 4).
- **Không tự thu hồi quyền của chính mình** (ADR-0020 Quyết định 11): một Superadmin không được thu hồi assignment administrator cuối cùng của chính họ; phải do Superadmin khác hoặc emergency recovery. Database **chưa** chặn điều này — trigger chỉ chặn `granted_by = staff_id` — nên đây là yêu cầu của #17, không phải hành vi đã có.

### Bước 7 — Audit của lần chạy

Hai bảng, hai chủ sở hữu, không bảng mới (ADR-0021 Quyết định 6):

| Bảng                               | Ghi ở bước | Nội dung bắt buộc                                                                                                                                                                                                                          |
| ---------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `account.security_events`          | A1         | `subject_sub`, `outcome = 'success'`, `metadata.address_hash`, `metadata.correlation_id`, `metadata.mode`, `metadata.operator_ref` — **không** có hai số đo, vì A1 chạy trước critical section đo (bảng **không có** cột `correlation_id`) |
| `staff_access.authorization_audit` | S1, S2     | actor NULL, target `staff.id`/`assignment.id`, action, outcome, `correlation_id`, `context.mode`, `context.operator_ref`, `context.admins_before`, `context.admins_ever`, `context.noop` khi bước hội tụ không ghi dữ liệu                 |

- `mode` là `bootstrap` hoặc `recovery`. `admins_before` và `admins_ever` là **số đo do procedure tính** trước khi ghi, bằng hai truy vấn canonical dưới đây — **không** phải input, và `admins_before` không phải `count(*) … WHERE revoked_at IS NULL`:

  ```sql
  SELECT count(DISTINCT ra.staff_id)
  FROM staff_access.role_assignments ra
  JOIN staff_access.roles r ON r.id = ra.role_id
  JOIN staff_access.staff s ON s.id = ra.staff_id
  WHERE r.kind = 'system' AND r.name = <định danh canonical>
    AND r.status = 'active'
    AND s.status = 'active'
    AND ra.revoked_at IS NULL
    AND (ra.effective_from IS NULL OR ra.effective_from <= now())
    AND (ra.effective_until IS NULL OR ra.effective_until > now());
  ```

  `revoked_at IS NULL` một mình đếm cả role không phải administrator, bỏ qua cửa sổ hiệu lực, và tính cả staff đã `terminated` — đo ra `admins_before = 1` trong khi không còn administrator hiệu lực nào. `count(DISTINCT staff_id)` chứ không `count(*)`: một staff có hai assignment còn hiệu lực vẫn là **một** administrator (ADR-0022 Quyết định 4).

  **Phép đo thứ hai — `admins_ever` — bắt buộc phải có, không phải thông tin thêm.** `admins_before` đếm assignment **còn hiệu lực**, nên nó về 0 ngay sau khi assignment cuối cùng bị `revoked_at`. Chỉ so `admins_before` thì một lần chạy `mode = 'bootstrap'` sau khi thu hồi quyền administrator cuối cùng sẽ được **chấp nhận** và insert assignment mới — tức khôi phục đúng quyền vừa bị thu hồi mà không có hai-phím. Câu đo thứ hai bỏ mọi bộ lọc trạng thái:

  ```sql
  SELECT count(*)
  FROM staff_access.role_assignments ra
  JOIN staff_access.roles r ON r.id = ra.role_id
  WHERE r.kind = 'system' AND r.name = <định danh canonical>;
  ```

  Guard chấp nhận `bootstrap` chỉ khi **cả** `admins_before = 0` **và** `admins_ever = 0`; một trong hai khác 0 chỉ chấp nhận `recovery` + hai-phím; mọi cặp khác bị từ chối. Hệ quả phải nói thẳng: một environment đã từng có administrator **không** bootstrap lại được, kể cả khi hiện không còn ai — đó chính là hành vi mong muốn.

  **Hai số đo được lấy ngay sau khi lấy advisory lock và trước bất kỳ phép ghi nào của S1/S2** — không phải sau S2, vì khi đó lần chạy vừa tạo đã được tính vào. Cùng giá trị đo được dùng cho cả quyết định của guard lẫn audit row, nên audit không thể ghi một số khác với số đã quyết định.

- **Transaction phải chạy ở `READ COMMITTED`.** Đây không phải chi tiết cấu hình: correctness của advisory lock phụ thuộc việc transaction **sau** khi lấy được lock mới thấy row mà lần chạy thắng đã commit. Ở `REPEATABLE READ` snapshot chốt ở statement đầu tiên (câu lấy lock), nên lần chạy bị chặn vẫn đọc số cũ và cả hai cùng ghi. Procedure đặt mức này tường minh; không dựa vào mặc định session hay `ALTER DATABASE`.

- **Mỗi lần chạy sinh một `correlation_id` mới và mọi bước đều ghi một audit row**, kể cả bước hội tụ không ghi dữ liệu. Row của bước no-op mang `outcome = 'success'` và `context.noop = true` cùng `correlation_id` của lần chạy **hiện tại** — nếu không, kiểm tra (5) ở Bước 8 không bao giờ đạt sau một lần chạy lại (ADR-0021 Quyết định 7).
- `operator_ref` là tham chiếu người thực thi do người vận hành khai báo (id change/ticket). ⚠️ **Đây là attribution tự khai, không phải attribution đã xác minh.** Không có cơ chế nào đối chiếu `operator_ref` với danh tính thật của người giữ credential, và cũng không chứng minh ticket đó tồn tại. Database chứng minh được đúng một điều: procedure đã chạy bằng credential vận hành, và người chạy **khai** là X. Bằng chứng bù được nêu trước đây ("audit truy cập credential ở CI secret store") **chưa** được xác minh và không có trong `architecture/04-platform-facts.md` — nó là cơ chế cần chọn, không phải kiểm soát đã có. Ứng viên có thật: GitHub environment protection rule (GH8, `04-platform-facts.md` §2.17) và ghi nhận ngoài hệ thống có kiểm soát (ADR-0021 Quyết định 6).
- **Bước 2, 4, 8 (và mọi bước dùng credential migrator) chạy trong service CLI/CI job của `account` và `staff-access`, không trong phiên `psql` của người vận hành.** Người vận hành không giữ credential database; phiên tay chỉ đọc kết quả khi CI không cung cấp đường đọc đó, và không bao giờ mang credential migrator (ADR-0021 Quyết định 5, §1).
- Không ghi token, secret hay PII vào `context`/`metadata`. Chỉ `staff_access.authorization_audit` có CHECK chặn khoá bí mật; `account.security_events` không có lớp đó, nên phía `account` phụ thuộc hoàn toàn vào người ghi.
- Audit nằm **trong** transaction của dữ liệu: lần chạy thất bại không tạo event `success`, lần chạy thành công không thể thiếu audit.

### Bước 8 — S3: đọc lại và verify

Chạy bằng credential S, đọc trực tiếp năm câu:

1. `SELECT id, status FROM staff_access.staff WHERE sub = <sub>` → đúng một row, `active`.
2. Role canonical: `SELECT id FROM staff_access.roles WHERE kind = 'system' AND name = <định danh canonical> AND status = 'active'` → đúng **một** row. Nhiều hơn một hàng nghĩa là "role administrator" không phải một khái niệm xác định, và mọi kiểm tra phía sau không chứng minh được gì.
3. `SELECT ra.id, ra.role_id FROM staff_access.role_assignments ra JOIN staff_access.roles r ON r.id = ra.role_id WHERE ra.staff_id = <staff.id> AND r.kind = 'system' AND r.name = <định danh canonical> AND r.status = 'active' AND ra.revoked_at IS NULL AND (ra.effective_from IS NULL OR ra.effective_from <= now()) AND (ra.effective_until IS NULL OR ra.effective_until > now())` → đúng một assignment **còn hiệu lực** trỏ role administrator; không có bản ghi trùng. Câu này dùng cùng predicate với truy vấn `admins_before` ở Bước 7 — khác nhau thì hai kết quả không so sánh được. Bỏ `AND revoked_at IS NULL` sẽ trả cả lịch sử đã thu hồi; chỉ lọc `revoked_at IS NULL` sẽ tính cả assignment đã hết hạn.
4. `SELECT permission_id FROM staff_access.role_permissions WHERE role_id = <role.id>` → đúng tập permission đã chốt (bốn read). Bảng `role_permissions` chỉ có `role_id`, `permission_id`, `created_at` — **không có cột `id`**.
5. Audit: có row `authorization_audit` cho **mọi bước** trong lần chạy hiện tại — S1 và S2, kể cả bước hội tụ (`context.noop = true`) — với cùng `correlation_id` của lần chạy này. Đối chiếu chéo với `account.security_events` (row A1, cùng `correlation_id` trong `metadata`) **chạy bằng credential A của `account`**, không bằng credential S: câu đọc chéo database đó do người thực thi A1 thực hiện, còn bước S3 chỉ đọc `db-staff-access`.

Unit chỉ được coi là hoàn tất khi **cả năm** kiểm đạt. Kiểm tra là truy vấn đọc được, không dựa vào log (ADR-0020 Quyết định 8).

### Bước 9 — Retry an toàn sau thất bại

Một lỗi ở bước nào — khi các bước trước đã commit — cũng để lại một **tiền tố hợp lệ**, không phải trạng thái hỏng: chạy lại **toàn bộ** procedure từ bước 1 là cơ chế phục hồi cho tiền tố đó (ADR-0020 Quyết định 6).

⚠️ **Không phải mọi trạng thái đều hội tụ bằng chạy lại.** Ba trạng thái sau là fail-closed cần can thiệp, và chạy lại sẽ lặp lại đúng lỗi đó: (a) `bootstrap_email` bị một Account khác giữ ở `pending` — do `POST /api/emails` cho phép; (b) assignment administrator đã hết hạn nhưng chưa `revoked_at`; (c) hàng staff theo `sub` không `active`. Gỡ (a) là vòng đời email bình thường của `account`, không phải SQL tay trên `db-account` (ADR-0021 Quyết định 2); (b) và (c) cần người quyết định, không tự sửa.

| Lỗi ở bước | Trạng thái còn lại                              | Chạy lại                                                                       |
| ---------- | ----------------------------------------------- | ------------------------------------------------------------------------------ |
| 3 (A1)     | Không có gì, hoặc Account đã commit rồi mới lỗi | Hội tụ theo `address_hash` dưới advisory lock; trả cùng `sub`                  |
| 4 (A2)     | Account hợp lệ, chưa có staff                   | Đọc lại đúng `sub`, tiếp tục S1                                                |
| 5 (S1)     | Staff đã commit, chưa có assignment             | `staff.sub` UNIQUE → không tạo staff thứ hai; staff không `active` → dừng, báo |
| 6 (S2)     | Assignment chưa commit                          | Insert-if-absent theo `(staff_id, role_id)` khi chưa có hàng còn hiệu lực      |
| 8 (S3)     | Dữ liệu đủ, verify sai                          | Không coi là xong; sửa nguyên nhân rồi verify lại                              |

⚠️ **Hai trạng thái ranh giới của retry.** (a) Assignment **hết hạn nhưng chưa `revoked_at`**: lần chạy lại lỗi duplicate key dù quyền hiệu lực bằng 0 — dừng và báo, không tự sửa. (b) Một lần chạy `mode = 'bootstrap'` trên environment đã từng có administrator bị guard **từ chối**: không ghi dữ liệu nghiệp vụ, nhưng **có** ghi đúng một audit row `outcome = 'denied'` — "không để lại dữ liệu" ở đây nghĩa là không có staff/assignment/Account mới, không phải không có dấu vết; chính row đó là thứ alert dựa vào. Chạy lại chỉ đúng khi quay về đúng chế độ (`recovery` + hai-phím).

⚠️ **Chạy lại sau khi assignment đã bị thu hồi chỉ tái tạo quyền dưới `mode = 'recovery'`.** Unique index bộ phận `(staff_id, role_id) WHERE revoked_at IS NULL` không chứa hàng đã `revoked_at`, nên một lần chạy lại S2 với cùng `sub` **sẽ** insert assignment mới đang hiệu lực. Đó chính là lý do guard đo thêm `admins_ever` (ADR-0022 Quyết định 3): sau khi thu hồi, `admins_before` về 0 nhưng `admins_ever` thì không, nên `mode = 'bootstrap'` bị **từ chối** và chỉ `recovery` + hai-phím mới cấp lại được. Hệ quả vận hành: (a) bề mặt này không được nối vào pipeline deploy của environment thật; (b) trên hệ thống đang chạy, cấp lại quyền administrator là **recovery**; (c) thu hồi quyền vì lý do bảo mật phải đi kèm thu hồi credential vận hành hoặc đổi input canonical (ADR-0021 Quyết định 5).

**Không xoá Account đã tạo hợp lệ vì một bước sau thất bại.** Account chưa có staff chỉ là một Account chưa có quyền; xoá nó tạo tombstone `sub` vĩnh viễn và đi ngược forward-fix (`architecture/01-architecture.md` §9 invariant 10). Không có compensating step, không có rollback dữ liệu.

⚠️ **Account mồ côi sau A1: có lối thoát, và nó không phải xoá.** A1 đã commit rồi S1/S2 thất bại để lại một Account `pending` không có staff. Trạng thái đó **đã là tiền tố hợp lệ**: chạy lại từ Bước 1 hội tụ trên cùng `sub` ở A1/A2 và đi tiếp S1; bước A2 đọc thấy `sub` cũ, không tạo Account thứ hai. Ba điều kiện để lối thoát đó còn mở: (a) `address_hash` vẫn có đúng một `sub` còn sống mang hàng `pending`; (b) Account đó vẫn `active`; (c) chưa ai khác chiếm địa chỉ. Mất bất kỳ điều kiện nào thì Account mồ côi **không** còn dùng được cho bootstrap và không có đường sửa bằng procedure — nó cần người quyết định, và đó là lý do procedure không tự xoá gì. Một Account mồ côi **không** bị tính là administrator (`admins_ever` đếm assignment, không đếm Account), nên nó không chặn một lần bootstrap hợp lệ sau đó.

### Bước 10 — Lần đăng nhập đầu tiên và quyền sở hữu Account về sau

Sau procedure, email khởi tạo vẫn `pending` và **chưa đăng nhập được**. Hoàn tất bootstrap chỉ khi người giữ hộp thư thực hiện:

1. Xác minh kiểm soát địa chỉ qua đường verify dành cho người **chưa có session** (purpose OTP `verify_email`, cùng rate limit/anti-enumeration). Đường này **không** phát hành session: nó chỉ chuyển email sang `verified` kèm `verified_at`, và không đổi `sub`, không tạo staff/role/assignment (ADR-0021 Quyết định 3).
2. Đăng nhập bằng luồng hiện có; principal mang `sub`, và Staff Access ánh xạ `sub` → staff (ADR-0012).

⚠️ Đường verify đó **chưa tồn tại** — nó là yêu cầu hiện thực của #17 (ADR-0021 Quyết định 3). Thiếu nó, procedure tạo ra Account không thể đăng nhập.

⚠️ **Điều kiện tiên quyết thuộc service khác:** gửi mã đi qua `transactional-mail`, nên template cho purpose `verify_email` và cấu hình của nó thuộc service đó, không thuộc procedure này. Thiếu template thì đường verify không gửi được mã dù logic đúng — kiểm trước khi tuyên bố bootstrap chạy được.

Từ đây Account thuộc về người dùng: đổi email, MFA/passkey, session đều đi qua `account` như mọi Account khác. Đổi email **không** đổi `sub` và **không** đổi staff identity — ánh xạ `sub` là bất biến.

## 3. Ba đường thay đổi quyền administrator

Ba đường tách biệt, mỗi đường có authorization riêng và **không** đường nào được "nâng cấp" im lặng thành đường khác (ADR-0023 Quyết định 1):

| Đường                | Tiền đề                                               | Authorization                    | Bề mặt                                                              |
| -------------------- | ----------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------- |
| Bootstrap            | `admins_before = 0` **và** `admins_ever = 0`          | Không approval                   | §2                                                                  |
| Bổ nhiệm thường (2+) | Đã có administrator; target là staff `active`         | Permission ghi, qua route thật   | `POST /staff/:id/assignments` — **chưa enforce, chưa có catalog**   |
| Emergency recovery   | Identity còn sống (`verified`), assignment đã thu hồi | Hai-phím có bằng chứng kiểm được | §3.2 — **chưa hiện thực** (đường) và **chưa cấu hình** (bằng chứng) |

### 3.1 Bổ nhiệm thường — đường hợp lệ duy nhất cho administrator thứ hai

Gán canonical administrator role cho một staff identity **đã tồn tại**, bởi một actor **đang có** permission ghi; không cần và **không** được dùng hai-phím (ADR-0023 Quyết định 2).

⚠️ **Đường này chưa chạy được, và thiếu ba thứ độc lập:** catalog chưa có permission ghi nào (`role.assign`/`role.revoke` chỉ có trong prototype fixture); `apps/staff-access/src/routes.ts` mở `POST /staff/:id/assignments` nhưng **không** enforce permission, và actor có thể là `null`; không có caller nào gọi `insertStaff`, nên không có đường tạo staff identity cho người thứ hai. Ngoài ra Account cho người thứ hai chưa có đường tạo (#48). Theo dõi ở #44 và #48. Cho tới khi cả ba xong, **cảnh báo vận hành là: hệ thống chạy trong cửa sổ một administrator** — không có đường hợp lệ nào thêm người thứ hai, và mất administrator cuối cùng không khôi phục được.

Điều kiện route phải giữ khi được hiện thực: principal lấy từ credential đã xác thực, không từ body; self-assignment bị từ chối (SR-005); target không `active` bị từ chối; assignment đã còn hiệu lực là no-op có audit, không tạo hàng trùng; audit actor là actor staff thật (SR-013).

### 3.2 Emergency recovery — identity còn sống, chỉ khôi phục authority

Recovery chạy trên **một** database (`db-staff-access`) và **không** có bước ghi nào ở `account` (ADR-0023 Quyết định 3). Thứ tự:

1. **Phân giải `sub` từ `address_hash`** bằng bề mặt **đọc** của `account` — không phải A1, không phải create-or-resolve. Yêu cầu đúng **một** Account `active` và đúng **một** hàng `email_addresses` `status = 'verified'` cho `address_hash` đó.
2. **Đọc staff row theo `sub`**: đúng một hàng, status `active`.
3. **Phân giải canonical administrator role**: đúng một hàng `(kind = 'system', name = <định danh canonical>)`; khác một hàng → từ chối `role_identity_ambiguous`.
4. **Đo guard** dưới advisory lock (Bước 7 của §2) và đối chiếu `mode = 'recovery'`.
5. **Kiểm bằng chứng hai-phím** (§3.3). Thiếu hoặc không kiểm được → từ chối.
6. **Phép ghi duy nhất:** trong một transaction của `db-staff-access`, insert **một assignment mới** trỏ canonical role, `granted_by` NULL, rồi ghi audit `success` với số đo.

- **Không hồi sinh hàng đã thu hồi.** `revoked_at` giữ nguyên; assignment mới có `id` mới. Lịch sử thể hiện một lần thu hồi và một lần cấp lại, và trigger `role_assignment_revoke_only` chặn runtime un-revoke.
- **Assignment còn hiệu lực đã có → từ chối `already_administrator`.** Không tạo hàng trùng, và không dùng recovery như no-op: người đó không mất quyền, nên không có gì để khôi phục. Cấp quyền cho người **khác** là §3.1.
- **Fail-closed:** Account `suspended`/`deleted`; staff `suspended`/`terminated`; nhiều hơn một Account cho địa chỉ; không có hàng `verified`; role không phân giải được; `mode` không khớp. Mỗi trường hợp dừng, exit khác 0, một audit row `denied`.
- **Retry:** lỗi trước commit không để lại gì; commit rồi thì chạy lại thấy assignment còn hiệu lực và từ chối. Không có trạng thái nửa vời xuyên database — đây là khác biệt cấu trúc so với bootstrap.
- **Account bị suspend sau lần đọc không tự thu hồi assignment.** Hai trục độc lập (invariant 8); đảo suspend là thao tác có audit của `account`, không phải một bước của recovery.

⚠️ **Ba trạng thái không khôi phục được, và đây là giới hạn đã biết, không phải sơ suất.** Staff `terminated` (terminal guard + `staff.sub` UNIQUE), Account `deleted` (tombstone, `sub` không tái phát hành, `address_hash` vẫn bị hàng `verified` cũ giữ), và địa chỉ email không còn dùng được đều cần **một identity mới** — tức một quyết định về danh tính canonical của recovery (#47). Cho tới khi có, ba trạng thái đó fail closed và không có nhánh thay thế. Không nới `UNIQUE`, không thêm trigger cho hồi sinh, không sửa trạng thái Account bằng tay.

⚠️ **Recovery chưa chạy được hôm nay**, vì hai lý do độc lập: đường này chưa hiện thực (#46), và **chưa có cơ chế bằng chứng nào được cấu hình** (#45).

### 3.3 Bằng chứng hai-phím

Hai-phím của ADR-0003 (hai người khác nhau, mỗi người có quyền quản trị danh tính hệ thống, một người thực thi, hai identity kèm thời điểm) chỉ có hiệu lực khi bằng chứng **kiểm được**. ADR-0023 Quyết định 5 chốt năm thuộc tính bắt buộc: hai danh tính **độc lập** do hệ thống tin cậy ghi nhận; gắn với **digest của đúng thao tác** (`mode`, `address_hash`, `sub`, `correlation_id`); **không tái dùng**; **kiểm tại thời điểm chạy** (CLI tự truy vấn và tự đối chiếu, không tin chuỗi từ entry point); **có thời hạn**.

- **`operator_ref` không phải bằng chứng.** Nó là metadata attribution tự khai và không thay được bất kỳ thuộc tính nào.
- **Thiếu bằng chứng → từ chối**, exit khác 0, không ghi dữ liệu nghiệp vụ, một audit row `denied` với `approval_missing` (không kiểm được) hoặc `approval_mismatch` (digest sai). Không có chế độ "cảnh báo rồi chạy tiếp", không có flag tắt kiểm.
- ⚠️ **Chưa cơ chế nào tồn tại.** `gh api repos/ecoma-io/ecoma/environments` trả `{"total_count":0}` và không workflow nào trong `.github/workflows/` khai `environment:` (kiểm 2026-11-10). Ứng viên GH8 (GitHub environment có required reviewers, `04-platform-facts.md` §2.17) vì vậy là **khả năng chưa cấu hình**, không phải kiểm soát đang có. Cơ chế, cấu hình và cách kiểm chứng thuộc #45.
- **Không đủ hai người có quyền hệ thống?** Đó là tình huống chưa được quyết — dừng và báo, không tự hạ cấp kiểm soát (§4 câu 3).

## 4. Câu hỏi còn mở

Ba câu chưa được quyết, ghi lại thay vì tự chọn (ADR-0021 Quyết định 7, ADR-0023 Quyết định 7):

1. "Quá ít administrator" được định nghĩa thế nào — 0, hay dưới một ngưỡng?
2. ~~Recovery tạo identity **mới** hay khôi phục identity đã có~~ — đã chốt một phần: recovery khôi phục authority trên identity **còn sống**, không tạo identity (ADR-0023 Quyết định 3). Phần còn mở: **danh tính thay thế lấy từ đâu** khi identity gốc không còn dùng được (staff `terminated`, Account `deleted`, email không dùng được) — #47.
3. Ai giữ phím thứ hai khi chính những người giữ phím là người mất quyền?
4. **Ai được giữ và ai được dùng credential vận hành?** `architecture/03-operations.md` §3.5 chỉ yêu cầu credential lấy lại được từ bản sao offline ngoài VPS; không tài liệu canonical nào chốt custody (một người hay tách đôi). Cho tới khi có, mọi lập luận "credential đã được kiểm soát nên một người là đủ" là suy diễn, không phải quyết định.

Các câu này thuộc policy vận hành/bảo mật; Issue #11 không quyết chúng.

## 5. Operational invariants

1. Không bề mặt serving nào thực hiện **bootstrap**: tạo Account, tạo staff identity, seed role, hay gán role system administrator lần đầu (ADR-0021 Quyết định 9). Route quản trị định kỳ `POST /staff/:id/assignments` và `POST /assignments/revoke` **có** tồn tại và không phải bootstrap — chúng gán/thu hồi trên một hệ thống đã có administrator, dưới authorization riêng.
2. Procedure chỉ ghi `db-staff-access`. Bước chạm `db-account` do `account` sở hữu và thực thi; không credential `staff-access` nào chạy `SELECT`/`INSERT` trên `db-account`.
3. Không transaction xuyên database, không compensating step; chạy lại toàn bộ là phục hồi **cho tiền tố hợp lệ** — không phải cho ba trạng thái fail-closed ở Bước 9, cũng không phải cho một environment đã từng có administrator (ADR-0022 Quyết định 3).
4. Không đánh dấu email `verified` trong bootstrap.
5. Role và permission là dữ liệu sealed từ migration/seed; procedure chỉ gán.
6. Không xoá Account hợp lệ để "rollback" một bước sau thất bại.
7. Không credential migrator/owner nào trở thành Worker secret, và credential migrator không rời CI secret store.
8. Mỗi lần chạy ghi `mode`, `admins_before` và `admins_ever` (số đo, không phải input) cùng `operator_ref`; actor NULL một mình không phải attribution, và `operator_ref` là tự khai chứ không được xác minh.
9. Chạy lại sau khi đã thu hồi assignment **sẽ** tái tạo quyền nếu được phép chạy — guard chặn điều đó ở `mode = 'bootstrap'` bằng `admins_ever`, nên đường tái tạo chỉ còn là `recovery` + hai-phím (§3.2–§3.3); vì vậy bề mặt này không thuộc pipeline deploy của environment thật.
10. Guard "chưa có administrator" là số đo race-safe trong critical section ghi của `staff-access`, dưới advisory lock; `mode` bị đối chiếu với số đo và một lần chạy sai chế độ bị **từ chối**, không ghi dữ liệu (ADR-0022). Guard chỉ chặn — nó không cấp, không sửa, không hồi sinh.
11. Không credential database nào được dùng trong phiên tương tác của người vận hành; mọi bước ghi chạy qua service CLI/CI job.
12. Bổ nhiệm administrator thứ hai **không** đi qua procedure bootstrap và **không** cần hai-phím; recovery **không** tạo identity, staff hay Account. Ba đường không thay thế nhau (ADR-0023 Quyết định 1, 2, 4).
