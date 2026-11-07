/**
 * Định danh test của suite — MỘT nguồn, mọi spec import từ đây.
 *
 * ## Vì sao MỖI spec file một định danh riêng
 *
 * Playwright chạy spec files SONG SONG (mỗi file một worker, `workers: 2`).
 * Định danh dùng chung cho mọi file tạo một va chạm thật đã đỏ: hai worker
 * cùng đi path `granted` (grant `oauth_grants` đã tồn tại từ run trước) và
 * cùng quyết consent cho một identity — INSERT grant trùng `(sub, client_id)`
 * văng duplicate key trên partial unique index
 * `oauth_grants_active_sub_client_idx` ⇒ 503 ở consent. Email OTP cũng dễ
 * cross-match khi hai worker poll cùng hộp thư sink. Định danh per-file tách
 * bạch cả grant, cả mail sink.
 *
 * ## Rerun-safe
 *
 * Suite khác có thể chạy SONG SONG trên cùng một stack. Mọi INSERT seed mang
 * `ON CONFLICT DO NOTHING` nên rerun là cùng một hàng. Và grant vẫn tồn tại
 * qua các run — lần chạy sau đi path `granted` (không consent screen):
 * `performBrowserLogin` chấp nhận cả hai hình dạng (có và không consent).
 *
 * ⚠️ Định dạng `sub` bị DB chặn ở HAI đầu:
 * - `account.users.sub` — reference của `backoffice.staff` (không FK, nhưng
 *   cùng hình dạng); seed của suite khác đã dùng format `sub_<32 base32>`.
 * - `backoffice.bff_sessions.account_sub` — CHECK
 *   `^sub_[a-z2-7]{32}$` (migration `0006`): sub không đúng định dạng là
 *   INSERT phiên fail ngay ở callback, tức login chết giữa chừng.
 * - `backoffice.role_assignments.created_by_sub` — guard
 *   `role_assignments_no_self_elevation` đòi đúng regex đó + khác `staff_sub`.
 *
 * Mỗi hằng là chuỗi `sub_` + 32 ký tự base32 viết thường (RFC 4648, không
 * padding) — cùng hình dạng được seed ở `account.users`,
 * `backoffice.staff`, `role_assignments.created_by_sub` để mọi khớp là khớp
 * theo cấu trúc, không phải trùng hợp.
 */

/** Định danh của `authenticated-access.spec.ts` (login + đọc `/api/**`). */
export const AUTH_IDENTITY = {
  sub: 'sub_aclfe2euserbseaaaaaaaaaaaaaaaaaa',
  email: 'backoffice-acl-e2e-auth@local.test',
} as const;

/** Định danh của `logout.spec.ts` — tách để logout không giết phiên của file khác. */
export const LOGOUT_IDENTITY = {
  sub: 'sub_aclfe2elgoubsaaaaaaaaaaaaaaaaaaa',
  email: 'backoffice-acl-e2e-logout@local.test',
} as const;

/** Định danh của `permission-enforcement.spec.ts` — chủ nhân các seed staff/role. */
export const PERMISSION_IDENTITY = {
  sub: 'sub_aclfe2epermstaaaaaaaaaaaaaaaaaaa',
  email: 'backoffice-acl-e2e-permission@local.test',
} as const;

/**
 * Actor khai báo trên `role_assignments.created_by_sub` — PHẢI khác sub của
 * staff (guard self-elevation của migration `0004` chặn
 * `staff_sub = created_by_sub` khi INSERT bằng runtime role; suite seed bằng
 * `ecoma_local` là superuser nên guard không kích hoạt, nhưng giữ bất
 * invariant này là giữ seed đúng hình dạng mà một lần seed lại bằng runtime
 * role cũng sống sót).
 */
export const SEED_ACTOR_SUB = 'sub_aclfe2eactorseaaaaaaaaaaaaaaaaaa';

/** Role id test — custom role (không prefix `sys_`), gán `staff.read`. */
export const TEST_ROLE_ID = 'acl-e2e-role';

/**
 * Id một role thứ hai KHÔNG có permission nào — dùng cho khẳng định phụ:
 * role trống cung cấp `permissions = []` ⇒ `can()` deny
 * (`permission_not_granted`), độc lập với số assignment.
 */
export const TEST_EMPTY_ROLE_ID = 'acl-e2e-role-empty';

/**
 * Nhãn sub-authorize-URL của suite — không phải secret, chỉ để assertion
 * `client_id` trên redirect login.
 */
export const EXPECTED_CLIENT_ID = 'ecoma-backoffice-local';

/**
 * Kỳ vọng middleware authn trả cho caller chưa đăng nhập — ADR-0011 §1,
 * đã verify trong `apps/backoffice/server/middleware/authn.ts` (PR #358).
 */
export const UNAUTHENTICATED_STATUS = 401;
