/**
 * `GET /api/sessions` — danh sách phiên sống của chính caller.
 *
 * ## Hợp đồng v1
 *
 * Thành công → `200 { sessions: AccountSessionView[] }` với mỗi phiên:
 *
 * - `id` — SHA-256 hex của `session_ref` ({@link publicSessionId}), KHÔNG
 *   bao giờ là `session_ref` (SR-006 cấm giá trị đó vào URL/log/audit; `id`
 *   của DELETE lấy giá trị này).
 * - `createdAt` / `expiresAt` — ISO 8601 UTC.
 * - `lastSeenAt` — suy gần đúng từ `expires_at - 12h` idle deadline: server
 *   đẩy `expires_at` mỗi request hợp lệ, đây là ước lượng trung thực về những
 *   gì DB biết (schema không có cột `last_seen`).
 * - `isCurrent` — đúng một phiên trong danh sách có `true`: phiên của cookie
 *   caller. KHÔNG có `id_hash`, KHÔNG có cookie value, KHÔNG có `session_ref`
 *   trong bất kỳ trường nào.
 *
 * Read-only — không audit. Danh sách lọc sẵn ở SQL (chưa revoked, chưa quá
 * idle expiry); absolute deadline kiểm thêm ở tầng app.
 */

import { createError, defineEventHandler, setResponseHeader } from 'h3';

import { requireAuthedSession } from '../../lib/bff-session';
import { listLiveSessions, toSessionView } from '../../lib/data-domain';
import { isSessionLive, SESSION_IDLE_SECONDS } from '../../lib/session';
import { accountHyperdrive } from '../../utils/bindings';
import { writeLog } from '../../utils/logger';
import { withRequestPool } from '../../utils/db';

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const authed = await requireAuthedSession(event);
  if (authed === null) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const hyperdrive = accountHyperdrive(useRuntimeConfig(event));
  if (!hyperdrive) {
    writeLog({ event: 'session_list.failed', status: 503, reason: 'binding_missing' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  const nowMs = Date.now();
  try {
    const rows = await withRequestPool(hyperdrive, (pool) =>
      listLiveSessions(pool, authed.session.sub, nowMs),
    );
    const views = [];
    for (const row of rows) {
      // Absolute deadline (`created_at + 7d`) — cùng luật `isSessionLive` của
      // luồng touch: phiên vượt deadline không được hiện là sống.
      if (!isSessionLive({ ...row, revoked_at: null }, nowMs)) {
        continue;
      }
      views.push(
        await toSessionView(row, {
          idleSeconds: SESSION_IDLE_SECONDS,
          currentRef: authed.session.sessionRef,
        }),
      );
    }
    return { sessions: views };
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
    ) {
      throw error;
    }
    writeLog({ event: 'session_list.failed', status: 503, reason: 'db_unreachable' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }
});
