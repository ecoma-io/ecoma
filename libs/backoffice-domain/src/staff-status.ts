/**
 * Trục **staff status** — trạng thái membership của một staff member trong staff
 * directory của `backoffice`.
 *
 * Source of truth:
 * - `docs/domains/staff-access/domain-model.md` §3 (trục tách đôi) và §4.2
 *   (staff status là trục KHÁC account status).
 * - `docs/architecture/01-architecture.md` invariant 8 và invariant 31.
 *
 * ⚠️ **Hai trục độc lập, không suy ra nhau:**
 * - `account.status` (`active` | `suspended` | `deleted`) do `account` sở hữu
 *   (`docs/applications/account/01-architecture.md`). Suspend account ở `account`
 *   KHÔNG tự viết lại staff status ở `backoffice` — không có đường ghi ngầm
 *   nào giữa hai bên (`01` §4.2).
 * - `terminated` ở `backoffice` KHÔNG tự suspend account.
 *
 * ⚠️ **Tập nhãn ba giá trị là ĐỀ XUẤT, chưa chốt** (`01` §4.2: "Tập nhãn này
 * chưa chốt; điều đã chốt là nó là trục riêng"). Điều ghim ở đây là **sự tách
 * trục** và **`terminated` là trạng thái cuối**, không phải từng chữ.
 *
 * `terminated` là trạng thái KẾT THÚC của membership: khôi phục membership
 * sau khi terminated là **thao tác mới có audit** (`01` §4.2: "khôi phục
 * membership là thao tác mới có audit, không phải chuyển lại về active im
 * lặng"), không phải một transition trong module này. Không có hàm nào chuyển
 * `terminated` sang trạng thái khác — cùng hình thức với tombstone của
 * `account-domain/src/account-status.ts`.
 */

/** Tập trạng thái hợp lệ, dùng làm nguồn cho union và type guard. */
export const BACKOFFICE_STAFF_STATUS = {
  Active: 'active',
  Suspended: 'suspended',
  Terminated: 'terminated',
} as const;

/** Union của staff status. */
export type BackofficeStaffStatus =
  (typeof BACKOFFICE_STAFF_STATUS)[keyof typeof BACKOFFICE_STAFF_STATUS];

/** Mảng trạng thái, thứ tự không mang ý nghĩa nghiệp vụ. */
export const BACKOFFICE_STAFF_STATUSES = [
  BACKOFFICE_STAFF_STATUS.Active,
  BACKOFFICE_STAFF_STATUS.Suspended,
  BACKOFFICE_STAFF_STATUS.Terminated,
] as const;

/** Type guard cho `BackofficeStaffStatus` — dữ liệu đọc từ DB/contract qua hàm này. */
export function isBackofficeStaffStatus(value: unknown): value is BackofficeStaffStatus {
  return (
    typeof value === 'string' && (BACKOFFICE_STAFF_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Trạng thái kết thúc của membership — chỉ `terminated` là terminal.
 *
 * `suspended` còn đường quay lại `active`; `terminated` không có transition
 * nào đi ra ở tầng domain. Khối `CHECK`/trigger của migration
 * (`apps/backoffice/db/migrations/0001_*.sql`) và tầng application đều neo vào
 * cùng tập này.
 */
export function isTerminalStaffStatus(status: BackofficeStaffStatus): boolean {
  return status === BACKOFFICE_STAFF_STATUS.Terminated;
}
