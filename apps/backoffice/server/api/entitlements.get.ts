/**
 * `GET /api/entitlements` — tóm tắt entitlement của một staff đối với các sản phẩm
 * nội bộ, qua Staff Access management API (`GET /staff/:id/entitlements`).
 *
 * ## Thay đổi P5.4 (issue #478)
 *
 * Route mới trong workstream C: hiển thị trạng thái entitlement (khả năng dùng
 * sản phẩm) của staff trên sổ nhân sự backoffice. Dữ liệu entitlement thuộc
 * bounded context `staff-access` (ADR-0013); backoffice chỉ là composition/UI +
 * BFF.
 *
 * Entitlement ≠ authorization (ADR-0009): route chỉ trả trạng thái sản phẩm
 * (`entitled` / `revoked`), KHÔNG trả verdict/permission/role. `FORBIDDEN_ENTITLEMENT_FIELDS`
 * ở hợp đồng entitlement đã cấm ranh giới này ở phía validator.
 *
 * Permission: `staff.read` — định danh có thật trong sealed catalog
 * (`0003_permission_catalog_seed.sql`, ADR-0010). Không phát minh permission.
 *
 * Query param: `staff_id` (bắt buộc) — định danh staff của Staff Access directory.
 *
 * Fail-closed: principal không verify được ⇒ `401` (ADR-0011); binding
 * `STAFF_ACCESS_SERVICE` vắng / secret vắng ⇒ `503`; `can()` deny ⇒ `403` sau
 * khi audit đã ghi. Staff-access không trả lời được ⇒ `503` — không có dữ liệu
 * mẫu để fallback. Xem {@link withReadEnforcement}.
 */

import { createError, defineEventHandler, getQuery } from 'h3';

import {
  fetchStaffEntitlements,
  staffAccessClientConfig,
} from '@ecoma-io/backoffice-infrastructure';
import { readWorkerEnv } from '../db';
import { withReadEnforcement } from '../read-route';

/** Lấy `staff_id` từ query string, fail với `400` khi thiếu hoặc không phải chuỗi. */
function staffIdFromQuery(event: import('h3').H3Event): string {
  const query = getQuery(event);
  const staffId = query['staff_id'];
  if (typeof staffId !== 'string' || staffId.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'staff_id is required' });
  }
  return staffId;
}

export default defineEventHandler((event) =>
  withReadEnforcement(event, 'staff.read', async () => {
    const env = readWorkerEnv(event);
    const config = env === null ? null : staffAccessClientConfig(env);
    if (config === null) {
      throw createError({ statusCode: 503, statusMessage: 'entitlements unavailable' });
    }

    const staffId = staffIdFromQuery(event);
    const result = await fetchStaffEntitlements(config, staffId);
    if (!result.ok) {
      throw createError({ statusCode: 503, statusMessage: 'entitlements unavailable' });
    }

    return {
      entitlements: result.entitlements.map((entry) => ({
        product: entry.product,
        status: entry.status,
      })),
    };
  }),
);
