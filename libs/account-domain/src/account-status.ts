/**
 * Vòng đời status của một account.
 *
 * ⚠️ **`deleted` là tombstone, trạng thái KẾT THÚC.** Khi account bị xoá, `sub` được
 * giữ lại và **không bao giờ được giải phóng** (invariant 7,
 * `docs/applications/account/01-architecture.md` §9). Giữ tombstone là để token cũ đã
 * cấp không resolve nhầm sang một người khác — nếu `sub` biến mất hẳn, một
 * identifier đã lỡ cấp sẽ rơi về "không tồn tại" và có thể được tái gán.
 *
 * Vì vậy không có hàm nào trong module này chuyển `deleted` sang trạng thái khác.
 */

/** Tập trạng thái hợp lệ, dùng làm nguồn cho type union và type guard. */
export const ACCOUNT_STATUS = {
  Active: 'active',
  Suspended: 'suspended',
  Deleted: 'deleted',
} as const;

/** Union của các trạng thái account. */
export type AccountStatus = (typeof ACCOUNT_STATUS)[keyof typeof ACCOUNT_STATUS];

/** Mảng trạng thái, thứ tự không mang ý nghĩa nghiệp vụ. */
export const ACCOUNT_STATUSES = [
  ACCOUNT_STATUS.Active,
  ACCOUNT_STATUS.Suspended,
  ACCOUNT_STATUS.Deleted,
] as const;

/** Type guard cho `AccountStatus`. */
export function isAccountStatus(value: unknown): value is AccountStatus {
  return typeof value === 'string' && (ACCOUNT_STATUSES as readonly string[]).includes(value);
}

/**
 * Trạng thái kết thúc — không quay lại được.
 *
 * Chỉ `deleted` là terminal: `suspended` còn đường quay lại `active`.
 */
export function isTerminalStatus(status: AccountStatus): boolean {
  return status === ACCOUNT_STATUS.Deleted;
}

/**
 * Account đã bị xoá hay chưa — tức là đã thành tombstone.
 *
 * Đây là hàm mà các invariant khác cần: tombstone giữ lâu dài là ngoại lệ DUY NHẤT
 * được phép vĩnh viễn, còn mọi entity khác phải bị xoá hoặc anonymize.
 */
export function isTombstone(status: AccountStatus): boolean {
  return isTerminalStatus(status);
}
