/**
 * `GET /api/roles` — danh sách role catalog, qua enforcement của workstream B
 * (issue #99).
 *
 * ## Thay đổi P5.1 (issue #475)
 *
 * Role catalog giờ đọc từ Staff Access management API (`GET /roles` qua binding
 * `STAFF_ACCESS_SERVICE` + envelope HMAC `AUTH_INTERNAL_SECRET`) thay vì đọc
 * `db-backoffice` trực tiếp qua `listRoles`. Dữ liệu quyền nội bộ thuộc bounded
 * context `staff-access` (ADR-0013).
 *
 * Permission: `role.read` — định danh có thật trong sealed catalog
 * (`0003_permission_catalog_seed.sql`, ADR-0010). Không phát minh permission.
 *
 * Trả `{ roles: RoleRow[] }` — `id` + `isSystem` (đã map ở tầng JS), đúng
 * allowlist của contract staff-access.
 *
 * Fail-closed: principal không verify được ⇒ `401` (ADR-0011); binding
 * `STAFF_ACCESS_SERVICE` vắng / secret vắng ⇒ `503`; `can()` deny ⇒ `403` sau
 * khi audit đã ghi. Xem {@link withReadEnforcement}.
 */

import { createError, defineEventHandler } from 'h3';

import { fetchRoleCatalog, staffAccessClientConfig } from '@ecoma-io/backoffice-infrastructure';
import { readWorkerEnv } from '../db';
import { withReadEnforcement } from '../read-route';

export default defineEventHandler((event) =>
  withReadEnforcement(event, 'role.read', async () => {
    const env = readWorkerEnv(event);
    const config = env === null ? null : staffAccessClientConfig(env);
    if (config === null) {
      throw createError({ statusCode: 503, statusMessage: 'role catalog unavailable' });
    }
    const result = await fetchRoleCatalog(config);
    if (!result.ok) {
      throw createError({ statusCode: 503, statusMessage: 'role catalog unavailable' });
    }
    return {
      roles: result.roles.map((role) => ({
        id: role.id,
        isSystem: role.kind === 'system',
      })),
    };
  }),
);
