/**
 * `@ecoma-io/staff-access-domain` — value object, invariant vong doi va
 * constraint thuan cua bounded context `staff-access` (staff directory,
 * permission catalog, role, staff-role assignment, entitlement, authorization
 * audit) — phan trach nghiem da supersede tu A21 sang context nay theo
 * ADR-0013 (`docs/domains/staff-access/adr/0013-staff-access-ownership-transfer.md`).
 *
 * Thu vien nay **khong** import Nx project khac (ca `type:contracts` cung
 * khong — module boundary cam `type:domain` phu thuoc contracts layer), **khong**
 * SQL, **khong** Node builtin va **khong** I/O. Moi tham so thoi gian do caller
 * truyen vao; domain khong doc dong ho.
 *
 * ## Rang buoc chua chot — khong am tham chot trong lib nay
 *
 * - **Tap nhan staff status la DE XUAT** (`01-architecture.md` §4.2): lib ghim
 *   su tach truc va terminal cua `terminated`, khong chot tung nhan.
 * - **Khong co permission cu the nao duoc phat minh o day**: noi dung catalog
 *   la seed migration co review; lib chi dinh nghia hinh dang danh dau.
 * - **Khong co noi dung role system nao o day**: role contents phai xuat phat
 *   tu catalog thuc te (`01` §4.4, ADR-0004).
 * - **Khong co mechanism outbox/transport nao o day**: delivery Phase 2
 *   (ADR-0002/P2.5) chua chot; revision o day chi la so thu tu tang don dieu.
 */

export {
  STAFF_ACCESS_STAFF_STATUS,
  STAFF_ACCESS_STAFF_STATUSES,
  isStaffAccessStaffStatus,
  isTerminalStaffAccessStatus,
  type StaffAccessStaffStatus,
} from './staff-status';
export {
  STAFF_ACCESS_DOMAIN_ERROR_MESSAGES,
  isStaffAccessDomainError,
  staffAccessDomainError,
  type StaffAccessDomainError,
  type StaffAccessDomainErrorCode,
} from './errors';
