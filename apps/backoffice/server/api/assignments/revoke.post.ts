/**
 * `POST /api/assignments/revoke` — thu hồi một assignment (issue #191, bề mặt
 * operator của `POST /assignments/revoke` của staff-access).
 *
 * BFF chỉ kiểm session + CSRF double-submit — verdict `role.revoke` do
 * staff-access enforce server-side trên từng request (ADR-0023 Quyết định 2);
 * thiếu quyền ⇒ 403 + hàng audit `denied` đã commit. Self-revocation của
 * administrator cuối cùng bị guard của #44 chặn (403 `self_revocation_last_
 * administrator`) — message của staff-access được forward nguyên vẹn để UI
 * hiện đúng lý do. Xem {@link requireWriteActor}.
 *
 * Body: `{ id }` — đúng contract `RevokeAssignmentRequest`, validate trước khi
 * gọi (400 hình sai). Thu hồi lại một assignment đã revoked ⇒ 409.
 */

import { createError, defineEventHandler, readBody } from 'h3';

import {
  revokeStaffAssignment,
  staffAccessClientConfig,
} from '@ecoma-io/backoffice-infrastructure';
import { validateRevokeAssignmentRequest } from '@ecoma-io/staff-access-contracts';

import { readWorkerEnv } from '../../db';
import { requireWriteActor } from '../../write-route';

export default defineEventHandler(async (event) => {
  const { actorSub } = requireWriteActor(event);

  const validated = validateRevokeAssignmentRequest(await readBody(event));
  if (!validated.ok) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
  }

  const env = readWorkerEnv(event);
  const config = env === null || env === undefined ? null : staffAccessClientConfig(env);
  if (config === null) {
    throw createError({ statusCode: 503, statusMessage: 'Staff Access is unavailable.' });
  }

  const result = await revokeStaffAssignment(config, validated.payload.id, actorSub);
  if (result.ok) {
    return result.assignment;
  }
  if (result.reason === 'http_error' && result.status !== undefined) {
    throw createError({ statusCode: result.status, statusMessage: result.message });
  }
  throw createError({ statusCode: 503, statusMessage: 'Staff Access is unavailable.' });
});
