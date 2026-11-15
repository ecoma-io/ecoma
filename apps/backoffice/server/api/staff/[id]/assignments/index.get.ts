/**
 * `GET /api/staff/:id/assignments` — assignments của một staff member (issue
 * #191, đường đọc phục vụ control thu hồi role trên staff listing).
 *
 * BFF không quyết định quyền gì thêm: permission `staff.read` (đã được enforce
 * qua {@link withReadEnforcement} — đường đọc có bảo vệ, audit như mọi read
 * route) là đủ để đọc danh sách assignment; verdict write (`role.assign` /
 * `role.revoke`) do staff-access enforce server-side trên từng request ghi.
 *
 * `:id` là **UUID nội bộ** của staff trong Staff Access (`staff_access.staff.id`)
 * — không phải Account ID `sub`: `role_assignments.staff_id` tham chiếu UUID
 * đó (migration 0001). Forward nguyên vẹn tới `GET /staff/:id/assignments`
 * của staff-access qua write/list client `fetchStaffAssignments`.
 *
 * Trả `{ assignments: StaffRoleAssignment[] }` đúng wire của contract; 503 khi
 * staff-access không trả lời được.
 */

import { createError, defineEventHandler, getRouterParam } from 'h3';

import {
  fetchStaffAssignments,
  staffAccessClientConfig,
} from '@ecoma-io/backoffice-infrastructure';

import { readWorkerEnv } from '../../../../db';
import { withReadEnforcement } from '../../../../read-route';

export default defineEventHandler((event) =>
  withReadEnforcement(event, 'staff.read', async () => {
    const staffId = getRouterParam(event, 'id');
    if (typeof staffId !== 'string' || staffId.length === 0) {
      throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
    }

    const env = readWorkerEnv(event);
    const config = env === null || env === undefined ? null : staffAccessClientConfig(env);
    if (config === null) {
      throw createError({ statusCode: 503, statusMessage: 'staff assignments unavailable' });
    }
    const result = await fetchStaffAssignments(config, staffId);
    if (!result.ok) {
      throw createError({ statusCode: 503, statusMessage: 'staff assignments unavailable' });
    }
    return { assignments: result.assignments };
  }),
);
