/**
 * `DELETE /api/sessions/:id` — thu hồi một phiên của chính caller.
 *
 * ## Hợp đồng v1
 *
 * - `id` là định danh công khai ({@link publicSessionId} — SHA-256 hex của
 *   `session_ref`). Route tra cứu bằng cách tính digest cho từng phiên sống
 *   của chính caller — không nhận `session_ref` trần từ URL (SR-006), không
 *   quét toàn bảng.
 * - `id` không khớp phiên sống nào của caller → `404` (không xác nhận tồn
 *   tại; phiên đã hết hạn/revoked cũng rơi vào đây — trạng thái cuối vẫn là
 *   "không còn sống", idempotent).
 * - Thu hồi **phiên hiện tại** → vẫn `204`, và response **xoá cả hai cookie**
 *   session + CSRF (quyết định v1 ghi trong PR body): caller vừa tự đăng xuất,
 *   giữ cookie là để lại cookie trỏ tới phiên đã chết. Body không có trường
 *   đặc biệt — client tự biết qua `isCurrent` ở danh sách trước khi gọi.
 * - Thu hồi phiên khác → `204`, cookie giữ nguyên.
 * - Mọi thu hồi thành công audit: `data_current_session_revoked` khi là phiên
 *   hiện tại, `data_session_revoked` khi là phiên khác. Metadata KHÔNG chứa
 *   `session_ref` hay digest — đếm được là đủ (SR-006).
 */

import { createError, defineEventHandler, getRouterParam, setResponseHeader } from 'h3';

import { requireAuthedSession } from '../../lib/bff-session';
import {
  appendSecurityEvent,
  DATA_EVENT_TYPES,
  listLiveSessions,
  publicSessionId,
  revokeOwnSession,
} from '../../lib/data-domain';
import { clearCsrfCookie, clearSessionCookie } from '../../lib/session';
import { accountHyperdrive } from '../../utils/bindings';
import { writeLog } from '../../utils/logger';
import { withRequestPool } from '../../utils/db';

/** Hình dạng id công khai — hex 64; sai hình dạng là 400 trước khi tính digest. */
const PUBLIC_ID_SHAPE = /^[0-9a-f]{64}$/u;

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const id = getRouterParam(event, 'id');
  if (typeof id !== 'string' || !PUBLIC_ID_SHAPE.test(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
  }

  const authed = await requireAuthedSession(event);
  if (authed === null) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const hyperdrive = accountHyperdrive(useRuntimeConfig(event));
  if (!hyperdrive) {
    writeLog({ event: 'session_revoke.failed', status: 503, reason: 'binding_missing' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  const currentRef = authed.session.sessionRef;
  try {
    // Tìm `session_ref` của caller có digest khớp `id` — chỉ trong các phiên
    // sống của chính caller, không quét bảng.
    const rows = await withRequestPool(hyperdrive, (pool) =>
      listLiveSessions(pool, authed.session.sub, Date.now()),
    );
    let targetRef: string | null = null;
    for (const row of rows) {
      if ((await publicSessionId(row.session_ref)) === id) {
        targetRef = row.session_ref;
        break;
      }
    }
    if (targetRef === null) {
      writeLog({ event: 'session_revoke.not_found', status: 404, sub: authed.session.sub });
      throw createError({ statusCode: 404, statusMessage: 'Not Found' });
    }

    const isCurrent = targetRef === currentRef;
    const revoked = await withRequestPool(hyperdrive, (pool) =>
      revokeOwnSession(pool, { userSub: authed.session.sub, sessionRef: targetRef as string }),
    );
    if (!revoked) {
      // Đua hiếm (phiên vừa revoked giữa list và update) — idempotent 204.
      writeLog({ event: 'session_revoke.race_noop', status: 204, sub: authed.session.sub });
      event.node.res.statusCode = 204;
      return null;
    }

    const audited = await withRequestPool(hyperdrive, (pool) =>
      appendSecurityEvent(pool, {
        subjectSub: authed.session.sub,
        type: isCurrent ? DATA_EVENT_TYPES.currentSessionRevoked : DATA_EVENT_TYPES.sessionRevoked,
        metadata: { field_count: 1 },
      }),
    );
    if (!audited) {
      writeLog({ event: 'session_revoke.audit_failed', status: 204, sub: authed.session.sub });
    }

    if (isCurrent) {
      // Tự thu hồi phiên hiện tại = tự đăng xuất: xoá cả hai cookie (cùng
      // hình thức logout — Set-Cookie header, không helper nhận event).
      setResponseHeader(event, 'Set-Cookie', [clearSessionCookie(), clearCsrfCookie()]);
    }
    writeLog({ event: 'session_revoke.done', status: 204, sub: authed.session.sub });
    event.node.res.statusCode = 204;
    return null;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
    ) {
      throw error;
    }
    writeLog({ event: 'session_revoke.failed', status: 503, reason: 'db_unreachable' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }
});
