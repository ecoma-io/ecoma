# ADR-0033 — Hợp đồng verdict permission nội bộ và literal `invitation.create`

> 📌 Thư mục này là bounded context **Staff Access**; ADR này chốt hai thứ mà `staff-access` sở hữu và Delivery #227 cần: literal catalog của hành động phát lời mời (kèm role canonical giữ nó), và hợp đồng nội bộ trả verdict permission theo từng request.

> **Trạng thái:** Accepted · **Ngày:** 2026-11-14 · **Quyết định từ:** [ADR-0030](../../account/adr/0030-account-creation-channel-invitation.md) Quyết định 3 · [ADR-0023](./0023-administrator-lifecycle-paths.md) Quyết định 2, 6 · [ADR-0010](./0010-permission-naming-and-read-catalog.md) · [ADR-0021](./0021-first-admin-bootstrap-path.md) Quyết định 4 · **Issue:** #227

## Bối cảnh

[ADR-0030](../../account/adr/0030-account-creation-channel-invitation.md) Quyết định 3 đã chốt: phát lời mời là thao tác **permission-based**, enforce server-side **mỗi request**, verdict và audit `denied`/`success` nằm ở phía `staff-access`, còn `account` **không** tự suy quyền và **không** đọc dữ liệu assignment của `staff-access`. Ba điểm còn để ngỏ ở đó là thứ ADR này giải quyết:

1. Literal cuối cùng — ADR-0030 ghi `account.invite` là **ứng viên, chưa ràng buộc**, và buộc literal cuối cùng phải đi cùng một quyết định catalog. PR #237 (issue #227) đã merged một hằng số `invitation.create` cùng route phát lời mời, nhưng hằng đó _chưa_ có trong catalog canonical: gọi thật sẽ không bao giờ `allowed`.
2. Ai giữ literal đó — ADR-0023 Quyết định 2 đòi seed migration đi cùng quyết định role mapping.
3. Bề mặt nào trả verdict. [ADR-0009](./0009-no-internal-authorization-result-contract.md) đã chốt **không có** hợp đồng nhận kết quả authorization nội bộ, và bất kỳ contract nội bộ nào như vậy — kể cả contract nhận kết quả authorization — **phải được chốt bằng ADR mới, có bằng chứng nhu cầu cụ thể**. ADR-0030 Quyết định 3 chính là bằng chứng đó: nó đòi verdict do `staff-access` quyết, theo từng request, cho một thao tác ghi dữ liệu của bounded context khác. Không có bề mặt nào trả lời được câu hỏi "staff X có permission P ở thời điểm này không" qua các contract hiện có — `GET /staff/:id/entitlements` trả entitlement sản phẩm, `GET /permissions` trả danh mục, `GET /staff/:id/assignments` trả assignment của một staff mà caller phải tự suy quyền — nên phép suy quyền sẽ chạy ở `account`, đúng thứ ADR-0030 Quyết định 3 cấm.

## Quyết định

### 1. Literal catalog: `invitation.create`

Permission của hành động phát lời mời là **`invitation.create`** (`domain = 'invitation'`, `action = 'create'`), theo quy ước `domain.action` của [ADR-0010](./0010-permission-naming-and-read-catalog.md): nửa domain là resource noun, nửa action là verb — cùng hình với `staff.read`, `permission.read`, và với audit action `role_assignment.create` mà các route ghi hiện dùng.

- Literal `account.invite` trong ADR-0030 là placeholder **không ràng buộc** (ADR-0030 Quyết định 3 đã ghi rõ điều đó) và **không** được seed.
- Không permission bao trùm, không `admin.*`, không wildcard (ADR-0010 phương án 4, §4.4/SR-016).

### 2. Role mapping: canonical `system-administrator`

Literal này được cấp cho **đúng một** role canonical hiện có: `kind = 'system'`, `name = 'system-administrator'`, `id = 'eeb3abcb-31ef-479f-9dd1-198a9d520b1b'` ([ADR-0024](./0024-trusted-bootstrap-verified-address.md) Quyết định 5). Đây là role mà bootstrap gán cho administrator đầu tiên ([ADR-0021](./0021-first-admin-bootstrap-path.md) Quyết định 4), nên "administrator" trong ADR-0030 Quyết định 3 nghĩa đúng là người giữ role này.

Hệ quả là nội dung role canonical **không còn đúng bốn permission read**: nó là bốn permission read cộng `invitation.create`. ADR này supersede-in-part ADR-0021 Quyết định 4 ở đúng vế "tập bốn permission read của system administrator role" — bốn read vẫn là **mức tối thiểu**, nhưng không còn là toàn bộ.

- Không tạo role mới. Một role thứ hai cho một permission là thêm một định danh canonical phải quản trị, trong khi ADR-0023 Quyết định 2 đã chốt bổ nhiệm thường = gán role canonical cho staff thứ hai.
- Seed đi bằng migration **mới** `0010_permission_catalog_invitation_create.sql`, không sửa `0003`/`0007` đã apply (ADR-0010). Migration `0008` chốt nội dung role bằng một assertion "sealed set"; assertion đó phải khai báo tập mở rộng do seed migration sau thêm, nếu không role canonical không thể lớn lên mà vẫn replay được (runner không có ledger nên **mọi** file chạy lại mỗi lần apply).
- Mọi seed grant mới cho role canonical sau này phải thêm literal của nó vào mảng khai báo trong `0008` và ghi ADR tương ứng; đó là điểm review duy nhất của "role được cấp thêm quyền". Issue #44 (`role.assign`, `role.revoke`, `staff.create`) sẽ dùng migration `0011` trở đi và cùng cơ chế này.

### 3. Hợp đồng verdict permission nội bộ

`staff-access` cung cấp **một** endpoint nội bộ, `POST /authorization/verdict`, trên cùng envelope HMAC canonical (`ecoma-internal-v2`) và cùng middleware với các route management hiện có:

- Request: `{ "permission": "<domain>.<action>", "correlation_id": "<uuid>" }`. `permission` phải đúng hình `domain.action` (validator của `@ecoma-io/staff-access-contracts`); `correlation_id` là định danh xuyên service do caller sinh, dùng cho audit.
- Response `200`: `{ "verdict": "allowed" | "denied", "actor_staff_id": "<uuid>" }` — `actor_staff_id` là staff identity do chính `staff-access` phân giải từ `sub` trong envelope, không do caller khai.
- Không actor principal trong envelope ⇒ `401` (không có verdict nào để quyết). Body sai hình ⇒ `400`. Actor không phải staff `active` ⇒ `403` của middleware hiện có.
- **Audit commit trước khi trả lời**, đúng hình ADR-0023 Quyết định 6: một hàng `staff_access.authorization_audit` với `action = <permission>`, `target = actor_staff_id`, `outcome = 'denied' | 'success'`, `reason = 'permission_denied'` khi denied, `correlation_id` = giá trị caller gửi. Denied phải truy được bằng `SELECT … WHERE correlation_id = <id>` và trả về **đúng một** hàng `denied`.
- Verdict là **read-time**, không cache: tập permission hiệu lực đọc bằng đúng truy vấn đã có (`listEffectivePermissionIdsForStaff` — `revoked_at IS NULL`, cửa sổ hiệu lực, role/permission/staff `active`). Không có bảng đệm, không có node-local state.

ADR này **supersede-in-part ADR-0009** đúng ở một điểm: hợp đồng nhận kết quả authorization nội bộ này **tồn tại**, với bằng chứng nhu cầu là ADR-0030 Quyết định 3. Ngoài endpoint đó, ADR-0009 giữ nguyên nghĩa — không có contract verdict nào khác, và phía caller vẫn phải tự enforce; backend không trả "kết quả authorization" cho một thao tác mà nó tự thực hiện.

**Vị trí đặt contract:** hình dạng wire của endpoint sống ở `apps/staff-access/src/authorization-verdict.ts` (module của provider). Consumer hiện tại — `apps/account` — giữ một bản sao validate chặt trong `apps/account/server/lib/staff-access-client.ts`. Lý do chưa đưa vào `libs/staff-access-contracts`: `account` chưa khai `@ecoma-io/staff-access-contracts` trong `apps/account/package.json`, và thêm nó đòi sửa `pnpm-lock.yaml` — ngoài scope lock của #227. Đây là **gaps đã biết**, không phải quyết định rằng hai bản định nghĩa song song là trạng thái đích: khi `account` được phép phụ thuộc lib contracts của provider, bản mirror bị xoá và consumer import từ lib.

## Hệ quả

- Gọi `POST /authorization/verdict` với `invitation.create` trả `allowed` **chỉ khi** người gọi giữ role canonical; mọi trường hợp khác là `denied` kèm một hàng audit, hoặc lỗi transport mà caller phải xử lý fail-closed.
- `account` không đọc bảng nào của `staff_access` và không suy quyền từ trạng thái của mình: trạng thái không hỏi được verdict ⇒ không phát lời mời (503), không có nhánh "cho qua".
- Catalog vẫn sealed: `invitation.create` vào bằng seed migration của migrator, runtime role vẫn chỉ `SELECT` trên `permissions`/`roles`/`role_permissions` (migration `0002`, assertion `0008`).
- ADR-0023 Quyết định 6 trở thành bắt buộc có thật cho ít nhất một đường: hàng `denied` của phép kiểm có mặt và kiểm được bằng `correlation_id`.
- #44 thêm literal ghi của nó bằng `0011` trở đi và cấp cho cùng role canonical; cơ chế khai báo tập mở rộng ở `0008` là điểm phải cập nhật.

## Cross-reference

- **SR/T-**: SR-002, SR-003, SR-013, SR-018, SR-020 · invariant 7, 10 ([`../../../architecture/01-architecture.md`](../../../architecture/01-architecture.md) §9).
- **Thiết kế:** [`../../account/adr/0030-account-creation-channel-invitation.md`](../../account/adr/0030-account-creation-channel-invitation.md) Quyết định 3 · [`./0023-administrator-lifecycle-paths.md`](./0023-administrator-lifecycle-paths.md) Quyết định 2, 6 · [`./0009-no-internal-authorization-result-contract.md`](./0009-no-internal-authorization-result-contract.md) (supersede-in-part) · [`./0010-permission-naming-and-read-catalog.md`](./0010-permission-naming-and-read-catalog.md).
- **Implementation:** `apps/staff-access/db/migrations/0010_permission_catalog_invitation_create.sql` · `apps/staff-access/src/authorization-verdict.ts` · `apps/staff-access/src/routes.ts` · `apps/account/server/lib/authorization.ts` · `apps/account/server/lib/staff-access-client.ts` · Issue #227.
