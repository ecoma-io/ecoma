/**
 * `GET /api/auth/session` — đọc session hiện tại của browser.
 *
 * ## Hợp đồng
 *
 * Cookie hợp lệ và session sống → `200` với `{ sub, acr, authnAt, expiresAt }`
 * (đồng thời **trượt** idle expiry — sliding session). Không có cookie / cookie
 * không khớp session nào / session đã hết hạn hay bị thu hồi → `401` với body
 * rỗng — client coi là "chưa đăng nhập", không phân biệt lý do (không lộ việc
 * session đã bị revoke server-side).
 *
 * ## CSRF token
 *
 * Route này **không** cấp lại CSRF token: token sinh cùng verify/logout khi
 * session được tạo, và chỉ bị thay thế khi session rotate. Re-issue ngầm ở một
 * GET sẽ tạo token thứ hai không khớp cookie — hai nguồn sự thật.
 */

import { createError, defineEventHandler, getCookie, setResponseHeader } from 'h3';

import { accountHyperdrive } from '../../utils/bindings';
import { writeLog } from '../../utils/logger';
import { withRequestPool } from '../../utils/db';
import {
  hashSessionIdentifier,
  isSessionLive,
  loadSessionByHash,
  SESSION_COOKIE_NAME,
  touchSession,
  SESSION_IDLE_SECONDS,
} from '../../lib/session';

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const cookieValue = getCookie(event, SESSION_COOKIE_NAME);
  if (cookieValue === undefined || cookieValue.length === 0) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
  }

  const config = useRuntimeConfig(event);
  const hyperdrive = accountHyperdrive(config);
  if (!hyperdrive) {
    writeLog({ event: 'session_read.failed', status: 503, reason: 'binding_missing' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  try {
    const result = await withRequestPool(hyperdrive, async (pool) => {
      const idHash = await hashSessionIdentifier(cookieValue);
      const session = await loadSessionByHash(pool, idHash);
      if (session === null || session.user_sub === null || !isSessionLive(session, Date.now())) {
        return null;
      }

      // Sliding idle: đẩy `expires_at` mỗi lần đọc hợp lệ. Absolute deadline
      // không đổi — nó tính từ `created_at` ở tầng policy.
      const now = Date.now();
      await touchSession(pool, idHash, now + SESSION_IDLE_SECONDS * 1000);

      return {
        sub: session.user_sub,
        acr: session.acr,
        authnAt: session.authn_at === null ? null : session.authn_at.getTime(),
        expiresAt: now + SESSION_IDLE_SECONDS * 1000,
      };
    });

    if (result === null) {
      throw createError({ statusCode: 401, statusMessage: 'Unauthorized' });
    }
    return result;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
    ) {
      throw error;
    }
    writeLog({ event: 'session_read.failed', status: 503, reason: 'db_unreachable' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }
});
