# ADR-0024 — Trusted offline bootstrap: địa chỉ canonical `verified`, đăng nhập passwordless vẫn bắt buộc

> 📌 Thư mục này là bounded context **Staff Access** (xem [`../README.md`](../README.md) §4), vì quyết định này đi cùng đường bootstrap administrator. Nó chốt **trạng thái email của Account đầu tiên**, **cơ chế chứng minh kiểm soát hộp thư**, và **định danh canonical của system administrator role**. Nó supersede-in-part [ADR-0020](./0020-bootstrap-seed-contract.md) Quyết định 11 (vế email `pending`) và [ADR-0021](./0021-first-admin-bootstrap-path.md) Quyết định 3 cùng phần liên quan của Quyết định 2; các phần còn lại của cả hai ADR giữ nguyên hiệu lực.

> **Trạng thái:** Accepted · **Ngày:** 2026-11-10 · **Quyết định từ:** [ADR-0020](./0020-bootstrap-seed-contract.md) Quyết định 11 · [ADR-0021](./0021-first-admin-bootstrap-path.md) Quyết định 2, 3, 4, 6 · [ADR-0022](./0022-measured-first-admin-guard.md) · [ADR-0023](./0023-administrator-lifecycle-paths.md) · **Issue:** #17

## Bối cảnh

ADR-0021 Quyết định 3 đặt email khởi tạo ở `pending` và yêu cầu một **đường verify không cần session** dùng purpose `verify_email` để đưa nó sang `verified`. Hai hệ quả chưa từng được chấp nhận như một quyết định độc lập:

1. **Đường đó tạo một bề mặt xác thực thứ hai không có session và không có danh tính.** Nó phải nhận địa chỉ trần, tự tra `sub`, tự cấp mã và tự đổi trạng thái email. Mọi ràng buộc trong ADR-0021 Quyết định 3 (input duy nhất là địa chỉ, phản hồi đồng nhất, kiểm lại trạng thái tại thời điểm verify) là hệ quả của việc mở bề mặt đó, không phải của bootstrap.
2. **Nó không giải quyết được vấn đề nó được tạo ra để giải quyết.** Trên một environment mới, không có template mail, không có cấu hình gửi mail cho purpose `verify_email`, và không có ai đã đăng nhập để nhận mã. Trạng thái cuối là một Account `active` với email `pending`, tức một Superadmin **không thể đăng nhập** — bootstrap "thành công" mà không ai vào được.

Đồng thời ADR-0021 Quyết định 4 và ADR-0022 Quyết định 4 yêu cầu một **định danh canonical** cho system administrator role để guard đo được, nhưng chưa tài liệu nào chốt literal của `roles.name`; để trống thì mỗi component sẽ tự chọn một chuỗi.

Quyết định của Issue #17: trên một environment mới provision, coi bootstrap là **thao tác offline được tin cậy**, ghi địa chỉ canonical ở trạng thái `verified`, và vẫn bắt buộc Superadmin đăng nhập bằng đúng luồng passwordless OTP hiện có.

## Phương án

| #   | Phương án                                                                        | Đánh giá                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Bootstrap offline ghi `verified`; đăng nhập passwordless vẫn bắt buộc**        | Chấp nhận — không mở bề mặt xác thực thứ hai; "kiểm soát hộp thư" được chứng minh bằng chính lần đăng nhập OTP thật; bootstrapping là thao tác provisioning có kiểm soát vận hành, không phải một đường tự phục vụ.                                  |
| 2   | Giữ ADR-0021 Quyết định 3 (email `pending` + đường `verify_email` không session) | Loại — thêm một bề mặt xác thực không session, không danh tính, cho một trường hợp chỉ xảy ra một lần trên mỗi environment; đồng thời vẫn phụ thuộc mail template chưa tồn tại, nên không đóng được vòng lặp bootstrap.                              |
| 3   | Bootstrap ghi `verified` **và** phát session/token ngay                          | Loại — bootstrap là thao tác ghi database, không phải một principal. Phát session từ nó tạo một đường đăng nhập không đi qua OTP, tức đúng thứ ADR-0021 Quyết định 9 cấm, và làm "kiểm soát hộp thư" không còn được chứng minh ở đâu.                |
| 4   | Cho phép cấu hình environment chọn địa chỉ bootstrap và trạng thái email         | Loại — danh tính canonical phải là hằng trong code (ADR-0021 Quyết định 1). Cấu hình chỉ **assert** giá trị; đổi được địa chỉ là mở đường tạo administrator mới không qua quyết định nào, và đổi được trạng thái là biến fail-closed thành cấu hình. |

## Quyết định

### 1. Bootstrap offline là thao tác được tin cậy và ghi địa chỉ canonical `verified`

Bước A1 ghi `account.users` và `account.email_addresses` trong **một** transaction, với `status = 'verified'`, `verified_at = database now()`, `is_sign_in = true`. Đây là **trusted provisioning assertion**: procedure khai rằng địa chỉ canonical đã được cấp phát cho tổ chức và nằm dưới kiểm soát của tổ chức trước khi bootstrap chạy. Nó **không** phải bằng chứng OTP, và tài liệu không được mô tả nó như vậy.

Ba điều kiện tiên quyết, đều là điều kiện vận hành chứ không phải kiểm tra tự động:

- **Environment mới provision.** Bootstrap chỉ hợp lệ khi chưa từng có administrator (ADR-0022 Quyết định 3: `admins_before = 0` **và** `admins_ever = 0`).
- **Hộp thư canonical đã thuộc tổ chức.** Địa chỉ `superadmin@ecoma.io` phải được cấp phát và có MFA **trước** khi chạy; người đầu tiên đăng nhập được bằng địa chỉ đó chính là người nhận quyền quản trị.
- **Bề mặt offline.** Chạy bằng credential admin/migrator của từng database trên admin path (ADR-0020 Quyết định 3(b), ADR-0021 Quyết định 5). Không route, không flag, không code path nào trong Worker bundle.

### 2. Đăng nhập passwordless vẫn bắt buộc, và bootstrap không phát hành session

- Bootstrap **không** tạo session, token, cookie hay handoff; nó không chạy trong serving path và không có credential của người dùng.
- Superadmin chứng minh kiểm soát hộp thư bằng **chính** luồng hiện có: `POST /api/auth/challenge` → `POST /api/auth/verify` với purpose `login`. Cổng đăng nhập không đổi (`email_addresses.status = 'verified'` + `users.status = 'active'`, `lookupVerifiedAddress`, `resolveOtpTarget`).
- **Không có endpoint `verify_email` không cần session, không purpose mới, không template bắt buộc cho bootstrap.** Yêu cầu đó của ADR-0021 Quyết định 3 bị rút lại.
- Luồng email thường **không** bị nới: địa chỉ do người dùng tự thêm vẫn `pending` và vẫn phải verify trong Account context đã đăng nhập. Một hàng `pending` không bao giờ nhận OTP `login` và không bao giờ nhận session của Account khác.

### 3. Giả định tin cậy phải được ghi rõ, cùng các kiểm soát bù

Bootstrap dựa trên một giả định mà database **không** kiểm chứng được: người chạy giữ credential vận hành và hành động thay mặt tổ chức. Vì vậy:

- `operator_ref` là **attribution tự khai**, không phải danh tính đã xác minh. Ghi được một ticket id không chứng minh người chạy sở hữu ticket đó.
- Kiểm soát bù nằm ngoài database: custody credential vận hành, approval/protection rule của CI (khi tồn tại — hiện chưa có environment nào được cấu hình, [#45](https://github.com/ecoma-io/ecoma/issues/45)), audit append-only ở hai database với cùng `correlation_id`, và khả năng thu hồi assignment.
- Mọi tuyên bố trong runbook và PR phải đọc theo nghĩa này: "procedure đã chạy bằng credential vận hành, và người chạy **khai** là X".

### 4. Quy tắc sở hữu email không đổi; `verified` chỉ được ghi cho đúng địa chỉ canonical

- Bootstrap chỉ đánh dấu `verified` cho **một** địa chỉ: hằng canonical trong code. Không địa chỉ nào khác, không theo cấu hình environment (cấu hình chỉ assert giá trị; input khác hằng → từ chối).
- Partial UNIQUE `(address_hash) WHERE status = 'verified'` vẫn là trọng tài duy nhất cho "một địa chỉ thuộc một Account".
- **Không bao giờ suy quyền từ địa chỉ một mình.** Trên lần chạy lại, A1 chỉ được nhận lại một Account đã `verified` khi đồng thời: địa chỉ khớp hằng canonical, Account `active`, đúng một `sub` sở hữu hàng đó, và có **bootstrap audit event cùng transaction** của lần bootstrap trước chứng minh Account đó do bootstrap tạo. Thiếu bất kỳ điều kiện nào → fail-closed, không chọn hàng, không "đoán chủ".
- Mọi trạng thái khác vẫn fail-closed như ADR-0021 Quyết định 2: nhiều `sub`, Account `suspended`/`deleted`, Account còn địa chỉ `verified` khác, nhiều hơn một hàng còn sống cho cùng `address_hash`, hoặc hàng `revoked` cho địa chỉ canonical (dấu hiệu đã có người từng chạm địa chỉ → dừng và báo).

### 5. Định danh canonical của system administrator role

- Role canonical là **đúng một** hàng `staff_access.roles` với `kind = 'system'` và `name = 'system-administrator'`.
- `name` là **định danh máy đọc**, không phải nhãn hiển thị: chữ thường, kebab-case, không dấu, không phụ thuộc ngôn ngữ. Nhãn hiển thị là việc của UI.
- Schema bảo đảm bằng UNIQUE `(kind, name)`; seed dùng `id` cố định để idempotent. Định danh không phân giải được thành đúng một hàng → mọi đường ghi canonical role **từ chối** (`role_identity_ambiguous`), không đoán.
- Nội dung role là bốn permission read: `staff.read`, `role.read`, `permission.read`, `audit.read`. Role là dữ liệu sealed trong seed migration (ADR-0020 Quyết định 10); procedure chỉ gán.

### 6. Audit bootstrap là bắt buộc và nằm trong cùng transaction

- Phía `account`: một `security_events` row với `type = 'bootstrap_account_provisioned'`, `outcome = 'success'`, `subject_sub` = `sub` vừa tạo, ghi trong **cùng** transaction với `users` + `email_addresses`. Metadata chứa `address_hash` (không bao giờ địa chỉ trần), `correlation_id`, `mode = 'bootstrap'`, `verification_source = 'trusted_bootstrap'`, `operator_ref`.
- Writer của đường này nhận **transaction client** và **ném** khi insert hỏng; không tái dùng helper best-effort của serving path (`appendSecurityEvent` không nhận transaction và không bao giờ ném).
- Phía `staff-access`: giữ nguyên ADR-0021 Quyết định 6 — một row cho mỗi bước ghi, cùng transaction với bước đó, cùng `correlation_id`; row `denied` của guard commit ngoài transaction bị abort (ADR-0022 Quyết định 3, ADR-0023 Quyết định 6).

## Quan hệ supersede

- **ADR-0020 Quyết định 11** — superseded in part: vế "email ở trạng thái `pending`, không đặt `verified_at`, không đặt `is_sign_in`" và vế "verify email là hành vi của Superadmin khi chứng minh kiểm soát hộp thư" **không còn hiệu lực**. Vế "không cần hai-phím cho lần đầu", danh tính canonical `superadmin@ecoma.io`, điều kiện hộp thư do tổ chức kiểm soát, và toàn bộ phần còn lại của Quyết định 11 giữ nguyên. Bảng dữ liệu khởi tạo của Quyết định 13 đọc "hàng email `verified`" thay cho "hàng email `pending`".
- **ADR-0021 Quyết định 3** — superseded in whole: đường verify không cần session, purpose `verify_email` cho bootstrap, và vòng đời đăng nhập đầu tiên 13 dòng đều bị rút lại. Lý do gốc của nó ("cần một đường đưa `pending` → `verified` không session") biến mất khi email không còn `pending`.
- **ADR-0021 Quyết định 2** — superseded in part: các vế coi "có hàng `verified`" và nhánh idempotent "chỉ hàng `pending`" là fail-closed thuần tuý được thay bằng Quyết định 4 ở trên (một hàng `verified` do bootstrap trước tạo, chứng minh được, là trạng thái hội tụ; mọi hàng `verified` khác vẫn fail-closed). **Khoá advisory cũng bị thu hẹp:** khoá **theo `address_hash`** được thay bằng **một khoá hằng toàn cục**. Lý do gốc của khoá-theo-địa-chỉ ("hai địa chỉ khác nhau không chặn nhau") không còn áp dụng khi Quyết định 4 chỉ cho phép đúng một địa chỉ canonical, nên mọi input hợp lệ đều ánh xạ về cùng một khoá; khoá hằng còn không phụ thuộc dữ liệu đầu vào. Các vế còn lại giữ nguyên: advisory lock nằm **trong** transaction ghi, chuẩn hoá bằng đúng hàm của luồng OTP, enumeration fail-closed, hàng `revoked` là dấu hiệu dừng, "chạy lại với input khác là ngoài hợp đồng".
- **ADR-0021 Quyết định 5, 6, 7; ADR-0022; ADR-0023** — giữ nguyên. Thứ tự A1 → A2 → S1 → S2 → S3, guard đo được, và ba đường vòng đời administrator không đổi.
- **ADR-0021 Quyết định 4** — bổ sung, không supersede: literal `system-administrator` được chốt ở Quyết định 5 của ADR này; phần nội dung role và yêu cầu UNIQUE `(kind, name)` giữ nguyên.

## Hệ quả

- Không cần migration mới ở `db-account`: `security_events.type` là text tự do, và trạng thái email đã có trong `0005`.
- `db-staff-access` cần migration mới: `audit.read` vào catalog, UNIQUE `(kind, name)` trên `roles`, partial unique `(staff_id, role_id) WHERE revoked_at IS NULL` trên `role_assignments`, và seed role canonical cùng `role_permissions`.
- Một lần chạy lại sau khi S2 đã commit **không** phải no-op: guard từ chối (`mode_mismatch`), ghi một audit `denied`, exit khác 0. Đó là hành vi đúng — bootstrap đã hoàn tất, đường còn lại là đăng nhập OTP.
- Bootstrap không còn phụ thuộc template mail `verify_email`. Phụ thuộc duy nhất còn lại cho lần đăng nhập đầu là luồng OTP `login` và cấu hình gửi mail của nó — đã tồn tại trong code.
- Rủi ro được chấp nhận: trên một environment mà hộp thư canonical chưa thuộc tổ chức, người kiểm soát hộp thư đó nhận quyền quản trị khi đăng nhập lần đầu. Kiểm soát bù là quy trình cấp phát hộp thư trước bootstrap và audit/custody credential; không có kiểm tra kỹ thuật nào thay được chúng.

## Cross-reference

- **System:** [`architecture/02-delivery.md`](../../../architecture/02-delivery.md) §3.2 (bước 3–4) · [`architecture/04-platform-facts.md`](../../../architecture/04-platform-facts.md) HD6.
- **Context:** [ADR-0020](./0020-bootstrap-seed-contract.md) · [ADR-0021](./0021-first-admin-bootstrap-path.md) · [ADR-0022](./0022-measured-first-admin-guard.md) · [ADR-0023](./0023-administrator-lifecycle-paths.md) · [`../domain-model.md`](../domain-model.md).
- **Application:** [`applications/staff-access/03-operations.md`](../../../applications/staff-access/03-operations.md) · [`applications/account/03-operations.md`](../../../applications/account/03-operations.md).
- **Hiện thực:** #17.
- **Index:** [`./README.md`](./README.md).
