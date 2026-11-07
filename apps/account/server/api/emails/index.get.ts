/**
 * `GET /api/emails` — danh sách email của chính caller (FR-009).
 *
 * ## Hợp đồng
 *
 * `200` với `{ emails: AccountEmailView[] }`, mới nhất trước. Địa chỉ trả dạng
 * **đã mask** ({@link maskEmail}): UI render danh sách được mà địa chỉ trần
 * không nằm trong payload JSON — quyết định v1, chi tiết trong JSDoc của hàm.
 * `isSignIn` là cờ hiển thị của ràng buộc FR-002 (địa chỉ verified cuối không
 * xoá được); server vẫn là nơi enforce thật ở DELETE.
 *
 * Subject duy nhất là `session.sub` (SR-009). `Cache-Control: no-store`.
 */

import { createError, defineEventHandler, setResponseHeader } from 'h3';

import { requireAuthedSession } from '../../lib/bff-session';
import { listEmails, toEmailView } from '../../lib/data-domain';
import { accountHyperdrive } from '../../utils/bindings';
import { writeLog } from '../../utils/logger';
import { withRequestPool } from '../../utils/db';

export interface EmailsBody {
  readonly emails: ReturnType<typeof toEmailView>[];
}

export default defineEventHandler(async (event): Promise<EmailsBody> => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const authed = await requireAuthedSession(event);
  if (authed === null) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const hyperdrive = accountHyperdrive(useRuntimeConfig(event));
  if (!hyperdrive) {
    writeLog({ event: 'emails_read.failed', status: 503, reason: 'binding_missing' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  try {
    const rows = await withRequestPool(hyperdrive, (pool) => listEmails(pool, authed.session.sub));
    return { emails: rows.map(toEmailView) };
  } catch {
    writeLog({ event: 'emails_read.failed', status: 503, reason: 'db_unreachable' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }
});
