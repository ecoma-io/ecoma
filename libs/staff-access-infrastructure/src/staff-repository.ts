import type { StaffAccessQueryable } from './postgres';

/**
 * Repository cua bang `staff_access.staff` — sổ staff của `db-staff-access`.
 *
 * ⚠️ **SQL là bản chép của schema, schema là nơi khai ràng buộc** (cùng
 * nguyên tắc với `authorization-code-cas.ts` của auth-infrastructure): tên
 * cột và tên constraint ở đây khớp đúng
 * `apps/staff-access/db/migrations/0001_staff_access_domain.sql` — lệch tên chỉ
 * lộ ra khi chạy với schema thật, nên không có hằng "tự chế" nào ở module này.
 *
 * Milestone A chỉ expose đường **read** (list/get theo id/sub) và đường
 * **insert** cho seed/bootstrap — mọi thao tác còn lại (suspend, terminate,
 * update display_name) thuộc Milestone B cùng tầng application chưa tồn tại ở
 * milestone này. Trigger `staff_identity_and_terminal_guard` của schema vẫn là
 * lớp enforce thật: repo không lặp lại policy đó ở JS.
 */

/** Một hàng staff như schema trả về. */
export interface StaffRow {
  readonly id: string;
  readonly sub: string;
  readonly display_name: string;
  /** Nhãn trạng thái — tập nhãn ĐỀ XUẤT của `01-architecture.md` §4.2 (chưa chốt). */
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Lấy một staff member theo định danh nội bộ của directory. */
export async function getStaffById(db: StaffAccessQueryable, id: string): Promise<StaffRow | null> {
  const rows = await db.unsafe<StaffRow>(
    `SELECT id, sub, display_name, status, created_at, updated_at
       FROM staff_access.staff
      WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Lấy một staff member theo Account ID (`sub`) — đường ánh xạ token → staff (ADR-0012 §4). */
export async function getStaffBySub(
  db: StaffAccessQueryable,
  sub: string,
): Promise<StaffRow | null> {
  const rows = await db.unsafe<StaffRow>(
    `SELECT id, sub, display_name, status, created_at, updated_at
       FROM staff_access.staff
      WHERE sub = $1`,
    [sub],
  );
  return rows[0] ?? null;
}

/**
 * Liệt kê staff theo cursor keyset `(created_at, id)` — đúng hình phân trang
 * cursor của contract list (`StaffListResponse.next_cursor`). Không listing
 * không giới hạn: `limit` là tham số bắt buộc do caller kiểm (contract cap
 * 100), repo không tự cap.
 */
export async function listStaff(
  db: StaffAccessQueryable,
  options: {
    readonly limit: number;
    readonly cursor?: { readonly createdAt: string; readonly id: string };
  },
): Promise<readonly StaffRow[]> {
  return db.unsafe<StaffRow>(
    `SELECT id, sub, display_name, status, created_at, updated_at
       FROM staff_access.staff
      WHERE ($1::timestamptz IS NULL OR (created_at, id) > ($1::timestamptz, $2::uuid))
      ORDER BY created_at, id
      LIMIT $3`,
    [options.cursor?.createdAt ?? null, options.cursor?.id ?? null, options.limit],
  );
}

/**
 * Tạo staff entry — đường server-side linkage (ADR-0012 §4): `id` và `sub`
 * đều do tầng application sinh/verify trước khi vào repo; schema giữ CHECK
 * định dạng `sub` và UNIQUE `sub`.
 */
export async function insertStaff(
  db: StaffAccessQueryable,
  entry: {
    readonly id: string;
    readonly sub: string;
    readonly displayName: string;
  },
): Promise<void> {
  await db.unsafe(
    `INSERT INTO staff_access.staff (id, sub, display_name)
     VALUES ($1, $2, $3)`,
    [entry.id, entry.sub, entry.displayName],
  );
}
