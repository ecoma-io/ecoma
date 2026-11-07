/**
 * `GET /api/staff` — danh sách staff directory, qua enforcement của
 * workstream B (issue #99); issue #325 thêm merge `displayName`.
 *
 * ## Thay đổi P5.1 (issue #475)
 *
 * Staff directory giờ đọc từ Staff Access management API
 * (`GET /staff` qua binding `STAFF_ACCESS_SERVICE` + envelope HMAC
 * `AUTH_INTERNAL_SECRET`) thay vì đọc `db-backoffice` trực tiếp qua
 * `listStaff`. `backoffice` chỉ còn composition/UI + BFF — dữ liệu nhân sự
 * thuộc bounded context `staff-access` (ADR-0013).
 *
 * Permission: `staff.read` — định danh có thật trong sealed catalog
 * (`0003_permission_catalog_seed.sql`, ADR-0010). Không phát minh permission.
 *
 * Trả `{ staff: Array<StaffRow & { displayName: string | null }> }` — mỗi
 * entry mapping từ StaffMember wire của staff-access: `accountId` lấy từ
 * `sub`, `displayName` lấy từ `display_name` (nhân sự), sau đó merge tên
 * hiển thị từ `account` qua `GET /internal/account/profiles` (issue #325).
 * Không nhân bản hồ sơ vào DB backoffice; không fallback từ email (lý do đầy
 * đủ ở `docs/applications/backoffice/01-architecture.md`).
 *
 * ## Hai chế độ lỗi trong cùng route
 *
 * - **Enforcement fail-closed** (issue #99, giữ nguyên): principal không verify
 *   được ⇒ `401` (ADR-0011); binding `STAFF_ACCESS_SERVICE` vắng / secret vắng
 *   ⇒ `503` (không có đường đọc staff directory ⇒ không trả dữ liệu giả);
 *   `can()` deny ⇒ `403` sau khi audit đã ghi. Xem {@link withReadEnforcement}.
 * - **Display controlled-degrade** (issue #325): khi `account` không trả lời
 *   được, sổ staff **vẫn trả 200** với `displayName: null` cho mọi người — kèm
 *   một dòng log `staff.account_degraded`.
 * - **Staff-access fail-closed**: khi staff-access không trả lời được (binding
 *   vắng, secret vắng, unreachable, HTTP lỗi, body sai contract) route trả
 *   `503` — không có dữ liệu mẫu để fallback.
 */

import { createError, defineEventHandler } from 'h3';

import {
  accountClientConfig,
  fetchAccountProfiles,
  fetchStaffDirectory,
  staffAccessClientConfig,
} from '@ecoma-io/backoffice-infrastructure';
import { cachedDisplayName, storeDisplayNames } from '@ecoma-io/backoffice-application';

import { readWorkerEnv } from '../db';
import { writeLog } from '../log';
import { withReadEnforcement } from '../read-route';

/**
 * Gọi account lấy displayName cho `missingSubs`. Không ném: lỗi mạng /
 * response sai contract trả `{ ok: false, reason }`; client chưa cấu hình
 * trả `null`. Route nhận kết quả này và quyết định controlled degrade.
 */
async function callAccountProfiles(
  accountConfig: Parameters<typeof fetchAccountProfiles>[0] | null,
  missingSubs: readonly string[],
): Promise<{
  readonly ok: boolean;
  readonly profiles: readonly { readonly sub: string; readonly displayName: string | null }[];
  readonly reason?: string;
} | null> {
  if (accountConfig === null) {
    return null;
  }
  try {
    const result = await fetchAccountProfiles(accountConfig, missingSubs);
    return result.ok
      ? {
          ok: true,
          profiles: result.profiles as readonly {
            readonly sub: string;
            readonly displayName: string | null;
          }[],
          reason: undefined,
        }
      : { ok: false, profiles: [], reason: result.reason };
  } catch {
    return { ok: false, profiles: [], reason: 'unreachable' };
  }
}

export default defineEventHandler((event) =>
  withReadEnforcement(event, 'staff.read', async () => {
    // Staff directory từ Staff Access API (P5.1), không từ db-backoffice.
    const env = readWorkerEnv(event);
    const staffConfig = env === null ? null : staffAccessClientConfig(env);
    if (staffConfig === null) {
      throw createError({ statusCode: 503, statusMessage: 'staff directory unavailable' });
    }
    const staffResult = await fetchStaffDirectory(staffConfig);
    if (!staffResult.ok) {
      writeLog({
        event: 'staff_access_directory_failed',
        route: '/api/staff',
        method: 'GET',
        status: 503,
        reason: staffResult.reason,
      });
      throw createError({ statusCode: 503, statusMessage: 'staff directory unavailable' });
    }
    const staff = staffResult.staff;

    const nowMs = Date.now();

    // Merge chỉ phủ những sub chưa có tên tươi trong cache — một lần mở sổ với
    // N staff nhưng M người đã có tên trong TTL tạo một batch cho đúng N−M sub.
    const missingSubs = staff
      .map((row) => row.sub)
      .filter((sub) => cachedDisplayName(sub, nowMs) === undefined);

    if (missingSubs.length > 0) {
      const accountConfig = accountClientConfig(env);
      const result = await callAccountProfiles(accountConfig, missingSubs);

      if (result !== null && result.ok) {
        storeDisplayNames(result.profiles, nowMs);
      } else {
        // Controlled degrade: sổ staff vẫn chạy, tên để `null`, hạ tầng lỗi được
        // ghi thành **một** dòng log riêng — điều tra bắt đầu từ đây chứ không từ
        // các dòng "displayName null" lặp theo số hàng.
        const reason =
          accountConfig === null ? 'account_client_unconfigured' : (result?.reason ?? 'unknown');
        writeLog({
          event: 'staff.account_degraded',
          route: '/api/staff',
          method: 'GET',
          status: 200,
          reason,
        });
      }
    }

    return {
      staff: staff.map((row) => {
        const cached = cachedDisplayName(row.sub, nowMs);
        return { ...row, displayName: cached === undefined ? null : cached };
      }),
    };
  }),
);
