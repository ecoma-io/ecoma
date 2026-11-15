/**
 * `POST /api/staff` — tạo staff identity cho một Account đã tồn tại (issue
 * #191, bề mặt operator của `POST /staff` của staff-access — #44).
 *
 * BFF chỉ kiểm session (principal từ middleware authn) + CSRF double-submit —
 * verdict permission do staff-access enforce server-side trên từng request
 * (ADR-0023 Quyết định 2); thiếu `staff.create` ⇒ 403 + hàng audit `denied`
 * đã commit, được forward nguyên vẹn. Xem {@link requireWriteActor}.
 *
 * Body: `{ sub, display_name }` — validate bằng contract
 * `validateCreateStaffRequest` (chặn trường hồ sơ cấm; hình sai ⇒ 400 trước
 * khi chạm staff-access). Actor đi vào envelope HMAC, không vào body.
 *
 * Trả 201 kèm StaffMember khi tạo được; 403 denial; 409 staff đã tồn tại;
 * 503 staff-access không trả lời được.
 */

import { createError, defineEventHandler, readBody, setResponseStatus } from 'h3';

import {
  createStaff,
  staffAccessClientConfig,
  type StaffCreateWriteResult,
} from '@ecoma-io/backoffice-infrastructure';
import { validateCreateStaffRequest } from '@ecoma-io/staff-access-contracts';

import { readWorkerEnv } from '../db';
import { requireWriteActor } from '../write-route';

export default defineEventHandler(async (event) => {
  const { actorSub } = requireWriteActor(event);

  const validated = validateCreateStaffRequest(await readBody(event));
  if (!validated.ok) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
  }

  const env = readWorkerEnv(event);
  const config = env === null || env === undefined ? null : staffAccessClientConfig(env);
  if (config === null) {
    throw createError({ statusCode: 503, statusMessage: 'Staff Access is unavailable.' });
  }

  const result: StaffCreateWriteResult = await createStaff(config, validated.payload, actorSub);
  if (result.ok) {
    setResponseStatus(event, 201);
    return result.staff;
  }
  if (result.reason === 'http_error' && result.status !== undefined) {
    throw createError({ statusCode: result.status, statusMessage: result.message });
  }
  throw createError({ statusCode: 503, statusMessage: 'Staff Access is unavailable.' });
});
