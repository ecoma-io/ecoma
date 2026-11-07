/**
 * `GET /api/permissions` — danh sách permission catalog, qua enforcement của
 * workstream B (issue #99).
 *
 * ## Thay đổi P5.1 (issue #475)
 *
 * Permission catalog giờ đọc từ Staff Access management API (`GET /permissions`
 * qua binding `STAFF_ACCESS_SERVICE` + envelope HMAC `AUTH_INTERNAL_SECRET`)
 * thay vì đọc `db-backoffice` trực tiếp qua `listPermissions`. Dữ liệu catalog
 * thuộc sở hữu của Staff Access (ADR-0013).
 *
 * Permission: `permission.read` — định danh có thật trong sealed catalog
 * (`0003_permission_catalog_seed.sql`, ADR-0010). Không phát minh permission.
 *
 * Trả `{ permissions: ... }` — `id`/`domain`/`action`/`status`, đúng allowlist
 * của contract staff-access. Có thể gồm row `retired`: catalog là sealed
 * history, lọc ở UI là quyết định hiển thị.
 *
 * Fail-closed: principal không verify được ⇒ `401` (ADR-0011); binding
 * `STAFF_ACCESS_SERVICE` vắng / secret vắng ⇒ `503`; `can()` deny ⇒ `403` sau
 * khi audit đã ghi. Xem {@link withReadEnforcement}.
 */

import { createError, defineEventHandler } from 'h3';

import {
  fetchPermissionCatalog,
  staffAccessClientConfig,
} from '@ecoma-io/backoffice-infrastructure';
import { readWorkerEnv } from '../db';
import { withReadEnforcement } from '../read-route';

export default defineEventHandler((event) =>
  withReadEnforcement(event, 'permission.read', async () => {
    const env = readWorkerEnv(event);
    const config = env === null ? null : staffAccessClientConfig(env);
    if (config === null) {
      throw createError({ statusCode: 503, statusMessage: 'permission catalog unavailable' });
    }
    const result = await fetchPermissionCatalog(config);
    if (!result.ok) {
      throw createError({ statusCode: 503, statusMessage: 'permission catalog unavailable' });
    }
    return {
      permissions: result.permissions.map((permission) => ({
        id: permission.id,
        domain: permission.domain,
        action: permission.action,
        status: permission.status,
      })),
    };
  }),
);
