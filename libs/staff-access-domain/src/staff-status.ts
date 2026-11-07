/**
 * Truc **staff status** — trang thai membership cua mot staff member trong
 * staff directory cua bounded context `staff-access`.
 *
 * Source of truth:
 * - `docs/domains/staff-access/domain-model.md` §3.2 (truc tach doi) va §8
 *   invariant 8 (staff status va account status la hai truc doc lap).
 * - `docs/domains/staff-access/adr/0013-staff-access-ownership-transfer.md` —
 *   ownership `staff-access`; tru trang thai khong doi theo ownership.
 *
 * ⚠️ **Hai truc doc lap, khong suy ra nhau:**
 * - `account.status` (`active` | `suspended` | `deleted`) do `account` so huu
 *   (`docs/applications/account/01-architecture.md`). Suspend/delete account o
 *   `account` KHONG tu viet lai staff status o day — khong co duong ghi ngam
 *   nao giua hai ben (`01` §4.2).
 * - `terminated` o staff-access KHONG tu suspend account.
 *
 * ⚠️ **Tap nhan ba gia tri la DE XUAT, chua chot** (`01` §4.2: "Tap nhan nay
 * chua chot; dieu da chot la no la truc rieng"). Dieu ghim o day la **su tach
 * truc** va **`terminated` la trang thai cuoi**, khong phai tung chu. Wire
 * type tuong ung nam o `@ecoma-io/staff-access-contracts` (`StaffStatus`) —
 * lib nay khai bao lai cung tap nhan vi `type:domain` khong duoc import
 * `type:contracts` (module boundary cua `.oxlintrc.json`); hai ben doi nhau
 * bang test ghim (xem `staff-status.spec.ts`).
 *
 * `terminated` la trang thai KET THUC cua membership: khoi phuc membership
 * sau khi terminated la **thao tac moi co audit** (`01` §4.2), khong phai mot
 * transition trong module nay. Khong co ham nao chuyen `terminated` sang trang
 * thai khac — cung hinh thuc voi tombstone cua
 * `libs/account-domain/src/account-status.ts` va
 * `libs/backoffice-domain/src/staff-status.ts`.
 */

/** Tap trang thai hop le, dung lam nguon cho union va type guard. */
export const STAFF_ACCESS_STAFF_STATUS = {
  Active: 'active',
  Suspended: 'suspended',
  Terminated: 'terminated',
} as const;

/** Union cua trang thai staff. */
export type StaffAccessStaffStatus =
  (typeof STAFF_ACCESS_STAFF_STATUS)[keyof typeof STAFF_ACCESS_STAFF_STATUS];

/** Mang trang thai, thu tu khong mang y nghia nghiep vu. */
export const STAFF_ACCESS_STAFF_STATUSES = [
  STAFF_ACCESS_STAFF_STATUS.Active,
  STAFF_ACCESS_STAFF_STATUS.Suspended,
  STAFF_ACCESS_STAFF_STATUS.Terminated,
] as const;

/** Type guard cho `StaffAccessStaffStatus` — du lieu doc tu DB/contract qua ham nay. */
export function isStaffAccessStaffStatus(value: unknown): value is StaffAccessStaffStatus {
  return (
    typeof value === 'string' && (STAFF_ACCESS_STAFF_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Trang thai ket thuc cua membership — chi `terminated` la terminal.
 *
 * `suspended` con duong quay lai `active`; `terminated` khong co transition
 * nao di ra o tang domain. CHECK/trigger cua migration
 * (`apps/staff-access/db/migrations/0001_staff_access_domain.sql`) va tang
 * application deu neo vao cung tap nay.
 */
export function isTerminalStaffAccessStatus(status: StaffAccessStaffStatus): boolean {
  return status === STAFF_ACCESS_STAFF_STATUS.Terminated;
}
