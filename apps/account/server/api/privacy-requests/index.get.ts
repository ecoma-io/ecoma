/**
 * `GET /api/privacy-requests` — danh sách privacy request của chính caller.
 *
 * ## Hợp đồng v1 (FR-013, FR-014, FR-015)
 *
 * `200` với `{ requests: [...] }`, mới nhất trước; mỗi entry: `kind`,
 * `status`, `submittedAt`, `dueAt` (deadline — FR-014). v1 chỉ TẠO — mọi
 * trạng thái sau `pending` là của vòng đời orchestration (FR-013a), nhưng
 * route đọc mọi giá trị CHECK cho phép để vòng đời sau này không phải đổi
 * route (FR-015: trạng thái hỏng phải nhìn thấy được, không biến mất).
 *
 * ⚠️ Subject duy nhất là `session.sub` (SR-009). Read-only — không audit.
 * `Cache-Control: no-store`.
 */

import { createError, defineEventHandler, setResponseHeader } from 'h3';

import { requireAuthedSession } from '../../lib/bff-session';
import { listPrivacyRequests, toPrivacyRequestView } from '../../lib/data-domain';
import { accountHyperdrive } from '../../utils/bindings';
import { writeLog } from '../../utils/logger';
import { withRequestPool } from '../../utils/db';

export interface PrivacyRequestsBody {
  readonly requests: ReturnType<typeof toPrivacyRequestView>[];
}

export default defineEventHandler(async (event): Promise<PrivacyRequestsBody> => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const authed = await requireAuthedSession(event);
  if (authed === null) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const hyperdrive = accountHyperdrive(useRuntimeConfig(event));
  if (!hyperdrive) {
    writeLog({ event: 'privacy_list.failed', status: 503, reason: 'binding_missing' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  try {
    const rows = await withRequestPool(hyperdrive, (pool) =>
      listPrivacyRequests(pool, authed.session.sub),
    );
    return { requests: rows.map(toPrivacyRequestView) };
  } catch {
    writeLog({ event: 'privacy_list.failed', status: 503, reason: 'db_unreachable' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }
});
