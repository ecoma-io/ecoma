# Staff Access — Vận hành

> Phạm vi: vận hành ứng dụng `staff-access` — bề mặt thực thi, credential, seed/migration và runbook **bootstrap first-administrator** + **emergency recovery**.
> Thiết kế → [`01-architecture.md`](./01-architecture.md) · yêu cầu → [`02-requirements.md`](./02-requirements.md) · nghiệp vụ → [`../../domains/staff-access/domain-model.md`](../../domains/staff-access/domain-model.md) · quyết định → [ADR-0021](../../domains/staff-access/adr/0021-first-admin-bootstrap-path.md) · [ADR-0003](../../domains/staff-access/adr/0003-bootstrap-first-admin-recovery.md) · [ADR-0020](../../domains/staff-access/adr/0020-bootstrap-seed-contract.md) · hợp đồng bootstrap/seed liên service → [`../../architecture/02-delivery.md`](../../architecture/02-delivery.md) §3.2.

## 1. Runtime và credential

| Hạng mục        | Giá trị                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database        | `db-staff-access`, schema `staff_access`                                                                                                                                                |
| Role migrator   | `ecoma_staff_access_migrator` — DDL, chỉ trong CI secret store / máy vận hành, **không bao giờ** là Worker secret                                                                       |
| Role runtime    | `ecoma_staff_access_runtime` — DML trên schema ứng dụng; chỉ `SELECT` trên `permissions`, `roles`, `role_permissions`                                                                   |
| Role owner      | `ecoma_owner` — chỉ dùng cho bước cần quyền sở hữu object (ADR-0020 Quyết định 3(b)); cầm ngoài VPS ([`../../architecture/03-operations.md`](../../architecture/03-operations.md) §3.5) |
| Bề mặt thực thi | Bước provisioning một-lần của `deploys/staff-access-deploy` (lane local), hoặc CLI offline trong `apps/staff-access` (environment thật) — ADR-0020 Quyết định 3                         |
| Không được dùng | Route HTTP, runtime flag, cron, hay bất kỳ code path nào trong Worker bundle để tạo staff/role/assignment (ADR-0021 Quyết định 9)                                                       |

`staff-access` **không** có quyền `CONNECT` sang `db-account`, và procedure này không đọc `db-account` ở bất kỳ bước nào. Giá trị duy nhất đi xuyên service là `sub`.

## 2. Bootstrap first-administrator

**Điều kiện áp dụng:** environment chưa có staff nào giữ role system administrator. Procedure **không** tự kiểm tra điều kiện này để rẽ nhánh — việc xác nhận thuộc người vận hành (ADR-0003, ADR-0020 Quyết định 5).

**Approval:** lần bootstrap đầu tiên **không** cần hai-phím (ADR-0021 Quyết định 7). Kiểm soát thay thế là bề mặt offline, credential owner/migrator, audit đầy đủ, kiểm tra đọc được sau mỗi bước, và không có nút UI. Hai-phím **không** bị bỏ cho emergency recovery — xem §3.

**Thứ tự bắt buộc:** A1 → A2 → S1 → S2 → S3. Mỗi bước commit độc lập; không có transaction xuyên database.

### Bước 1 — Chọn cấu hình môi trường đích

Đọc cấu hình từ chính môi trường đích, không từ máy cá nhân:

- `bootstrap_email` của environment (giá trị khởi tạo là `superadmin@ecoma.io`, nhưng đây là **input cấu hình theo environment**, không phải hằng số — ADR-0021 Quyết định 1).
- Tên database và credential migrator/owner của `db-account` và `db-staff-access` của **đúng** environment đó.

Không có project bootstrap trung tâm: cấu hình do bề mặt offline của từng service sở hữu đọc (ADR-0020 Phương án 2 bị loại). Không truyền cấu hình production vào lane local hoặc Preview.

### Bước 2 — Validate cấu hình và credential

| Kiểm                                        | Đạt khi                                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Kết nối `db-account` bằng credential A      | `SELECT 1` thành công; role **không** phải `ecoma_account_runtime` cho bước ghi (dùng migrator/owner)           |
| Kết nối `db-staff-access` bằng credential S | `SELECT 1` thành công; dùng `ecoma_staff_access_migrator`, không phải runtime                                   |
| Chặn chéo                                   | `SELECT has_database_privilege('ecoma_staff_access_runtime', 'db-account', 'CONNECT')` = `false`                |
| `bootstrap_email` hợp lệ                    | `normalizeEmailAddress` chấp nhận; chuỗi không rỗng và không phải placeholder                                   |
| Seed đã chạy                                | `staff_access.permissions` có đủ 4 bản ghi read; role system administrator và `role_permissions` của nó tồn tại |

Dừng ở đây nếu bất kỳ kiểm nào sai. Procedure **không** tạo role hay permission: role là dữ liệu sealed từ seed migration (ADR-0021 Quyết định 4, ADR-0020 Quyết định 10).

### Bước 3 — A1: `account` create-or-resolve

Chạy thao tác create-or-resolve của `account` (ADR-0021 Quyết định 2) với `bootstrap_email`. Bề mặt là CLI offline của `apps/account`; không có route HTTP.

- Địa chỉ được chuẩn hoá bằng đúng hàm của luồng OTP, rồi tra theo `address_hash` (SHA-256 hex), **không** theo địa chỉ trần.
- Đã có `sub` còn sống → trả lại chính `sub` đó. Chưa có → sinh `sub` mới và ghi `account.users` + `account.email_addresses` trong một transaction.
- Email được ghi `status = 'pending'`, `is_sign_in = false`, `verified_at IS NULL`. **Không** đánh dấu `verified` — xác minh thuộc lần đăng nhập đầu tiên (Bước 10).
- Audit ghi cùng transaction: `account.security_events` với `subject_sub` = `sub`, `outcome = 'success'`, `metadata.address_hash`.

Sinh `correlation_id` cho lần chạy **trước** bước này và dùng lại cho mọi bước còn lại.

### Bước 4 — A2: lấy và xác nhận `sub`

Đọc lại trong `db-account` bằng credential A:

```sql
SELECT u.sub, e.status, e.verified_at
FROM account.users u
JOIN account.email_addresses e ON e.user_sub = u.sub
WHERE e.address_hash = <sha256(bootstrap_email)>;
```

Đạt khi trả đúng **một** row: `sub` khớp định dạng `^sub_[a-z2-7]{32}$`, `status = 'pending'`, `verified_at IS NULL`, và Account không ở trạng thái tombstone.

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

| Bảng                               | Ghi ở bước | Nội dung bắt buộc                                                                                                        |
| ---------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| `account.security_events`          | A1         | `subject_sub`, `outcome = 'success'`, `metadata.address_hash` và mã idempotency (bảng **không có** cột `correlation_id`) |
| `staff_access.authorization_audit` | S1, S2     | actor NULL, target `staff.id`/`assignment.id`, action, outcome, `correlation_id`                                         |

Không ghi token, secret hay PII vào `context`/`metadata`. Audit nằm **trong** transaction của dữ liệu: lần chạy thất bại không tạo event `success`, lần chạy thành công không thể thiếu audit.

### Bước 8 — S3: đọc lại và verify

Chạy bằng credential S, đọc trực tiếp ba câu:

1. `SELECT id, status FROM staff_access.staff WHERE sub = <sub>` → đúng một row, `active`.
2. `SELECT role_id, revoked_at FROM staff_access.role_assignments WHERE staff_id = <staff.id>` → đúng một assignment còn hiệu lực trỏ role administrator; không có bản ghi trùng.
3. `SELECT id FROM staff_access.role_permissions WHERE role_id = <role.id>` → đúng tập permission đã chốt (4 read).
4. Audit: có row `authorization_audit` cho cả S1 và S2 với cùng `correlation_id`.

Unit chỉ được coi là hoàn tất khi **cả bốn** kiểm đạt. Kiểm tra là truy vấn đọc được, không dựa vào log (ADR-0020 Quyết định 8).

### Bước 9 — Retry an toàn sau thất bại

Lỗi ở bước nào cũng để lại một **tiền tố hợp lệ**, không phải trạng thái hỏng: chạy lại **toàn bộ** procedure từ bước 1 là cơ chế phục hồi duy nhất (ADR-0020 Quyết định 6).

| Lỗi ở bước | Trạng thái còn lại                              | Chạy lại                                          |
| ---------- | ----------------------------------------------- | ------------------------------------------------- |
| 3 (A1)     | Không có gì, hoặc Account đã commit rồi mới lỗi | Hội tụ theo `address_hash`; trả cùng `sub`        |
| 4 (A2)     | Account hợp lệ, chưa có staff                   | Đọc lại đúng `sub`, tiếp tục S1                   |
| 5 (S1)     | Staff đã commit, chưa có assignment             | `staff.sub` UNIQUE → không tạo staff thứ hai      |
| 6 (S2)     | Assignment chưa commit                          | Insert-if-absent theo `(staff_id, role_id)`       |
| 8 (S3)     | Dữ liệu đủ, verify sai                          | Không coi là xong; sửa nguyên nhân rồi verify lại |

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

## 4. Câu hỏi recovery còn mở

Ba câu chưa được quyết, ghi lại thay vì tự chọn (ADR-0021 Quyết định 7):

1. "Quá ít administrator" được định nghĩa thế nào — 0, hay dưới một ngưỡng?
2. Recovery tạo identity **mới** hay khôi phục identity đã có — và nếu tạo mới thì Account mới lấy từ đâu khi không còn ai có quyền xác nhận?
3. Ai giữ phím thứ hai khi chính những người giữ phím là người mất quyền?

Ba câu này thuộc policy vận hành/bảo mật; Issue #11 không quyết chúng.

## 5. Operational invariants

1. Không bề mặt serving nào tạo Account, staff, role hay assignment (ADR-0021 Quyết định 9, invariant 36).
2. Procedure chỉ ghi `db-staff-access`; không `CONNECT`, không đọc, không ghi `db-account` ngoài bước do `account` sở hữu.
3. Không transaction xuyên database, không compensating step; chạy lại toàn bộ là phục hồi.
4. Không đánh dấu email `verified` trong bootstrap.
5. Role và permission là dữ liệu sealed từ migration/seed; procedure chỉ gán.
6. Không xoá Account hợp lệ để "rollback" một bước sau thất bại.
7. Không credential migrator/owner nào trở thành Worker secret.
