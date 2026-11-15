/**
 * `POST /api/staff/:id/assignments` — gán role cho một staff member (issue
 * #191, bề mặt operator của `POST /staff/:id/assignments` của staff-access).
 *
 * BFF chỉ kiểm session + CSRF double-submit — verdict `role.assign` do
 * staff-access enforce server-side trên từng request (ADR-0023 Quyết định 2);
 * thiếu quyền ⇒ 403 + hàng audit `denied` đã commit, được forward nguyên vẹn.
 * Xem {@link requireWriteActor}.
 *
 * Body: đúng contract `CreateAssignmentRequest`, nhưng `staff_id` đến từ
 * **path** — không nhận từ body (SR-001: client không supply được danh tính
 * hay đích gán). Validate bằng `validateCreateAssignmentRequest`. Self-
 * assignment của actor bị staff-access chặn (403 + audit `denied`
 * `self_assignment`).
 */

import { createError, defineEventHandler, getRouterParam, readBody, setResponseStatus } from 'h3';

import {
  createStaffAssignment,
  staffAccessClientConfig,
} from '@ecoma-io/backoffice-infrastructure';
import { validateCreateAssignmentRequest } from '@ecoma-io/staff-access-contracts';

import { readWorkerEnv } from '../../../../db';
import { requireWriteActor } from '../../../../write-route';

export default defineEventHandler(async (event) => {
  const { actorSub } = requireWriteActor(event);

  const staffId = getRouterParam(event, 'id');
  if (typeof staffId !== 'string' || staffId.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
  }

  const request = {
    ...((await readBody(event)) as object),
    staff_id: staffId,
  };
  const validated = validateCreateAssignmentRequest(request);
  if (!validated.ok) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
  }

  const env = readWorkerEnv(event);
  const config = env === null || env === undefined ? null : staffAccessClientConfig(env);
  if (config === null) {
    throw createError({ statusCode: 503, statusMessage: 'Staff Access is unavailable.' });
  }

  const result = await createStaffAssignment(config, validated.payload, actorSub);
  if (result.ok) {
    setResponseStatus(event, 201);
    return result.assignment;
  }
  if (result.reason === 'http_error' && result.status !== undefined) {
    throw createError({ statusCode: result.status, statusMessage: result.message });
  }
  throw createError({ statusCode: 503, statusMessage: 'Staff Access is unavailable.' });
});
