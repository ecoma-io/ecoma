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

`staff-access` **không** có quyền `CONNECT` sang `db-account`. Mọi lần chạm `db-account` đều do `account` sở hữu và thực thi, bằng credential của `account`: A1 ghi duy nhất một lần (bước 3), A2 đọc (bước 4), còn kiểm chặn chéo (Bước 2) và đối chiếu chéo audit với `account.security_events` (Bước 8) là các lần đọc. Không bước nào chạy `SELECT`/`INSERT` trên `db-account` từ một credential của `staff-access`. Giá trị duy nhất đi xuyên service là `sub`.

⚠️ **Credential migrator không rời CI secret store.** Bước S1–S3 dùng `ecoma_staff_access_migrator` trên admin path của `../../architecture/02-delivery.md` §3.1. Nếu cần chạy procedure ngoài CI, **policy credential phải đổi trước** — không tự tạo bản sao thứ hai của credential, và không cấp credential riêng cho procedure (ADR-0021 Quyết định 5).

## 2. Bootstrap first-administrator

**Điều kiện áp dụng:** `admins_before = 0` **và** `admins_ever = 0` cho **bootstrap** (`mode = 'bootstrap'`). Nếu một trong hai khác 0, procedure **từ chối** — nó không có nhánh tự chuyển sang recovery. Recovery là bề mặt khác, ở §3.2, và đòi một identity **đã `verified`** cùng staff `active` — một email `pending` với `admins_ever > 0` fail closed cho tới khi verify trong Account context, rồi mới đi tiếp bằng §3.2. Procedure **tự đo** cả hai con số trong critical section ghi của `staff-access`, dưới advisory lock, rồi **từ chối** khi `mode` không khớp số đo — exit khác 0, không ghi staff và không ghi assignment, một audit row `outcome = 'denied'` với lý do `mode_mismatch` trong `staff_access.authorization_audit` (ADR-0022). Bước A1 đã commit trước đó, nên một lần bị từ chối vẫn để lại Account và hàng email `verified` nếu địa chỉ chưa có chủ (Bước 9). ⚠️ Row `denied` phải được **commit ngoài transaction guard** — `ROLLBACK` của transaction đó cuốn theo nó và lần từ chối mất dấu vết; kiểm bằng `SELECT … WHERE correlation_id = <id>` sau khi exit, đúng một row (ADR-0023 Quyết định 6). Entry point giữ một lớp kiểm trước để fail nhanh, nhưng nó **không** phải lớp bảo vệ chính và không thay lớp trong procedure.

⚠️ `admins_before` và `admins_ever` là **số đo do procedure tính**, không phải giá trị người chạy truyền vào: chúng đi vào audit dưới dạng kết quả đo, và không được dùng cho bất kỳ quyết định nào khi là input. Hai truy vấn canonical ở Bước 7 — chúng đếm hai thứ khác nhau: `admins_before` đếm **administrator còn hiệu lực** (`count(DISTINCT staff_id)`), `admins_ever` đếm **hàng assignment từng tồn tại** của role canonical, nên nó chỉ dùng làm ngưỡng khác 0 và không bao giờ được báo cáo như số administrator (ADR-0022 Quyết định 4).

**Approval:** lần bootstrap đầu tiên **không** cần hai-phím (ADR-0020 Quyết định 11, không phải quyết định của ADR-0021). Hai-phím **không** bị bỏ cho emergency recovery — xem §3.2–§3.3.

**Thứ tự bắt buộc:** A1 → A2 → S1 → S2 → S3. Mỗi bước commit độc lập; không có transaction xuyên database.

⚠️ **Cửa sổ một administrator là cửa sổ rủi ro, và hôm nay nó là trạng thái thực tế.** Mất hoặc suspend staff identity duy nhất đưa hệ thống về trạng thái chỉ recovery mới sửa được, và recovery chưa chạy được (§3.2, §3.3). Administrator thứ hai chỉ tạo được qua bổ nhiệm thường, mà đường đó chưa tồn tại — thiếu permission ghi trong catalog, thiếu enforcement, thiếu đường tạo staff, thiếu đường tạo Account (§3.1, #44, #48). Không được báo cáo "nhiều Superadmin được phép" mà bỏ vế "nhưng chưa có đường tạo" (ADR-0023 Quyết định 8).

### Bước 1 — Chọn cấu hình môi trường đích

Xác nhận đang nhắm đúng môi trường đích, không phải máy cá nhân:

- `bootstrap_email` và tenant `ecoma` là **hằng trong code** của bước bootstrap, không phải giá trị cấu hình tự do: cấu hình environment chỉ **assert** lại đúng giá trị đó, và procedure **từ chối chạy** khi input khác hằng — kể cả khi input hợp lệ về cú pháp (ADR-0021 Quyết định 1). Không có nhánh "dùng địa chỉ của environment này".
- Tên database và credential migrator của `db-account` và `db-staff-access` của **đúng** environment đó, cộng **tham chiếu người thực thi** (id change/ticket) cho audit Bước 7.

Entry point là một repo script trong `tools/` (ADR-0020 Quyết định 12), chạy bằng `pnpm dx bootstrap-superadmin`: nó không giữ credential nào, không ghi database nào, và gọi CLI bootstrap của từng service như tiến trình con theo thứ tự dưới đây. Hai chuỗi kết nối đi qua env `ECOMA_ACCOUNT_DATABASE_URL` và `ECOMA_STAFF_ACCESS_DATABASE_URL`; mỗi service chỉ nhận chuỗi của database mình sở hữu. Correlation id dùng chung cho mọi bước và mọi audit row là `--correlation-id` (mặc định một UUID mới), người thực thi là `--operator-ref`. Không truyền cấu hình production vào lane local hoặc Preview.

- `bootstrap_email` là **PII**: nằm trong cấu hình của environment, đọc được bởi bất kỳ ai đọc cấu hình đó. Địa chỉ **không** được truyền qua command-line argument (lộ trong lịch sử shell và danh sách tiến trình) và không được gõ vào phiên `psql` có ghi history; nó đi qua stdin/env của tiến trình con. Bước đọc cấu hình **chuẩn hoá** địa chỉ bằng `normalizeEmailAddress` rồi tính `address_hash` — nhưng A1 vẫn nhận **địa chỉ đã chuẩn hoá**, không phải hash: chính A1 định nghĩa cách tra cứu theo `address_hash` (ADR-0021 Quyết định 2), và một hash truyền từ ngoài vào sẽ bỏ qua bước chuẩn hoá thuộc sở hữu của `account`. Kiểm cú pháp ở Bước 2 chạy trên **địa chỉ trần đã chuẩn hoá** trước khi nó được dùng, cùng chỗ đọc cấu hình.

### Bước 2 — Validate cấu hình và credential

| Kiểm                                        | Đạt khi                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kết nối `db-account` bằng credential A      | `SELECT 1` thành công; role **không** phải runtime role cho bước ghi                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Kết nối `db-staff-access` bằng credential S | `SELECT 1` thành công; dùng `ecoma_staff_access_migrator` trên admin path CI, không phải runtime role                                                                                                                                                                                                                                                                                                                                                                                              |
| Chặn chéo                                   | `SELECT has_database_privilege('ecoma_staff_access_runtime', 'db-account', 'CONNECT')` = `false`. Chạy **sau** khi `db-account` tồn tại: hàm này lỗi khi database chưa có, nên `false` chỉ có nghĩa khi kiểm được cả hai trạng thái                                                                                                                                                                                                                                                                |
| `bootstrap_email` hợp lệ                    | Khớp kiểm cú pháp của `account` (`/^[^\s@]{1,64}@[^\s@]{1,255}$/u`, `apps/account/server/api/emails/index.post.ts`) — **không** dùng `normalizeEmailAddress` làm kiểm tra: hàm đó chỉ `trim()` + `toLowerCase()` và chấp nhận cả `'not an email'`                                                                                                                                                                                                                                                  |
| Hộp thư đã được kiểm soát                   | Người vận hành xác nhận **ngoài hệ thống** rằng `bootstrap_email` đã được cấp phát cho tổ chức và có MFA — đây là điều kiện tiên quyết, không phải kiểm tra tự động (ADR-0020 Quyết định 11)                                                                                                                                                                                                                                                                                                       |
| Seed đã chạy                                | Đạt khi `staff_access.permissions` có đủ **4** permission read (`staff.read`, `role.read`, `permission.read`, `audit.read`), đúng **một** hàng `roles` `kind = 'system'`, `name = 'system-administrator'`, `active`, và `role_permissions` của nó đúng bốn permission đó (ADR-0021 Quyết định 4, 8; ADR-0024 Quyết định 5). Seed là migration, procedure chỉ đọc                                                                                                                                   |
| Địa chỉ bootstrap không bị giữ chỗ          | Chạy truy vấn A2 (Bước 4) **trước** khi bắt đầu: phải trả 0 hàng, hoặc đúng một hàng `verified` do một lần bootstrap trước tạo ra (có bootstrap audit event cùng transaction, Account `active`, không có đường đăng nhập khác). Có hàng `verified` không chứng minh được nguồn gốc bootstrap, có hàng `pending` thuộc cùng địa chỉ, hoặc có hàng `revoked`, nghĩa là bootstrap sẽ fail-closed ở giữa procedure — dừng ở đây và xử lý theo §2 Bước 9 (ADR-0021 Quyết định 2; ADR-0024 Quyết định 4) |

Dừng ở đây nếu bất kỳ kiểm nào sai. Procedure **không** tạo role hay permission: role là dữ liệu sealed từ seed migration (ADR-0021 Quyết định 4, ADR-0020 Quyết định 10).

### Bước 3 — A1: `account` create-or-resolve

Chạy thao tác create-or-resolve của `account` (ADR-0021 Quyết định 2) với `bootstrap_email`. Bề mặt là CLI offline của `apps/account`; không có route HTTP.

- Địa chỉ được chuẩn hoá bằng đúng hàm của luồng OTP, rồi tra theo `address_hash` (SHA-256 hex), **không** theo địa chỉ trần.
- **Đọc và ghi trong một transaction dưới advisory transaction lock toàn cục cố định** (một khoá hằng cho đường bootstrap, không phải khoá theo `address_hash`: chỉ có một địa chỉ canonical nên một khoá toàn cục tuần tự hoá mọi lần chạy). Hai lần chạy đồng thời phải tuần tự hoá: lần thứ hai chờ, rồi đọc thấy hàng đã commit của lần thứ nhất và đi nhánh hội tụ. Không có lock này, cả hai cùng đọc "chưa có hàng" và cùng ghi — hai `sub` cho cùng địa chỉ, và A2 fail-closed không hội tụ được. ⚠️ Bước này vì vậy chỉ chạy được trên bề mặt CLI offline: `pg_advisory_xact_lock` không chạy qua Hyperdrive (platform fact `HD6`), đúng bề mặt §1 chốt.
- Không có hàng nào **còn sống** → sinh `sub` mới (entropy 32 ký tự base32 từ CSPRNG; `createSubject` chỉ nhận entropy, không tự sinh; `sub` không bao giờ là email) và ghi `account.users` + `account.email_addresses` `verified` + bootstrap audit trong cùng transaction.
- Có đúng một hàng `verified` **đã hội tụ và chứng minh được nguồn gốc** → trả lại chính `sub` đó, không ghi gì thêm. Điều kiện hội tụ gồm bốn vế cùng lúc: địa chỉ khớp hằng canonical, Account `active`, đúng một `sub` sở hữu hàng đó, và có bootstrap audit event cùng transaction của lần chạy trước. Thiếu một vế → fail-closed (ADR-0024 Quyết định 4).
- **Fail-closed ở mọi trạng thái khác:** nhiều hơn một `sub`; `sub` đã `suspended`/`deleted`; Account đó còn địa chỉ `verified` **khác**; cùng `sub` có nhiều hơn một hàng còn sống cho `address_hash`; hoặc có hàng `verified` không chứng minh được nguồn gốc bootstrap. **Không bao giờ suy quyền từ địa chỉ một mình:** một Account bất kỳ có thể mang chính `bootstrap_email`, nên nhận `sub` đó là cấp administrator cho người đăng nhập bằng địa chỉ của họ chứ không phải người kiểm soát hộp thư bootstrap (ADR-0021 Quyết định 2). ⚠️ Điều kiện là hàng `verified` **khác**, không phải `is_sign_in`: xem ghi chú ở Bước 4.
- ⚠️ **Hàng `revoked` không tính là "đã có hàng" và không tính là "đã có chủ".** Khoá tự nhiên và mọi kiểm fail-closed chỉ đọc `status IN ('pending','verified')`. Nhưng một hàng `revoked` cho `bootstrap_email` là dấu hiệu đã có người từng chạm địa chỉ đó (`POST /api/emails` cho họ thêm `pending`, rồi revoke) — **dừng và báo**, không chạy tiếp, vì lần chạy này sẽ tạo Account mới cho cùng địa chỉ. Procedure **không** xoá hay revoke hàng email nào.
- Email được ghi `status = 'verified'`, `verified_at = database now()`, `is_sign_in = true`, trong cùng transaction với `account.users`. Đây là **trusted provisioning assertion** của một thao tác offline, không phải bằng chứng OTP: không có endpoint sessionless nào đổi trạng thái này, và bootstrap không phát session (ADR-0024 Quyết định 1, 2). Địa chỉ do người dùng tự thêm vẫn `pending` và vẫn phải verify trong Account context.
- Audit ghi cùng transaction: `account.security_events` với `type = 'bootstrap_account_provisioned'`, `subject_sub` = `sub`, `outcome = 'success'`, `metadata.address_hash`, `metadata.correlation_id`, `metadata.mode = 'bootstrap'`, `metadata.verification_source = 'trusted_bootstrap'`, `metadata.operator_ref`. Writer của đường này nhận transaction client và **ném** khi insert hỏng; helper best-effort của serving path không dùng được vì nó nuốt lỗi và sẽ commit một Account không audit (ADR-0024 Quyết định 6). Bảng **không có** cột `correlation_id`, nên các trường này nằm trong `metadata`. **Không** ghi `admins_before`/`admins_ever` ở bước này: hai số đó chỉ được đo trong critical section ghi của `staff-access` (Bước 7), và ghi một giá trị chưa đo được là ghi một con số bịa.

Sinh `correlation_id` cho lần chạy **trước** bước này và dùng lại cho mọi bước còn lại.

### Bước 4 — A2: lấy và xác nhận `sub`

Đọc lại trong `db-account` bằng credential A:

```sql
SELECT u.sub, u.status AS account_status, e.status, e.verified_at, e.is_sign_in
FROM account.users u
JOIN account.email_addresses e ON e.user_sub = u.sub
WHERE e.address_hash = <address_hash>
  AND e.status IN ('pending', 'verified');
```

Đạt khi trả đúng **một** row: `sub` khớp định dạng `^sub_[a-z2-7]{32}$`, `account_status = 'active'` (không tombstone), `status = 'verified'`, `verified_at IS NOT NULL`, `is_sign_in = true`, **và** có đúng một `security_events` row `type = 'bootstrap_account_provisioned'` cùng `subject_sub` với `metadata.address_hash` khớp — vế cuối là bằng chứng hàng email do bootstrap tạo, không phải do đường khác.

⚠️ **`is_sign_in` đọc ra nhưng không phải điều kiện để đạt.** Đó là cờ hiển thị (`is_sign_in boolean NOT NULL DEFAULT false`, `0005_email_addresses.sql`), **không** có CHECK ràng buộc nó với `status`, và **không** phải cổng đăng nhập: `lookupVerifiedAddress` chỉ lọc `e.status = 'verified'` rồi `resolveOtpTarget` đòi `users.status = 'active'` (`apps/account/server/lib/otp.ts`). Đạt khi `is_sign_in = true`, vì hàng bootstrap do A1 ghi như vậy; nếu hàng `verified` đó mang `is_sign_in = false` thì trạng thái không phải do procedure này tạo ra — dừng và báo. Nhưng lý do để nó **không** thay được câu đếm `verified` bên dưới là điều quan trọng hơn: dùng `is_sign_in` làm cổng sẽ bỏ lọt một Account còn địa chỉ `verified` khác, tức cấp quyền administrator cho `sub` đăng nhập được bằng hộp thư khác. Câu đếm `status = 'verified'` mới là lớp chặn đó.

⚠️ Đúng một row **chưa đủ**. Kiểm thêm hai câu, vì partial UNIQUE trên `email_addresses` chỉ áp cho hàng `verified`, nên hàng `pending` cạnh nó không bị ràng buộc:

```sql
SELECT count(*) FROM account.email_addresses
WHERE user_sub = <sub> AND status = 'verified'
  AND address_hash <> <address_hash>;                           -- phải = 0

SELECT count(DISTINCT user_sub) FROM account.email_addresses
WHERE address_hash = <address_hash>
  AND status IN ('pending', 'verified');                        -- phải = 1
```

Câu đầu chứng minh Account này không có đường đăng nhập nào **khác**, nên người duy nhất vào được nó là người kiểm soát `bootstrap_email`. Câu sau chứng minh không `sub` nào khác cùng giữ địa chỉ đó. Cả hai lọc `status IN ('pending','verified')`: hàng `revoked` không chứng minh quyền sở hữu và không giữ địa chỉ (ADR-0021 Quyết định 2).

Đây là lần đọc `db-account` duy nhất ở phần giữa procedure: A2 đọc, S1–S3 chỉ đọc `db-staff-access`, và các lần đọc `db-account` còn lại (kiểm chặn chéo ở Bước 2, đối chiếu chéo audit ở Bước 8) cũng do `account` sở hữu và chạy bằng credential A. Không bước nào **ghi** `db-account` ngoài A1. Giá trị `sub` đọc ở bước này là đầu vào duy nhất của các bước sau.

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

### Bước 7 — Audit của lần chạy (không phải bước riêng)

Audit **không** phải một bước trong thứ tự A1 → A2 → S1 → S2 → S3: nó được ghi **trong** transaction của A1, S1 và S2. Mục này chỉ tập hợp nội dung bắt buộc để kiểm, không được đọc như một lần ghi độc lập hay một transaction thứ sáu.

Hai bảng, hai chủ sở hữu, không bảng mới (ADR-0021 Quyết định 6):

| Bảng                               | Ghi ở bước | Nội dung bắt buộc                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account.security_events`          | A1         | `type = 'bootstrap_account_provisioned'`, `subject_sub`, `outcome = 'success'`, `metadata.address_hash`, `metadata.correlation_id`, `metadata.mode`, `metadata.verification_source`, `metadata.operator_ref` — **không** có hai số đo, vì A1 chạy trước critical section đo (bảng **không có** cột `correlation_id`) |
| `staff_access.authorization_audit` | S1, S2     | actor NULL, target `staff.id`/`assignment.id`, action, outcome, `correlation_id`, `context.mode`, `context.operator_ref`, `context.admins_before`, `context.admins_ever`, `context.noop` khi bước hội tụ không ghi dữ liệu                                                                                           |

- `mode` là `bootstrap` hoặc `recovery`. `admins_before` và `admins_ever` là **số đo do procedure tính** trước khi ghi — **không** phải input. Câu SQL canonical của cả hai phép đo nằm ở một chỗ duy nhất: [ADR-0022](../../domains/staff-access/adr/0022-measured-first-admin-guard.md) Quyết định 4; procedure dùng đúng câu ở đó, không dùng bản viết lại.

  Hệ quả vận hành phải giữ, không phải chi tiết của câu truy vấn:

  - `admins_before` đếm **administrator còn hiệu lực** (`count(DISTINCT staff_id)`), nên `revoked_at IS NULL` một mình là sai: nó tính cả role không phải administrator, bỏ qua cửa sổ hiệu lực, và tính cả staff đã `terminated`. Đếm theo `staff_id` chứ theo số hàng: một staff có hai assignment còn hiệu lực vẫn là **một** administrator.
  - `admins_ever` **bắt buộc phải có, không phải thông tin thêm.** `admins_before` về 0 ngay sau khi assignment cuối cùng bị `revoked_at`, nên chỉ so nó thì một lần `mode = 'bootstrap'` sau khi thu hồi quyền administrator cuối cùng sẽ được **chấp nhận** và insert assignment mới — tức khôi phục đúng quyền vừa bị thu hồi mà không có hai-phím. `admins_ever` bỏ mọi bộ lọc trạng thái và chỉ dùng làm ngưỡng khác 0.
  - Guard chấp nhận `bootstrap` chỉ khi **cả** `admins_before = 0` **và** `admins_ever = 0`; mọi cặp khác bị từ chối. Một environment đã từng có administrator **không** bootstrap lại được, kể cả khi hiện không còn ai. Đường cấp lại là §3.2, và §3.2 chỉ nhận identity **đã `verified`** cùng staff `active` — nên một email còn `pending` với `admins_ever > 0` không đi được đường nào cho tới khi verify trong Account context (Bước 10).
  - Guard chỉ chặn; nó **không** cấp lại quyền.

  **Hai số đo được lấy lại trong từng bước ghi, ngay sau khi bước đó lấy advisory lock và trước phép ghi của chính nó** — S1 đo trong transaction của S1, S2 đo lại trong transaction của S2; không phải một phép đo dùng chung cho cả hai, và không phải đo sau S2 (khi đó lần chạy vừa tạo đã được tính vào). Đo lại ở S2 không phải dư thừa mà là lớp chặn: hai lần bootstrap chạy song song đều thấy `admins_before = 0` khi vào S1, nên nếu S2 tin số đo của S1 thì cả hai cùng ghi assignment; đo lại trong S2 thì lần thứ hai thấy lần thứ nhất vừa commit và bị **từ chối** (ADR-0022 Quyết định 1, 3, 5). Trong mỗi transaction, cùng giá trị đo được dùng cho cả quyết định của guard lẫn audit row của bước đó, nên audit không thể ghi một số khác với số đã quyết định.

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
5. Audit: có row `authorization_audit` cho **mọi bước** trong lần chạy hiện tại — S1 và S2, kể cả bước hội tụ (`context.noop = true`) — với cùng `correlation_id` của lần chạy này. ⚠️ Khi S3 chạy lại **sau** một S2 đã commit (Bước 9), không có lần chạy S1/S2 nào mang `correlation_id` mới: kiểm này đối chiếu `correlation_id` của lần chạy đã tạo dữ liệu, không đòi một lần chạy mới. Đối chiếu chéo với `account.security_events` (row A1, cùng `correlation_id` trong `metadata`) **chạy bằng credential A của `account`**, không bằng credential S: câu đọc chéo database đó do người thực thi A1 thực hiện, còn bước S3 chỉ đọc `db-staff-access`.

Unit chỉ được coi là hoàn tất khi **cả năm** kiểm đạt. Kiểm tra là truy vấn đọc được, không dựa vào log (ADR-0020 Quyết định 8).

### Bước 9 — Retry an toàn sau thất bại

Một lỗi ở bước nào — khi các bước trước đã commit — cũng để lại một **tiền tố hợp lệ**, không phải trạng thái hỏng: chạy lại **toàn bộ** procedure từ bước 1 là cơ chế phục hồi cho tiền tố đó (ADR-0020 Quyết định 6).

⚠️ **Chạy lại toàn bộ chỉ đúng cho tiền tố chưa có assignment: A1, A1+A2, A1+A2+S1.** Ngay khi **S2 đã commit**, lần chạy lại không còn là no-op mà bị guard **từ chối** `mode_mismatch`: `admins_before` và `admins_ever` đều bằng 1, nên `mode = 'bootstrap'` không còn khớp số đo (ADR-0022 Quyết định 3). Đây là hành vi đúng — bootstrap đã hoàn tất, và việc còn lại chỉ là S3 (đọc lại) và Bước 10 (đăng nhập OTP). Cách xử lý đúng: **không** chạy lại procedure; chạy S3 rồi Bước 10.

⚠️ **Một lần chạy lại như vậy sinh ra cùng chữ ký audit mà T-11 dùng để báo "có người đang thử cấp lại quyền" — nhưng hai sự kiện phân biệt được, và phải phân biệt bằng số đo chứ không bằng ý định.** Cả hai đều là `denied` với `mode_mismatch` và `admins_ever > 0`. Khác biệt nằm ở `admins_before`:

- Lần chạy lại vô ý ngay sau một S2 thành công: `admins_before = 1` — environment **đang** có administrator còn hiệu lực, và chính đó là người vừa được tạo. Không có gì bị thu hồi.
- Nỗ lực cấp lại quyền đã thu hồi: `admins_before = 0` với `admins_ever > 0` — không còn administrator nào, đúng trạng thái mà bootstrap không được phép vượt qua.

Không được gộp hai trường hợp này thành một alert rồi bỏ qua cả hai, và cũng không được chỉ ghi nhận trường hợp thứ hai: một chuỗi lần chạy lại lặp lại là tín hiệu vận hành khác (procedure đang bị dùng sai), không phải tín hiệu bảo mật.

⚠️ **Không phải mọi trạng thái đều hội tụ bằng chạy lại.** Bốn trạng thái sau là fail-closed cần can thiệp, và chạy lại sẽ lặp lại đúng lỗi đó: (a) `bootstrap_email` bị một Account khác giữ ở `pending` — do `POST /api/emails` cho phép, và trạng thái này **tạo ra được cả sau S2**; (b) assignment administrator đã hết hạn nhưng chưa `revoked_at`; (c) hàng staff theo `sub` không `active`; (d) một `sub` khác đã `verified` chính `bootstrap_email` sau khi A1 commit — trạng thái này không còn tạo được sau A1, vì partial UNIQUE giữ địa chỉ ở một chủ `verified`, nhưng vẫn kiểm vì một hàng cũ có thể đã tồn tại trước đó. Gỡ (a) và (d) là vòng đời email bình thường của `account`, không phải SQL tay trên `db-account` (ADR-0021 Quyết định 2; ADR-0024 Quyết định 4); (b) và (c) cần người quyết định, không tự sửa. Cả bốn đều **không** có bước gỡ nào bên trong procedure.

| Lỗi ở bước | Trạng thái còn lại                              | Chạy lại                                                                                              |
| ---------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 3 (A1)     | Không có gì, hoặc Account đã commit rồi mới lỗi | Hội tụ theo `address_hash` dưới advisory lock; trả cùng `sub`                                         |
| 4 (A2)     | Account hợp lệ, chưa có staff                   | Đọc lại đúng `sub`, tiếp tục S1                                                                       |
| 5 (S1)     | Staff đã commit, chưa có assignment             | `staff.sub` UNIQUE → không tạo staff thứ hai; staff không `active` → dừng, báo                        |
| 6 (S2)     | Assignment chưa commit                          | Insert-if-absent theo `(staff_id, role_id)` khi chưa có hàng còn hiệu lực                             |
| 8 (S3)     | S2 **đã** commit, verify sai                    | **Không** chạy lại procedure (guard từ chối `mode_mismatch`); sửa nguyên nhân rồi chạy lại **chỉ S3** |

⚠️ **Hai trạng thái ranh giới của retry.** (a) Assignment **hết hạn nhưng chưa `revoked_at`**: lần chạy lại lỗi duplicate key dù quyền hiệu lực bằng 0 — dừng và báo, không tự sửa. (b) Một lần chạy `mode = 'bootstrap'` trên environment đã từng có administrator bị guard **từ chối**: không ghi staff và không ghi assignment, nhưng **có** ghi đúng một audit row `outcome = 'denied'` — chính row đó là thứ alert dựa vào. ⚠️ **A1 đã commit trước khi guard chạy.** Thứ tự bắt buộc là A1 → A2 → S1 → S2, và phép đo nằm trong critical section ghi của S1/S2, nên một lần bị từ chối **vẫn để lại** một Account mới cùng hàng email `verified` (và một row `security_events` `success` của A1) khi địa chỉ bootstrap chưa có chủ. Đó không phải một lần "không có hệ quả": nó là Account chưa có quyền, giữ lại theo forward-fix (§"Không xoá Account đã tạo hợp lệ"), và là lý do entry point phải kiểm trước (§2, ADR-0022 Quyết định 7) — với gọi thẳng CLI thì không có lớp nào chặn trước A1. Chạy lại **không** sửa được trạng thái đó: guard đã đo đúng, và cấp lại quyền không phải việc của procedure này — nó là §3.2 (#46).

⚠️ **Chạy lại sau khi assignment đã bị thu hồi chỉ tái tạo quyền qua đường recovery của §3.2, không qua procedure này.** Unique index bộ phận `(staff_id, role_id) WHERE revoked_at IS NULL` không chứa hàng đã `revoked_at`, nên một lần chạy lại S2 với cùng `sub` **sẽ** insert assignment mới đang hiệu lực. Đó chính là lý do guard đo thêm `admins_ever` (ADR-0022 Quyết định 3): sau khi thu hồi, `admins_before` về 0 nhưng `admins_ever` thì không, nên `mode = 'bootstrap'` bị **từ chối**. Hệ quả vận hành: (a) bề mặt này không được nối vào pipeline deploy của environment thật; (b) trên hệ thống đang chạy, cấp lại quyền administrator là §3.2 (ADR-0023 Quyết định 3, #46), không phải một chế độ của procedure này; (c) thu hồi quyền vì lý do bảo mật phải đi kèm thu hồi credential vận hành hoặc đổi input canonical (ADR-0021 Quyết định 5).

**Không xoá Account đã tạo hợp lệ vì một bước sau thất bại.** Account chưa có staff chỉ là một Account chưa có quyền; xoá nó tạo tombstone `sub` vĩnh viễn và đi ngược forward-fix (`architecture/01-architecture.md` §9 invariant 10). Không có compensating step, không có rollback dữ liệu.

⚠️ **Account mồ côi sau A1: có lối thoát, và nó không phải xoá.** A1 đã commit rồi S1/S2 thất bại để lại một Account không có staff. Trạng thái đó **đã là tiền tố hợp lệ**: chạy lại từ Bước 1 hội tụ trên cùng `sub` ở A1/A2 và đi tiếp S1; bước A2 đọc thấy `sub` cũ, không tạo Account thứ hai. Ba điều kiện để lối thoát đó còn mở: (a) `address_hash` vẫn có đúng một `sub` còn sống mang hàng `verified` do bootstrap tạo; (b) Account đó vẫn `active`; (c) **không** ai khác chiếm địa chỉ — kể cả ở trạng thái `pending`, vì một hàng `pending` cùng địa chỉ làm trạng thái không còn là tiền tố hội tụ được. Mất bất kỳ điều kiện nào thì Account mồ côi **không** còn dùng được cho bootstrap và không có đường sửa bằng procedure — nó cần người quyết định, và đó là lý do procedure không tự xoá gì. Một Account mồ côi **không** bị tính là administrator (`admins_ever` đếm assignment, không đếm Account), nên nó không chặn một lần bootstrap hợp lệ sau đó.

### Bước 10 — Lần đăng nhập đầu tiên và quyền sở hữu Account về sau

Sau A1, email khởi tạo đã `verified`, còn thiếu bước để **có session**: Superadmin đăng nhập bằng đúng luồng passwordless OTP hiện có.

1. `POST /api/auth/challenge` với địa chỉ canonical → `POST /api/auth/verify` với purpose `login`. Cổng đăng nhập không đổi: `email_addresses.status = 'verified'` cộng `users.status = 'active'` (`lookupVerifiedAddress`, `resolveOtpTarget`).
2. Session trả về mang `sub` trùng `sub` mà A1/A2 đã xác nhận; Staff Access ánh xạ `sub` → staff (ADR-0012).

⚠️ **Bootstrap không phát session, token hay cookie** — và không có endpoint sessionless nào để "hoàn tất" bootstrap. Việc duy nhất còn lại sau procedure là người giữ hộp thư nhập mã OTP nhận được ở hộp thư đó. Đó cũng chính là bằng chứng kiểm soát hộp thư; không có bằng chứng nào khác (ADR-0024 Quyết định 2, 3).

⚠️ **Điều kiện tiên quyết thuộc service khác:** gửi mã đi qua `transactional-mail`, nên template của purpose `login` và cấu hình của nó thuộc service đó. Thiếu template thì lần đăng nhập đầu không gửi được mã dù mọi thứ khác đúng — kiểm trước khi tuyên bố bootstrap chạy được.

⚠️ **Đăng nhập OTP thất bại không phải sự cố bootstrap.** Rate limit (`3/15 phút`, `10/giờ`), cooldown 60 giây, mã hết hạn 600 giây đều là hành vi của luồng `login`; không trạng thái bootstrap nào bị đổi và không cần chạy lại procedure.

Từ đây Account thuộc về người dùng: đổi email, MFA/passkey, session đều đi qua `account` như mọi Account khác. Đổi email **không** đổi `sub` và **không** đổi staff identity — ánh xạ `sub` là bất biến.

## 3. Ba đường thay đổi quyền administrator

Ba đường tách biệt, mỗi đường có authorization riêng và **không** đường nào được "nâng cấp" im lặng thành đường khác (ADR-0023 Quyết định 1):

| Đường                | Tiền đề                                                                               | Authorization                    | Bề mặt                                                              |
| -------------------- | ------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------- |
| Bootstrap            | `admins_before = 0` **và** `admins_ever = 0`                                          | Không approval                   | §2                                                                  |
| Bổ nhiệm thường (2+) | Đã có administrator; target là staff `active`                                         | Permission ghi, qua route thật   | `POST /staff/:id/assignments` — **chưa enforce, chưa có catalog**   |
| Emergency recovery   | Identity còn sống (`verified`) và **đã từng** là administrator; assignment đã thu hồi | Hai-phím có bằng chứng kiểm được | §3.2 — **chưa hiện thực** (đường) và **chưa cấu hình** (bằng chứng) |

### 3.1 Bổ nhiệm thường — đường hợp lệ duy nhất cho administrator thứ hai

Gán canonical administrator role cho một staff identity **đã tồn tại**, bởi một actor **đang có** permission ghi; không cần và **không** được dùng hai-phím (ADR-0023 Quyết định 2).

⚠️ **Đường này chưa chạy được, và thiếu ba thứ độc lập:** catalog chưa có permission ghi nào (`role.assign`/`role.revoke` chỉ có trong prototype fixture); `apps/staff-access/src/routes.ts` mở `POST /staff/:id/assignments` nhưng **không** enforce permission, và actor có thể là `null`; không có caller nào gọi `insertStaff`, nên không có đường tạo staff identity cho người thứ hai. Ngoài ra Account cho người thứ hai chưa có đường tạo (#48). Theo dõi ở #44 và #48. Cho tới khi cả ba xong, **cảnh báo vận hành là: hệ thống chạy trong cửa sổ một administrator** — không có đường hợp lệ nào thêm người thứ hai, và khi identity của administrator cuối cùng không còn dùng được (staff `terminated`, Account `deleted`) thì không khôi phục được — còn assignment bị thu hồi thì khôi phục được qua §3.2 khi #45/#46 xong.

Điều kiện route phải giữ khi được hiện thực: principal lấy từ credential đã xác thực, không từ body; self-assignment bị từ chối (SR-005); target không `active` bị từ chối; assignment đã còn hiệu lực là no-op có audit, không tạo hàng trùng; audit actor là actor staff thật (SR-013).

### 3.2 Emergency recovery — identity còn sống, chỉ khôi phục authority

Recovery chạy trên **một** database (`db-staff-access`) và **không** có bước ghi nào ở `account` (ADR-0023 Quyết định 3). Thứ tự:

1. **Phân giải `sub` từ `address_hash`** bằng bề mặt **đọc** của `account` — không phải A1, không phải create-or-resolve. Yêu cầu đúng **một** Account `active` và đúng **một** hàng `email_addresses` `status = 'verified'` cho `address_hash` đó.
2. **Đọc staff row theo `sub`**: đúng một hàng, status `active`.
3. **Phân giải canonical administrator role**: đúng một hàng `(kind = 'system', name = <định danh canonical>)`; khác một hàng → từ chối `role_identity_ambiguous`.
4. **Đo guard** trong critical section ghi của `staff-access` — cùng advisory lock và cùng hai câu đo canonical của §2 Bước 7 — rồi đối chiếu `mode = 'recovery'` (ADR-0022 Quyết định 3–4).
5. **Từ chối nếu target đã có assignment canonical còn hiệu lực** (`already_administrator`). Đây là một bước của thứ tự, và nó chạy **sau** phép đo nên hàng `denied` của nó mang số đo (ADR-0023 Quyết định 6). Không dùng recovery như no-op: người đó không mất quyền.
6. **Kiểm target đã từng là administrator** — có ít nhất một hàng `role_assignments` cho `staff_id` đó trỏ canonical role, **bất kể** `revoked_at` và cửa sổ hiệu lực; không có → từ chối `not_a_recovery_target` — **và** kiểm bằng chứng hai-phím (§3.3): thiếu hoặc không kiểm được → `approval_missing`; digest sai → `approval_mismatch`; bằng chứng đã dùng → `approval_reused`; ngoài thời hạn → `approval_expired` (ADR-0023 Quyết định 5). Hai phép kiểm này độc lập với bước 5: thiếu phép "đã từng", recovery cấp quyền administrator cho người chưa từng giữ role, tức một đường bổ nhiệm có approval bỏ qua permission ghi.
7. **Phép ghi duy nhất:** trong một transaction của `db-staff-access`, insert **một assignment mới** trỏ canonical role, `granted_by` NULL, rồi ghi audit `success` với số đo.

- **Không hồi sinh hàng đã thu hồi.** `revoked_at` giữ nguyên; assignment mới có `id` mới. Lịch sử thể hiện một lần thu hồi và một lần cấp lại, và trigger `role_assignment_revoke_only` chặn runtime un-revoke. Bước 5 đảm bảo một lần chạy lại sau khi commit **không** tạo hàng thứ hai.
- **Chưa từng giữ canonical administrator role → từ chối `not_a_recovery_target`.** Recovery chỉ khôi phục authority đã từng có, không cấp lần đầu; cấp lần đầu là §3.1, và khi §3.1 chưa chạy được thì fail closed.
- **Fail-closed, mỗi trường hợp một mã:** Account `suspended`/`deleted` → `account_not_active`; staff `suspended`/`terminated` → `staff_not_active`; nhiều hơn một Account hoặc nhiều hơn một hàng `email_addresses` cho `address_hash` → `address_ambiguous`; không có hàng `verified` → `address_not_verified`; role không phân giải được → `role_identity_ambiguous`; `mode` không khớp → `mode_mismatch`. Mỗi trường hợp dừng, exit khác 0, một audit row `denied` mang đúng mã đó — không bỏ trống `reason`, vì alert và điều tra dựa vào nó (ADR-0023 Quyết định 3, 6).
- **Retry:** lỗi trước commit không để lại gì; commit rồi thì chạy lại thấy assignment còn hiệu lực và từ chối. Không có trạng thái nửa vời xuyên database — đây là khác biệt cấu trúc so với bootstrap.
- **Account bị suspend sau lần đọc không tự thu hồi assignment.** Hai trục độc lập ([`domain-model.md`](../../domains/staff-access/domain-model.md) §8 invariant 8); đảo suspend là thao tác có audit của `account`, không phải một bước của recovery.

⚠️ **Ba trạng thái không khôi phục được, và đây là giới hạn đã biết, không phải sơ suất.** Staff `terminated` (terminal guard + `staff.sub` UNIQUE), Account `deleted` (tombstone, `sub` không tái phát hành, `address_hash` vẫn bị hàng `verified` cũ giữ), và địa chỉ email không còn dùng được đều cần **một identity mới** — tức một quyết định về danh tính canonical của recovery (#47). Cho tới khi có, ba trạng thái đó fail closed và không có nhánh thay thế. Không nới `UNIQUE`, không thêm trigger cho hồi sinh, không sửa trạng thái Account bằng tay.

⚠️ **Recovery chưa chạy được hôm nay**, vì hai lý do độc lập: đường này chưa hiện thực (#46), và **chưa có cơ chế bằng chứng nào được cấu hình** (#45).

### 3.3 Bằng chứng hai-phím

Hai-phím của ADR-0003 (hai người khác nhau, mỗi người có quyền quản trị danh tính hệ thống, một người thực thi, hai identity kèm thời điểm) chỉ có hiệu lực khi bằng chứng **kiểm được**. ADR-0023 Quyết định 5 chốt năm thuộc tính bắt buộc: hai danh tính **độc lập** do hệ thống tin cậy ghi nhận; gắn với **digest của đúng thao tác** (`mode`, `address_hash`, `sub`, `correlation_id`); **không tái dùng**; **kiểm tại thời điểm chạy** (CLI tự truy vấn và tự đối chiếu, không tin chuỗi từ entry point); **có thời hạn**.

- **Ba vai, và cả ba lấy danh tính từ hệ thống tin cậy:** người **thực thi**, người **phê duyệt thứ nhất**, người **phê duyệt thứ hai**. ADR-0003 chốt một trong hai người phê duyệt **là** người thực thi, nên chỉ cần hai danh tính — nhưng danh tính người thực thi cũng phải do platform hoặc hệ thống cấp bằng chứng ghi, không phải một chuỗi người chạy tự khai (ADR-0023 Quyết định 5).
- **`operator_ref` không phải bằng chứng.** Nó là metadata attribution tự khai và không thay được bất kỳ thuộc tính nào — kể cả danh tính người thực thi.
- **Thiếu bằng chứng → từ chối**, exit khác 0, không ghi dữ liệu nghiệp vụ, một audit row `denied` với đúng một mã: `approval_missing` (không kiểm được), `approval_mismatch` (digest sai), `approval_reused` (bằng chứng đã dùng cho lần chạy khác), `approval_expired` (ngoài cửa sổ thời gian). ⚠️ `approval_reused` **không** gộp vào `approval_mismatch`: một bằng chứng bị dùng lại có digest **khớp** theo đúng thiết kế, nên gộp lại là làm sự kiện tái dùng không có mã riêng. Không có chế độ "cảnh báo rồi chạy tiếp", không có flag tắt kiểm.
- ⚠️ **Chưa cơ chế nào tồn tại.** `gh api repos/ecoma-io/ecoma/environments` trả `{"total_count":0}` và không workflow nào trong `.github/workflows/` khai `environment:` (kiểm 2026-11-10). Ứng viên GH8 (GitHub environment có required reviewers, `04-platform-facts.md` §2.17) vì vậy là **khả năng chưa cấu hình**, không phải kiểm soát đang có. Cơ chế, cấu hình và cách kiểm chứng thuộc #45.
- **Không đủ hai người có quyền hệ thống?** Đó là tình huống chưa được quyết — dừng và báo, không tự hạ cấp kiểm soát (§4 câu 3).

## 4. Câu hỏi còn mở

**Bốn** câu chưa được quyết, ghi lại thay vì tự chọn (ADR-0021 Quyết định 7, ADR-0023 Quyết định 7):

1. "Quá ít administrator" được định nghĩa thế nào — 0, hay dưới một ngưỡng?
2. ~~Recovery tạo identity **mới** hay khôi phục identity đã có~~ — đã chốt một phần: recovery khôi phục authority trên identity **còn sống**, không tạo identity (ADR-0023 Quyết định 3). Phần còn mở: **danh tính thay thế lấy từ đâu** khi identity gốc không còn dùng được (staff `terminated`, Account `deleted`, email không dùng được) — canonical ở [`domain-model.md`](../../domains/staff-access/domain-model.md) §10, Issue [#47](https://github.com/ecoma-io/ecoma/issues/47).
3. Ai giữ phím thứ hai khi chính những người giữ phím là người mất quyền?
4. **Ai được giữ và ai được dùng credential vận hành?** `architecture/03-operations.md` §3.5 chỉ yêu cầu credential lấy lại được từ bản sao offline ngoài VPS; không tài liệu canonical nào chốt custody (một người hay tách đôi). Cho tới khi có, mọi lập luận "credential đã được kiểm soát nên một người là đủ" là suy diễn, không phải quyết định.

Các câu này thuộc policy vận hành/bảo mật; Issue #11 không quyết chúng. Hai quyết định modelling còn mở (#47 danh tính thay thế, [#48](https://github.com/ecoma-io/ecoma/issues/48) đường tạo Account ngoài bootstrap) nằm ở [`domain-model.md`](../../domains/staff-access/domain-model.md) §10, không nhân bản ở đây.

## 5. Operational invariants

1. Không bề mặt serving nào thực hiện **bootstrap**: tạo Account, tạo staff identity, seed role, hay gán role system administrator lần đầu (ADR-0021 Quyết định 9). Route quản trị định kỳ `POST /staff/:id/assignments` và `POST /assignments/revoke` **có** tồn tại và không phải bootstrap — chúng gán/thu hồi trên một hệ thống đã có administrator, dưới authorization riêng.
2. Procedure chỉ ghi `db-staff-access`. Bước chạm `db-account` do `account` sở hữu và thực thi; không credential `staff-access` nào chạy `SELECT`/`INSERT` trên `db-account`.
3. Không transaction xuyên database, không compensating step; chạy lại toàn bộ là phục hồi **cho tiền tố hợp lệ** — không phải cho ba trạng thái fail-closed ở Bước 9, cũng không phải cho một environment đã từng có administrator (ADR-0022 Quyết định 3).
4. Email canonical là `verified` **do** bootstrap, ghi trong cùng transaction với Account và bootstrap audit — không có endpoint sessionless nào đổi trạng thái email, và không địa chỉ nào khác được đánh dấu `verified` (ADR-0024 Quyết định 1, 2, 4).
5. Role và permission là dữ liệu sealed từ migration/seed; procedure chỉ gán.
6. Không xoá Account hợp lệ để "rollback" một bước sau thất bại.
7. Không credential migrator/owner nào trở thành Worker secret, và credential migrator không rời CI secret store.
8. Mỗi lần chạy ghi `mode`, `admins_before` và `admins_ever` (số đo, không phải input) cùng `operator_ref`; actor NULL một mình không phải attribution, và `operator_ref` là tự khai chứ không được xác minh.
9. Chạy lại sau khi đã thu hồi assignment **sẽ** tái tạo quyền nếu được phép chạy — guard chặn điều đó ở `mode = 'bootstrap'` bằng `admins_ever`, nên đường tái tạo chỉ còn là `recovery` + hai-phím (§3.2–§3.3); vì vậy bề mặt này không thuộc pipeline deploy của environment thật.
10. Guard "chưa có administrator" là số đo race-safe trong critical section ghi của `staff-access`, dưới advisory lock; `mode` bị đối chiếu với số đo và một lần chạy sai chế độ bị **từ chối**, không ghi dữ liệu (ADR-0022). Guard chỉ chặn — nó không cấp, không sửa, không hồi sinh.
11. Không credential database nào được dùng trong phiên tương tác của người vận hành; mọi bước ghi chạy qua service CLI/CI job.
12. Bổ nhiệm administrator thứ hai **không** đi qua procedure bootstrap và **không** cần hai-phím; recovery **không** tạo identity, staff hay Account, và **không** cấp quyền administrator lần đầu cho bất kỳ ai (`not_a_recovery_target`). Ba đường không thay thế nhau (ADR-0023 Quyết định 1, 2, 4).
